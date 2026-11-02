/**
 * Command output that a person or a model reads (the evidence of a review, a check's output in
 * "See what was checked", a finding) is plain text: no terminal escape sequences. A program
 * prints them into a pipe when the environment forces colour (`FORCE_COLOR=1`, which some people
 * set and CI sets), and some print them whatever the environment says. Two halves:
 *
 * - `withoutForcedColour(env)`: the environment for a command whose output is read, not shown in
 *   a terminal: the variables that force colour into a pipe removed, `NO_COLOR=1` added (the
 *   convention tools that colour without checking for a terminal follow).
 * - `stripAnsi(text)`: what such a command printed, without its escape sequences.
 */

/**
 * The variables that make a program print colour into a pipe: Node, chalk, npm and pytest read
 * `FORCE_COLOR` (any value but `0`/`false` for Node; any value at all for pytest and rich, so
 * setting it to `0` is not enough); `CLICOLOR_FORCE` many CLIs; `PY_COLORS=1` pytest and tox.
 */
export const COLOUR_FORCING_ENV = ["FORCE_COLOR", "CLICOLOR_FORCE", "PY_COLORS"] as const;

const FORCING = new Set<string>(COLOUR_FORCING_ENV);

/**
 * `env` without the variables that force colour (any letter case: Windows' names are not
 * case-sensitive) and with `NO_COLOR=1`. Never changes `env` itself.
 */
export function withoutForcedColour<V extends string | undefined>(
  env: Readonly<Record<string, V>>,
): Record<string, V | string> {
  const out: Record<string, V | string> = {};
  for (const [k, v] of Object.entries(env)) {
    const upper = k.toUpperCase();
    if (FORCING.has(upper) || upper === "NO_COLOR") continue;
    out[k] = v;
  }
  out.NO_COLOR = "1";
  return out;
}

const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are control characters by definition
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P^_][^\u001b]*\u001b\\|\u001b[ -/]*[0-~]|\u009b[0-?]*[ -/]*[@-~]/g;

/**
 * `text` without terminal escape sequences: colours and cursor moves (CSI, `ESC [ ... m`, and its
 * 8-bit form), titles and links (OSC, `ESC ] ... BEL`), device strings (DCS, PM, APC) and the
 * two-character escapes. Everything else, line breaks and tabs included, is kept as it was.
 */
export function stripAnsi(text: string): string {
  return text.includes("\u001b") || text.includes("\u009b") ? text.replace(ESCAPES, "") : text;
}
