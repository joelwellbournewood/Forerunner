import { ForerunnerError } from "@forerunner/platform";
import type { AgentRow, HumanRow, StateStore } from "@forerunner/state";
import type { SetupConfig } from "../setup/wizard.ts";

/**
 * Which human an install is: the binding of a daemon (or the cloud runner) to one row of the
 * `human` table (ADR 0082). On a shared store (ADR 0024: every PC's daemon is a direct client
 * of the shared Postgres) the store holds every member's human, so "the first row" is another
 * person's identity, their agent, their vault keys, their cap and their inbox. An install
 * therefore names its human: the caller (the runner passes the human it resolved), the
 * environment (`FORERUNNER_HUMAN`, id or email), `config.json` (`humanId`, written by
 * `fr setup --human-id` or recorded by the daemon at its first bind; else `humanEmail` from
 * `fr setup --email`, which finds the row by email or names the one created at first start).
 * Without any of these the store must hold at most one human: none is the first run (the
 * human is created), one is a solo install, more is `identity_ambiguous` and the daemon does
 * not start. The store's dialect plays no part: two profiles can share one `sqlite:` file.
 */

/** `FORERUNNER_HUMAN`: the human this start binds to, as an id or an email; ahead of `config.json`. */
export const HUMAN_ENV = "FORERUNNER_HUMAN";

/** How many of the store's humans an ambiguity report names. */
const AMBIGUITY_LIST_LIMIT = 10;

/** Where the binding came from: `fr doctor`, the logs and the tests read it. */
export type IdentitySource =
  /** `ComposeOptions.identity.humanId`: the caller resolved the human (the cloud runner). */
  | "option"
  /** `FORERUNNER_HUMAN`. */
  | "env"
  /** `config.json` `humanId`. */
  | "config"
  /** `config.json` `humanEmail` (or `identity.email`) matched a row. */
  | "email"
  /** No selector and the store holds exactly one human. */
  | "only"
  /** No human for this install yet: created at this start. */
  | "created";

export interface InstallIdentity {
  humanId: string;
  source: IdentitySource;
  /** The id or email that selected the human; null for `only` and `created`. */
  selector: string | null;
}

/** The selectors in precedence order; the first one present decides. */
export interface IdentitySelectors {
  /** An id or email the caller resolved itself. */
  humanId?: string;
  /** `FORERUNNER_HUMAN`: an id or email. */
  env?: string;
  /** `config.json` `humanId`. */
  configHumanId?: string;
  /** An email that finds the human, else names the one created on first run. */
  email?: string;
}

export type HumanSummary = Pick<HumanRow, "id" | "name" | "email">;

/** What the store holds for this install's selectors, without creating or throwing anything. */
export type InstallHumanLookup =
  | {
      kind: "bound";
      human: HumanRow;
      source: Exclude<IdentitySource, "created">;
      selector: string | null;
    }
  /** No human for this install yet: the daemon creates one at its first start (with `email` when set). */
  | { kind: "none"; email: string | null; humans: number }
  /** Several humans and no selector: refused. `rows` lists up to AMBIGUITY_LIST_LIMIT of them. */
  | { kind: "ambiguous"; humans: number; rows: HumanSummary[] }
  /** A selector that names nobody. */
  | { kind: "not_found"; selector: string; source: "option" | "env" | "config" };

/** The selectors of one start from the composition inputs: the caller's, the environment's, `config.json`'s. */
export function installIdentitySelectors(input: {
  humanId?: string;
  email?: string;
  env?: NodeJS.ProcessEnv;
  config?: SetupConfig | null;
}): IdentitySelectors {
  const present = (v: string | undefined): string | undefined => {
    const t = v?.trim();
    return t ? t : undefined;
  };
  return {
    humanId: present(input.humanId),
    env: present(input.env?.[HUMAN_ENV]),
    configHumanId: present(input.config?.humanId),
    email: present(input.email) ?? present(input.config?.humanEmail),
  };
}

function summary(h: HumanRow): HumanSummary {
  return { id: h.id, name: h.name, email: h.email };
}

/**
 * Resolve the selectors against the store: a named selector (id, then email, case-insensitive
 * on the email) binds or is `not_found`; an email binds or reports `none` with the email; no
 * selector binds the only human, reports `none` on an empty store, `ambiguous` otherwise.
 */
export async function lookupInstallHuman(
  store: StateStore,
  sel: IdentitySelectors,
): Promise<InstallHumanLookup> {
  const named: [string | undefined, "option" | "env" | "config"][] = [
    [sel.humanId, "option"],
    [sel.env, "env"],
    [sel.configHumanId, "config"],
  ];
  const first = named.find(([value]) => value !== undefined && value.trim() !== "");
  if (first) {
    const [value, source] = first;
    const selector = (value as string).trim();
    const byId = await store.human.get(selector);
    if (byId) return { kind: "bound", human: byId, source, selector };
    const byEmail = await store.human.byEmail(selector);
    if (byEmail) return { kind: "bound", human: byEmail, source, selector };
    return { kind: "not_found", selector, source };
  }
  const email = sel.email?.trim();
  if (email) {
    const row = await store.human.byEmail(email);
    if (row) return { kind: "bound", human: row, source: "email", selector: email };
    return { kind: "none", email, humans: await store.human.count() };
  }
  const humans = await store.human.count();
  if (humans === 0) return { kind: "none", email: null, humans: 0 };
  if (humans === 1) {
    const [only] = await store.human.list(undefined, { limit: 1 });
    if (only) return { kind: "bound", human: only, source: "only", selector: null };
  }
  const rows = await store.human.list(undefined, { limit: AMBIGUITY_LIST_LIMIT });
  return { kind: "ambiguous", humans, rows: rows.map(summary) };
}

const SOURCE_LABEL: Record<IdentitySource, string> = {
  option: "the caller",
  env: HUMAN_ENV,
  config: "config.json humanId",
  email: "config.json humanEmail",
  only: "the store's only human",
  created: "created at this start",
};

function describeHuman(h: HumanSummary): string {
  return `${h.name} <${h.email || "no email"}> (${h.id})`;
}

/** The ways out of an ambiguous or missing binding, as `fr doctor` and the refusal name them. */
export const IDENTITY_REMEDY = `set ${HUMAN_ENV}=<id or email>, or run fr setup --human-id <id> or fr setup --email <address>`;

/**
 * Bind this install to its human, creating one through `create` only when the store has none
 * for it (`kind: "none"`). Throws `identity_ambiguous` for several humans and no selector,
 * `not_found` for a selector that names nobody.
 */
export async function bindInstallHuman(
  store: StateStore,
  sel: IdentitySelectors,
  create: (email: string | null) => Promise<HumanRow>,
): Promise<{ human: HumanRow; identity: InstallIdentity }> {
  const lookup = await lookupInstallHuman(store, sel);
  switch (lookup.kind) {
    case "bound":
      return {
        human: lookup.human,
        identity: { humanId: lookup.human.id, source: lookup.source, selector: lookup.selector },
      };
    case "none": {
      const human = await create(lookup.email);
      return { human, identity: { humanId: human.id, source: "created", selector: null } };
    }
    case "ambiguous":
      throw new ForerunnerError(
        "identity_ambiguous",
        `the state store holds ${lookup.humans} humans and this install names none; ${IDENTITY_REMEDY}`,
        { details: { humans: lookup.humans, rows: lookup.rows } },
      );
    case "not_found":
      throw new ForerunnerError(
        "not_found",
        `no human with id or email ${lookup.selector} (from ${SOURCE_LABEL[lookup.source]}); ${IDENTITY_REMEDY}`,
        { details: { selector: lookup.selector, source: lookup.source } },
      );
  }
}

/** One `fr doctor` line for a lookup: whether the next start binds, and to whom. */
export function describeIdentityCheck(lookup: InstallHumanLookup): { ok: boolean; detail: string } {
  switch (lookup.kind) {
    case "bound":
      return {
        ok: true,
        detail: `${describeHuman(lookup.human)}, from ${SOURCE_LABEL[lookup.source]}`,
      };
    case "none":
      return {
        ok: true,
        detail: lookup.email
          ? `no human with email ${lookup.email} yet: created at the daemon's first start (the store holds ${lookup.humans} other${lookup.humans === 1 ? "" : "s"}; use --human-id to bind to one of them instead)`
          : "no human yet: created at the daemon's first start",
      };
    case "ambiguous": {
      const listed = lookup.rows.map(describeHuman).join(", ");
      const more = lookup.humans > lookup.rows.length ? ", ..." : "";
      return {
        ok: false,
        detail: `${lookup.humans} humans in the store and this install names none: ${IDENTITY_REMEDY}; the humans: ${listed}${more}`,
      };
    }
    case "not_found":
      return {
        ok: false,
        detail: `no human with id or email ${lookup.selector} (from ${SOURCE_LABEL[lookup.source]}): ${IDENTITY_REMEDY}`,
      };
  }
}

/**
 * The install's principal agent among the human's own principals: the one named (case does
 * not matter) when it exists, else the first; undefined when the human has none yet. Another
 * human's agent is never a candidate: `principals` is already the owner's list.
 */
export function pickPrincipal(principals: AgentRow[], name?: string): AgentRow | undefined {
  const wanted = name?.trim().toLowerCase();
  if (wanted) {
    const named = principals.find((a) => a.name.toLowerCase() === wanted);
    if (named) return named;
  }
  return principals[0];
}
