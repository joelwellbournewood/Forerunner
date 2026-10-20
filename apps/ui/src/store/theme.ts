import type { ThemePreference } from "./store.ts";

/**
 * Dark mode: `prefers-color-scheme` by default, with a manual override persisted per install.
 * The resolved theme is written to `<html data-theme="light|dark">`; `styles.css` binds
 * Tailwind's `dark:` variant to that attribute, so the override wins over the OS setting.
 */

export type ResolvedTheme = "light" | "dark";

export function systemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function resolveTheme(preference: ThemePreference, prefersDark = systemPrefersDark()) {
  if (preference === "system") return prefersDark ? "dark" : "light";
  return preference;
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }
  return resolved;
}

/** Re-applies "system" when the OS preference changes; returns an unsubscribe. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia("(prefers-color-scheme: dark)");
  } catch {
    return () => {};
  }
  const handler = () => onChange();
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }
  return () => {};
}

export const THEME_CYCLE: ThemePreference[] = ["system", "light", "dark"];
export function nextTheme(current: ThemePreference): ThemePreference {
  const idx = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(idx + 1) % THEME_CYCLE.length] ?? "system";
}
