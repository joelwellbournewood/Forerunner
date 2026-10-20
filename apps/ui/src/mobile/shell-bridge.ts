import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  type BiometricAssertion,
  type BiometricPort,
  BiometricTicketError,
  type DeviceSigner,
  fromBase64,
  needsBiometricTicket,
  type SignOptions,
  toBase64,
  utf8,
} from "../api/state-signing.ts";
import type { PushPort, PushStatus } from "./push.ts";
import type { SecureStore } from "./storage.ts";

/**
 * The Android shell's commands (apps/mobile/src-tauri, ADR 0032) as seen from the UI. Each
 * wrapper is a thin `invoke`; the shell owns the device key (generated inside the app's
 * Keystore-wrapped store, never exported), the secure store for the session token, the
 * biometric prompt (tauri-plugin-biometric) and the push status. When the page runs outside
 * the shell (`inTauriShell()` false) the mobile env falls back to WebCrypto and browser
 * storage; nothing here is called then.
 */
export function inTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface ShellInfo {
  platform: string;
  version: string;
  deviceName: string;
  stateUrl: string | null;
  /** "keystore" on Android (AES-GCM key in the Android Keystore wraps the files), "file" elsewhere. */
  secureStore: "keystore" | "file";
  biometric: boolean;
  installId: string;
  /** A device key and a session token survived the restart (the shell's `config::recover`). */
  paired: boolean;
}

export async function shellInfo(): Promise<ShellInfo> {
  return invoke<ShellInfo>("shell_info");
}

/**
 * Signs with the key the shell keeps; the UI only ever sees the public key and signatures.
 * A `biometric=1` string goes to the shell with the ticket of the prompt that just ran; the
 * shell refuses any other (`biometric ticket ...`), and so does this wrapper before the IPC
 * when no ticket is at hand, so a fabricated assertion never reaches the key.
 */
export class ShellSigner implements DeviceSigner {
  readonly kind = "shell" as const;
  async publicKey(): Promise<string> {
    const r = await invoke<{ publicKey: string }>("device_key_public");
    return r.publicKey;
  }
  async sign(message: Uint8Array, options?: SignOptions): Promise<string> {
    const ticket = options?.biometric?.ticket?.trim() || null;
    if (needsBiometricTicket(message) && !ticket) {
      throw new BiometricTicketError(
        "a biometric=1 signature needs the one-time ticket of the shell's prompt",
      );
    }
    try {
      const r = await invoke<{ signature: string }>("device_key_sign", {
        message: toBase64(message),
        ticket,
      });
      return r.signature;
    } catch (error) {
      const text =
        typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
      if (/^biometric ticket/i.test(text)) throw new BiometricTicketError(text);
      throw error instanceof Error ? error : new Error(text);
    }
  }
  async forget(): Promise<void> {
    await invoke("device_key_forget");
  }
}

export const shellSecureStore: SecureStore = {
  kind: "shell",
  async get(key) {
    const r = await invoke<{ value: string | null }>("secure_store_get", { key });
    return r.value;
  },
  async set(key, value) {
    await invoke("secure_store_set", { key, value });
  },
  async remove(key) {
    await invoke("secure_store_delete", { key });
  },
};

interface BiometricResult {
  asserted: boolean;
  at: string;
  method: string;
  reason?: string;
  /** The one-time ticket the shell issued; present only with `asserted: true`. */
  ticket?: string | null;
}

/**
 * The platform prompt; `asserted` is true only when Android's BiometricPrompt succeeded,
 * and the assertion carries the shell's ticket (without one the shell would refuse to sign
 * anyway, so the outcome counts as not asserted).
 */
export const shellBiometric: BiometricPort = {
  async available() {
    try {
      const info = await shellInfo();
      return info.biometric;
    } catch {
      return false;
    }
  },
  async assert(reason): Promise<BiometricAssertion | null> {
    try {
      const r = await invoke<BiometricResult>("assert_biometric", { reason });
      if (!r.asserted || !r.ticket) return null;
      return { asserted: true, at: r.at, method: r.method, ticket: r.ticket };
    } catch {
      return null;
    }
  },
};

export const shellPush: PushPort = {
  async status(): Promise<PushStatus> {
    return invoke<PushStatus>("push_status");
  },
  notify() {
    // Platform notifications arrive through the shell when a push channel exists; the
    // polling stand-in in push.ts renders in-app notices.
    return false;
  },
};

/** QR scan through tauri-plugin-barcode-scanner; null when the plugin is missing or denied. */
export async function scanQr(): Promise<string | null> {
  try {
    const perm = await invoke<{ camera: string }>("plugin:barcode-scanner|check_permissions");
    if (perm.camera !== "granted") {
      const asked = await invoke<{ camera: string }>("plugin:barcode-scanner|request_permissions");
      if (asked.camera !== "granted") return null;
    }
    const r = await invoke<{ content: string; format: string }>("plugin:barcode-scanner|scan", {
      formats: ["QR_CODE"],
      windowed: false,
    });
    return r.content ?? null;
  } catch {
    return null;
  }
}

/** The `fr://` link the app was opened with (tauri-plugin-deep-link), and later ones. */
export const shellDeepLink = {
  async current(): Promise<string | null> {
    try {
      const urls = await invoke<string[] | null>("plugin:deep-link|get_current");
      return urls?.[0] ?? null;
    } catch {
      return null;
    }
  },
  listen(callback: (url: string) => void): () => void {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<string[]>("deep-link://new-url", (event) => {
      const first = event.payload?.[0];
      if (active && first) callback(first);
    })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  },
};

/** Bytes of a shell-signed message, for callers that hold base64 (tests). */
export function messageBytes(text: string): Uint8Array {
  return utf8(text);
}

export { fromBase64 };
