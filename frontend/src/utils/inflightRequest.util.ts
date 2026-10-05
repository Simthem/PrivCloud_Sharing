/** Coalesce simultaneous reads only. Neither successes nor errors are cached. */
export function createInflightRequest<T>() {
  const pending = new Map<string, Promise<T>>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    const request = Promise.resolve()
      .then(read)
      .finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
