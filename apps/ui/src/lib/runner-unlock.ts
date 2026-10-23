import type { RunnerUnlockAnswerView } from "@forerunner/runtime/daemon/api-types";
import {
  AUTO_UNLOCK_SETTING,
  autoUnlockWindowEnd,
  decodeStoredKey,
  parseUnlockChallenge,
  runnerKeySecureStoreKey,
  shouldAutoAnswer,
  type UnlockAnswer,
  type UnlockChallengeCard,
  wrapVaultKey,
} from "@forerunner/vault/runner-unlock";
import type { DaemonClient } from "../api/client.ts";
import { type KeyValueStore, storageKey } from "./storage.ts";

export {
  AUTO_UNLOCK_WINDOW_HOURS,
  parseUnlockChallenge,
  type UnlockAnswer,
  type UnlockChallengeCard,
} from "@forerunner/vault/runner-unlock";

/**
 * The inbox's side of the cloud runner unlock (spec S.12, ADR 0033, ADR 0068). A runner start
 * files a blocking `credential` request whose change card is the challenge; the unlock card
 * answers it with the runner's vault key wrapped to the challenge, or "deny".
 *
 * The bridge contract: a `RunnerKeyBridge` holds or reaches the vault key and returns only the
 * wrapped answer. The UI never keeps the key: on the desktop the daemon (which holds the OS
 * keyring) wraps it and the key never enters the web view; on Android the key comes out of the
 * Keystore-wrapped secure store for the one call, is wrapped with WebCrypto and zeroed; a page
 * without a keyring (the browser fallback) has the `none` bridge and shows the card read-only.
 */

export type RunnerKeyStatus =
  | { available: true; backend: string }
  | { available: false; backend: string; reason: string };

export interface WrapRequest {
  /**
   * The unlock request the challenge came on. The desktop daemon reads the challenge from its
   * own store by this id and never wraps to a card the page sends.
   */
  requestId: string;
  /** The device's idea of now (ms): an expired challenge is refused before the key is read. */
  now: number;
  /** Set (ISO) or clear (null) the human's auto-unlock window; omitted leaves it as it is. */
  autoUnlockUntil?: string | null;
}

export interface RunnerKeyBridge {
  readonly kind: "daemon" | "keystore" | "none" | "test";
  status(runnerId: string): Promise<RunnerKeyStatus>;
  wrap(card: UnlockChallengeCard, request: WrapRequest): Promise<UnlockAnswer>;
}

const wrapOptions = (r: WrapRequest) => ({
  now: r.now,
  ...(r.autoUnlockUntil !== undefined ? { autoUnlockUntil: r.autoUnlockUntil } : {}),
});

/**
 * A bridge over a key holder that hands the key out for one call: the bytes are wrapped and
 * zeroed in `finally`, so the clear key lives in the web layer only for the call.
 */
export function keyHolderBridge(holder: {
  kind: RunnerKeyBridge["kind"];
  backend: string;
  /** The 32 key bytes, or null when this device does not hold the runner's key. */
  key(runnerId: string): Promise<Uint8Array | null>;
  missingReason(runnerId: string): string;
}): RunnerKeyBridge {
  return {
    kind: holder.kind,
    async status(runnerId) {
      let key: Uint8Array | null = null;
      try {
        key = await holder.key(runnerId);
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        return {
          available: false,
          backend: holder.backend,
          reason: `The keystore refused: ${why}`,
        };
      }
      const available = key !== null;
      key?.fill(0);
      return available
        ? { available: true, backend: holder.backend }
        : { available: false, backend: holder.backend, reason: holder.missingReason(runnerId) };
    },
    async wrap(card, request) {
      if (Date.parse(card.expiresAt) <= request.now) {
        throw new Error("The unlock challenge has expired; the runner files a fresh one.");
      }
      const key = await holder.key(card.runnerId);
      if (!key) throw new Error(holder.missingReason(card.runnerId));
      try {
        return await wrapVaultKey(card, key, wrapOptions(request));
      } finally {
        key.fill(0);
      }
    },
  };
}

/** Android: the key lives in the shell's Keystore-wrapped secure store (ADR 0032). */
export function secureStoreRunnerKeys(store: {
  get(key: string): Promise<string | null>;
}): RunnerKeyBridge {
  return keyHolderBridge({
    kind: "keystore",
    backend: "android-keystore",
    key: async (runnerId) => decodeStoredKey(await store.get(runnerKeySecureStoreKey(runnerId))),
    missingReason: (runnerId) =>
      `This phone holds no vault key for runner "${runnerId}". Answer from the desktop app, or store the key on this phone first.`,
  });
}

/** Desktop: the daemon holds the OS keyring and wraps the key itself (ADR 0068). */
export function daemonRunnerKeys(
  client: Pick<DaemonClient, "runnerKeyStatus" | "wrapRunnerKey">,
): RunnerKeyBridge {
  return {
    kind: "daemon",
    async status(runnerId) {
      const s = await client.runnerKeyStatus(runnerId);
      return s.available
        ? { available: true, backend: s.backend }
        : {
            available: false,
            backend: s.backend,
            reason: s.reason ?? "This computer cannot answer the unlock.",
          };
    },
    async wrap(_card, request): Promise<RunnerUnlockAnswerView> {
      return client.wrapRunnerKey({
        requestId: request.requestId,
        ...(request.autoUnlockUntil !== undefined
          ? { autoUnlockUntil: request.autoUnlockUntil }
          : {}),
      });
    },
  };
}

/** A shell without a keyring: the card is read-only with this reason. */
export function noKeyringBridge(reason: string): RunnerKeyBridge {
  return {
    kind: "none",
    async status() {
      return { available: false, backend: "none", reason };
    },
    async wrap() {
      throw new Error(reason);
    },
  };
}

export const NO_KEYRING_REASON =
  "This browser has no OS keyring to hold the runner's vault key: answer from the desktop app or the Android app.";

// ---------------------------------------------------------------------------------------------
// The choices on the card and the device's window record

export type UnlockChoice =
  | { kind: "once" }
  | { kind: "window"; hours: number }
  | { kind: "clear" }
  | { kind: "deny" };

export interface PreparedAnswer {
  /** What goes to the request: the wrapped answer, or "deny". */
  value: UnlockAnswer | "deny";
  /** The window this answer sets (ISO), clears (null), or leaves (undefined). */
  window: string | null | undefined;
}

/** Turn a choice into the request's answer; only deny skips the bridge. */
export async function prepareAnswer(
  bridge: RunnerKeyBridge,
  requestId: string,
  card: UnlockChallengeCard,
  choice: UnlockChoice,
  now: number,
): Promise<PreparedAnswer> {
  if (choice.kind === "deny") return { value: "deny", window: undefined };
  const window =
    choice.kind === "window"
      ? autoUnlockWindowEnd(choice.hours, now)
      : choice.kind === "clear"
        ? null
        : undefined;
  const value = await bridge.wrap(card, {
    requestId,
    now,
    ...(window !== undefined ? { autoUnlockUntil: window } : {}),
  });
  return { value, window };
}

/**
 * The window this device set with an answer, kept on the device: the device auto-answers only
 * inside a window it set itself (the runner keeps the human's copy in `notify_prefs`).
 */
export interface UnlockWindowStore {
  get(): string | null;
  set(until: string | null): void;
  /**
   * Called after every `set` through any store on the same storage key, so the inbox card
   * (which sets the window) and the app-level auto-answer (which reads it) agree at once.
   */
  subscribe(listener: () => void): () => void;
}

const windowListeners = new Map<string, Set<() => void>>();

export function unlockWindowStore(storage: KeyValueStore, key: string): UnlockWindowStore {
  return {
    get: () => storage.get(key),
    set: (until) => {
      if (until) storage.set(key, until);
      else storage.remove(key);
      for (const listener of [...(windowListeners.get(key) ?? [])]) listener();
    },
    subscribe: (listener) => {
      let set = windowListeners.get(key);
      if (!set) {
        set = new Set();
        windowListeners.set(key, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) windowListeners.delete(key);
      };
    },
  };
}

/** The desktop's window record for this human (ADR 0068): browser storage by default. */
export function desktopUnlockWindowStore(
  storage: KeyValueStore,
  humanId: string,
): UnlockWindowStore {
  return unlockWindowStore(storage, storageKey(null, `runnerUnlockWindow.${humanId}`));
}

/** The window rule of the protocol over the device's record. */
export function windowOpen(until: string | null, now: number): boolean {
  return shouldAutoAnswer({ [AUTO_UNLOCK_SETTING]: { auto_unlock_until: until } }, now);
}

/** The challenge on a request, when the request is an unlock. */
export function unlockChallengeOf(request: {
  kind: string;
  changeCard?: unknown;
}): UnlockChallengeCard | null {
  return request.kind === "credential" ? parseUnlockChallenge(request.changeCard) : null;
}

/** "4 min", "2 h 5 min": a short duration for the challenge's age and its time left. */
export function shortDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}
