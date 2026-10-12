type Entry<T> = { value: T; bytes: number; lastUsed: number; pins: number };

export function createBoundedLru<T>(maxEntries: number, maxBytes: number, idleMs: number, now = Date.now) {
  const entries = new Map<string, Entry<T>>();
  let bytes = 0;
  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    bytes -= entry.bytes;
    entries.delete(key);
  }
  function trim(protectedKey?: string) {
    const time = now();
    for (const [key, entry] of entries) if (entry.pins === 0 && time - entry.lastUsed >= idleMs) remove(key);
    while (entries.size > maxEntries || bytes > maxBytes) {
      const candidate = [...entries].find(([key, entry]) => key !== protectedKey && entry.pins === 0);
      if (!candidate) return false;
      remove(candidate[0]);
    }
    return true;
  }
  return {
    acquire(key: string) {
      trim();
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entry.pins++;
      entry.lastUsed = now();
      entries.set(key, entry);
      return { value: entry.value, release() { entry.pins--; entry.lastUsed = now(); } };
    },
    set(key: string, value: T, size: number) {
      if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes || (entries.get(key)?.pins ?? 0) > 0) return false;
      remove(key);
      entries.set(key, { value, bytes: size, lastUsed: now(), pins: 0 });
      bytes += size;
      if (trim(key)) return true;
      remove(key);
      return false;
    },
    updateSize(key: string, size: number) {
      const entry = entries.get(key);
      if (!entry || !Number.isSafeInteger(size) || size < 0 || size > maxBytes) return false;
      const old = entry.bytes;
      entry.bytes = size;
      bytes += size - old;
      if (trim(key)) return true;
      bytes += old - entry.bytes;
      entry.bytes = old;
      return false;
    },
    stats() { trim(); return { entries: entries.size, bytes }; },
  };
}
