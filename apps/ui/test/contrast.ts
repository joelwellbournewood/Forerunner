/**
 * WCAG contrast of an element's Tailwind text colour on its background, in the light and the
 * dark theme, read from the class names (jsdom applies no CSS). Colours not in the table throw,
 * so a new colour has to be added here before a test can pass with it.
 */

// Tailwind palette, sRGB.
const COLORS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  "neutral-50": "#fafafa",
  "neutral-100": "#f5f5f5",
  "neutral-200": "#e5e5e5",
  "neutral-300": "#d4d4d4",
  "neutral-400": "#a3a3a3",
  "neutral-500": "#737373",
  "neutral-600": "#525252",
  "neutral-700": "#404040",
  "neutral-800": "#262626",
  "neutral-900": "#171717",
  "neutral-950": "#0a0a0a",
  "blue-500": "#3b82f6",
  "blue-600": "#2563eb",
  "blue-700": "#1d4ed8",
};

type Theme = "light" | "dark";

function colorClass(el: Element, kind: "text" | "bg", theme: Theme): string | undefined {
  const tokens = (el.getAttribute("class") ?? "").split(/\s+/);
  const plain = new RegExp(`^${kind}-([a-z]+(?:-\\d+)?)$`);
  const dark = new RegExp(`^dark:${kind}-([a-z]+(?:-\\d+)?)$`);
  const pick = (re: RegExp) =>
    tokens
      .map((t) => re.exec(t)?.[1])
      .find((c) => c !== undefined && !/^(xs|sm|base|lg|xl)$/.test(c));
  return (theme === "dark" ? pick(dark) : undefined) ?? pick(plain);
}

/** The nearest colour of `kind` on `el` or an ancestor up to `root`. */
function resolve(el: Element, root: Element, kind: "text" | "bg", theme: Theme): string {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const c = colorClass(cur, kind, theme);
    if (c) {
      const hex = COLORS[c];
      if (!hex) throw new Error(`contrast: no value for ${kind}-${c}`);
      return hex;
    }
    if (cur === root) break;
  }
  throw new Error(`contrast: no ${kind} colour (${theme}) on the element or up to the root`);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The element's text-on-background contrast in each theme. */
export function contrast(el: Element, root: Element): Record<Theme, number> {
  const ratio = (theme: Theme) =>
    contrastRatio(resolve(el, root, "text", theme), resolve(el, root, "bg", theme));
  return { light: ratio("light"), dark: ratio("dark") };
}
