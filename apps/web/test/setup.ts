/**
 * Node 26 exposes experimental Web Storage globals, and Vitest's jsdom
 * environment currently leaves both `window.localStorage` and
 * `window.sessionStorage` undefined. Install a tiny in-memory implementation
 * on both `window` and `globalThis`, matching what the browser code expects.
 */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

if (typeof window !== 'undefined') {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  for (const [name, storage] of [
    ['localStorage', local],
    ['sessionStorage', session],
  ] as const) {
    Object.defineProperty(window, name, {
      value: storage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, name, {
      value: storage,
      configurable: true,
      writable: true,
    });
  }
}
