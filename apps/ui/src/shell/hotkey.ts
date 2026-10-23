import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createContext, useContext, useMemo } from "react";
import type { DaemonConfig } from "../api/config.ts";
import { useUiState } from "../store/context.tsx";

/**
 * The global hotkey as the UI sees it (spec O.1, ADR 0064). The desktop shell
 * (apps/desktop/src-tauri/src/hotkey.rs) registers the chord with the OS; on a press it shows
 * and focuses the window and emits `forerunner://hotkey`, which the shell component turns into
 * "open the conversation and start a push-to-talk turn". Settings shows the chord and changes
 * it through `invoke("hotkey_set")`. The grammar below is the shell's, case for case: both run
 * `test/hotkey-chords.json`.
 */

export const DEFAULT_CHORD = "CommandOrControl+Shift+Space";
export const PRESS_EVENT = "forerunner://hotkey";
export const CHANGED_EVENT = "forerunner://hotkey-changed";

const MODIFIERS = ["CommandOrControl", "Control", "Alt", "Shift", "Super"] as const;
export type Modifier = (typeof MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, Modifier> = {
  commandorcontrol: "CommandOrControl",
  commandorctrl: "CommandOrControl",
  cmdorctrl: "CommandOrControl",
  cmdorcontrol: "CommandOrControl",
  mod: "CommandOrControl",
  control: "Control",
  ctrl: "Control",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  super: "Super",
  command: "Super",
  cmd: "Super",
  meta: "Super",
  win: "Super",
};

/** Canonical name and the lower-case spellings accepted for it (the shell's `NAMED_KEYS`). */
export const NAMED_KEYS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Space", ["space"]],
  ["Enter", ["enter", "return"]],
  ["Tab", ["tab"]],
  ["Escape", ["escape", "esc"]],
  ["Backspace", ["backspace"]],
  ["Delete", ["delete", "del"]],
  ["Insert", ["insert", "ins"]],
  ["Home", ["home"]],
  ["End", ["end"]],
  ["PageUp", ["pageup"]],
  ["PageDown", ["pagedown"]],
  ["ArrowUp", ["arrowup", "up"]],
  ["ArrowDown", ["arrowdown", "down"]],
  ["ArrowLeft", ["arrowleft", "left"]],
  ["ArrowRight", ["arrowright", "right"]],
  ["Minus", ["minus"]],
  ["Equal", ["equal"]],
  ["BracketLeft", ["bracketleft"]],
  ["BracketRight", ["bracketright"]],
  ["Backslash", ["backslash"]],
  ["Semicolon", ["semicolon"]],
  ["Quote", ["quote"]],
  ["Comma", ["comma"]],
  ["Period", ["period"]],
  ["Slash", ["slash"]],
  ["Backquote", ["backquote"]],
  ["PrintScreen", ["printscreen"]],
  ["Pause", ["pause"]],
  ["ScrollLock", ["scrolllock"]],
];

export type ChordErrorKind =
  | "empty"
  | "empty-token"
  | "unknown-token"
  | "no-key"
  | "key-not-last"
  | "too-many-keys"
  | "repeated-modifier"
  | "conflicting-modifiers"
  | "needs-modifier";

export type ChordResult =
  | { ok: true; canonical: string; modifiers: Modifier[]; key: string }
  | { ok: false; reason: ChordErrorKind; message: string };

function functionKeyNumber(lower: string): number | null {
  const m = /^f([1-9][0-9]?)$/.exec(lower);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 24 ? n : null;
}

function parseKey(lower: string): string | null {
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  let m = /^key([a-z])$/.exec(lower);
  if (m?.[1]) return m[1].toUpperCase();
  m = /^digit([0-9])$/.exec(lower);
  if (m?.[1]) return m[1];
  m = /^numpad([0-9])$/.exec(lower);
  if (m?.[1]) return `Numpad${m[1]}`;
  const f = functionKeyNumber(lower);
  if (f !== null) return `F${f}`;
  for (const [name, aliases] of NAMED_KEYS) if (aliases.includes(lower)) return name;
  return null;
}

const fail = (reason: ChordErrorKind, message: string): ChordResult => ({
  ok: false,
  reason,
  message,
});

/** Parse and validate a chord exactly as the desktop shell does (first bad token wins). */
export function parseChord(text: string): ChordResult {
  const trimmed = text.trim();
  if (trimmed === "") return fail("empty", "the shortcut is empty");
  const modifiers: Modifier[] = [];
  let key: string | null = null;
  for (const raw of trimmed.split("+")) {
    const token = raw.trim();
    if (token === "")
      return fail("empty-token", 'the shortcut has an empty part ("++" or a + at an end)');
    const lower = token.toLowerCase();
    const modifier = Object.hasOwn(MODIFIER_ALIASES, lower) ? MODIFIER_ALIASES[lower] : undefined;
    if (modifier) {
      if (key !== null)
        return fail("key-not-last", `the key must come last; "${token}" follows it`);
      if (modifiers.includes(modifier))
        return fail("repeated-modifier", `the modifier "${token}" appears twice`);
      modifiers.push(modifier);
      continue;
    }
    const k = parseKey(lower);
    if (k === null)
      return fail("unknown-token", `"${token}" is not a key or modifier this shell knows`);
    if (key !== null)
      return fail("too-many-keys", `only one key is allowed; "${token}" is a second one`);
    key = k;
  }
  if (key === null) return fail("no-key", "the shortcut has modifiers but no key");
  if (
    modifiers.includes("CommandOrControl") &&
    (modifiers.includes("Control") || modifiers.includes("Super"))
  ) {
    return fail(
      "conflicting-modifiers",
      "CommandOrControl already means Control (Windows, Linux) or Command (macOS); do not combine it with Control or Super",
    );
  }
  const strong = modifiers.some((m) => m !== "Shift");
  if (!strong && functionKeyNumber(key.toLowerCase()) === null) {
    return fail(
      "needs-modifier",
      "the shortcut needs a modifier other than Shift (Ctrl, Alt or Super), or a function key",
    );
  }
  modifiers.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));
  return { ok: true, canonical: [...modifiers, key].join("+"), modifiers, key };
}

/** How a canonical chord reads on this platform: Ctrl on Windows and Linux, Win/Super keys. */
export function formatChord(chord: string, platform: string | null = null): string {
  const mac = (platform ?? "").toLowerCase() === "macos";
  const win = (platform ?? "").toLowerCase() === "windows";
  return chord
    .split("+")
    .map((part) => {
      if (part === "CommandOrControl") return mac ? "Cmd" : "Ctrl";
      if (part === "Control") return "Ctrl";
      if (part === "Super") return mac ? "Cmd" : win ? "Win" : "Super";
      return part;
    })
    .join("+");
}

/** What `hotkey_status` / `hotkey_set` answer and `forerunner://hotkey-changed` carries. */
export interface HotkeyStatus {
  chord: string;
  defaultChord: string;
  registered: boolean;
  error: string | null;
}

export interface HotkeyPress {
  chord: string;
  state: "pressed" | "released";
}

/**
 * The shell side of the hotkey. `available` is false outside the desktop shell (a browser,
 * the approvals page, the Android app): Settings then says "unavailable" and why.
 */
export interface HotkeyBridge {
  available: boolean;
  /** Why the hotkey is unavailable; null when available. */
  unavailableReason: string | null;
  status(): Promise<HotkeyStatus>;
  /** Rejects with the shell's message when the grammar or the OS refuses the chord. */
  set(chord: string): Promise<HotkeyStatus>;
  onPress(callback: (press: HotkeyPress) => void): () => void;
  onChanged(callback: (status: HotkeyStatus) => void): () => void;
}

export function unavailableHotkeyBridge(reason: string): HotkeyBridge {
  const refuse = () => Promise.reject(new Error(reason));
  return {
    available: false,
    unavailableReason: reason,
    status: refuse,
    set: refuse,
    onPress: () => () => {},
    onChanged: () => () => {},
  };
}

function subscribe<T>(event: string, callback: (payload: T) => void): () => void {
  let active = true;
  let unlisten: (() => void) | null = null;
  void listen<T>(event, (e) => {
    if (active) callback(e.payload);
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
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}

/** The Tauri desktop shell's commands and events. */
export function desktopHotkeyBridge(): HotkeyBridge {
  return {
    available: true,
    unavailableReason: null,
    status: () => invoke<HotkeyStatus>("hotkey_status"),
    set: async (chord) => {
      try {
        return await invoke<HotkeyStatus>("hotkey_set", { chord });
      } catch (error) {
        throw new Error(errorText(error));
      }
    },
    onPress: (callback) => subscribe<HotkeyPress>(PRESS_EVENT, callback),
    onChanged: (callback) => subscribe<HotkeyStatus>(CHANGED_EVENT, callback),
  };
}

const DESKTOP_PLATFORMS = new Set(["windows", "linux", "macos"]);

/**
 * Which bridge this page gets: the desktop one only inside the Tauri shell on a desktop
 * platform. `inTauri` is a parameter so every branch is tested without globals.
 */
export function hotkeyBridgeFor(config: Pick<DaemonConfig, "platform">, inTauri: boolean) {
  const platform = (config.platform ?? "").trim().toLowerCase();
  if (!inTauri) {
    return unavailableHotkeyBridge(
      "unavailable here: the global hotkey needs the Forerunner desktop app (this page runs in a browser)",
    );
  }
  if (!DESKTOP_PLATFORMS.has(platform)) {
    return unavailableHotkeyBridge(
      `unavailable here: the global hotkey is a desktop-app feature (this shell is ${platform || "unknown"})`,
    );
  }
  return desktopHotkeyBridge();
}

export function inTauriShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The bridge for this page load; tests provide their own through `HotkeyContext`. */
export function hotkeyBridgeFromGlobals(config: Pick<DaemonConfig, "platform">): HotkeyBridge {
  return hotkeyBridgeFor(config, inTauriShell());
}

/** `null` means "derive from the globals" (the app's default). */
export const HotkeyContext = createContext<HotkeyBridge | null>(null);

/** The bridge the shell and Settings use: the provided one, else the one for this page. */
export function useHotkeyBridge(): HotkeyBridge {
  const provided = useContext(HotkeyContext);
  const platform = useUiState((s) => s.config.platform);
  return useMemo(() => provided ?? hotkeyBridgeFromGlobals({ platform }), [provided, platform]);
}
