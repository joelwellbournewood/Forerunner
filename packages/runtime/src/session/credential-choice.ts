import { existsSync, readFileSync } from "node:fs";
import type { BillingSourceKind } from "@forerunner/billing";
import { join } from "@forerunner/platform";
import { RUN_COMMAND_TOOL, WEB_FETCH_TOOL } from "../registry/tools.ts";
import { CLAUDE_CODE_PREFIX } from "../registry/types.ts";
import {
  type ChooserFacts,
  type CredentialChoice,
  capabilitiesOf,
  chooseAmong,
} from "../wiring/billing-pick.ts";
import type { CodeCommands, TaskNeed, TaskNeeds } from "./billing.ts";
import { yourCredential } from "./credential-wait.ts";
import { needsPersonsAnswers } from "./person-questions.ts";

/**
 * The credential chooser's needs and words (U-078, the owner's decision of 2026-11-02: "the
 * person's order decides; another credential only when the first cannot do the task properly;
 * the plan card says why"; ADR 0100 amended, ADR 0107 points 7 to 9 amended).
 *
 * A task's needs come from its specialist's registry entry and its own words (`needsOf`); what
 * each credential can do here is `capabilitiesOf` (`wiring/billing-pick.ts`); the pick keeps the
 * credentials that meet every hard need and lets the person's order decide among them. The plan
 * card, New task and Settings say the result in the same words (`choiceLine`, `abilityTable`).
 */

/** The registry's page reader and web search (`cc:` names). */
const CC_WEB_FETCH = `${CLAUDE_CODE_PREFIX}WebFetch`;
const CC_WEB_SEARCH = `${CLAUDE_CODE_PREFIX}WebSearch`;
const CC_BASH = `${CLAUDE_CODE_PREFIX}Bash`;

export interface NeedsInput {
  /** The registry entry's `allowed_tools` as written (`cc:` names, Forerunner names). */
  registryTools: readonly string[];
  /** The task, when there is one (a plan task, a task row): its words may need the person. */
  task?: { title: string; outcome: string; acceptance_criteria: readonly string[] } | null;
  /** The person already answered this task's questions, or went ahead without (no need to ask). */
  answered?: boolean;
  /** "Code tasks that need commands" (`code_commands`). */
  codeCommands: CodeCommands;
}

/**
 * What a task needs of its credential:
 * - **reading web pages** and **searching the web**, hard, when its specialist's entry names the
 *   page reader (`cc:WebFetch`) or web search (`cc:WebSearch`): research cannot be done properly
 *   without them;
 * - **asking the person while it works**, hard, when the task's own words say it needs the
 *   person's answers and they have not answered yet (`needsPersonsAnswers`);
 * - **running commands**, when its entry names `cc:Bash`: only better (its own tests), unless the
 *   person chose "Code tasks that need commands: the API key", which makes it hard.
 */
export function needsOf(input: NeedsInput): TaskNeeds {
  const t = input.registryTools;
  const hard: TaskNeed[] = [];
  const better: TaskNeed[] = [];
  if (t.includes(CC_WEB_FETCH) || t.includes(WEB_FETCH_TOOL)) hard.push("webRead");
  if (t.includes(CC_WEB_SEARCH)) hard.push("webSearch");
  if (input.task && !input.answered && needsPersonsAnswers(input.task)) hard.push("askPerson");
  if (t.includes(CC_BASH) || t.includes(RUN_COMMAND_TOOL))
    (input.codeCommands === "api_key" ? hard : better).push("commands");
  return { hard, better };
}

/**
 * Whether the folder's project has dependencies to install (its `package.json` names any), so its
 * checks run before the critic only where its dependencies are installed (`project-checks.ts`),
 * which a run without commands cannot do. False without a readable `package.json`.
 */
export function hasDependenciesToInstall(folder: string | null | undefined): boolean {
  if (!folder) return false;
  const file = join(folder, "package.json");
  if (!existsSync(file)) return false;
  try {
    const pkg = JSON.parse(readFileSync(file, "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const count = (d: unknown) => (d && typeof d === "object" ? Object.keys(d).length : 0);
    return count(pkg.dependencies) + count(pkg.devDependencies) > 0;
  } catch {
    return false;
  }
}

/** "your API key" at the start of a sentence. */
const where = (kind: BillingSourceKind) => yourCredential(kind);

/** "read web pages", "read web pages and search the web" (what only the chosen one can do). */
function canWords(needs: readonly TaskNeed[]): string {
  const words: Record<TaskNeed, string> = {
    webRead: "read web pages",
    webSearch: "search the web",
    askPerson: "ask you questions while it works",
    commands: "run commands",
  };
  const list = needs.map((n) => words[n]);
  return list.length <= 1
    ? (list[0] ?? "")
    : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * Where a task runs and why, in the person's words, or null when there is nothing to say (it runs
 * on the person's first choice and that one can do all it needs). The plan card, New task and
 * Settings show this sentence:
 * - none can do every hard need: what the chosen one can do and what follows ("Runs on your API
 *   key: it can read web pages here but not search, so the researcher reads pages whose
 *   address it knows.");
 * - only the chosen one can ("Runs on your API key: only it can read web pages here.");
 * - it runs where it cannot run commands on a project whose checks need its dependencies
 *   installed ("On your subscription its tests will not run: it cannot run commands there.").
 */
export function choiceLine(
  choice: CredentialChoice | null,
  opts: { specialist: string; dependencies: boolean },
): string | null {
  if (!choice || choice.kind === "fake") return null;
  const who = `the ${opts.specialist}`;
  const runsOn = `Runs on ${where(choice.kind)}`;
  const lacks = new Set(choice.lacks);
  const needs = new Set(choice.hard);
  if (lacks.size) {
    // P7-15: within 100 characters (it was about 122).
    if (lacks.has("webSearch") && needs.has("webRead") && !lacks.has("webRead"))
      return `${runsOn}: it reads web pages here but cannot search, so it reads known addresses.`;
    if (lacks.has("webRead") && needs.has("webSearch") && !lacks.has("webSearch"))
      return `${runsOn}: it can search the web here but not open pages yet, so ${who} works from search results.`;
    if (lacks.has("webRead"))
      return `${runsOn}, where it cannot read web pages: ${who} works from the project's files and the sources the brief gives.`;
    if (lacks.has("askPerson"))
      return `${runsOn}, where it cannot ask you while it works: ${who} lists its questions in its report.`;
    if (lacks.has("commands"))
      return `${runsOn}, where it cannot run commands: its tests will not run.`;
  }
  if (choice.onlyIt.length) return `${runsOn}: only it can ${canWords(choice.onlyIt)} here.`;
  if (choice.lost.includes("commands") && opts.dependencies)
    return choice.kind === "subscription"
      ? "On your subscription its tests will not run: it cannot run commands there."
      : `On ${where(choice.kind)} its tests will not run: it cannot run commands there.`;
  return null;
}

/**
 * Where a task of this specialist runs here, and the sentence (`choiceLine`): the chooser over the
 * saved kinds in the person's order (`kindsInOrder`, first used first). Null without one.
 */
export function credentialChoiceFor(input: {
  kindsInOrder: readonly BillingSourceKind[];
  needs: TaskNeeds;
  facts: ChooserFacts;
  specialist: string;
  dependencies: boolean;
}): { kind: BillingSourceKind; line: string | null } | null {
  const kinds = input.kindsInOrder.filter((k) => k !== "fake");
  const choice = chooseAmong(kinds, input.needs, input.facts);
  if (!choice) return null;
  return {
    kind: choice.kind,
    line: choiceLine(choice, { specialist: input.specialist, dependencies: input.dependencies }),
  };
}

/** The credentials the Settings table compares, in the order a person adds them. */
export const TABLE_KINDS = ["api_key", "subscription"] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

export interface AbilityTable {
  columns: { kind: TableKind; name: string; saved: boolean }[];
  rows: { need: TaskNeed | "cost"; label: string; cells: { can: boolean; words: string }[] }[];
}

/**
 * Settings' "What each can do here" (U-078): one row per need, one column per credential, read
 * from `capabilitiesOf` (and the words for where commands run), plus what each costs.
 */
export function abilityTable(
  facts: ChooserFacts,
  saved: readonly BillingSourceKind[],
): AbilityTable {
  const can = (k: TableKind) => capabilitiesOf(k, facts);
  const cell = (yes: boolean, words: string) => ({ can: yes, words });
  const key = can("api_key");
  const sub = can("subscription");
  return {
    columns: TABLE_KINDS.map((kind) => ({
      kind,
      name: kind === "api_key" ? "API key" : "Claude subscription",
      saved: saved.includes(kind),
    })),
    rows: [
      {
        need: "webRead",
        label: "Read web pages",
        cells: [
          cell(key.webRead, key.webRead ? "Yes" : "No: the page reader is off here"),
          cell(sub.webRead, sub.webRead ? "Yes" : "Not yet"),
        ],
      },
      {
        need: "webSearch",
        label: "Search the web",
        // 'web-search': the key searches unless something switched it off; the cell says what
        // (review of 'web-search': "Not yet" promised what the code does not do, §5.9).
        cells: [
          cell(
            key.webSearch,
            key.webSearch
              ? "Yes"
              : !facts.webFetch
                ? "No: the page reader is off here"
                : facts.keySearchOff
                  ? "No: switched off for this API key"
                  : "No: search is off here",
          ),
          cell(sub.webSearch, "Yes"),
        ],
      },
      {
        need: "commands",
        label: "Run commands (its tests)",
        cells: [
          cell(
            key.commands,
            facts.dockerReady === false
              ? "Yes, in a separate folder; a full review waits for Docker"
              : "Yes, in the sandbox",
          ),
          cell(sub.commands, sub.commands ? "Yes, outside the sandbox" : "No"),
        ],
      },
      {
        need: "askPerson",
        label: "Ask you while it works",
        cells: [
          cell(key.askPerson, "Yes"),
          cell(sub.askPerson, sub.askPerson ? "Yes" : "No: it lists its questions in its report"),
        ],
      },
      {
        need: "cost",
        label: "What it costs",
        cells: [cell(true, "Money per use"), cell(true, "Your plan's limits, no money per use")],
      },
    ],
  };
}
