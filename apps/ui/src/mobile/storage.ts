/**
 * Where the phone keeps state (spec R.7: no secrets or private memory on the phone beyond
 * its own key and a scoped session token). Two ports:
 *
 * - `MobileStorage`: non-secret conveniences (service URL, device name, the local change
 *   log, the offline outbox, the SHA-256 fingerprint of the registered push token, never the
 *   token) in `localStorage`, namespaced per install, every access wrapped.
 * - `SecureStore`: the session token. The Android shell keeps it under a key the Android
 *   Keystore wraps (`secure_store_*` commands); outside the shell the fallback is browser
 *   storage and the Settings screen says so ("insecure fallback").
 */
import { browserStorage, type KeyValueStore } from "../lib/storage.ts";

export type MobileStorage = KeyValueStore;

export interface SecureStore {
  readonly kind: "shell" | "browser" | "memory";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export function mobileKey(installId: string | null, name: string): string {
  return `forerunner.mobile.${installId ?? "local"}.${name}`;
}

export function mobileStorage(backend?: Storage | null): MobileStorage {
  return browserStorage(backend);
}

/** Browser-storage fallback: works, but the token is only as safe as the WebView profile. */
export function browserSecureStore(backend?: Storage | null): SecureStore {
  const kv = browserStorage(backend);
  return {
    kind: "browser",
    get: async (key) => kv.get(`forerunner.mobile.secure.${key}`),
    set: async (key, value) => kv.set(`forerunner.mobile.secure.${key}`, value),
    remove: async (key) => kv.remove(`forerunner.mobile.secure.${key}`),
  };
}

export function memorySecureStore(): SecureStore {
  const map = new Map<string, string>();
  return {
    kind: "memory",
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
  };
}

/** Read a JSON value, or `fallback` when missing or malformed. */
export function readJson<T>(storage: MobileStorage, key: string, fallback: T): T {
  const raw = storage.get(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(storage: MobileStorage, key: string, value: unknown): void {
  storage.set(key, JSON.stringify(value));
}
