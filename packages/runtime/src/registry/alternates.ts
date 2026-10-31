import { CLAUDE_CODE_PREFIX } from "./types.ts";

/**
 * Which specialist takes over a task (U-044). Two moments need one:
 *
 * - the retry ladder's second rung, "split or change specialist" (spec D.2): after two failed
 *   attempts the next attempt goes to a different specialist, not the same one again;
 * - a specialist whose registry entry names web tools (`cc:WebFetch`, `cc:WebSearch`) on a
 *   driver that does not offer them: the loop driver, which runs every task billed to an API
 *   key, has no web tool (`registry/tools.ts`), so such a run could only fail and be retried.
 *
 * A candidate fits when it can do everything the specialist it replaces can: its registry tools
 * cover the other's, and so do its tools on the driver the run uses (a registry entry may name
 * a tool the driver drops). Among those, the closest comes first: the words its description
 * shares with the replaced one's (the kind of work) less the tools it has on top (a wider grant
 * than the work had), then the fewest extra tools, then the name. With the registry as shipped: coder and
 * migration-specialist stand in for each other, tester goes to coder, designer and
 * writer-marketing to each other, data-analyst to science-evaluator; the researcher and the
 * science-evaluator have no stand-in. No fit: null, and the task goes to the person.
 */
export interface SpecialistProfile {
  name: string;
  /** The registry entry's one-line description. */
  description: string;
  /** `allowed_tools` as the registry wrote them (`cc:` names, Forerunner names). */
  registryTools: readonly string[];
  /** The tools a run gets on the driver in use (the loop's built-ins, or `cc:` names on the SDK). */
  driverTools: readonly string[];
}

/** The registry's web tools: the Agent SDK offers them, the loop driver has no equivalent. */
export const WEB_TOOLS: readonly string[] = [
  `${CLAUDE_CODE_PREFIX}WebFetch`,
  `${CLAUDE_CODE_PREFIX}WebSearch`,
];

/** A tool that reaches the web on the loop driver: the browser capability's page fetch. */
const LOOP_WEB_TOOLS: readonly string[] = ["browser_navigate"];

/** Whether the registry entry works from the web (it names a web tool). */
export function needsWeb(p: Pick<SpecialistProfile, "registryTools">): boolean {
  return p.registryTools.some((t) => WEB_TOOLS.includes(t) || LOOP_WEB_TOOLS.includes(t));
}

/** Whether a run on the driver in use can reach the web. */
export function hasWeb(p: Pick<SpecialistProfile, "driverTools">): boolean {
  return p.driverTools.some((t) => WEB_TOOLS.includes(t) || LOOP_WEB_TOOLS.includes(t));
}

/** The web tools the entry names that the driver in use does not offer. */
export function lostWebTools(p: SpecialistProfile): string[] {
  return p.registryTools.filter(
    (t) => (WEB_TOOLS.includes(t) || LOOP_WEB_TOOLS.includes(t)) && !p.driverTools.includes(t),
  );
}

/**
 * Words that say nothing about the kind of work: grammar, and what every registry description
 * may mention (the brief, the repository, what it is given).
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "brief",
  "by",
  "every",
  "for",
  "from",
  "given",
  "in",
  "inside",
  "into",
  "it",
  "its",
  "named",
  "never",
  "of",
  "on",
  "or",
  "own",
  "provided",
  "repository",
  "the",
  "to",
  "using",
  "with",
  "without",
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}

function covers(have: readonly string[], need: readonly string[]): boolean {
  return need.every((t) => have.includes(t));
}

/**
 * The specialist that takes the task over from `from`, or null when none fits. `exclude` names
 * the specialists that must not get it (those that already ran it); `requireWeb` asks for one
 * that reaches the web on the driver in use.
 */
export function alternateSpecialist(
  from: SpecialistProfile,
  candidates: readonly SpecialistProfile[],
  opts: { exclude?: ReadonlySet<string>; requireWeb?: boolean } = {},
): SpecialistProfile | null {
  const own = words(from.description);
  const ranked = candidates
    .filter(
      (c) =>
        c.name !== from.name &&
        !opts.exclude?.has(c.name) &&
        covers(
          c.registryTools,
          from.registryTools.filter((t) => !opts.requireWeb || !WEB_TOOLS.includes(t)),
        ) &&
        covers(c.driverTools, from.driverTools) &&
        (!opts.requireWeb || hasWeb(c)),
    )
    .map((c) => {
      const theirs = words(c.description);
      let shared = 0;
      for (const w of own) if (theirs.has(w)) shared++;
      const extra = c.registryTools.filter((t) => !from.registryTools.includes(t)).length;
      return { c, shared, extra };
    })
    // Closeness: the description's shared words, less each tool the stand-in would get on top.
    .sort(
      (a, b) =>
        b.shared - b.extra - (a.shared - a.extra) ||
        a.extra - b.extra ||
        a.c.name.localeCompare(b.c.name),
    );
  return ranked[0]?.c ?? null;
}
