import { readFileSync } from "node:fs";
import { availableParallelism, totalmem } from "node:os";

const MAX_PROTOCOL_SLOTS = 64;
const DEFAULT_MAX_SLOTS = 6;
const DEFAULT_MIN_SLOTS = 2;
const DEFAULT_QUEUE_LIMIT = 128;
const DEFAULT_SLOT_TIMEOUT_MS = 240_000;
const DEFAULT_ACTIVE_FLOW_TTL_MS = 60_000;
const DEFAULT_REEVALUATION_MS = 2_000;
const DEFAULT_SLOT_MEMORY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MEMORY_SOFT_LIMIT = 0.78;
const DEFAULT_CPU_SOFT_LIMIT = 0.9;
const DEFAULT_EVENT_LOOP_LAG_MS = 120;
const DEFAULT_PRESSURE_SAMPLES = 3;

type QueueEntry = {
  flowId: string;
  sequence: number;
  resolve: (acquired: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export type TransferSchedulerAllocation = {
  recommendedSlots: number;
  targetSlots: number;
  activeSlots: number;
  activeFlows: number;
  queuedRequests: number;
  fairShare: number;
  memoryPressure: number;
  cpuPressure: number;
  eventLoopLagMs: number;
  pressureSamples: number;
};

type SchedulerLimits = {
  maxSlots: number;
  minSlots: number;
  maxSlotsPerFlow: number;
  queueLimit: number;
  slotTimeoutMs: number;
  activeFlowTtlMs: number;
  reevaluationMs: number;
  slotMemoryBytes: number;
  memorySoftLimit: number;
  cpuSoftLimit: number;
  eventLoopLagLimitMs: number;
  pressureSamples: number;
};

type ResourceSnapshot = {
  rssBytes: number;
  memoryLimitBytes: number;
  cpuPressure: number;
  eventLoopLagMs: number;
};

type SchedulerEnvironmentKeys = {
  maxSlots: string;
  minSlots: string;
  maxSlotsPerFlow: string;
  queueLimit: string;
  slotTimeoutMs: string;
  activeFlowTtlMs: string;
  reevaluationMs: string;
  slotMemoryBytes: string;
  memorySoftLimit: string;
  cpuSoftLimit: string;
  eventLoopLagLimitMs: string;
  pressureSamples: string;
};

const DEFAULT_ENVIRONMENT_KEYS: SchedulerEnvironmentKeys = {
  maxSlots: "S3_MAX_CONCURRENT_UPLOADS",
  minSlots: "S3_MIN_CONCURRENT_UPLOADS",
  maxSlotsPerFlow: "S3_MAX_CONCURRENT_PER_FILE",
  queueLimit: "S3_UPLOAD_QUEUE_LIMIT",
  slotTimeoutMs: "S3_UPLOAD_SLOT_TIMEOUT_MS",
  activeFlowTtlMs: "S3_ACTIVE_FLOW_TTL_MS",
  reevaluationMs: "S3_ADAPTIVE_REEVALUATION_MS",
  slotMemoryBytes: "S3_UPLOAD_SLOT_MEMORY_BYTES",
  memorySoftLimit: "S3_MEMORY_SOFT_LIMIT_RATIO",
  cpuSoftLimit: "S3_CPU_SOFT_LIMIT_RATIO",
  eventLoopLagLimitMs: "S3_EVENT_LOOP_LAG_LIMIT_MS",
  pressureSamples: "S3_ADAPTIVE_PRESSURE_SAMPLES",
};

export type AdaptiveTransferSchedulerOptions = {
  environment?: NodeJS.ProcessEnv;
  environmentKeys?: Partial<SchedulerEnvironmentKeys>;
  now?: () => number;
  resourceSnapshot?: () => ResourceSnapshot;
};

const parseInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const parseRatio = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const detectMemoryLimit = (): number => {
  const candidates = [totalmem()];
  for (const path of [
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (!/^\d+$/.test(value)) continue;
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        candidates.push(parsed);
      }
    } catch {
      // A host without this cgroup version simply falls back to os.totalmem().
    }
  }
  return Math.min(...candidates);
};

const DETECTED_MEMORY_LIMIT_BYTES = detectMemoryLimit();

/**
 * Work-conserving, fair transfer scheduler.
 *
 * This class remains the enforcement point: it owns the global slot budget,
 * rebalances queued work toward under-served flows, lets an otherwise idle
 * flow borrow spare slots, and lowers the budget when the Node process
 * approaches resource limits. Upload and download instantiate it with
 * separate Compose-controlled variable names.
 */
export class AdaptiveTransferScheduler {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly environmentKeys: SchedulerEnvironmentKeys;
  private readonly now: () => number;
  private readonly customResourceSnapshot?: () => ResourceSnapshot;
  private readonly fileSlots = new Map<string, number>();
  private readonly activeFlows = new Map<string, number>();
  private readonly queue: QueueEntry[] = [];
  private activeSlots = 0;
  private targetSlots: number;
  private sequence = 0;
  private lastGrantedFlow = "";
  private lastReevaluationAt = 0;
  private lastCpuUsage = process.cpuUsage();
  private lastCpuSampleAt: number;
  private cpuPressure = 0;
  private eventLoopLagMs = 0;
  private memoryPressure = 0;
  private consecutivePressureSamples = 0;

  constructor(options: AdaptiveTransferSchedulerOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.environmentKeys = {
      ...DEFAULT_ENVIRONMENT_KEYS,
      ...options.environmentKeys,
    };
    this.now = options.now ?? Date.now;
    this.customResourceSnapshot = options.resourceSnapshot;
    this.targetSlots = this.getLimits().maxSlots;
    this.lastCpuSampleAt = this.now();

    if (!this.customResourceSnapshot) {
      const intervalMs = 250;
      let expectedAt = this.now() + intervalMs;
      const timer = setInterval(() => {
        const current = this.now();
        this.eventLoopLagMs = Math.max(0, current - expectedAt);
        expectedAt = current + intervalMs;
      }, intervalMs);
      timer.unref?.();
    }
  }

  registerFlow(flowId: string): void {
    if (!flowId) return;
    this.activeFlows.set(flowId, this.now());
  }

  touchFlow(flowId: string): void {
    this.registerFlow(flowId);
  }

  unregisterFlow(flowId: string): void {
    if (
      (this.fileSlots.get(flowId) ?? 0) === 0 &&
      !this.queue.some((entry) => entry.flowId === flowId)
    ) {
      this.activeFlows.delete(flowId);
    }
  }

  async acquire(
    flowId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    this.touchFlow(flowId);
    const limits = this.refreshBudget();
    if (this.queue.length === 0 && this.canGrant(flowId, limits)) {
      this.grant(flowId);
      return true;
    }
    if (this.queue.length >= limits.queueLimit) return false;

    return new Promise<boolean>((resolve) => {
      const entry: QueueEntry = {
        flowId,
        sequence: ++this.sequence,
        resolve,
        timer: undefined,
        signal,
      };
      entry.timer = setTimeout(() => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        this.cleanupQueueEntry(entry);
        resolve(false);
      }, timeoutMs ?? limits.slotTimeoutMs);
      if (signal) {
        entry.abortListener = () => {
          const index = this.queue.indexOf(entry);
          if (index < 0) return;
          this.queue.splice(index, 1);
          clearTimeout(entry.timer);
          this.cleanupQueueEntry(entry);
          resolve(false);
        };
        signal.addEventListener("abort", entry.abortListener, { once: true });
      }
      this.queue.push(entry);
      this.drainQueue(limits);
    });
  }

  release(flowId: string): void {
    const activeForFlow = this.fileSlots.get(flowId) ?? 0;
    if (activeForFlow < 1 || this.activeSlots < 1) {
      throw new Error(`Transfer slot accounting underflow for ${flowId}`);
    }

    if (activeForFlow === 1) this.fileSlots.delete(flowId);
    else this.fileSlots.set(flowId, activeForFlow - 1);
    this.activeSlots--;
    this.touchFlow(flowId);
    this.drainQueue(this.refreshBudget());
  }

  getAllocation(
    flowId: string,
    options: { allowBorrowing?: boolean } = {},
  ): TransferSchedulerAllocation {
    this.touchFlow(flowId);
    const limits = this.refreshBudget();
    this.drainQueue(limits);
    const flowIds = this.getActiveFlowIds(limits);
    const activeFlowCount = Math.max(1, flowIds.size);
    const fairShare = Math.max(
      1,
      Math.floor(this.targetSlots / activeFlowCount),
    );
    const otherActiveSlots = [...this.fileSlots.entries()].reduce(
      (total, [otherFlowId, slots]) =>
        total + (otherFlowId === flowId ? 0 : slots),
      0,
    );
    const borrowableSlots = Math.max(1, this.targetSlots - otherActiveSlots);
    const recommendedSlots = Math.min(
      limits.maxSlotsPerFlow,
      options.allowBorrowing === false
        ? fairShare
        : Math.max(fairShare, borrowableSlots),
    );

    return {
      recommendedSlots,
      targetSlots: this.targetSlots,
      activeSlots: this.activeSlots,
      activeFlows: activeFlowCount,
      queuedRequests: this.queue.length,
      fairShare,
      memoryPressure: this.memoryPressure,
      cpuPressure: this.cpuPressure,
      eventLoopLagMs: this.eventLoopLagMs,
      pressureSamples: this.consecutivePressureSamples,
    };
  }

  getSnapshot(): Omit<TransferSchedulerAllocation, "recommendedSlots"> {
    const limits = this.refreshBudget();
    const activeFlowCount = Math.max(1, this.getActiveFlowIds(limits).size);
    return {
      targetSlots: this.targetSlots,
      activeSlots: this.activeSlots,
      activeFlows: activeFlowCount,
      queuedRequests: this.queue.length,
      fairShare: Math.max(1, Math.floor(this.targetSlots / activeFlowCount)),
      memoryPressure: this.memoryPressure,
      cpuPressure: this.cpuPressure,
      eventLoopLagMs: this.eventLoopLagMs,
      pressureSamples: this.consecutivePressureSamples,
    };
  }

  private getLimits(): SchedulerLimits {
    const maxSlots = parseInteger(
      this.readEnvironment("maxSlots"),
      DEFAULT_MAX_SLOTS,
      1,
      MAX_PROTOCOL_SLOTS,
    );
    const minSlots = Math.min(
      maxSlots,
      parseInteger(
        this.readEnvironment("minSlots"),
        Math.min(DEFAULT_MIN_SLOTS, maxSlots),
        1,
        MAX_PROTOCOL_SLOTS,
      ),
    );
    return {
      maxSlots,
      minSlots,
      maxSlotsPerFlow: Math.min(
        maxSlots,
        parseInteger(
          this.readEnvironment("maxSlotsPerFlow"),
          maxSlots,
          1,
          MAX_PROTOCOL_SLOTS,
        ),
      ),
      queueLimit: parseInteger(
        this.readEnvironment("queueLimit"),
        DEFAULT_QUEUE_LIMIT,
        maxSlots,
        10_000,
      ),
      slotTimeoutMs: parseInteger(
        this.readEnvironment("slotTimeoutMs"),
        DEFAULT_SLOT_TIMEOUT_MS,
        1_000,
        280_000,
      ),
      activeFlowTtlMs: parseInteger(
        this.readEnvironment("activeFlowTtlMs"),
        DEFAULT_ACTIVE_FLOW_TTL_MS,
        5_000,
        10 * 60_000,
      ),
      reevaluationMs: parseInteger(
        this.readEnvironment("reevaluationMs"),
        DEFAULT_REEVALUATION_MS,
        250,
        60_000,
      ),
      slotMemoryBytes: parseInteger(
        this.readEnvironment("slotMemoryBytes"),
        DEFAULT_SLOT_MEMORY_BYTES,
        8 * 1024 * 1024,
        512 * 1024 * 1024,
      ),
      memorySoftLimit: parseRatio(
        this.readEnvironment("memorySoftLimit"),
        DEFAULT_MEMORY_SOFT_LIMIT,
        0.5,
        0.95,
      ),
      cpuSoftLimit: parseRatio(
        this.readEnvironment("cpuSoftLimit"),
        DEFAULT_CPU_SOFT_LIMIT,
        0.5,
        1,
      ),
      eventLoopLagLimitMs: parseInteger(
        this.readEnvironment("eventLoopLagLimitMs"),
        DEFAULT_EVENT_LOOP_LAG_MS,
        20,
        2_000,
      ),
      pressureSamples: parseInteger(
        this.readEnvironment("pressureSamples"),
        DEFAULT_PRESSURE_SAMPLES,
        1,
        20,
      ),
    };
  }

  private readEnvironment(
    key: keyof SchedulerEnvironmentKeys,
  ): string | undefined {
    return this.environment[this.environmentKeys[key]];
  }

  private refreshBudget(): SchedulerLimits {
    const limits = this.getLimits();
    this.targetSlots = Math.min(this.targetSlots, limits.maxSlots);
    const current = this.now();
    if (
      this.lastReevaluationAt > 0 &&
      current - this.lastReevaluationAt < limits.reevaluationMs
    ) {
      return limits;
    }
    this.lastReevaluationAt = current;

    const resource = this.customResourceSnapshot
      ? this.customResourceSnapshot()
      : this.sampleResources(current);
    this.memoryPressure =
      resource.memoryLimitBytes > 0
        ? resource.rssBytes / resource.memoryLimitBytes
        : 0;
    this.cpuPressure = resource.cpuPressure;
    this.eventLoopLagMs = resource.eventLoopLagMs;

    const memoryCeiling = resource.memoryLimitBytes * limits.memorySoftLimit;
    const memoryHeadroom = Math.max(0, memoryCeiling - resource.rssBytes);
    const additionalMemorySlots = Math.floor(
      memoryHeadroom / limits.slotMemoryBytes,
    );
    let desiredSlots = Math.min(
      limits.maxSlots,
      Math.max(limits.minSlots, this.activeSlots + additionalMemorySlots),
    );

    const overloaded =
      this.memoryPressure >= limits.memorySoftLimit ||
      resource.cpuPressure >= limits.cpuSoftLimit ||
      resource.eventLoopLagMs >= limits.eventLoopLagLimitMs;
    this.consecutivePressureSamples = overloaded
      ? this.consecutivePressureSamples + 1
      : 0;

    // Memory pressure is an immediate, reliable signal. CPU load and event
    // loop lag are deliberately required to persist: one GC pause or the
    // host-wide load of another container must not collapse a healthy
    // transfer window to one lane for the rest of the upload.
    const immediatePressure =
      this.memoryPressure >= limits.memorySoftLimit ||
      resource.eventLoopLagMs >=
        Math.max(1_000, limits.eventLoopLagLimitMs * 8);
    const sustainedPressure =
      this.consecutivePressureSamples >= limits.pressureSamples;
    const severelyOverloaded =
      this.memoryPressure >= Math.min(0.97, limits.memorySoftLimit + 0.12) ||
      resource.eventLoopLagMs >=
        Math.max(2_000, limits.eventLoopLagLimitMs * 16);
    if (immediatePressure || sustainedPressure) {
      const reduction = severelyOverloaded ? 0.5 : 0.75;
      desiredSlots = Math.min(
        desiredSlots,
        Math.max(limits.minSlots, Math.floor(this.targetSlots * reduction)),
      );
    }

    if (desiredSlots < this.targetSlots) {
      this.targetSlots = desiredSlots;
    } else if (desiredSlots > this.targetSlots) {
      // Grow gradually after pressure clears; lowering remains immediate.
      this.targetSlots = Math.min(desiredSlots, this.targetSlots + 1);
    }
    this.targetSlots = Math.min(
      limits.maxSlots,
      Math.max(limits.minSlots, this.targetSlots),
    );
    return limits;
  }

  private sampleResources(current: number): ResourceSnapshot {
    const elapsedMs = Math.max(1, current - this.lastCpuSampleAt);
    const cpu = process.cpuUsage(this.lastCpuUsage);
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuSampleAt = current;
    const cpuCapacity = Math.max(1, availableParallelism());
    const processCpuPressure = Math.min(
      1,
      (cpu.user + cpu.system) / 1_000 / elapsedMs / cpuCapacity,
    );
    return {
      rssBytes: process.memoryUsage.rss(),
      memoryLimitBytes: DETECTED_MEMORY_LIMIT_BYTES,
      // Host loadavg is not container scoped. On a shared pre-production
      // machine it can stay above the container's CPU allowance even while this
      // process is nearly idle, which previously reduced 4 -> 3 -> 2 -> 1.
      // Process CPU plus event-loop lag are the actionable local signals.
      cpuPressure: processCpuPressure,
      eventLoopLagMs: this.eventLoopLagMs,
    };
  }

  private getActiveFlowIds(limits: SchedulerLimits): Set<string> {
    const current = this.now();
    for (const [flowId, lastActivity] of this.activeFlows) {
      const hasDemand =
        (this.fileSlots.get(flowId) ?? 0) > 0 ||
        this.queue.some((entry) => entry.flowId === flowId);
      if (!hasDemand && current - lastActivity > limits.activeFlowTtlMs) {
        this.activeFlows.delete(flowId);
      }
    }
    return new Set([
      ...this.activeFlows.keys(),
      ...this.fileSlots.keys(),
      ...this.queue.map((entry) => entry.flowId),
    ]);
  }

  private canGrant(flowId: string, limits: SchedulerLimits): boolean {
    return (
      this.activeSlots < this.targetSlots &&
      (this.fileSlots.get(flowId) ?? 0) < limits.maxSlotsPerFlow
    );
  }

  private grant(flowId: string): void {
    this.activeSlots++;
    this.fileSlots.set(flowId, (this.fileSlots.get(flowId) ?? 0) + 1);
    this.lastGrantedFlow = flowId;
  }

  private drainQueue(limits: SchedulerLimits): void {
    while (this.activeSlots < this.targetSlots && this.queue.length > 0) {
      const index = this.selectNextQueueEntry(limits);
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      clearTimeout(entry.timer);
      this.cleanupQueueEntry(entry);
      this.grant(entry.flowId);
      entry.resolve(true);
    }
  }

  private selectNextQueueEntry(limits: SchedulerLimits): number {
    const activeFlowCount = Math.max(1, this.getActiveFlowIds(limits).size);
    const fairShare = Math.max(
      1,
      Math.floor(this.targetSlots / activeFlowCount),
    );
    const eligible = this.queue
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          (this.fileSlots.get(entry.flowId) ?? 0) < limits.maxSlotsPerFlow,
      );
    if (eligible.length === 0) return -1;

    const underFairShare = eligible.filter(
      ({ entry }) => (this.fileSlots.get(entry.flowId) ?? 0) < fairShare,
    );
    const candidates = underFairShare.length > 0 ? underFairShare : eligible;
    candidates.sort((left, right) => {
      const leftSlots = this.fileSlots.get(left.entry.flowId) ?? 0;
      const rightSlots = this.fileSlots.get(right.entry.flowId) ?? 0;
      if (leftSlots !== rightSlots) return leftSlots - rightSlots;
      const leftWasLast = left.entry.flowId === this.lastGrantedFlow ? 1 : 0;
      const rightWasLast = right.entry.flowId === this.lastGrantedFlow ? 1 : 0;
      if (leftWasLast !== rightWasLast) return leftWasLast - rightWasLast;
      return left.entry.sequence - right.entry.sequence;
    });
    return candidates[0].index;
  }

  private cleanupQueueEntry(entry: QueueEntry): void {
    if (entry.signal && entry.abortListener) {
      entry.signal.removeEventListener("abort", entry.abortListener);
    }
  }
}
