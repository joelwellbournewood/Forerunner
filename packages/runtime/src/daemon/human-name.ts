/**
 * The name the daemon gives the install's human when it knows none (no setup answer, no
 * `USERNAME`/`USER` in the environment the desktop shell starts it with). It is a placeholder,
 * not the person's name: the setup assistant shows an empty field for it, never "me" (U-077).
 */
export const PLACEHOLDER_HUMAN_NAME = "me";

/** The human's name as the setup assistant prefills it: empty for the placeholder. */
export function shownHumanName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n === PLACEHOLDER_HUMAN_NAME ? "" : n;
}
