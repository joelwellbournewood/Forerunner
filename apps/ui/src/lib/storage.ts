/**
 * Per-install browser storage. Keys are namespaced by the install id the shell injects (or
 * "local" in the dev server) so two installs sharing a webview profile do not share state.
 * Every access is wrapped: storage can be missing or throw in private windows and tests.
 */

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function storageKey(installId: string | null, name: string): string {
  return `forerunner.ui.${installId ?? "local"}.${name}`;
}

export function browserStorage(backend?: Storage | null): KeyValueStore {
  const resolve = (): Storage | null => {
    if (backend !== undefined) return backend;
    try {
      return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      try {
        return resolve()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        resolve()?.setItem(key, value);
      } catch {
        // storage unavailable: state stays in memory for this page load
      }
    },
    remove(key) {
      try {
        resolve()?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

export function memoryStorage(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}
