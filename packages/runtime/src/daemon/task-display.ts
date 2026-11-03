import type { BillingSourceKind } from "@forerunner/billing";
import type {
  EventRow,
  HumanRequestRow,
  JsonValue,
  ReviewRow,
  RunRow,
  StateStore,
  TaskRow,
} from "@forerunner/state";
import { type CredentialWaitWords, waitRowWords } from "../session/credential-wait.ts";
import { TASK_FILES_EVENT } from "../session/peers.ts";
import { stopLimitWords, stopReasonOfHandoff } from "../session/stop-words.ts";
import { waitingOf } from "../wiring/billing-pick.ts";
import type { TaskCheck, TaskDetailView, TaskReviewEvidence, TaskView } from "./api-types.ts";
import { verdictWords } from "./event-lines.ts";
import { holdsTask, plainPlurals, plainReason, type TaskDisplayContext } from "./task-words.ts";

export * from "./task-words.ts";

/** As `views.money` (not imported: views reads this module through the project's health). */
function money(usdMicro: number, chfPerUsd: number) {
  return { usdMicro, chfMicro: Math.round(usdMicro * chfPerUsd) };
}

/** Reads what `taskDisplay` needs for the tasks of one project. */
export async function loadTaskDisplayContext(
  store: StateStore,
  projectTasks: readonly TaskRow[],
  sandboxReady: boolean | null,
): Promise<TaskDisplayContext> {
  const tasks = new Map(projectTasks.map((t) => [t.id, t]));
  // A task waits for tasks of its own project; one from elsewhere (an old row) is read too.
  for (const t of projectTasks)
    for (const d of t.depends_on)
      if (!tasks.has(d)) {
        const row = await store.task.get(d);
        if (row) tasks.set(d, row);
      }
  const projectId = projectTasks[0]?.project_id;
  const cards = new Map<string, HumanRequestRow>();
  if (projectId) {
    const open = await store.humanRequest.list({ status: "open", project_id: projectId } as never, {
      orderBy: [{ column: "created_at" }, { column: "id" }],
      limit: 1000,
    });
    for (const r of open)
      if (r.task_id && !cards.has(r.task_id) && holdsTask(r)) cards.set(r.task_id, r);
  }
  const runs = new Map<string, RunRow>();
  const agentNames = new Map<string, string>();
  for (const t of projectTasks) {
    if (t.status !== "claimed" && t.status !== "in_progress") continue;
    const latest = await store.run.list({ task_id: t.id } as never, {
      orderBy: [{ column: "created_at", direction: "desc" }],
      limit: 1,
    });
    if (latest[0]) runs.set(t.id, latest[0]);
    if (t.claimed_by && !agentNames.has(t.claimed_by)) {
      const agent = await store.agent.get(t.claimed_by);
      if (agent) agentNames.set(agent.id, agent.name);
    }
  }
  // ADR 0104: a done task says how it was checked ("Reviewed", "Reviewed and tried").
  const reviews = new Map<string, Pick<ReviewRow, "verdict" | "evidence">>();
  for (const t of projectTasks) {
    if (t.status !== "done") continue;
    const latest = await store.review.latestForTask(t.id);
    if (latest) reviews.set(t.id, latest);
  }
  const credentialWait = projectId ? await credentialWaitRow(store, projectId) : null;
  return {
    tasks,
    cards,
    sandboxReady,
    runs,
    agentNames,
    reviews,
    ...(credentialWait ? { credentialWait } : {}),
  };
}

/**
 * What the project's ready tasks wait for, when they wait for a Claude credential (U-078): the
 * source that keeps the project in its `limits.waiting` and still cannot serve (it rests, or its
 * refusal stands), worded for the row in the person's time zone. Null once it can serve: the
 * scheduler starts the session within a tick.
 */
export async function credentialWaitRow(
  store: StateStore,
  projectId: string,
): Promise<CredentialWaitWords | null> {
  const rows = await store.billingSource.list({}, { limit: 100 }).catch(() => []);
  const now = store.clock.now();
  for (const row of rows) {
    if (!waitingOf(row.limits).some((w) => w.projectId === projectId)) continue;
    const limits = row.limits as { restingUntil?: unknown; refusedAt?: unknown };
    const until =
      typeof limits.restingUntil === "string" && Date.parse(limits.restingUntil) > now
        ? limits.restingUntil
        : null;
    const refused = typeof limits.refusedAt === "string";
    if (!until && !refused) continue;
    const human = await store.human.get(row.human_id).catch(() => undefined);
    return waitRowWords(
      {
        reason: refused ? "refused" : "limit",
        sourceId: row.id,
        kind: row.kind as BillingSourceKind,
        until,
      },
      { ...(human?.timezone ? { timezone: human.timezone } : {}), nowMs: now },
    );
  }
  return null;
}

/** The `verification` record a review keeps in its evidence (ADR 0104), or null. */
export function verificationIn(evidence: readonly JsonValue[] | null | undefined): {
  checks: { name: string; passed: boolean; output: string }[];
  tried: {
    kind: "page" | "command" | "server";
    what: string;
    target: string;
    ok: boolean;
    output: string;
    screenshots: { label: string; file: string }[];
  }[];
  notChecked: string[];
} | null {
  for (const e of evidence ?? []) {
    if (!e || typeof e !== "object" || Array.isArray(e) || !("verification" in e)) continue;
    const v = e.verification as Record<string, unknown> | null;
    if (!v || typeof v !== "object") continue;
    const list = (x: unknown): Record<string, unknown>[] =>
      Array.isArray(x)
        ? x.filter((i): i is Record<string, unknown> => !!i && typeof i === "object")
        : [];
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    return {
      checks: list(v.checks).map((c) => ({
        name: str(c.name),
        passed: c.passed === true,
        output: str(c.output),
      })),
      tried: list(v.tried).map((t) => ({
        // ADR 0110: a try kept before it had no kind; those were pages.
        kind: t.kind === "command" || t.kind === "server" ? t.kind : ("page" as const),
        what: str(t.what),
        target: str(t.target),
        ok: t.ok === true,
        output: str(t.output),
        screenshots: list(t.screenshots).map((s) => ({ label: str(s.label), file: str(s.file) })),
      })),
      notChecked: (Array.isArray(v.notChecked) ? v.notChecked : []).filter(
        (n): n is string => typeof n === "string",
      ),
    };
  }
  return null;
}

/**
 * How a done task was checked (ADR 0104): "Reviewed and tried" when the critic reviewed it and a
 * page of it was tried, "Reviewed" when the critic reviewed it; null when it is not done, was
 * closed without a review, or no review exists (a task closed before ADR 0104).
 */
export function taskCheck(
  task: Pick<TaskRow, "status" | "reason">,
  review: Pick<ReviewRow, "evidence"> | null | undefined,
): TaskCheck | null {
  if (task.status !== "done" || !review || /accepted without review/i.test(task.reason))
    return null;
  const tried = (verificationIn(review.evidence)?.tried.length ?? 0) > 0;
  return { label: tried ? "Reviewed and tried" : "Reviewed", tried };
}

/** The review's evidence for the drawer (ADR 0104), or undefined for a review without one. */
function reviewEvidence(review: Pick<ReviewRow, "evidence">): TaskReviewEvidence | undefined {
  const v = verificationIn(review.evidence);
  if (!v) return undefined;
  return {
    checks: v.checks.map((c) => ({ ...c, output: c.output.slice(0, 2000) })),
    tried: v.tried,
    notChecked: v.notChecked,
  };
}

/** The critic's last verdict on the task, as a sentence for the drawer. */
export function reviewSentence(verdict: string): string {
  switch (verdict) {
    case "accept":
    case "pass":
      return "The critic accepted it.";
    case "revise":
      return "The critic sent it back for changes.";
    case "escalate":
      return "The critic sent it back for another try.";
    case "human":
      return "The critic asked you to decide.";
    default:
      return `The critic's verdict: ${verdictWords(verdict)}.`;
  }
}

/** A run's outcome label in words. */
function runOutcomeWords(outcome: string): string {
  switch (outcome) {
    case "running":
      return "Running";
    case "success":
    case "done":
    case "completed":
      return "Finished";
    case "needs_human":
      return "Asked you";
    case "killed":
    case "stopped":
      return "Stopped";
    case "timeout":
      return "Ran out of time";
    case "usage_limit":
      return "Stopped at the usage limit";
    // ADR 0112: a run that wrapped up with work left, and one a budget stopped.
    case "paused":
      return "Paused";
    case "budget_exceeded":
      return "Stopped at a budget";
    case "error":
    case "failed":
      return "Failed";
    default:
      return outcome ? outcome.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—";
  }
}

/** The critic's run rows of a task are its reviews (`specialist: "critic"`, views.runMode). */
const REVIEW_SPECIALIST = "critic";

/** A specialist's own run of the task (not the critic's review, not a sub-run). */
function isWorkRun(r: Pick<RunRow, "specialist" | "parent_run_id">): boolean {
  return r.specialist !== REVIEW_SPECIALIST && !r.parent_run_id;
}

interface RunReport {
  report: string | null;
  /** The whole report when `report` was cut. */
  fullReport?: string;
  files: string[];
}

/**
 * Each specialist run's report and files from its session's log. The runner writes, per run of
 * the task, `task.files` (when it changed files) and then `task.finished`; neither names the
 * run, so a report goes to the latest run of the task begun at or before it that has none yet.
 * A run that never reported (its session ended under it) is passed over when a later run began
 * before the report; a report from before any run began (the run never started) has no run.
 * `work` is the session's specialist runs of the task, oldest first.
 */
export function pairReports(
  work: readonly Pick<RunRow, "id" | "created_at">[],
  events: readonly Pick<EventRow, "seq" | "type" | "payload" | "created_at">[],
  taskId: string,
): Map<string, RunReport> {
  const finished: { at: string; report: RunReport }[] = [];
  let files: string[] = [];
  for (const e of [...events].sort((x, y) => x.seq - y.seq)) {
    const p = (e.payload ?? {}) as {
      taskId?: unknown;
      summary?: unknown;
      report?: unknown;
      files?: unknown;
    };
    if (p.taskId !== taskId) continue;
    if (e.type === TASK_FILES_EVENT && Array.isArray(p.files)) {
      files = p.files.filter((x): x is string => typeof x === "string");
    } else if (e.type === "task.finished") {
      // A paused run (ADR 0112) carries its own report beside its sentence: both are shown.
      const said =
        typeof p.summary === "string" && typeof p.report === "string" && p.report.trim()
          ? `${p.summary}\n\n${p.report}`
          : p.summary;
      const report = typeof said === "string" ? reportText(said) : null;
      const whole = typeof said === "string" ? reportText(said, FULL_REPORT_LINES) : null;
      finished.push({
        at: e.created_at,
        report: { report, ...(whole && whole !== report ? { fullReport: whole } : {}), files },
      });
      files = [];
    }
  }
  const out = new Map<string, RunReport>();
  let r = 0;
  for (const f of finished) {
    // A run with no report of its own: a later run began before this report.
    for (let next = work[r + 1]; next && next.created_at < f.at; next = work[r + 1]) r++;
    const run = work[r];
    if (!run || run.created_at > f.at) continue;
    out.set(run.id, f.report);
    r++;
  }
  return out;
}

/** The lines of a run's whole report the drawer keeps behind "The whole report". */
const FULL_REPORT_LINES = 80;

/** A report as the drawer shows it: plain text, at most `lines` lines. */
function reportText(text: string, lines = 6): string | null {
  // A run stopped from outside (Stop, Cancel, Stop all) reports only the driver's words.
  if (/^\s*run stopped by its caller\.?\s*$/i.test(text)) return "The run was stopped.";
  const t = plainPlurals(text)
    .replace(/\*\*/g, "")
    .replace(/\[stand-in model\]\s*/gi, "")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
  if (!t.length) return null;
  return t.length > lines ? `${t.slice(0, lines).join("\n")}\n…` : t.join("\n");
}

/** Run outcomes of a run stopped from outside (Stop now, Stop all, Quit, a cancel). */
const STOPPED_OUTCOMES = new Set(["killed", "stopped"]);
/**
 * A critic's run stopped before the critic decided (C-41), in plain words: never "verdict"
 * (design §2, §5 rule 6).
 */
const REVIEW_STOPPED = "Review stopped";
const REVIEW_STOPPED_SENTENCE = "The review stopped before the critic decided";

/**
 * Who or what stopped a review before its verdict, in words (C-41): the cancel of the task, or
 * how its session ended (`handoff.stop_reason`). Before, the drawer said "Review by the critic ·
 * Stopped" and nothing else.
 */
export function reviewStopWords(task: Pick<TaskRow, "status">, sessionStop: string | null): string {
  if (task.status === "cancelled") return "you cancelled the task";
  switch (sessionStop) {
    case "you":
      return "you stopped the session";
    case "stop_all":
      return "Stop all stopped the session";
    case "quit":
      return "Forerunner was closed";
    case "interrupted":
      return "Forerunner closed while it ran";
    case "budget_exceeded":
    case "budget_finish_current":
      return "the session's budget was used";
    case "timeout":
      return "the session ran out of time";
    default: {
      // A pause at the month's cap, the project's budget or the subscription's share ended the
      // session (ADR 0112): the review stopped there, not at the session's own budget.
      const limit = stopLimitWords(sessionStop);
      return limit ? `the session stopped at ${limit}` : "it was stopped";
    }
  }
}

/**
 * The web pages a run read and those it could not read (ADR 0107, C-72), from its Run row's
 * `webSources` artifact (`webSourceArtifact`): the address it asked for, the page's title, and
 * why one was not read, in words. Nothing of the page's text.
 */
export function runWebSources(
  artifacts: readonly JsonValue[] | null | undefined,
): { url: string; title: string | null; refused: string | null }[] {
  const out: { url: string; title: string | null; refused: string | null }[] = [];
  for (const a of artifacts ?? []) {
    if (!a || typeof a !== "object" || Array.isArray(a)) continue;
    const list = (a as { webSources?: unknown }).webSources;
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      if (!s || typeof s !== "object" || Array.isArray(s)) continue;
      const o = s as Record<string, unknown>;
      if (typeof o.url !== "string" || !o.url) continue;
      out.push({
        url: o.url,
        title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : null,
        // Shown in brackets after the address: without its closing full stop.
        refused:
          typeof o.error === "string" && o.error
            ? plainReason(o.error, 160).replace(/[.\s]+$/, "")
            : null,
      });
    }
  }
  return out;
}

/**
 * The task drawer (design §3.5, `GET /tasks/:id`): what it asks for, what it waits for and what
 * waits on it, its runs with the report or error and the files each changed, the critic's last
 * review in words and its open Inbox cards. `views` are the project's task views (each with
 * its status in words), for the tasks it waits for.
 */
export async function taskDetail(
  store: StateStore,
  view: TaskView,
  task: TaskRow,
  views: readonly TaskView[],
  chfPerUsd: number,
): Promise<TaskDetailView> {
  const byId = new Map(views.map((v) => [v.id, v]));
  const waitsOn = task.depends_on.map((id) => {
    const dep = byId.get(id);
    return {
      taskId: id,
      title: dep?.title ?? null,
      status: dep ? (dep.display?.label ?? dep.status) : "No longer exists",
      done: dep?.status === "done",
    };
  });
  const waitedOnBy = views
    .filter((v) => v.dependsOn.includes(task.id) && v.status !== "done" && v.status !== "cancelled")
    .map((v) => ({ taskId: v.id, title: v.title }));
  const runRows = await store.run.list({ task_id: task.id } as never, {
    orderBy: [{ column: "created_at", direction: "desc" }],
    limit: 20,
  });
  // The report and the files of each specialist run are in its session's log (task.files,
  // then task.finished, once per run); the critic's runs of the task are its reviews, which
  // report nothing there.
  const reports = new Map<string, RunReport>();
  for (const sessionId of new Set(runRows.map((r) => r.session_id))) {
    const work = runRows
      .filter((r) => r.session_id === sessionId && isWorkRun(r))
      .sort((x, y) => x.created_at.localeCompare(y.created_at) || x.id.localeCompare(y.id));
    if (!work.length) continue;
    const events = await store.event.list(sessionId, 0, 5000);
    for (const [runId, report] of pairReports(work, events, task.id)) reports.set(runId, report);
  }
  // Why a review stopped before its verdict (C-41): who stopped its session, or the cancel.
  const stopReasons = new Map<string, string | null>();
  for (const r of runRows)
    if (!isWorkRun(r) && STOPPED_OUTCOMES.has(r.outcome) && !stopReasons.has(r.session_id))
      stopReasons.set(
        r.session_id,
        stopReasonOfHandoff((await store.session.get(r.session_id))?.handoff),
      );
  const runs = runRows.map((r) => {
    const got = reports.get(r.id);
    const work = isWorkRun(r);
    const stoppedReview = !work && STOPPED_OUTCOMES.has(r.outcome);
    const web = runWebSources(r.artifacts);
    return {
      id: r.id,
      kind: work ? ("work" as const) : ("review" as const),
      specialist: r.specialist,
      startedAt: r.created_at,
      durationMs: r.duration_ms,
      cost: money(r.cost_usd_micro, chfPerUsd),
      outcome: stoppedReview ? REVIEW_STOPPED : runOutcomeWords(r.outcome),
      report: stoppedReview
        ? `${REVIEW_STOPPED_SENTENCE}: ${reviewStopWords(task, stopReasons.get(r.session_id) ?? null)}.`
        : (got?.report ?? null),
      ...(got?.fullReport ? { fullReport: got.fullReport } : {}),
      files: got?.files ?? [],
      sessionId: r.session_id,
      ...(web.length ? { webSources: web } : {}),
    };
  });
  const latest = await store.review.latestForTask(task.id);
  const open = latest ? await store.finding.openFor(task.id) : [];
  const review = latest
    ? {
        id: latest.id,
        verdict: reviewSentence(latest.verdict),
        summary: reportText(latest.summary, 4) ?? "",
        // Each thing the critic still asks for once, however many reviews raised it.
        open: [...new Set(open.map((f) => plainReason(f.required_action || f.description, 160)))],
        check: taskCheck(task, latest),
        ...(reviewEvidence(latest) ? { evidence: reviewEvidence(latest) } : {}),
      }
    : null;
  const requests = await store.humanRequest.list({ task_id: task.id, status: "open" } as never, {
    limit: 20,
  });
  const cards = requests.map((r) => ({
    requestId: r.id,
    question: plainReason(r.why.split(/\r?\n/)[0] ?? r.why, 160),
  }));
  return { task: view, waitsOn, waitedOnBy, runs, review, cards };
}
