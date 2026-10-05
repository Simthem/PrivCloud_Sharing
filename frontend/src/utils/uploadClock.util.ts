type ClockEntry = {
  deadline: number;
  callback: () => void;
  fallback: ReturnType<typeof setTimeout>;
};

const entries = new Map<number, ClockEntry>();
let nextId = 0;
let clock: Worker | null = null;

function closeIdleClock() {
  if (entries.size === 0 && clock) {
    clock.terminate();
    clock = null;
  }
}

function finish(id: number) {
  const entry = entries.get(id);
  if (!entry) return;
  if (Date.now() < entry.deadline) {
    clearTimeout(entry.fallback);
    entry.fallback = setTimeout(() => finish(id), entry.deadline - Date.now());
    clock?.postMessage({ type: "schedule", id, deadline: entry.deadline });
    return;
  }
  entries.delete(id);
  clearTimeout(entry.fallback);
  clock?.postMessage({ type: "cancel", id });
  try {
    entry.callback();
  } finally {
    closeIdleClock();
  }
}

function getClock(): Worker | null {
  if (clock) return clock;
  try {
    const worker = new Worker("/upload-clock-worker.js");
    worker.addEventListener("message", (event: MessageEvent<unknown>) => {
      // Dedicated worker messages use an empty origin and no Window source.
      // Bind replies to this live worker and reject synthetic dispatchEvent calls.
      if (
        event.origin !== "" ||
        event.isTrusted !== true ||
        event.currentTarget !== worker ||
        clock !== worker ||
        event.source !== null ||
        event.ports.length !== 0
      )
        return;
      const data = event.data;
      if (
        data === null ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        Reflect.ownKeys(data).length !== 2 ||
        !Object.prototype.hasOwnProperty.call(data, "type") ||
        !Object.prototype.hasOwnProperty.call(data, "id")
      )
        return;
      const reply = data as { type: unknown; id: unknown };
      if (
        reply.type !== "elapsed" ||
        typeof reply.id !== "number" ||
        !Number.isSafeInteger(reply.id) ||
        reply.id <= 0 ||
        !entries.has(reply.id)
      )
        return;
      finish(reply.id);
    });
    worker.addEventListener("error", () => {
      worker.terminate();
      if (clock === worker) clock = null;
    });
    clock = worker;
    return worker;
  } catch {
    return null;
  }
}

/** Keep upload deadlines independent of timers aligned in a hidden document. */
export function scheduleUploadTimeout(
  callback: () => void,
  delayMs: number,
): () => void {
  const delay = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
  if (typeof Worker === "undefined") {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  }
  const id = ++nextId;
  const deadline = Date.now() + delay;
  const fallback = setTimeout(() => finish(id), delay);
  entries.set(id, { deadline, callback, fallback });
  getClock()?.postMessage({ type: "schedule", id, deadline });
  return () => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    clearTimeout(entry.fallback);
    clock?.postMessage({ type: "cancel", id });
    closeIdleClock();
  };
}

export function scheduleUploadInterval(
  callback: () => void,
  intervalMs: number,
): () => void {
  if (typeof Worker === "undefined") {
    const interval = setInterval(callback, intervalMs);
    return () => clearInterval(interval);
  }
  let stopped = false;
  let cancel: () => void;
  const next = () => {
    cancel = scheduleUploadTimeout(
      () => {
        if (stopped) return;
        // Rearm before callback execution so cancellation also stops this tick.
        next();
        callback();
      },
      Math.max(1, intervalMs),
    );
  };
  next();
  return () => {
    stopped = true;
    cancel();
  };
}
