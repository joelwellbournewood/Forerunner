import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  AGENT_TEXT_MARKER,
  type GitHost,
  hasWriteAccess,
  type IssueCommentInfo,
  type IssueInfo,
  issueRefusalOf,
  type RepoRef,
  type RepoRole,
  readForerunnerMarker,
} from "@forerunner/capabilities";
import type { StatusIssueState } from "@forerunner/memory";
import { type Clock, errorMessage, isAbsolute, join, log, safeSegment } from "@forerunner/platform";
import type { ProjectRow, StateStore, TaskRow } from "@forerunner/state";
import { handoffOf, keptOf } from "../session/budget-pause.ts";
import { clockTime } from "../session/credential-wait.ts";
import { extractPathHints } from "../session/peers.ts";
import { INSTALL_MARKER_FILE, parseInstallMarker } from "../sources/marker.ts";
import { markerNameOf } from "../sources/repository-use.ts";
import { isTogether } from "../sources/repository-words.ts";
import {
  type BodyWriter,
  commentChangedUpdate,
  docsStatusNote,
  duplicateIssueLine,
  issueDeletedUpdate,
  type LastSessionLine,
  OLD_STATUS_PR_LINE,
  type ParsedWriterComment,
  type PausedLine,
  parseWriterComment,
  readStatusIssueKey,
  renderIssueBody,
  renderWriterComment,
  STATUS_ISSUE_LABEL,
  type StatusPlace,
  statusIssuePolicy,
  statusIssueTitle,
  statusPlaceSentence,
  type WaitingLine,
  WORKING_HOLD_MS,
  type WorkingLine,
} from "./status-board-words.ts";

/**
 * The status issue (w8-status-write, ADR 0122; the owner's status design of 2026-11-02, D-W8-2):
 * each Forerunner keeps one comment on one pinned issue per project ("Forerunner status:
 * <project>"), saying what it works on now, what waits for Merge, what is paused and what its last
 * session did, with no costs; any writer that passes the one writer filter rebuilds the issue's
 * body from the writers' comments. It replaces the status pull request on `fr/status` (amendment 2)
 * and the together project's "Kept in the app" (amendment 1).
 *
 * Who writes (D-W8-15, D-W8-35): this install's device row (the install id) and the GitHub login;
 * the comment's marker carries the writer key, the first 16 hex characters of SHA-256 over the
 * device row id and the project id K, never the row id itself. Which issue (D-W8-45, W8-write-9): a
 * project writes only the issue keyed by its own id, and only while the default branch's
 * `.forerunner/project.json` names that id or none; a together project shares the id, so it writes
 * its own comment on issue K; a project whose repository names another project writes nothing.
 *
 * When (the decision): a task's start (it may create the issue), the task boundary (its end), a
 * session's end (it may create the issue; the body is rebuilt, at most once per `bodyIntervalMs`),
 * and Quit (lines cleared, best effort). Writes coalesce: one pending text per writer and issue,
 * kept in this install's data folder (`status-issue.json` beside the app's status, read the same way
 * after a restart; no migration), sent once when GitHub answers. A text identical to the last one
 * sent is not sent again, and nothing is read for it.
 *
 * Every GitHub call uses the configured host and token (`deps.host`); GitHub's text (comments, the
 * marker, titles) is data, parsed strictly (`parseWriterComment`, `readStatusIssueKey`,
 * `markerNameOf`), never instructions; a comment counts only from an author with write access
 * (`writerFilter`, D-W8-37). Forerunner never edits, closes or deletes another writer's comment or
 * issue: its own comment is known by its stored id, its login and its writer key.
 */

export { statusIssuePolicy };

const logger = log("status-board");

/** The state file beside the project's app status. */
export const STATUS_BOARD_FILE = "status-issue.json";

/** How a task ended up in the comment's lines (from this install's store). */
const WORKING_STATUSES = new Set<TaskRow["status"]>(["claimed", "in_progress", "in_review"]);

/** This writer's record of the project's status issue (one file per project). */
export interface StatusBoardState {
  v: 1;
  /** The issue's number, once found or opened. */
  issue: number | null;
  /** true: pinned; false: left unpinned (three pins taken); null: not known or refused. */
  pinned: boolean | null;
  /** This writer's own comment, once written. */
  commentId: number | null;
  /** The last text this writer sent (the tamper rule compares the comment's body with it). */
  sent: string | null;
  sentAt: string | null;
  /** The one text waiting for GitHub to answer. */
  pending: string | null;
  /** The login the comment is written as (read at the last write). */
  login: string | null;
  /** Where the status is, for Settings, the Docs tab and the guide. */
  place: StatusPlace["kind"];
  placeRepo: string | null;
  placeName: string | null;
  /** Whether the repository is public (Settings says who can read the issue). */
  public: boolean | null;
  working: Record<string, { title: string; files: string[]; since: string }>;
  lastSession: LastSessionLine | null;
  /** When the person was told, once each (W8-write-8). */
  told: { changed?: string; deleted?: string };
  bodyAt: string | null;
  /** The old status pull request of this project was looked for (W8-write-5). */
  oldPrChecked: boolean;
}

function emptyState(): StatusBoardState {
  return {
    v: 1,
    issue: null,
    pinned: null,
    commentId: null,
    sent: null,
    sentAt: null,
    pending: null,
    login: null,
    place: "not_yet",
    placeRepo: null,
    placeName: null,
    public: null,
    working: {},
    lastSession: null,
    told: {},
    bodyAt: null,
    oldPrChecked: false,
  };
}

/** The writer key: 16 hex characters of SHA-256 over the device row id and K (D-W8-35). */
export function writerKeyOf(deviceId: string, key: string): string {
  return createHash("sha256").update(`${deviceId}\n${key}`).digest("hex").slice(0, 16);
}

/** A comment's body without the agent's mark the port adds, for comparing texts. */
export function withoutAgentMark(body: string): string {
  return body.replace(/\r\n?/g, "\n").split(AGENT_TEXT_MARKER).join("").trimEnd();
}

/** The repository a project writes its status issue on, or null (a folder, no repository). */
export function statusRepoOf(project: Pick<ProjectRow, "repos">): RepoRef | null {
  const first = project.repos[0]?.trim() ?? "";
  if (!first || isAbsolute(first)) return null;
  const m = /^(?:https?:\/\/[^/]+\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(first);
  return m ? { owner: m[1] as string, name: m[2] as string } : null;
}

/**
 * The one writer filter (D-W8-37): a status comment counts as a writer's only when it carries a
 * valid marker for `key`, its header names the login that wrote it, and that login has write
 * access to the repository (write, maintain or admin; a refused read counts as none). The body
 * rebuild uses it here; w8-status-read's reader and w8-github-feed's block use the same function.
 */
export async function writerFilter(
  comment: Pick<IssueCommentInfo, "body" | "author">,
  key: string,
  roleOf: (login: string) => Promise<RepoRole>,
): Promise<ParsedWriterComment | null> {
  const parsed = parseWriterComment(comment.body);
  if (!parsed || parsed.key !== key) return null;
  if (parsed.login.toLowerCase() !== comment.author.toLowerCase()) return null;
  let role: RepoRole = "none";
  try {
    role = await roleOf(comment.author);
  } catch {
    role = "none";
  }
  return hasWriteAccess(role) ? parsed : null;
}

/** What the session runner tells the status board (event hooks only; nothing is awaited). */
export interface StatusBoardPort {
  taskStarted(
    projectId: string,
    task: Pick<TaskRow, "id" | "title" | "outcome" | "acceptance_criteria">,
  ): void;
  taskBoundary(projectId: string): void;
  sessionEnded(projectId: string, last: LastSessionLine): void;
}

export interface StatusBoardDeps {
  store: StateStore;
  clock: Clock;
  /** The configured GitHub host, or null when no token is saved (nothing is written then). */
  host: () => Promise<GitHost | null>;
  /** This runtime's device row id (the install id), or null when it has none. */
  writerId: () => string | null;
  /** The person's agent's name, as the comment's header names it. */
  agentName: () => Promise<string>;
  /** `<projectsRoot>/<project id>/` holds the state file. */
  projectsRoot: string;
  /** Tell the person once (an Update): the agent and the person the line goes to. */
  tell?: (projectId: string, body: string) => Promise<void>;
  /** The status issue's state changed (the guide refreshes, D-W8-44). */
  onStateChange?: (projectId: string) => void;
  /** The body is rebuilt at most once per this many milliseconds (default 30 s). */
  bodyIntervalMs?: number;
  /** A write GitHub did not take is tried again after this many milliseconds (default 60 s). */
  retryMs?: number;
  /** While a task runs, its lines are written again this often (default 30 minutes). */
  refreshMs?: number;
}

interface Wanted {
  /** The issue may be opened now (a task's start or a session's end). */
  create: boolean;
  /** The body is rebuilt. */
  body: boolean;
  /** Write even when the text did not change (the 30-minute refresh, a retry). */
  force: boolean;
}

interface Slot {
  running: Promise<void> | null;
  wanted: Wanted | null;
}

export class StatusBoard implements StatusBoardPort {
  private readonly slots = new Map<string, Slot>();
  private readonly timers = new Map<string, () => void>();
  private closed = false;
  private loginCache: { login: string; at: number } | null = null;

  constructor(private readonly deps: StatusBoardDeps) {}

  // ---------------------------------------------------------------------------------------
  // The runner's events
  // ---------------------------------------------------------------------------------------

  /** A task started (the runner's `task.started`): its Working on now line; may open the issue. */
  taskStarted(
    projectId: string,
    task: Pick<TaskRow, "id" | "title" | "outcome" | "acceptance_criteria">,
  ): void {
    if (this.closed) return;
    this.update(projectId, (s) => {
      const since = this.deps.clock.nowIso();
      s.working[task.id] = {
        title: task.title,
        files: filesOf(task),
        since: s.working[task.id]?.since ?? since,
      };
    });
    this.schedule(projectId, { create: true, body: true, force: false });
  }

  /** The task boundary (between tasks): a task that ended leaves Working on now. */
  taskBoundary(projectId: string): void {
    if (this.closed) return;
    this.schedule(projectId, { create: false, body: false, force: false });
  }

  /** A session ended: its Last session line, Working on now cleared; the body is rebuilt. */
  sessionEnded(projectId: string, last: LastSessionLine): void {
    if (this.closed) return;
    this.update(projectId, (s) => {
      s.working = {};
      s.lastSession = {
        endedAt: last.endedAt,
        done: [...last.done],
        next: [...last.next],
      };
    });
    this.schedule(projectId, { create: true, body: true, force: false });
  }

  /** Send what waits for GitHub (after a restart, or when a screen asks where the status is). */
  resume(projectId: string): void {
    if (this.closed) return;
    const s = this.read(projectId);
    if (s.pending === null) return;
    const slot = this.slots.get(projectId);
    if (slot?.running) return;
    this.schedule(projectId, { create: false, body: false, force: true });
  }

  /** Every project with a pending write (compose calls it once its services start). */
  async resumeAll(): Promise<void> {
    const projects = await this.deps.store.project.list({}, { limit: 1000 }).catch(() => []);
    for (const p of projects) this.resume(p.id);
  }

  /** Waits until nothing is being written (tests, the daemon's close). */
  async settled(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const running = [...this.slots.values()].map((s) => s.running).filter(Boolean);
      if (!running.length) return;
      await Promise.allSettled(running);
    }
  }

  /**
   * Quit (POST /shutdown) and the daemon's close: a project whose comment still says this install
   * works on something has those lines cleared, best effort, within `withinMs`; then nothing of the
   * writer runs (validation rule 4).
   */
  async close(withinMs = 5000): Promise<void> {
    if (this.closed) return;
    const projects = await this.deps.store.project.list({}, { limit: 1000 }).catch(() => []);
    for (const p of projects) {
      const s = this.read(p.id);
      if (Object.keys(s.working).length === 0) continue;
      this.update(p.id, (st) => {
        st.working = {};
      });
      this.schedule(p.id, { create: false, body: false, force: false });
    }
    this.closed = true;
    for (const cancel of this.timers.values()) cancel();
    this.timers.clear();
    let timer: (() => void) | null = null;
    await Promise.race([
      this.settled(),
      new Promise<void>((resolve) => {
        timer = this.deps.clock.setTimeout(resolve, withinMs);
      }),
    ]);
    (timer as (() => void) | null)?.();
  }

  // ---------------------------------------------------------------------------------------
  // What the screens and the guide read
  // ---------------------------------------------------------------------------------------

  /** Where the project's status is now, from this install's record (no GitHub call). */
  place(project: ProjectRow): StatusPlace {
    const repo = statusRepoOf(project);
    if (!repo) return { kind: "none" };
    if (!statusIssuePolicy(project).on) return { kind: "switched_off", projectName: project.name };
    const s = this.read(project.id);
    const repoName = `${repo.owner}/${repo.name}`;
    switch (s.place) {
      case "issues_off":
        return { kind: "issues_off", repo: s.placeRepo ?? repoName };
      case "no_permission":
        return { kind: "no_permission", repo: s.placeRepo ?? repoName };
      case "other_project":
        return { kind: "other_project", repo: s.placeRepo ?? repoName, projectName: s.placeName };
      case "closed":
        return s.issue ? { kind: "closed", issue: s.issue } : { kind: "not_yet" };
      case "waiting":
        return { kind: "waiting", lastAt: s.sentAt };
      case "on":
        return s.issue
          ? { kind: "on", issue: s.issue, pinned: s.pinned, lastAt: s.sentAt }
          : { kind: "not_yet" };
      default:
        return s.pending !== null ? { kind: "waiting", lastAt: s.sentAt } : { kind: "not_yet" };
    }
  }

  /**
   * The words the screens show for the project (W8-write-7): Settings' sentence under the
   * switch, the Docs tab's Status note, and whether the repository is public. Times in the
   * person's zone. Asking also sends a write that waits for GitHub (`resume`).
   */
  words(
    project: ProjectRow,
    timezone: string | undefined,
  ): { sentence: string | null; docsNote: string | null; public: boolean | null } {
    const place = this.place(project);
    if (place.kind === "none") return { sentence: null, docsNote: null, public: null };
    this.resume(project.id);
    const last =
      (place.kind === "waiting" || place.kind === "on") && place.lastAt
        ? clockTime(place.lastAt, timezone, this.deps.clock.now())
        : null;
    return {
      sentence: statusPlaceSentence(place, last),
      docsNote: docsStatusNote(place, last),
      public: this.isPublic(project.id),
    };
  }

  /** Whether the repository is public (null: not known yet). */
  isPublic(projectId: string): boolean | null {
    return this.read(projectId).public;
  }

  /**
   * The guide's fact (D-W8-44; w8-repo-guide's `guideStatusIssueState`): on, switched off in
   * Settings, or issues turned off on the repository. Never the issue's number.
   */
  guideState(project: Pick<ProjectRow, "id" | "settings">): StatusIssueState {
    if (!statusIssuePolicy(project).on) return "switched_off";
    return this.read(project.id).place === "issues_off" ? "issues_off" : "on";
  }

  // ---------------------------------------------------------------------------------------
  // The status pull request goes (W8-write-5) and the join's one write (w8-together)
  // ---------------------------------------------------------------------------------------

  /**
   * Closes the project's own open status pull request on `fr/status`, if an earlier version of
   * this install opened one (W8-write-5, amendment 2; the one GitHub write w8-together's join may
   * make, D-W8-45): its hidden mark names this project and this install's record names it (a
   * `docs.status_written` event of one of the project's sessions). One line on it, then closed;
   * one of another project, an unmarked one or one this install has no record of is never touched.
   */
  async closeOwnStatusPullRequest(project: ProjectRow): Promise<{ closed: number | null }> {
    const none = { closed: null };
    if (isTogether(project)) return none;
    const repo = statusRepoOf(project);
    const host = repo ? await this.deps.host() : null;
    if (!repo || !host) return none;
    const recorded = await this.recordedStatusPrUrls(project.id);
    if (!recorded.size) return none;
    const open = await host.listPullRequests(repo, { state: "open" });
    for (const pr of open) {
      if (pr.head.ref !== "fr/status") continue;
      if (readForerunnerMarker(pr.body ?? "")?.project !== project.id) continue;
      if (!recorded.has(pr.htmlUrl)) continue;
      await host.commentOnPullRequest(repo, pr.number, OLD_STATUS_PR_LINE);
      await host.updatePullRequest(repo, pr.number, { state: "closed" });
      logger.info("old status pull request closed", { projectId: project.id, number: pr.number });
      return { closed: pr.number };
    }
    return none;
  }

  /** The status pull requests this install opened for the project (its sessions' records). */
  private async recordedStatusPrUrls(projectId: string): Promise<Set<string>> {
    const out = new Set<string>();
    const sessions = await this.deps.store.session
      .list({ project_id: projectId }, { limit: 500 })
      .catch(() => []);
    for (const s of sessions) {
      const events = await this.deps.store.event
        .ofTypes(s.id, ["docs.status_written"], { limit: 5 })
        .catch(() => []);
      for (const e of events) {
        const p = (e.payload ?? {}) as { location?: unknown; branch?: unknown; prUrl?: unknown };
        if (p.location === "repo" && p.branch === "fr/status" && typeof p.prUrl === "string")
          out.add(p.prUrl);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------
  // The writer
  // ---------------------------------------------------------------------------------------

  private schedule(projectId: string, want: Wanted): void {
    const slot = this.slots.get(projectId) ?? { running: null, wanted: null };
    this.slots.set(projectId, slot);
    slot.wanted = slot.wanted
      ? {
          create: slot.wanted.create || want.create,
          body: slot.wanted.body || want.body,
          force: slot.wanted.force || want.force,
        }
      : want;
    if (!slot.running)
      slot.running = (async () => {
        try {
          while (slot.wanted) {
            const w = slot.wanted;
            slot.wanted = null;
            await this.flush(projectId, w).catch((e: unknown) =>
              logger.warn("status issue not written", { projectId, error: errorMessage(e) }),
            );
          }
        } finally {
          slot.running = null;
        }
      })();
  }

  private timer(name: string, ms: number, fn: () => void): void {
    if (this.closed) return;
    this.timers.get(name)?.();
    const cancel = this.deps.clock.setTimeout(() => {
      this.timers.delete(name);
      if (!this.closed) fn();
    }, ms);
    this.timers.set(name, cancel);
  }

  private async login(host: GitHost): Promise<string> {
    const now = this.deps.clock.now();
    if (this.loginCache && now - this.loginCache.at < 5 * 60_000) return this.loginCache.login;
    const { login } = await host.whoAmI();
    this.loginCache = { login, at: now };
    return login;
  }

  /** The comment's facts, from this install's store and record only. */
  private async facts(project: ProjectRow, s: StatusBoardState) {
    const { store } = this.deps;
    const tasks = await store.task.list({ project_id: project.id }, { limit: 2000 });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const records = await store.mergeRecord
      .list({ project_id: project.id }, { limit: 500 })
      .catch(() => []);
    const waiting: WaitingLine[] = [];
    const waitingIds = new Set<string>();
    for (const r of records) {
      const t = byId.get(r.task_id);
      if (!t || r.state === "merged" || !r.pr_number) continue;
      if (t.status === "cancelled" || t.status === "failed") continue;
      waiting.push({ number: r.pr_number, title: t.title, files: filesOf(t) });
      waitingIds.add(t.id);
    }
    waiting.sort((a, b) => a.number - b.number);
    const working: WorkingLine[] = [];
    for (const [id, w] of Object.entries(s.working)) {
      const t = byId.get(id);
      if (!t || !WORKING_STATUSES.has(t.status) || waitingIds.has(id)) continue;
      working.push({
        title: t.title,
        files: w.files,
        since: w.since,
        until: new Date(Date.parse(w.since) + WORKING_HOLD_MS).toISOString(),
      });
    }
    const paused: PausedLine[] = [];
    for (const t of tasks.filter((x) => x.status === "needs_human")) {
      const runs = (await store.run.forTask(t.id).catch(() => []))
        .filter((r) => r.specialist !== "critic" && !r.parent_run_id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      const last = runs[0];
      if (!last || (last.outcome !== "paused" && last.outcome !== "budget_exceeded")) continue;
      const handoff = handoffOf(last.artifacts);
      const kept = keptOf(last.artifacts);
      const checks = kept?.checks;
      paused.push({
        title: t.title,
        done: handoff?.stopped || null,
        left: handoff?.leftToDo ?? [],
        checksPass: checks?.length ? checks.every((c) => c.passed) : null,
        noProgress: kept?.noProgress === true || (!handoff?.stopped && !handoff?.leftToDo.length),
      });
    }
    return { working, waiting, paused };
  }

  /** The comment as this writer would send it now (null: no login known yet). */
  private async render(
    project: ProjectRow,
    s: StatusBoardState,
    login: string | null,
    writer: string,
  ): Promise<string | null> {
    if (!login) return null;
    const f = await this.facts(project, s);
    return renderWriterComment({
      key: project.id,
      writer,
      agentName: await this.deps.agentName(),
      login,
      updatedAt: this.deps.clock.nowIso(),
      working: f.working,
      waiting: f.waiting,
      paused: f.paused,
      claudeWait: null,
      lastSession: s.lastSession,
    });
  }

  private async flush(projectId: string, want: Wanted): Promise<void> {
    const project = await this.deps.store.project.get(projectId);
    if (!project || project.status === "archived") return;
    const repo = statusRepoOf(project);
    if (!repo) return;
    const before = this.read(projectId);
    const changeState = (
      place: StatusBoardState["place"],
      extra: Partial<StatusBoardState> = {},
    ) => {
      const was = this.read(projectId).place;
      this.update(projectId, (s) => {
        s.place = place;
        Object.assign(s, extra);
      });
      if ((was === "issues_off") !== (place === "issues_off")) this.deps.onStateChange?.(projectId);
    };
    if (!statusIssuePolicy(project).on) {
      // W8-write-10: switched off, this install writes no issue and no comment for the project.
      this.update(projectId, (s) => {
        s.pending = null;
      });
      return;
    }
    const host = await this.deps.host();
    const deviceId = this.deps.writerId();
    if (!host || !deviceId) return;
    const writer = writerKeyOf(deviceId, project.id);
    // The text as it would go now, with the login last read: the pending one if GitHub is out.
    const draft = await this.render(project, before, before.login, writer);
    if (
      draft &&
      !want.force &&
      before.place === "on" &&
      before.pending === null &&
      before.sent !== null &&
      contentOf(draft) === contentOf(before.sent)
    ) {
      if (want.body) await this.maybeBody(project, repo, host, writer, before);
      return;
    }
    if (draft)
      this.update(projectId, (s) => {
        s.pending = draft;
      });
    try {
      const info = await host.getRepo(repo);
      const repoName = `${repo.owner}/${repo.name}`;
      this.update(projectId, (s) => {
        s.public = info.private === false;
      });
      if (info.hasIssues === false) {
        changeState("issues_off", { placeRepo: repoName });
        return;
      }
      const login = await this.login(host);
      // W8-write-9 (D-W8-45): only the issue keyed by this project's own id, only while the
      // default branch's marker names this id or none.
      const markerFile = await host.getFile(repo, INSTALL_MARKER_FILE, info.defaultBranch);
      const marker = markerFile ? parseInstallMarker(markerFile.content) : null;
      if (marker && marker.project.toLowerCase() !== project.id.toLowerCase()) {
        changeState("other_project", {
          placeRepo: repoName,
          placeName: markerNameOf(marker.name),
          pending: null,
        });
        return;
      }
      if (!before.oldPrChecked) {
        // W8-write-5: an old status pull request this install opened for the project is closed.
        await this.closeOwnStatusPullRequest(project).catch((e: unknown) =>
          logger.warn("old status pull request not checked", {
            projectId,
            error: errorMessage(e),
          }),
        );
        this.update(projectId, (s) => {
          s.oldPrChecked = true;
        });
      }
      const issue = await this.issueOf(project, repo, host, login, want.create);
      if (!issue) {
        changeState("not_yet", { login });
        return;
      }
      if (issue.state === "closed") {
        // W8-write-8: a closed issue is not reopened; writes stop while it is closed.
        changeState("closed", { issue: issue.number, pending: null, login });
        return;
      }
      const text = (await this.render(project, this.read(projectId), login, writer)) as string;
      const own = await this.ownComment(project, repo, host, issue.number, login, writer);
      const s = this.read(projectId);
      let comment: IssueCommentInfo;
      if (!own) {
        comment = await host.commentOnIssue(repo, issue.number, text);
      } else {
        if (s.sent !== null && withoutAgentMark(own.body) !== withoutAgentMark(s.sent)) {
          // W8-write-8: changed on GitHub by someone (the REST comment names no editor): found by
          // comparing with the text this writer last sent; the person is told once, and the
          // comment gets this writer's text again.
          if (!s.told.changed) {
            await this.deps
              .tell?.(projectId, commentChangedUpdate(issue.number))
              .catch(() => undefined);
            this.update(projectId, (st) => {
              st.told.changed = this.deps.clock.nowIso();
            });
          }
          logger.info("status comment changed on GitHub; written again", { projectId });
        }
        comment =
          withoutAgentMark(own.body) === withoutAgentMark(text)
            ? own
            : await host.updateIssueComment(repo, own.id, text);
      }
      changeState("on", {
        issue: issue.number,
        commentId: comment.id,
        sent: text,
        sentAt: this.deps.clock.nowIso(),
        pending: null,
        login,
        placeRepo: repoName,
      });
      if (want.body) await this.maybeBody(project, repo, host, writer, this.read(projectId));
      // While a task runs its lines are written again every 30 minutes (the decision's "every
      // 30 minutes while the task runs").
      if (Object.keys(this.read(projectId).working).length)
        this.timer(`refresh:${projectId}`, this.deps.refreshMs ?? 30 * 60_000, () =>
          this.schedule(projectId, { create: false, body: false, force: true }),
        );
    } catch (e) {
      const refusal = issueRefusalOf(e);
      const repoName = `${repo.owner}/${repo.name}`;
      if (refusal === "issues_off") changeState("issues_off", { placeRepo: repoName });
      else if (refusal === "no_permission" || refusal === "token_refused")
        changeState("no_permission", { placeRepo: repoName });
      else {
        // GitHub did not answer (or a read raced a delete): the text waits; tried again later.
        changeState("waiting");
        this.timer(`retry:${projectId}`, this.deps.retryMs ?? 60_000, () => this.resume(projectId));
      }
      logger.info("status issue write waits", {
        projectId,
        reason: refusal ?? "error",
        error: errorMessage(e),
      });
    }
  }

  /** The role of `login` on the repository, read once per call site (fails closed). */
  private roles(host: GitHost, repo: RepoRef, login: string) {
    const seen = new Map<string, Promise<RepoRole>>();
    return (who: string): Promise<RepoRole> => {
      const k = who.toLowerCase();
      if (k === login.toLowerCase()) return Promise.resolve("write");
      let p = seen.get(k);
      if (!p) {
        p = host.getRepoPermission(repo, who).catch(() => "none" as RepoRole);
        seen.set(k, p);
      }
      return p;
    };
  }

  /**
   * The project's status issue: the stored number, then the open issues carrying the marker of K,
   * then the title (each opened by someone with write access); the lowest number wins. None and
   * `create`: this writer opens it (labelled, pinned while fewer than three are pinned), and when
   * another writer opened one at the same time, the lower number stays and this one is closed
   * with one line. A deleted issue gets one new issue and the person is told once.
   */
  private async issueOf(
    project: ProjectRow,
    repo: RepoRef,
    host: GitHost,
    login: string,
    create: boolean,
  ): Promise<IssueInfo | null> {
    const key = project.id;
    const s = this.read(project.id);
    let deleted: number | null = null;
    if (s.issue) {
      try {
        const known = await host.getIssue(repo, s.issue);
        if (!known.isPullRequest && readStatusIssueKey(known.body) === key) return known;
        if (!known.isPullRequest && known.title === statusIssueTitle(project.name)) return known;
      } catch (e) {
        if (issueRefusalOf(e) !== "missing") throw e;
        deleted = s.issue;
      }
      this.update(project.id, (st) => {
        st.issue = null;
        st.commentId = null;
        st.pinned = null;
      });
    }
    const role = this.roles(host, repo, login);
    const found = await this.lowestIssue(project, repo, host, role);
    if (found) {
      this.update(project.id, (st) => {
        st.issue = found.number;
      });
      return found;
    }
    if (!create) return null;
    let made: IssueInfo;
    const opts = { title: statusIssueTitle(project.name), body: renderIssueBody(key, []) };
    try {
      made = await host.createIssue(repo, { ...opts, labels: [STATUS_ISSUE_LABEL] });
    } catch (e) {
      // A label the token may not add (GitHub drops it, or refuses): the issue without it.
      const r = issueRefusalOf(e);
      if (
        r === "issues_off" ||
        r === "unreachable" ||
        r === "rate_limited" ||
        r === "token_refused"
      )
        throw e;
      made = await host.createIssue(repo, opts);
    }
    // Two Forerunners opening at once: the lowest number wins, the other closes its own.
    const lowest = await this.lowestIssue(project, repo, host, role);
    let issue = made;
    if (lowest && lowest.number < made.number) {
      await host.commentOnIssue(repo, made.number, duplicateIssueLine(lowest.number));
      await host.updateIssue(repo, made.number, { state: "closed" });
      issue = lowest;
    }
    let pinned: boolean | null = null;
    try {
      const pin = await host.pinIssue(repo, issue.number);
      pinned = pin === "pinned" ? true : pin === "limit" ? false : null;
    } catch (e) {
      logger.info("status issue not pinned", { projectId: project.id, error: errorMessage(e) });
    }
    this.update(project.id, (st) => {
      st.issue = issue.number;
      st.pinned = pinned;
      st.commentId = null;
    });
    if (deleted !== null && !s.told.deleted) {
      await this.deps.tell?.(project.id, issueDeletedUpdate(deleted)).catch(() => undefined);
      this.update(project.id, (st) => {
        st.told.deleted = this.deps.clock.nowIso();
      });
    }
    return issue;
  }

  private async lowestIssue(
    project: ProjectRow,
    repo: RepoRef,
    host: GitHost,
    role: (login: string) => Promise<RepoRole>,
  ): Promise<IssueInfo | null> {
    const open = (await host.listIssues(repo, { state: "open", sort: "created", direction: "asc" }))
      .filter((i) => !i.isPullRequest)
      .sort((a, b) => a.number - b.number);
    const byWriter = async (list: IssueInfo[]) => {
      for (const i of list) if (hasWriteAccess(await role(i.author))) return i;
      return null;
    };
    return (
      (await byWriter(open.filter((i) => readStatusIssueKey(i.body) === project.id))) ??
      (await byWriter(open.filter((i) => i.title === statusIssueTitle(project.name))))
    );
  }

  /**
   * This writer's own comment on the issue: by its stored id, else by its login and writer key;
   * a comment by another login carrying this writer key is that login's and never this writer's
   * (W8-write-8). Null when there is none (a deleted one is written again).
   */
  private async ownComment(
    project: ProjectRow,
    repo: RepoRef,
    host: GitHost,
    issue: number,
    login: string,
    writer: string,
  ): Promise<IssueCommentInfo | null> {
    const mine = (c: IssueCommentInfo) => {
      const p = parseWriterComment(c.body);
      return (
        c.issueNumber === issue &&
        c.author.toLowerCase() === login.toLowerCase() &&
        p?.key === project.id &&
        p.writer === writer
      );
    };
    const s = this.read(project.id);
    if (s.commentId) {
      const c = await host.getIssueComment(repo, s.commentId).catch((e: unknown) => {
        if (issueRefusalOf(e) === "missing") return null;
        throw e;
      });
      if (c && c.author.toLowerCase() === login.toLowerCase() && c.issueNumber === issue) {
        // Its marker may have been changed by an edit: still this writer's by its id and login.
        if (mine(c) || readStatusIssueKey(c.body) === null) return c;
      }
    }
    const read = await host.listIssueComments(repo, issue);
    const own = read.comments.filter(mine).sort((a, b) => b.id - a.id);
    return own[0] ?? null;
  }

  /** The body rebuilt from the writers' comments, at most once per interval (trailing). */
  private async maybeBody(
    project: ProjectRow,
    repo: RepoRef,
    host: GitHost,
    writer: string,
    s: StatusBoardState,
  ): Promise<void> {
    if (!s.issue) return;
    const interval = this.deps.bodyIntervalMs ?? 30_000;
    const last = s.bodyAt ? Date.parse(s.bodyAt) : 0;
    const wait = last + interval - this.deps.clock.now();
    if (wait > 0) {
      this.timer(`body:${project.id}`, wait, () =>
        this.schedule(project.id, { create: false, body: true, force: false }),
      );
      return;
    }
    await this.rebuildBody(project, repo, host, s.issue, writer).catch((e: unknown) =>
      logger.info("status issue body not rebuilt", {
        projectId: project.id,
        error: errorMessage(e),
      }),
    );
  }

  private async rebuildBody(
    project: ProjectRow,
    repo: RepoRef,
    host: GitHost,
    issue: number,
    _writer: string,
  ): Promise<void> {
    const login = await this.login(host);
    const role = this.roles(host, repo, login);
    let etag: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const read = await host.listIssueComments(repo, issue);
      etag = read.etag ?? undefined;
      const writers: BodyWriter[] = [];
      const seen = new Set<string>();
      for (const c of [...read.comments].sort((a, b) => b.id - a.id)) {
        const parsed = await writerFilter(c, project.id, role);
        if (!parsed) continue;
        const k = `${c.author.toLowerCase()}:${parsed.writer}`;
        if (seen.has(k)) continue;
        seen.add(k);
        writers.push({
          login: c.author,
          agentName: parsed.agentName,
          updated: parsed.updated,
          working: parsed.working,
          waiting: parsed.waiting,
          paused: parsed.paused,
          lastSession: parsed.lastSession,
        });
      }
      writers.sort(
        (a, b) => a.login.localeCompare(b.login) || a.agentName.localeCompare(b.agentName),
      );
      const body = renderIssueBody(project.id, writers);
      const current = await host.getIssue(repo, issue);
      if (current.state !== "open") return;
      if (withoutAgentMark(current.body) !== withoutAgentMark(body))
        await host.updateIssue(repo, issue, { body });
      this.update(project.id, (s) => {
        s.bodyAt = this.deps.clock.nowIso();
      });
      // A comment changed after the snapshot: read and rebuilt once more, at most.
      const again = await host.listIssueComments(repo, issue, etag ? { etag } : {});
      if (again.notModified || !etag) return;
    }
  }

  // ---------------------------------------------------------------------------------------
  // The record
  // ---------------------------------------------------------------------------------------

  private file(projectId: string): string {
    return join(this.deps.projectsRoot, safeSegment(projectId, "project"), STATUS_BOARD_FILE);
  }

  /** This writer's record of the project (an empty one when none was written yet). */
  read(projectId: string): StatusBoardState {
    const file = this.file(projectId);
    if (!existsSync(file)) return emptyState();
    try {
      const o = JSON.parse(readFileSync(file, "utf8")) as Partial<StatusBoardState>;
      return {
        ...emptyState(),
        ...o,
        working: { ...(o.working ?? {}) },
        told: { ...(o.told ?? {}) },
      };
    } catch {
      return emptyState();
    }
  }

  private update(projectId: string, fn: (s: StatusBoardState) => void): void {
    const s = this.read(projectId);
    fn(s);
    const file = this.file(projectId);
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(s, null, 1)}\n`, "utf8");
      renameSync(tmp, file);
    } catch (e) {
      logger.warn("status issue record not written", { projectId, error: errorMessage(e) });
    }
  }
}

/** The text without its header line (the time in it changes every minute). */
function contentOf(text: string): string {
  return withoutAgentMark(text)
    .split("\n")
    .filter((_l, i) => i !== 1)
    .join("\n");
}

/** The files a task names (its title, outcome and criteria), as Working on now lists them. */
function filesOf(task: Pick<TaskRow, "title" | "outcome" | "acceptance_criteria">): string[] {
  return extractPathHints(
    [task.title, task.outcome, ...(task.acceptance_criteria ?? [])].join("\n"),
    5,
  );
}
