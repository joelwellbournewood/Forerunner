/**
 * Key combinations the model may press, parsed once and rendered per platform. The grammar is
 * `[modifier+]*key` with modifiers ctrl, alt, shift, super (xdotool names) and a named key or a
 * single character. Anything else is a validation error before any process starts.
 */
import { ForerunnerError } from "@forerunner/platform";

export const KEY_MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;
export type KeyModifier = (typeof KEY_MODIFIERS)[number];

const MODIFIER_ALIASES: Record<string, KeyModifier> = {
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  shift: "shift",
  super: "super",
  win: "super",
  meta: "super",
  cmd: "super",
};

/** Named keys in xdotool (X keysym) spelling; the Windows adapter maps them to SendKeys. */
export const NAMED_KEYS = [
  "Return",
  "Tab",
  "Escape",
  "BackSpace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "Page_Up",
  "Page_Down",
  "Up",
  "Down",
  "Left",
  "Right",
  "space",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
] as const;
export type NamedKey = (typeof NAMED_KEYS)[number];

const NAMED_BY_LOWER = new Map<string, NamedKey>(NAMED_KEYS.map((k) => [k.toLowerCase(), k]));
const ALIASES: Record<string, NamedKey> = {
  enter: "Return",
  esc: "Escape",
  backspace: "BackSpace",
  del: "Delete",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  pgup: "Page_Up",
  pgdn: "Page_Down",
  " ": "space",
};

export interface ParsedKey {
  modifiers: KeyModifier[];
  /** A named key, or one printable character. */
  key: NamedKey | string;
  named: boolean;
}

export const MAX_KEY_LENGTH = 64;

export function parseKey(input: string): ParsedKey {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_KEY_LENGTH) {
    throw new ForerunnerError("validation", "key must be a non-empty string of at most 64 chars");
  }
  const parts = input.split("+");
  // A trailing "+" means the plus key itself: "ctrl++" -> ["ctrl", "", ""].
  const last = parts[parts.length - 1] === "" && parts.length >= 2 ? "+" : parts.pop();
  if (last === "+") parts.splice(-2, 2);
  const modifiers: KeyModifier[] = [];
  for (const raw of parts) {
    const mod = MODIFIER_ALIASES[raw.trim().toLowerCase()];
    if (!mod)
      throw new ForerunnerError("validation", `unknown modifier "${raw}" in key "${input}"`);
    if (!modifiers.includes(mod)) modifiers.push(mod);
  }
  const keyRaw = (last ?? "").trim();
  if (!keyRaw) throw new ForerunnerError("validation", `key "${input}" names no key`);
  const named = NAMED_BY_LOWER.get(keyRaw.toLowerCase()) ?? ALIASES[keyRaw.toLowerCase()];
  if (named) return { modifiers, key: named, named: true };
  if ([...keyRaw].length === 1 && /^[\x21-\x7e]$/.test(keyRaw)) {
    return { modifiers, key: keyRaw, named: false };
  }
  throw new ForerunnerError(
    "validation",
    `unknown key "${keyRaw}": use a printable character or one of ${NAMED_KEYS.join(", ")}`,
  );
}

/** xdotool spelling: `ctrl+shift+s`, `alt+F4`, `Return`. */
export function toXdotoolKey(k: ParsedKey): string {
  return [...k.modifiers, k.key].join("+");
}

export const MAX_TEXT_LENGTH = 20_000;

/** Text the model may type: bounded, no control characters except newline and tab. */
export function validateText(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    throw new ForerunnerError("validation", "text must be a non-empty string");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw new ForerunnerError("validation", `text longer than ${MAX_TEXT_LENGTH} characters`);
  }
  const cleaned = text.replace(/\r\n?/g, "\n");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(cleaned)) {
    throw new ForerunnerError("validation", "text contains control characters");
  }
  return cleaned;
}
