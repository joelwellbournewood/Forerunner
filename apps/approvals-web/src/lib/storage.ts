/**
 * Per-tab storage for the session (ADR 0009: a web device holds nothing but its session
 * token and its own key; this page keeps both in `sessionStorage`, never in cookies or
 * `localStorage`, so closing the tab ends the session). Every access is wrapped: private
 * windows and blocked site data throw, and the page must still render.
 */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export function memoryStore(): KeyValueStore {
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

/** `window.sessionStorage` behind try/catch, with an in-memory fallback when it is unusable. */
export function sessionStore(): KeyValueStore {
  const fallback = memoryStore();
  let backing: Storage | null = null;
  try {
    backing = typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    backing = null;
  }
  return {
    get(key) {
      try {
        return backing ? backing.getItem(key) : fallback.get(key);
      } catch {
        return fallback.get(key);
      }
    },
    set(key, value) {
      try {
        if (backing) {
          backing.setItem(key, value);
          return;
        }
      } catch {
        // quota or blocked storage: keep the value for this page load only
      }
      fallback.set(key, value);
    },
    remove(key) {
      try {
        backing?.removeItem(key);
      } catch {
        // nothing to remove when storage is blocked
      }
      fallback.remove(key);
    },
  };
}
