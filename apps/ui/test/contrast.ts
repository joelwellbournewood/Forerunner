import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * WCAG contrast of an element's Tailwind colours, in the light and the dark theme, read from
 * its class names (jsdom applies no CSS). The colours are the ones the app renders: Tailwind
 * v4's `theme.css` (oklch), converted to sRGB (out-of-gamut channels clipped). Anything this
 * cannot judge throws instead of being skipped: an unknown colour, an opacity form
 * (`text-x/70`), an arbitrary colour (`text-[#777]`) or an `opacity-*` class on the way up.
 */

type Theme = "light" | "dark";
type Kind = "text" | "bg" | "border";

const THEME_CSS = readFileSync(
  createRequire(import.meta.url).resolve("tailwindcss/theme.css"),
  "utf8",
);

const PALETTE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  for (const m of THEME_CSS.matchAll(/--color-([a-z]+(?:-\d+)?):\s*([^;]+);/g)) {
    const [, name, value] = m;
    if (name && value) map.set(name, toHex(value.trim()));
  }
  return map;
})();

function toHex(value: string): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return `#${full.toLowerCase()}`;
  }
  const ok = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+|none)\s*\)$/.exec(value);
  if (!ok) throw new Error(`contrast: cannot read colour value ${value}`);
  const L = Number(ok[1]) / 100;
  const C = Number(ok[2]);
  const h = ok[3] === "none" ? 0 : (Number(ok[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${linear
    .map((v) => {
      const c = Math.min(1, Math.max(0, v));
      const e = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
      return Math.round(e * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

/** A Tailwind colour name (`neutral-500`, `white`) as the app renders it, in sRGB hex. */
export function tailwindColor(name: string): string {
  const hex = PALETTE.get(name);
  if (!hex) throw new Error(`contrast: no Tailwind colour ${name}`);
  return hex;
}

const SIZE = /^\[\d*\.?\d+(?:rem|em|px|%)\]$/;
const NAMED_SIZE = /^(?:xs|sm|base|lg|xl|\d?xl)$/;
const NOT_COLOUR = new Set(["transparent", "current", "inherit"]);

/** Rejects what this helper cannot judge, on one element. */
function guard(el: Element): void {
  for (const token of (el.getAttribute("class") ?? "").split(/\s+/)) {
    const bare = token.replace(/^dark:/, "");
    if (/^opacity-/.test(bare)) throw new Error(`contrast: cannot judge ${token}`);
    const m = /^(text|bg|border)-(.+)$/.exec(bare);
    if (!m) continue;
    const rest = m[2] ?? "";
    if (rest.includes("/")) throw new Error(`contrast: cannot judge opacity form ${token}`);
    if (rest.startsWith("[") && !SIZE.test(rest))
      throw new Error(`contrast: cannot judge arbitrary colour ${token}`);
  }
}

function colorClass(el: Element, kind: Kind, theme: Theme): string | undefined {
  const tokens = (el.getAttribute("class") ?? "").split(/\s+/);
  const plain = new RegExp(`^${kind}-([a-z]+(?:-\\d+)?)$`);
  const dark = new RegExp(`^dark:${kind}-([a-z]+(?:-\\d+)?)$`);
  const pick = (re: RegExp) =>
    tokens
      .map((t) => re.exec(t)?.[1])
      .find((c) => c !== undefined && !NAMED_SIZE.test(c) && !/^[trblxy]$/.test(c));
  return (theme === "dark" ? pick(dark) : undefined) ?? pick(plain);
}

/** The nearest colour of `kind` on `from` or an ancestor up to `root`. */
function resolve(from: Element | null, root: Element, kind: Kind, theme: Theme): string {
  for (let cur = from; cur; cur = cur.parentElement) {
    guard(cur);
    const c = colorClass(cur, kind, theme);
    if (c && !NOT_COLOUR.has(c)) return tailwindColor(c);
    if (cur === root) break;
  }
  throw new Error(`contrast: no ${kind} colour (${theme}) up to the root`);
}

/** Checks every element from `el` up to `root` for forms this helper cannot judge. */
function guardChain(el: Element, root: Element): void {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    guard(cur);
    if (cur === root) break;
  }
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The element's text on its (nearest) background, in each theme. */
export function contrast(el: Element, root: Element): Record<Theme, number> {
  guardChain(el, root);
  const ratio = (theme: Theme) =>
    contrastRatio(resolve(el, root, "text", theme), resolve(el, root, "bg", theme));
  return { light: ratio("light"), dark: ratio("dark") };
}

/** The element's own border against the background behind it (its parent's), in each theme. */
export function borderContrast(el: Element, root: Element): Record<Theme, number> {
  guardChain(el, root);
  const ratio = (theme: Theme) => {
    const border = colorClass(el, "border", theme);
    if (!border || NOT_COLOUR.has(border))
      throw new Error(`contrast: no border colour (${theme}) on the element`);
    return contrastRatio(tailwindColor(border), resolve(el.parentElement, root, "bg", theme));
  };
  return { light: ratio("light"), dark: ratio("dark") };
}
