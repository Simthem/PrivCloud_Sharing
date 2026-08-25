const DEFAULT_DIRECT_CONNECTIONS_PER_ORIGIN = 6;
const MAX_DIRECT_CONNECTIONS_PER_ORIGIN = 8;
const MAX_DIRECT_ORIGINS = 8;
const MAX_DIRECT_TOTAL_CONCURRENCY = 32;
const MAX_RELAY_TOTAL_CONCURRENCY = 32;
const MAX_COOLDOWN_MS = 120_000;

export type UploadDirectPoolConfig = {
  originCount?: number;
  connectionsPerOrigin?: number;
  maxConcurrency?: number;
  relayGlobalConcurrency?: number;
  // Compatibility for older backends that only exposed a per-flow hint.
  relayFallbackConcurrency?: number;
};

export type UploadDirectSlotCandidate = {
  origin: string;
};

export type UploadDirectSlotGrant = {
  leaseId: string;
  candidateIndex: number;
  origin: string;
};

type PendingDirectRequest = {
  id: string;
  flowId: string;
  candidates: UploadDirectSlotCandidate[];
  resolve: (_grant: UploadDirectSlotGrant) => void;
  reject: (_error: Error) => void;
};

type PendingRelayRequest = {
  id: string;
  flowId: string;
  resolve: (_leaseId: string) => void;
  reject: (_error: Error) => void;
};

type DirectLease = {
  flowId: string;
  origin: string;
};

type FlowState = {
  onWindowChange?: (_maxParallel: number) => void;
};

type OriginState = {
  active: number;
  cooldownUntil: number;
  consecutiveFailures: number;
};

let coordinatorSequence = 0;

function nextId(prefix: string): string {
  coordinatorSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${coordinatorSequence.toString(36)}`;
}

function clampInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(parsed)));
}

/**
 * Page-local upload arbiter.
 *
 * Browser connection pools are shared by every Worker from a page, whereas a
 * Web Worker cannot observe the other file Workers. This coordinator is the
 * single authority for direct-S3 sockets and for the emergency Nest relay.
 * Queueing is round-robin by file flow, so one large file cannot reserve the
 * complete origin pool ahead of its siblings.
 */
export class UploadBatchCoordinator {
  private readonly flows = new Map<string, FlowState>();
  private readonly directQueues = new Map<string, PendingDirectRequest[]>();
  private readonly relayQueues = new Map<string, PendingRelayRequest[]>();
  private readonly directLeases = new Map<string, DirectLease>();
  private readonly relayLeases = new Map<string, string>();
  private readonly directActiveByFlow = new Map<string, number>();
  private readonly origins = new Map<string, OriginState>();
  private flowOrder: string[] = [];
  private directCursor = 0;
  private relayCursor = 0;
  private directActive = 0;
  private relayActive = 0;
  private originCount = 1;
  private connectionsPerOrigin = DEFAULT_DIRECT_CONNECTIONS_PER_ORIGIN;
  private maxDirectConcurrency = DEFAULT_DIRECT_CONNECTIONS_PER_ORIGIN;
  private maxRelayConcurrency = 1;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  get flowCount(): number {
    return this.flows.size;
  }

  get activeDirectCount(): number {
    return this.directActive;
  }

  get activeRelayCount(): number {
    return this.relayActive;
  }

  registerFlow(onWindowChange?: (_maxParallel: number) => void): string {
    if (this.closed) throw new Error("Upload coordinator is closed");
    const flowId = nextId("upload-flow");
    this.flows.set(flowId, { onWindowChange });
    this.directQueues.set(flowId, []);
    this.relayQueues.set(flowId, []);
    this.directActiveByFlow.set(flowId, 0);
    this.flowOrder.push(flowId);
    this.notifyWindows();
    return flowId;
  }

  configure(config: UploadDirectPoolConfig): void {
    this.originCount = clampInteger(
      config.originCount,
      this.originCount,
      1,
      MAX_DIRECT_ORIGINS,
    );
    this.connectionsPerOrigin = clampInteger(
      config.connectionsPerOrigin,
      this.connectionsPerOrigin,
      1,
      MAX_DIRECT_CONNECTIONS_PER_ORIGIN,
    );
    const physicalMaximum = this.originCount * this.connectionsPerOrigin;
    this.maxDirectConcurrency = Math.min(
      physicalMaximum,
      clampInteger(
        config.maxConcurrency,
        physicalMaximum,
        1,
        MAX_DIRECT_TOTAL_CONCURRENCY,
      ),
    );
    this.maxRelayConcurrency =
      config.relayGlobalConcurrency === undefined
        ? clampInteger(
            config.relayFallbackConcurrency,
            this.maxRelayConcurrency,
            1,
            2,
          )
        : clampInteger(
            config.relayGlobalConcurrency,
            this.maxRelayConcurrency,
            1,
            MAX_RELAY_TOTAL_CONCURRENCY,
          );
    this.notifyWindows();
    if (!this.closed) this.drain();
  }

  acquireDirect(
    flowId: string,
    candidates: UploadDirectSlotCandidate[],
  ): Promise<UploadDirectSlotGrant> {
    if (!this.flows.has(flowId)) {
      return Promise.reject(new Error("Upload flow is no longer active"));
    }
    const normalizedCandidates = candidates
      .map((candidate) => ({ origin: candidate.origin.trim().toLowerCase() }))
      .filter((candidate) => candidate.origin.length > 0);
    if (normalizedCandidates.length === 0) {
      return Promise.reject(new Error("Direct upload has no valid origin"));
    }

    return new Promise((resolve, reject) => {
      this.directQueues.get(flowId)!.push({
        id: nextId("direct-request"),
        flowId,
        candidates: normalizedCandidates,
        resolve,
        reject,
      });
      this.drain();
    });
  }

  acquireRelay(flowId: string): Promise<string> {
    if (!this.flows.has(flowId)) {
      return Promise.reject(new Error("Upload flow is no longer active"));
    }
    return new Promise((resolve, reject) => {
      this.relayQueues.get(flowId)!.push({
        id: nextId("relay-request"),
        flowId,
        resolve,
        reject,
      });
      this.drainRelay();
    });
  }

  releaseDirect(
    leaseId: string,
    outcome: "success" | "transient" | "network" | "cancelled" = "success",
    retryAfterMs = 0,
  ): void {
    const lease = this.directLeases.get(leaseId);
    if (!lease) return;
    this.directLeases.delete(leaseId);
    this.directActive = Math.max(0, this.directActive - 1);
    this.directActiveByFlow.set(
      lease.flowId,
      Math.max(0, (this.directActiveByFlow.get(lease.flowId) ?? 0) - 1),
    );

    const origin = this.getOrigin(lease.origin);
    origin.active = Math.max(0, origin.active - 1);
    if (outcome === "success") {
      origin.consecutiveFailures = 0;
      origin.cooldownUntil = 0;
    } else if (outcome === "transient" || outcome === "network") {
      origin.consecutiveFailures += 1;
      const exponential =
        Math.min(250 * 2 ** Math.min(origin.consecutiveFailures - 1, 7), 30_000) +
        Math.floor(Math.random() * 500);
      origin.cooldownUntil =
        Date.now() +
        Math.min(
          MAX_COOLDOWN_MS,
          Math.max(exponential, Math.max(0, retryAfterMs)),
        );
    }
    if (!this.closed) this.drain();
  }

  releaseRelay(leaseId: string): void {
    if (!this.relayLeases.delete(leaseId)) return;
    this.relayActive = Math.max(0, this.relayActive - 1);
    if (!this.closed) this.drainRelay();
  }

  unregisterFlow(flowId: string): void {
    if (!this.flows.delete(flowId)) return;
    const cancellation = new Error("Upload flow was cancelled");
    for (const request of this.directQueues.get(flowId) ?? []) {
      request.reject(cancellation);
    }
    for (const request of this.relayQueues.get(flowId) ?? []) {
      request.reject(cancellation);
    }
    this.directQueues.delete(flowId);
    this.relayQueues.delete(flowId);
    this.flowOrder = this.flowOrder.filter((candidate) => candidate !== flowId);

    for (const [leaseId, lease] of this.directLeases) {
      if (lease.flowId === flowId) {
        this.releaseDirect(leaseId, "cancelled");
      }
    }
    for (const [leaseId, leaseFlowId] of this.relayLeases) {
      if (leaseFlowId === flowId) this.releaseRelay(leaseId);
    }
    this.directActiveByFlow.delete(flowId);
    this.directCursor %= Math.max(1, this.flowOrder.length);
    this.relayCursor %= Math.max(1, this.flowOrder.length);
    if (!this.closed) {
      this.notifyWindows();
      this.drain();
    }
  }

  close(): void {
    this.closed = true;
    for (const flowId of [...this.flows.keys()]) this.unregisterFlow(flowId);
    if (this.cooldownTimer !== null) clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
  }

  private notifyWindows(): void {
    const fairWindow = Math.max(
      1,
      Math.ceil(this.maxDirectConcurrency / Math.max(1, this.flows.size)),
    );
    for (const flow of this.flows.values()) {
      flow.onWindowChange?.(fairWindow);
    }
  }

  private getOrigin(origin: string): OriginState {
    let state = this.origins.get(origin);
    if (!state) {
      state = { active: 0, cooldownUntil: 0, consecutiveFailures: 0 };
      this.origins.set(origin, state);
    }
    return state;
  }

  private selectCandidate(
    candidates: UploadDirectSlotCandidate[],
    now: number,
  ): { candidateIndex: number; origin: string } | null {
    let selected: { candidateIndex: number; origin: string; active: number } | null =
      null;
    candidates.forEach((candidate, candidateIndex) => {
      const state = this.getOrigin(candidate.origin);
      if (
        state.cooldownUntil > now ||
        state.active >= this.connectionsPerOrigin
      ) {
        return;
      }
      if (!selected || state.active < selected.active) {
        selected = { candidateIndex, origin: candidate.origin, active: state.active };
      }
    });
    return selected;
  }

  private drain(): void {
    if (this.flowOrder.length === 0) return;
    const now = Date.now();
    let madeProgress = true;

    while (this.directActive < this.maxDirectConcurrency && madeProgress) {
      madeProgress = false;
      for (let offset = 0; offset < this.flowOrder.length; offset += 1) {
        const position = (this.directCursor + offset) % this.flowOrder.length;
        const flowId = this.flowOrder[position];
        const fairWindow = Math.max(
          1,
          Math.ceil(this.maxDirectConcurrency / Math.max(1, this.flows.size)),
        );
        if ((this.directActiveByFlow.get(flowId) ?? 0) >= fairWindow) continue;
        const queue = this.directQueues.get(flowId);
        const request = queue?.[0];
        if (!request) continue;
        const selected = this.selectCandidate(request.candidates, now);
        if (!selected) continue;

        queue!.shift();
        const leaseId = nextId("direct-lease");
        this.directLeases.set(leaseId, {
          flowId,
          origin: selected.origin,
        });
        this.directActive += 1;
        this.directActiveByFlow.set(
          flowId,
          (this.directActiveByFlow.get(flowId) ?? 0) + 1,
        );
        this.getOrigin(selected.origin).active += 1;
        this.directCursor = (position + 1) % this.flowOrder.length;
        request.resolve({
          leaseId,
          candidateIndex: selected.candidateIndex,
          origin: selected.origin,
        });
        madeProgress = true;
        break;
      }
    }

    this.scheduleCooldownDrain(now);
    this.drainRelay();
  }

  private scheduleCooldownDrain(now: number): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const state of this.origins.values()) {
      if (state.cooldownUntil > now) earliest = Math.min(earliest, state.cooldownUntil);
    }
    if (!Number.isFinite(earliest)) return;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.drain();
    }, Math.max(1, earliest - now));
  }

  private drainRelay(): void {
    if (this.flowOrder.length === 0) return;
    while (this.relayActive < this.maxRelayConcurrency) {
      let granted = false;
      for (let offset = 0; offset < this.flowOrder.length; offset += 1) {
        const position = (this.relayCursor + offset) % this.flowOrder.length;
        const flowId = this.flowOrder[position];
        const request = this.relayQueues.get(flowId)?.shift();
        if (!request) continue;
        const leaseId = nextId("relay-lease");
        this.relayLeases.set(leaseId, flowId);
        this.relayActive += 1;
        this.relayCursor = (position + 1) % this.flowOrder.length;
        request.resolve(leaseId);
        granted = true;
        break;
      }
      if (!granted) break;
    }
  }
}

type CoordinatorEntry = {
  coordinator: UploadBatchCoordinator;
  references: number;
};

const coordinators = new Map<string, CoordinatorEntry>();

export type UploadFlowCoordinatorHandle = {
  flowId: string;
  configure: (_config: UploadDirectPoolConfig) => void;
  acquireDirect: (
    _candidates: UploadDirectSlotCandidate[],
  ) => Promise<UploadDirectSlotGrant>;
  releaseDirect: (
    _leaseId: string,
    _outcome?: "success" | "transient" | "network" | "cancelled",
    _retryAfterMs?: number,
  ) => void;
  acquireRelay: () => Promise<string>;
  releaseRelay: (_leaseId: string) => void;
  close: () => void;
};

export function acquireUploadFlowCoordinator(
  batchKey: string,
  onWindowChange?: (_maxParallel: number) => void,
): UploadFlowCoordinatorHandle {
  let entry = coordinators.get(batchKey);
  if (!entry) {
    entry = { coordinator: new UploadBatchCoordinator(), references: 0 };
    coordinators.set(batchKey, entry);
  }
  entry.references += 1;
  const flowId = entry.coordinator.registerFlow(onWindowChange);
  let closed = false;

  return {
    flowId,
    configure: (config) => entry!.coordinator.configure(config),
    acquireDirect: (candidates) =>
      entry!.coordinator.acquireDirect(flowId, candidates),
    releaseDirect: (leaseId, outcome, retryAfterMs) =>
      entry!.coordinator.releaseDirect(leaseId, outcome, retryAfterMs),
    acquireRelay: () => entry!.coordinator.acquireRelay(flowId),
    releaseRelay: (leaseId) => entry!.coordinator.releaseRelay(leaseId),
    close: () => {
      if (closed) return;
      closed = true;
      entry!.coordinator.unregisterFlow(flowId);
      entry!.references -= 1;
      if (entry!.references <= 0) {
        entry!.coordinator.close();
        coordinators.delete(batchKey);
      }
    },
  };
}
