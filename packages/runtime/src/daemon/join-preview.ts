import { DEFAULT_SESSION_CAP_CHF, formatChf } from "@forerunner/billing";
import type { ProjectRow, StateStore, TaskRow } from "@forerunner/state";
import { statusPullRequestOn } from "../loop/docs.ts";
import { isClosedRecord, MERGE_MODE_WORDS, mergeModeOf } from "../loop/merge-mode.ts";
import { moneyWords } from "../session/money-words.ts";
import { startPendingOf } from "../session/prepared-work.ts";
import { type LinkIdentity, linkWords, type RepositoryIndex } from "../sources/repository-use.ts";
import { isTogether, togetherOf } from "../sources/repository-words.ts";
import { researchReadsLine, webAccessOf } from "../wiring/web-access.ts";
import type { JoinPreviewView } from "./api-types.ts";
import {
  JOIN_REFUSED_CHOOSE,
  JOIN_REFUSED_NOT_YOURS,
  joinedIntoOf,
  joinMovesLine,
  joinRefusedDrafting,
  joinRefusedGone,
  joinRefusedHeldStart,
  joinRefusedMerging,
  joinRefusedNoLink,
  joinRefusedPlan,
  joinRefusedRunning,
  joinRefusedWaiting,
  joinStaysLine,
  keptTogetherLine,
  settingAppliesLine,
  sharedLinkSentence,
} from "./join-words.ts";

/**
 * Make one project (d1109-onerepo-join, D1, ADR 0117 amended 2026-11-16): which projects on this
 * computer share a repository or folder (made before one repository was one project), what the
 * dialog shows of each, and why a join cannot be made now. Everything here only reads; the moves
 * are `project.join`'s (`@forerunner/commands`), in one store transaction, after this module's
 * `joinRefusal` said nothing holds them.
 */

/** What the join's checks read beyond the store. */
export interface JoinDeps {
  store: StateStore;
  humanId: string;
  agentId: string | null;
  /** The index over this computer's projects (`RepositoryUse.index`), read now. */
  index(): Promise<RepositoryIndex>;
  /** The identities of a project's links (`RepositoryUse.identities`); a bad link is none. */
  identities(repos: readonly string[]): LinkIdentity[];
  /**
   * d1109-starts-engine (read only): when a session of the project kept to go on after its
   * Claude credential, or a Start kept for the reset, goes on ("at 15:40", or null when the time
   * is not known); undefined when none waits (`keptContinuationOf`, `keptStartOf`).
   */
  keptWaitWhen(projectId: string): Promise<string | null | undefined>;
  /** CHF per USD at the day's rate. */
  chfPerUsd(): number;
}

/** The repository or folder two or more projects here share, with them oldest first. */
export interface SharedLink {
  link: { kind: "repo" | "folder"; locator: string };
  /** Every project here on the link, this one among them, oldest first. */
  projects: ProjectRow[];
}

const byAge = (a: ProjectRow, b: ProjectRow) =>
  a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);

/**
 * OJ-01: the projects on this computer that work in the same repository or folder as `project`
 * (the one index of d1109-onerepo-link: every spelling of a link is one), or null when it is the
 * only one. A removed or joined project uses nothing.
 */
export async function sharedLinkOf(
  deps: Pick<JoinDeps, "index" | "identities">,
  project: ProjectRow,
  index?: RepositoryIndex,
): Promise<SharedLink | null> {
  if (project.status === "archived") return null;
  const links = deps.identities(project.repos ?? []);
  if (!links.length) return null;
  const ix = index ?? (await deps.index());
  for (const link of links) {
    const others = ix.projectsUsing(link, project.id);
    if (!others.length) continue;
    const uses = [{ project, identity: link }, ...others].sort((a, b) =>
      byAge(a.project, b.project),
    );
    // Spelled as the oldest project has it, so every Overview of the set says the same.
    const first = uses[0]?.identity ?? link;
    return {
      link: { kind: link.kind, locator: linkWords(first, first) },
      projects: uses.map((u) => u.project),
    };
  }
  return null;
}

/** The card's field (`ProjectCard.sharesRepositoryWith`): the line and the others' names. */
export async function sharesRepositoryWith(
  deps: Pick<JoinDeps, "index" | "identities">,
  project: ProjectRow,
): Promise<JoinPreviewView["shared"] | null> {
  const shared = await sharedLinkOf(deps, project);
  if (!shared) return null;
  return {
    text: sharedLinkSentence(
      shared.projects.map((p) => p.name),
      shared.link,
    ),
    projects: shared.projects
      .filter((p) => p.id !== project.id)
      .map((p) => ({ id: p.id, name: p.name })),
  };
}

/**
 * Whether the project is this person's own (its members name their agent, they made it, or
 * nothing records an owner): a project only shared with them is another person's, and nothing
 * of another person is moved (the area's security line).
 */
export function ownsOwnProject(
  project: Pick<ProjectRow, "settings" | "author_human">,
  who: { humanId: string; agentId: string | null },
): boolean {
  const settings = (project.settings ?? {}) as { members?: unknown; shared_with?: unknown };
  const ids = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const members = ids(settings.members);
  if (who.agentId !== null && members.includes(who.agentId)) return true;
  if (project.author_human && project.author_human === who.humanId) return true;
  // Shared with them by its owner: another person's project.
  if (ids(settings.shared_with).includes(who.humanId)) return false;
  return members.length === 0 && !project.author_human;
}

/** A session of the project that works now (never the chat's own row or a planning call). */
async function workingSession(
  store: StateStore,
  projectId: string,
): Promise<"work" | "planning" | null> {
  const rows = await store.session.list({
    project_id: projectId,
    status: ["running", "paused", "planned"],
  } as never);
  let planning = false;
  for (const s of rows) {
    if (s.summary === "conversation") continue;
    const plan = s.plan as { intake?: unknown } | null;
    if (plan && typeof plan === "object" && !Array.isArray(plan) && plan.intake) {
      planning = true;
      continue;
    }
    return "work";
  }
  return planning ? "planning" : null;
}

/** The project's plan card waits for the person (the intake's open card). */
async function planCardOpen(store: StateStore, projectId: string): Promise<boolean> {
  const open = await store.humanRequest.list({ project_id: projectId, status: "open" } as never, {
    limit: 1000,
  });
  return open.some((r) => {
    const key = (r.change_card as { key?: unknown } | null)?.key;
    return typeof key === "string" && key.startsWith("intake:");
  });
}

/** A merge of one of the project's pull requests is under way now (ADR 0111's `merging`). */
async function mergeInFlight(store: StateStore, projectId: string): Promise<boolean> {
  const rows = await store.mergeRecord.list({ project_id: projectId, state: "merging" } as never, {
    limit: 1,
  });
  return rows.length > 0;
}

/** What a join of these projects is asked as (ids or names already resolved to rows). */
export interface JoinRequest {
  keep: ProjectRow;
  close: ProjectRow[];
}

/**
 * Why the join cannot be made now, in one sentence; null when nothing holds it (OJ-02). The
 * shape first (a project gone, not the person's own, sharing no link), then what runs or waits
 * on either project (a session working, one waiting to go on, a held hands-off start), then the
 * closing projects' own holds (their plan waiting for an answer, a merge under way). Nothing
 * moves under a running worker, and nothing the person was told will go on is dropped.
 */
export async function joinRefusal(deps: JoinDeps, req: JoinRequest): Promise<string | null> {
  const { keep, close } = req;
  if (!close.length || close.some((c) => c.id === keep.id)) return JOIN_REFUSED_CHOOSE;
  const all = [keep, ...close];
  for (const p of all) {
    if (p.status === "archived" || joinedIntoOf(p)) return joinRefusedGone(p.name);
  }
  const who = { humanId: deps.humanId, agentId: deps.agentId };
  if (all.some((p) => !ownsOwnProject(p, who))) return JOIN_REFUSED_NOT_YOURS;
  const index = await deps.index();
  const shared = await sharedLinkOf(deps, keep, index);
  for (const c of close) {
    if (!shared?.projects.some((p) => p.id === c.id)) return joinRefusedNoLink([keep.name, c.name]);
  }
  // OJ-11: a pair of which one is worked on together keeps that one (the project GitHub knows).
  const together = close.find((c) => isTogether(c));
  if (together && !isTogether(keep)) return keptTogetherLine(together.name);
  for (const p of all) {
    const working = await workingSession(deps.store, p.id);
    if (working === "work") return joinRefusedRunning(p.name);
    if (working === "planning") return joinRefusedDrafting(p.name);
  }
  for (const p of all) {
    const when = await deps.keptWaitWhen(p.id);
    if (when !== undefined) return joinRefusedWaiting(p.name, when);
    if (startPendingOf(p)) return joinRefusedHeldStart(p.name);
  }
  for (const c of close) {
    if (await planCardOpen(deps.store, c.id)) return joinRefusedPlan(c.name);
    if (await mergeInFlight(deps.store, c.id)) return joinRefusedMerging(c.name);
  }
  return null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "CHF 3.20", never "CHF 0.00" for an amount above zero. */
function chfWords(chfMicro: number): string {
  return moneyWords(formatChf(chfMicro), chfMicro);
}

/** A project's budget per session as Settings names it (CHF 5.00 unless set). */
export function sessionBudgetWords(p: Pick<ProjectRow, "settings">, chfPerUsd: number): string {
  const s = p.settings as { session_cap_usd_micro?: unknown; session_cap_chf_micro?: unknown };
  if (typeof s.session_cap_usd_micro === "number" && s.session_cap_usd_micro > 0) {
    const chf =
      typeof s.session_cap_chf_micro === "number"
        ? s.session_cap_chf_micro
        : Math.round(s.session_cap_usd_micro * chfPerUsd);
    return chfWords(chf);
  }
  return chfWords(DEFAULT_SESSION_CAP_CHF * 1_000_000);
}

/** A project's budget in all ("no project budget" for 0: only the monthly cap limits it). */
export function projectBudgetWords(
  p: Pick<ProjectRow, "budget_usd_micro">,
  chfPerUsd: number,
): string {
  return p.budget_usd_micro > 0
    ? chfWords(Math.round(p.budget_usd_micro * chfPerUsd))
    : "no project budget";
}

/** Whether the project's link is a repository on the host (who merges applies only there). */
function onRepository(deps: Pick<JoinDeps, "identities">, p: ProjectRow): boolean {
  return deps.identities(p.repos ?? []).some((l) => l.kind === "repo");
}

/**
 * The pull requests of the tasks that are open on GitHub as the store knows it (L4-github-114):
 * a task's pull request that is neither merged (its own, or merged through another) nor closed
 * there (`isClosedRecord`: the watcher read the close), and a take-out pull request that waits.
 * Before, a pull request closed on GitHub counted as open, beside its row's "Accepted · pull
 * request closed".
 */
async function openPullRequests(store: StateStore, tasks: readonly TaskRow[]): Promise<number> {
  let n = 0;
  for (const t of tasks) {
    if (!t.pr_url || t.status === "cancelled") continue;
    const record = await store.mergeRecord.forTask(t.id);
    const ofThis = record?.pr_url === t.pr_url ? record : undefined;
    if (ofThis?.take_out_state === "open") n += 1;
    if (ofThis?.state === "merged" || (ofThis && isClosedRecord(ofThis))) continue;
    n += 1;
  }
  return n;
}

/**
 * OJ-05: the dialog's facts (GET /projects/:id/join-preview): each project with its open and done
 * tasks, open pull requests, what it spent so far in CHF, its budget per session, project budget,
 * who merges and what research reads; and, for each project as the kept one, what moves, what
 * stays, each setting of the kept project that differs and what holds the join now.
 */
export async function joinPreview(
  deps: JoinDeps,
  project: ProjectRow,
  withIds: readonly string[],
): Promise<JoinPreviewView> {
  const shared = await sharedLinkOf(deps, project);
  const rows = shared
    ? shared.projects.filter(
        (p) => p.id === project.id || !withIds.length || withIds.includes(p.id),
      )
    : [project];
  const rate = deps.chfPerUsd();
  const projects: JoinPreviewView["projects"] = [];
  const settings = new Map<string, { label: string; value: string }[]>();
  for (const p of rows) {
    const tasks = await deps.store.task.list({ project_id: p.id } as never, { limit: 5000 });
    const done = tasks.filter((t) => t.status === "done").length;
    const open = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
    const prs = await openPullRequests(deps.store, tasks);
    const spent = await deps.store.costLedger.sum({ projectId: p.id });
    const own: { label: string; value: string }[] = [
      { label: "Budget per session", value: sessionBudgetWords(p, rate) },
      { label: "Project budget", value: projectBudgetWords(p, rate) },
      ...(onRepository(deps, p)
        ? [{ label: "Who merges", value: MERGE_MODE_WORDS[mergeModeOf(p.settings)] }]
        : []),
      // L4-github-113: the status pull request moves too, so its setting is named (a project
      // worked on together has none, L4-github-103).
      ...(onRepository(deps, p) && !isTogether(p)
        ? [{ label: "Status pull request", value: statusPullRequestOn(p) ? "On" : "Off" }]
        : []),
      {
        label: "Research reads",
        value: researchReadsLine(webAccessOf(p.settings)).replace(/^Research reads: /, ""),
      },
    ];
    settings.set(p.id, own);
    const taskWords =
      open && done
        ? `${plural(open, "open task")}, ${done} done`
        : open
          ? plural(open, "open task")
          : done
            ? `${plural(done, "task")} done`
            : "No tasks yet";
    projects.push({
      id: p.id,
      name: p.name,
      together: isTogether(p),
      lines: [
        taskWords,
        ...(prs ? [plural(prs, "open pull request")] : []),
        `Spent so far: ${chfWords(spent.chf_micro)}`,
        ...own.map((s) => `${s.label}: ${s.value}`),
      ],
    });
  }
  const ifKept: JoinPreviewView["ifKept"] = {};
  for (const keep of rows) {
    const close = rows.filter((p) => p.id !== keep.id);
    const names = close.map((p) => p.name);
    const mine = settings.get(keep.id) ?? [];
    const differs: string[] = [];
    for (const s of mine) {
      if (
        close.some(
          (c) => (settings.get(c.id) ?? []).find((x) => x.label === s.label)?.value !== s.value,
        )
      )
        // Inside the sentence a value reads in lower case ("you press Merge"), an amount as it is.
        differs.push(
          settingAppliesLine(
            s.label,
            keep.name,
            /^CHF /.test(s.value) ? s.value : s.value.charAt(0).toLowerCase() + s.value.slice(1),
          ),
        );
    }
    ifKept[keep.id] = {
      moves: close.length ? joinMovesLine(keep.name, names) : "",
      stays: close.length ? joinStaysLine(names) : "",
      settings: differs,
      refusal: await joinRefusal(deps, { keep, close }),
    };
  }
  const together = rows.find((p) => isTogether(p));
  return {
    projectId: project.id,
    shared: shared
      ? {
          text: sharedLinkSentence(
            shared.projects.map((p) => p.name),
            shared.link,
          ),
          projects: shared.projects
            .filter((p) => p.id !== project.id)
            .map((p) => ({ id: p.id, name: p.name })),
        }
      : null,
    projects,
    ifKept,
    keepOnly: together ? together.id : null,
    keepOnlyLine: together ? keptTogetherLine(togetherOf(together)?.name || together.name) : null,
  };
}
