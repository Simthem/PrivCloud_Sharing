/** Bounded, session-only bytes. A cancelled reader never cancels another one. */
type Bytes = Uint8Array<ArrayBuffer>;
type Entry = {
  id: string;
  abort: AbortController;
  promise: Promise<Bytes>;
  load: (_signal: AbortSignal) => Promise<Bytes>;
  resolve: (_bytes: Bytes) => void;
  reject: (_error: unknown) => void;
  users: number;
  bytes?: Bytes;
};

export function createPreviewReadCache(
  maxBytes: number,
  concurrency: number,
  lifetime?: AbortSignal,
) {
  const entries = new Map<string, Entry>();
  const queue: Entry[] = [];
  let retained = 0;
  let active = 0;
  const remove = (entry: Entry) => {
    if (entries.get(entry.id) !== entry) return;
    entries.delete(entry.id);
    retained -= entry.bytes?.byteLength ?? 0;
  };
  const pump = () => {
    while (active < concurrency && queue.length) {
      const entry = queue.shift()!;
      if (entry.abort.signal.aborted) {
        entry.reject(entry.abort.signal.reason);
        continue;
      }
      active++;
      entry
        .load(entry.abort.signal)
        .then(
          (bytes) => {
            if (
              entries.get(entry.id) === entry &&
              !entry.abort.signal.aborted
            ) {
              entry.bytes = bytes;
              retained += bytes.byteLength;
              // Pending reads do not count as retained bytes and stay shared.
              for (const oldest of entries.values()) {
                if (retained <= maxBytes) break;
                if (oldest.bytes) remove(oldest);
              }
            }
            entry.resolve(bytes);
          },
          (error) => {
            remove(entry);
            entry.reject(error);
          },
        )
        .finally(() => {
          active--;
          pump();
        });
    }
  };
  lifetime?.addEventListener(
    "abort",
    () => {
      for (const entry of entries.values()) entry.abort.abort(lifetime.reason);
      entries.clear();
      retained = 0;
      pump();
    },
    { once: true },
  );

  return {
    read(
      id: string,
      load: Entry["load"],
      signal?: AbortSignal,
    ): Promise<Bytes> {
      lifetime?.throwIfAborted();
      signal?.throwIfAborted();
      let entry = entries.get(id);
      if (entry) {
        entries.delete(id);
        entries.set(id, entry);
      } else {
        let resolve!: Entry["resolve"];
        let reject!: Entry["reject"];
        const promise = new Promise<Bytes>((ok, failed) => {
          resolve = ok;
          reject = failed;
        });
        entry = {
          id,
          load,
          promise,
          resolve,
          reject,
          abort: new AbortController(),
          users: 0,
        };
        entries.set(id, entry);
        queue.push(entry);
        queueMicrotask(pump);
      }
      const shared = entry;
      shared.users++;
      return new Promise<Bytes>((resolve, reject) => {
        let finished = false;
        const finish = (error?: unknown, bytes?: Bytes) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", abort);
          shared.users--;
          if (!shared.users && !shared.bytes) {
            remove(shared);
            shared.abort.abort();
          }
          if (error !== undefined) reject(error);
          else resolve(bytes!);
        };
        const abort = () => finish(signal!.reason);
        signal?.addEventListener("abort", abort, { once: true });
        shared.promise.then(
          (bytes) => finish(undefined, bytes),
          (error) => finish(error),
        );
      });
    },
  };
}
