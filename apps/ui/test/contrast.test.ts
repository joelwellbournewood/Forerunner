import { describe, expect, it } from "vitest";
import { borderContrast, contrast, contrastRatio, tailwindColor } from "./contrast.ts";

/** The test helper that checks colour contrast from Tailwind classes (jsdom renders no CSS). */

function el(html: string): { root: HTMLElement; target: HTMLElement } {
  const root = document.createElement("div");
  root.innerHTML = html;
  const target = root.querySelector("[data-target]") as HTMLElement;
  return { root, target };
}

describe("contrast helper", () => {
  it("uses the colours Tailwind v4 renders (oklch from its theme.css, converted to sRGB)", () => {
    // v4 values, not the v3 hex palette (v3 neutral-500 was #737373).
    expect(tailwindColor("neutral-500")).toBe("#737373");
    expect(tailwindColor("neutral-600")).toBe("#525252");
    expect(tailwindColor("neutral-100")).toBe("#f5f5f5");
    expect(tailwindColor("white")).toBe("#ffffff");
    // A chromatic one, where v3 and v4 differ: v4 blue-500 is oklch(62.3% 0.214 259.815).
    expect(tailwindColor("blue-500")).not.toBe("#3b82f6");
    expect(tailwindColor("blue-500")).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(tailwindColor("white"), tailwindColor("blue-500"))).toBeLessThan(4.5);
    expect(() => tailwindColor("nope-500")).toThrow(/nope-500/);
  });

  it("reads text on the nearest background in each theme", () => {
    const { root, target } = el(
      '<span class="bg-neutral-100 dark:bg-neutral-800"><span data-target class="text-neutral-600 dark:text-neutral-400">x</span></span>',
    );
    const r = contrast(target, root);
    expect(r.light).toBeCloseTo(
      contrastRatio(tailwindColor("neutral-600"), tailwindColor("neutral-100")),
      5,
    );
    expect(r.dark).toBeCloseTo(
      contrastRatio(tailwindColor("neutral-400"), tailwindColor("neutral-800")),
      5,
    );
  });

  it("reads a border against the background behind the element", () => {
    const { root, target } = el(
      '<span class="bg-neutral-100 dark:bg-neutral-800"><span data-target class="border border-neutral-500 bg-white dark:border-neutral-400">x</span></span>',
    );
    const r = borderContrast(target, root);
    expect(r.light).toBeCloseTo(
      contrastRatio(tailwindColor("neutral-500"), tailwindColor("neutral-100")),
      5,
    );
    expect(r.dark).toBeCloseTo(
      contrastRatio(tailwindColor("neutral-400"), tailwindColor("neutral-800")),
      5,
    );
  });

  it.each([
    ["a text opacity form", '<span data-target class="bg-white text-neutral-900/70">x</span>'],
    [
      "a background opacity form",
      '<span data-target class="bg-white/50 text-neutral-900">x</span>',
    ],
    [
      "a dark opacity form",
      '<span data-target class="bg-white text-neutral-900 dark:text-white/80">x</span>',
    ],
    ["an arbitrary text colour", '<span data-target class="bg-white text-[#777]">x</span>'],
    [
      "an arbitrary background colour",
      '<span data-target class="bg-[oklch(50%_0_0)] text-white">x</span>',
    ],
    ["an opacity class", '<span data-target class="bg-white text-neutral-900 opacity-60">x</span>'],
    [
      "an opacity class on an ancestor",
      '<span class="bg-white dark:opacity-50"><span data-target class="text-neutral-900">x</span></span>',
    ],
  ])("throws on %s rather than skipping it", (_what, html) => {
    const { root, target } = el(html);
    // For the reason itself, not an incidental one (an unknown colour, a missing background).
    expect(() => contrast(target, root)).toThrow(/cannot judge/);
  });

  it("an arbitrary font size is not a colour", () => {
    const { root, target } = el(
      '<span data-target class="bg-white text-[0.7rem] text-neutral-900">x</span>',
    );
    expect(contrast(target, root).light).toBeGreaterThan(15);
  });
});
