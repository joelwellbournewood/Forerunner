/**
 * Keyboard shortcuts (spec K QoL). Two-key sequences in the style of "g h" plus single keys;
 * the pure matcher is tested on its own, the hook wires it to `window`.
 */

export interface ShortcutDefinition {
  /** Keys in order, e.g. ["g", "h"]; single-key shortcuts have one entry. */
  keys: readonly string[];
  description: string;
  id: string;
}

export const SHORTCUTS: readonly ShortcutDefinition[] = [
  { id: "go.home", keys: ["g", "h"], description: "Go to Home" },
  { id: "go.inbox", keys: ["g", "i"], description: "Go to Inbox" },
  { id: "go.settings", keys: ["g", "s"], description: "Go to Settings" },
  { id: "go.project", keys: ["g", "p"], description: "Open the active project" },
  { id: "go.memory", keys: ["g", "m"], description: "Go to Memory" },
  { id: "go.extensions", keys: ["g", "e"], description: "Go to Extensions" },
  { id: "go.changes", keys: ["g", "c"], description: "Go to Changes" },
  { id: "go.performance", keys: ["g", "t"], description: "Go to Performance (timings)" },
  { id: "go.updates", keys: ["g", "u"], description: "Go to Updates" },
  { id: "help", keys: ["?"], description: "Show keyboard shortcuts" },
  { id: "palette", keys: ["Mod", "k"], description: "Command palette" },
  { id: "escape", keys: ["Escape"], description: "Close dialogs and menus" },
];

export interface KeyPress {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** True when the event target is a text field; sequences are ignored there. */
  inField?: boolean;
}

export interface SequenceMatcher {
  /** Returns the shortcut id that completed, or null. */
  press(press: KeyPress, now?: number): string | null;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).tagName !== "string") return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return el.isContentEditable === true;
}

/** `windowMs` is how long the first key of a sequence stays armed (1 s by default). */
export function createSequenceMatcher(
  shortcuts: readonly ShortcutDefinition[] = SHORTCUTS,
  windowMs = 1000,
): SequenceMatcher {
  let pending: string[] = [];
  let armedAt = 0;
  return {
    press(press, now = Date.now()) {
      const mod = press.ctrlKey === true || press.metaKey === true;
      // Chords with a modifier are matched on their own, in fields too.
      if (mod) {
        pending = [];
        for (const s of shortcuts) {
          if (s.keys.length === 2 && s.keys[0] === "Mod" && s.keys[1] === press.key.toLowerCase()) {
            return s.id;
          }
        }
        return null;
      }
      if (press.key === "Escape") {
        pending = [];
        return shortcuts.find((s) => s.keys.length === 1 && s.keys[0] === "Escape")?.id ?? null;
      }
      if (press.inField || press.altKey) {
        pending = [];
        return null;
      }
      if (pending.length > 0 && now - armedAt > windowMs) pending = [];
      const candidate = [...pending, press.key];
      const exact = shortcuts.find(
        (s) => s.keys.length === candidate.length && s.keys.every((k, i) => k === candidate[i]),
      );
      if (exact) {
        pending = [];
        return exact.id;
      }
      const prefix = shortcuts.some(
        (s) => s.keys.length > candidate.length && candidate.every((k, i) => s.keys[i] === k),
      );
      if (prefix) {
        pending = candidate;
        armedAt = now;
      } else {
        pending = [];
      }
      return null;
    },
  };
}

export function formatKeys(keys: readonly string[]): string[] {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");
  return keys.map((k) => (k === "Mod" ? (isMac ? "⌘" : "Ctrl") : k));
}
