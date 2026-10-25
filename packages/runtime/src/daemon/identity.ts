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
  /**
   * `config.json`'s `humanId` when it named nobody in this store and the configured email
   * decided instead (the id was recorded on another store, or the row is gone): the daemon
   * re-records the human it bound. Absent otherwise.
   */
  staleConfigHumanId?: string;
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

/** The reads the lookup needs: a `StateStore`'s `human` repository, or `EMPTY_HUMAN_STORE`. */
export type HumanLookupSource = Pick<StateStore["human"], "get" | "byEmail" | "count" | "list">;

/**
 * A store that holds nobody, for `fr doctor` on an install whose store does not exist yet: the
 * lookup answers as the daemon's first start will, without creating the store to ask it.
 */
export const EMPTY_HUMAN_STORE: { human: HumanLookupSource } = {
  human: {
    get: async () => undefined,
    byEmail: async () => undefined,
    count: async () => 0,
    list: async () => [],
  },
};

/** What the store holds for this install's selectors, without creating or throwing anything. */
export type InstallHumanLookup =
  | {
      kind: "bound";
      human: HumanRow;
      source: Exclude<IdentitySource, "created">;
      selector: string | null;
      /** `config.json`'s `humanId` when it named nobody and the email decided (see `InstallIdentity`). */
      staleConfigHumanId?: string;
    }
  /** No human for this install yet: the daemon creates one at its first start (with `email` when set). */
  | { kind: "none"; email: string | null; humans: number; staleConfigHumanId?: string }
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
 *
 * One exception to `not_found`: `config.json`'s `humanId` is the id the daemon recorded at an
 * earlier bind (or `fr setup --human-id` wrote), and an id never travels between stores. When
 * it names nobody here (the install moved to another store with `fr setup --state-url`, the
 * data directory was wiped, the row is gone) and the configuration carries an email, the email
 * decides as if the id were absent, and the result names the stale id so the daemon re-records
 * the human it bound and `fr doctor` can say so. That path still never adopts a row the
 * selectors do not name: the email binds its own row or creates one. Without an email the
 * stale id stays `not_found`; the environment's and the caller's selectors are given per start
 * and stay strict.
 */
export async function lookupInstallHuman(
  store: { human: HumanLookupSource },
  sel: IdentitySelectors,
): Promise<InstallHumanLookup> {
  const named: [string | undefined, "option" | "env" | "config"][] = [
    [sel.humanId, "option"],
    [sel.env, "env"],
    [sel.configHumanId, "config"],
  ];
  const first = named.find(([value]) => value !== undefined && value.trim() !== "");
  const configuredEmail = sel.email?.trim();
  let stale: { staleConfigHumanId: string } | undefined;
  if (first) {
    const [value, source] = first;
    const selector = (value as string).trim();
    const byId = await store.human.get(selector);
    if (byId) return { kind: "bound", human: byId, source, selector };
    const byEmail = await store.human.byEmail(selector);
    if (byEmail) return { kind: "bound", human: byEmail, source, selector };
    if (source !== "config" || !configuredEmail) return { kind: "not_found", selector, source };
    stale = { staleConfigHumanId: selector };
  }
  if (configuredEmail) {
    const row = await store.human.byEmail(configuredEmail);
    if (row) {
      return { kind: "bound", human: row, source: "email", selector: configuredEmail, ...stale };
    }
    return { kind: "none", email: configuredEmail, humans: await store.human.count(), ...stale };
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
        identity: {
          humanId: lookup.human.id,
          source: lookup.source,
          selector: lookup.selector,
          ...(lookup.staleConfigHumanId ? { staleConfigHumanId: lookup.staleConfigHumanId } : {}),
        },
      };
    case "none": {
      const human = await create(lookup.email);
      return {
        human,
        identity: {
          humanId: human.id,
          source: "created",
          selector: null,
          ...(lookup.staleConfigHumanId ? { staleConfigHumanId: lookup.staleConfigHumanId } : {}),
        },
      };
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
  const stale =
    (lookup.kind === "bound" || lookup.kind === "none") && lookup.staleConfigHumanId
      ? `config.json humanId ${lookup.staleConfigHumanId} names nobody in this store (recorded on another store, or the row is gone); the email decides and the next start records the new id: `
      : "";
  switch (lookup.kind) {
    case "bound":
      return {
        ok: true,
        detail: `${stale}${describeHuman(lookup.human)}, from ${SOURCE_LABEL[lookup.source]}`,
      };
    case "none":
      return {
        ok: true,
        detail: `${stale}${
          lookup.email
            ? `no human with email ${lookup.email} yet: created at the daemon's first start${
                lookup.humans > 0
                  ? ` (the store holds ${lookup.humans} other${lookup.humans === 1 ? "" : "s"}; use --human-id to bind to one of them instead)`
                  : ""
              }`
            : "no human yet: created at the daemon's first start"
        }`,
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
 * The install's principal agent among the human's own principals: the one with the given id
 * when it is among them, else the one named (case does not matter) when it exists, else the
 * first; undefined when the human has none yet. Another human's agent is never a candidate:
 * `principals` is already the owner's list. A caller that resolved the agent itself (the cloud
 * runner) passes the id and checks the pick is that agent: an id that is not among the human's
 * principals must be refused by the caller, never replaced by another agent.
 */
export function pickPrincipal(
  principals: AgentRow[],
  sel: { id?: string; name?: string } = {},
): AgentRow | undefined {
  const id = sel.id?.trim();
  if (id) {
    const byId = principals.find((a) => a.id === id);
    if (byId) return byId;
  }
  const wanted = sel.name?.trim().toLowerCase();
  if (wanted) {
    const named = principals.find((a) => a.name.toLowerCase() === wanted);
    if (named) return named;
  }
  return principals[0];
}
