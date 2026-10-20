import { type Clock, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import type { Scheduler, SchedulerDeps, StartRequest } from "@forerunner/runtime";
import {
  type JsonObject,
  type JsonValue,
  type ProjectRow,
  type ReviewRow,
  type SessionRow,
  type StateStore,
  TASK_STATUSES,
  type TaskRow,
  type TaskStatus,
} from "@forerunner/state";
import { parseSecretRef, resolveSecretRefs, type Vault } from "@forerunner/vault";
import { GitHubHost } from "./github.ts";
import {
  FORERUNNER_TASK_ID_FIELD,
  type GitHost,
  type ProjectFieldSpec,
  type ProjectItemFields,
  type ProjectItemInput,
  type ProjectOptionColor,
} from "./types.ts";

/**
 * One-way mirror of tasks to GitHub Projects (spec: build order phase 2; "Source of truth
 * rules": the state store is the truth, GitHub is a mirror).
 *
 * - `sync(projectId)` reads the tasks of a Forerunner project from the store and creates or
 *   updates one project item per task (title, status, specialist, cost in CHF, links to the
 *   PR and the review); done and cancelled tasks are archived, deleted tasks too.
 * - Nothing is ever read back from GitHub into the store. The host's state only decides
 *   whether an item exists; the store decides what it says.
 * - A cursor (task id -> last mirrored version) lives in `project.settings.github_mirror`,
 *   so a run after no changes touches GitHub zero times.
 * - Work goes out in batches; the cursor is saved after each batch. A rate limit the host
 *   could not wait out stops the run cleanly; the next run continues where it stopped.
 * - Every run writes an event with counts (or, when no session can carry it, an audit row
 *   with the same counts); every outward action writes an audit row.
 */

export const MIRROR_SETTINGS_KEY = "github_mirror";
export const DEFAULT_MIRROR_SECRET_REF = "secret:github_token";
export const MIRROR_EVENT_TYPE = "mirror.sync";
/** Audit tool of the run summary written when a run has no session to carry its event. */
export const MIRROR_AUDIT_TOOL = "github.projects.sync";
/** Bump when MIRROR_FIELDS changes so existing projects get the new fields on the next run. */
export const MIRROR_FIELDS_VERSION = 2;
export const DEFAULT_MIRROR_BATCH_SIZE = 25;
/**
 * GitHub caps a draft issue body at 65 536 characters. A longer body is cut here, with a
 * marker at the end, instead of failing the item (the store keeps the full text anyway).
 */
export const MIRROR_BODY_MAX_CHARS = 60_000;
export const MIRROR_BODY_TRUNCATED_MARKER = "\n\n_(cut here; the full text is in Forerunner)_";
export const DEFAULT_MIRROR_EVERY_MINUTES = 15;

/** Task statuses whose items are archived on the board. */
export const CLOSED_TASK_STATUSES: readonly TaskStatus[] = ["done", "cancelled"];

/**
 * Single-select option per task status (one-to-one; the mirror never maps back). Title case
 * like GitHub's own default options, so "In Progress" and "Done" reuse the options every new
 * board already has instead of adding near-duplicates.
 */
export const MIRROR_STATUS_LABELS: Record<TaskStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  claimed: "Claimed",
  in_progress: "In Progress",
  in_review: "In Review",
  needs_human: "Needs Human",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_COLORS: Record<TaskStatus, ProjectOptionColor> = {
  draft: "GRAY",
  ready: "BLUE",
  claimed: "PURPLE",
  in_progress: "YELLOW",
  in_review: "ORANGE",
  needs_human: "RED",
  done: "GREEN",
  failed: "RED",
  cancelled: "GRAY",
};

export const MIRROR_FIELD_STATUS = "Status";
export const MIRROR_FIELD_SPECIALIST = "specialist";
export const MIRROR_FIELD_COST = "cost";
export const MIRROR_FIELD_PR = "pr";
export const MIRROR_FIELD_REVIEW = "review";
export const MIRROR_FIELD_MILESTONE = "milestone";

/** The fields every mirror project carries. "Status" reuses GitHub's built-in field. */
export const MIRROR_FIELDS: readonly ProjectFieldSpec[] = [
  {
    name: MIRROR_FIELD_STATUS,
    kind: "single_select",
    options: TASK_STATUSES.map((s) => ({
      name: MIRROR_STATUS_LABELS[s],
      color: STATUS_COLORS[s],
      description: `Forerunner task status ${s}`,
    })),
  },
  { name: MIRROR_FIELD_SPECIALIST, kind: "text" },
  { name: MIRROR_FIELD_COST, kind: "text" },
  { name: FORERUNNER_TASK_ID_FIELD, kind: "text" },
  { name: MIRROR_FIELD_PR, kind: "text" },
  { name: MIRROR_FIELD_REVIEW, kind: "text" },
  { name: MIRROR_FIELD_MILESTONE, kind: "text" },
];

// ---- settings ----------------------------------------------------------------------------------

/** `project.settings.github_mirror`. Only `enabled: true` turns the mirror on. */
export interface MirrorSettings {
  enabled: boolean;
  /** GitHub user or organisation that holds the board. Default: owner of the first repo. */
  owner?: string;
  /** Board title. Default: the Forerunner project name. */
  title?: string;
  /** Vault reference of the token. Default: secret:github_token. */
  secret_ref?: string;
  /** Set once the board exists. */
  project_id?: string;
  project_url?: string;
  project_number?: number;
  /** Human approved creating the board (asked once when a human port is wired). */
  approved?: boolean;
  fields_version?: number;
  /** Task id -> task version last mirrored. */
  cursor?: Record<string, number>;
  last_sync_at?: string;
}

/** The mirror settings of a project, or null when the mirror is off. */
export function mirrorSettingsOf(project: Pick<ProjectRow, "settings">): MirrorSettings | null {
  const raw = (project.settings as Record<string, unknown>)[MIRROR_SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.enabled !== true) return null;
  const str = (k: string) => (typeof s[k] === "string" && s[k] ? (s[k] as string) : undefined);
  const cursor: Record<string, number> = {};
  if (s.cursor && typeof s.cursor === "object" && !Array.isArray(s.cursor)) {
    for (const [k, v] of Object.entries(s.cursor as Record<string, unknown>))
      if (typeof v === "number" && Number.isFinite(v)) cursor[k] = v;
  }
  return {
    enabled: true,
    owner: str("owner"),
    title: str("title"),
    secret_ref: str("secret_ref"),
    project_id: str("project_id"),
    project_url: str("project_url"),
    project_number: typeof s.project_number === "number" ? s.project_number : undefined,
    approved: s.approved === true,
    fields_version: typeof s.fields_version === "number" ? s.fields_version : undefined,
    cursor,
    last_sync_at: str("last_sync_at"),
  };
}

/** `owner/name`, `https://host/owner/name(.git)`, `git@host:owner/name.git` -> owner. */
export function ownerFromLocator(locator: string): string | null {
  const s = locator.trim();
  if (!s) return null;
  const scp = /^[^@\s]+@[^:\s]+:([^/\s]+)\/[^/\s]+?(?:\.git)?$/.exec(s);
  if (scp?.[1]) return scp[1];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const parts = new URL(s).pathname.split("/").filter(Boolean);
      return parts.length >= 2 ? (parts[0] ?? null) : null;
    } catch {
      return null;
    }
  }
  const plain = /^([^/\s]+)\/[^/\s]+$/.exec(s);
  return plain?.[1] ?? null;
}

// ---- human port --------------------------------------------------------------------------------

export interface MirrorApprovalRequest {
  projectId: string;
  projectName: string;
  humanId: string | null;
  owner: string;
  title: string;
  why: string;
  options: string[];
}
export type MirrorApprovalAnswer = "approve" | "deny";

/** Asked once before the mirror creates a board on GitHub. Backed by HumanRequestRepo in production. */
export interface MirrorHumanPort {
  ask(request: MirrorApprovalRequest): Promise<MirrorApprovalAnswer>;
}

export const MIRROR_APPROVE_OPTION = "Create the GitHub project";
export const MIRROR_DENY_OPTION = "Do not mirror this project";

/**
 * Production port: files a human request and polls the store (through the Clock) until it is
 * answered. A timeout withdraws the request and counts as deny; nothing is created meanwhile.
 */
export class HumanRequestMirrorPort implements MirrorHumanPort {
  constructor(
    private readonly store: Pick<StateStore, "humanRequest">,
    private readonly clock: Clock,
    private readonly opts: { pollMs?: number; timeoutMs?: number; sessionId?: string | null } = {},
  ) {}

  async ask(req: MirrorApprovalRequest): Promise<MirrorApprovalAnswer> {
    const row = await this.store.humanRequest.insert({
      human_id: req.humanId,
      project_id: req.projectId,
      session_id: this.opts.sessionId ?? null,
      kind: "approval",
      why: req.why,
      steps: [
        `Forerunner will create the GitHub project "${req.title}" under ${req.owner}`,
        "Tasks are mirrored one way; edits on GitHub never change Forerunner",
      ],
      options: req.options,
      blocking: false,
      risk: "low",
    });
    const pollMs = Math.max(100, this.opts.pollMs ?? 5_000);
    const deadline = this.clock.now() + (this.opts.timeoutMs ?? 24 * 60 * 60_000);
    while (this.clock.now() < deadline) {
      await this.clock.sleep(pollMs);
      const cur = await this.store.humanRequest.mustGet(row.id);
      if (cur.status === "answered") return answerToDecision(cur.answer, req.options);
      if (cur.status !== "open") return "deny";
    }
    try {
      const cur = await this.store.humanRequest.mustGet(row.id);
      if (cur.status === "open") await this.store.humanRequest.withdraw(cur.id, cur.version);
    } catch {
      // the answer is deny either way
    }
    return "deny";
  }
}

function answerToDecision(answer: JsonValue | null, options: string[]): MirrorApprovalAnswer {
  const chosen =
    typeof answer === "string"
      ? answer
      : answer && typeof answer === "object" && !Array.isArray(answer)
        ? String((answer as JsonObject).choice ?? (answer as JsonObject).option ?? "")
        : "";
  if (chosen === options[0] || /^(approve|approved|yes|create)/i.test(chosen.trim()))
    return "approve";
  return "deny";
}

// ---- host from the vault -------------------------------------------------------------------------

export interface GitHubHostFromVaultOptions {
  vault: Vault;
  /** `secret:<name>`; default secret:github_token. */
  ref?: string;
  baseUrl?: string;
  clock?: Clock;
  fetchImpl?: typeof fetch;
  maxRateLimitWaitSec?: number;
  /** Receives the secret name (never the value) for the audit log. */
  audit?: (name: string) => void;
}

/**
 * Build a GitHub host from a vault reference. The value goes straight into the bearer header;
 * it never reaches the model context, the logs or the store. The token needs, for a
 * fine-grained PAT: "Projects: read and write" on the user or organisation (plus repository
 * "Metadata: read"); for a classic PAT: the `project` scope.
 */
export async function githubHostForSecretRef(
  opts: GitHubHostFromVaultOptions,
): Promise<GitHubHost> {
  const ref = opts.ref ?? DEFAULT_MIRROR_SECRET_REF;
  const name = parseSecretRef(ref);
  const resolved = (await resolveSecretRefs({ token: ref }, opts.vault, new Set([name]), {
    audit: opts.audit,
  })) as { token: string };
  return new GitHubHost({
    token: resolved.token,
    baseUrl: opts.baseUrl,
    clock: opts.clock,
    fetchImpl: opts.fetchImpl,
    maxRateLimitWaitSec: opts.maxRateLimitWaitSec,
  });
}

// ---- task -> item --------------------------------------------------------------------------------

export interface TaskMirrorExtras {
  /** Cost of the task in micro-CHF (from the ledger), or null when unknown. */
  costChfMicro: number | null;
  /** Fallback when the ledger has no CHF amount: micro-USD. */
  costUsdMicro: number;
  review: ReviewRow | null;
  reviewLink: string | null;
  /** Name of the task's milestone (from the store), or null when it has none. */
  milestone: string | null;
}

export function formatMicro(micro: number): string {
  // Round half up on cents (1.275 -> 1.28), not on the binary float.
  return (Math.round(micro / 10_000) / 100).toFixed(2);
}

/** Pure mapping of a task row (plus ledger and review facts) to a project item. */
export function taskToItem(task: TaskRow, extras: TaskMirrorExtras): ProjectItemInput {
  const cost =
    extras.costChfMicro !== null
      ? `CHF ${formatMicro(extras.costChfMicro)}`
      : `USD ${formatMicro(extras.costUsdMicro)}`;
  const review = extras.review
    ? `${extras.review.verdict} ${extras.review.grade}/100${extras.reviewLink ? ` ${extras.reviewLink}` : ""}`
    : null;
  const fields: ProjectItemFields = {
    [MIRROR_FIELD_STATUS]: MIRROR_STATUS_LABELS[task.status],
    [MIRROR_FIELD_SPECIALIST]: task.specialist || null,
    [MIRROR_FIELD_COST]: cost,
    [MIRROR_FIELD_PR]: task.pr_url || null,
    [MIRROR_FIELD_REVIEW]: review,
    [MIRROR_FIELD_MILESTONE]: extras.milestone || null,
  };
  const lines = [
    `Mirrored from Forerunner task \`${task.id}\` (one way: edits here are not synced back).`,
    "",
    `**Outcome:** ${task.outcome || "-"}`,
  ];
  if (task.acceptance_criteria.length) {
    lines.push("", "**Acceptance criteria:**");
    for (const c of task.acceptance_criteria) lines.push(`- ${c}`);
  }
  lines.push(
    "",
    `**Status:** ${MIRROR_STATUS_LABELS[task.status]} · **Specialist:** ${task.specialist || "-"} · **Cost:** ${cost} · **Risk tier:** ${task.risk_tier}`,
  );
  if (extras.milestone) lines.push(`**Milestone:** ${extras.milestone}`);
  if (task.pr_url) lines.push(`**PR:** ${task.pr_url}`);
  if (review) lines.push(`**Review:** ${review}`);
  return { forerunnerTaskId: task.id, title: task.title, body: capBody(lines.join("\n")), fields };
}

/** Cut a body that would exceed the host's limit; the marker says where it was cut. */
export function capBody(body: string): string {
  if (body.length <= MIRROR_BODY_MAX_CHARS) return body;
  return (
    body.slice(0, MIRROR_BODY_MAX_CHARS - MIRROR_BODY_TRUNCATED_MARKER.length) +
    MIRROR_BODY_TRUNCATED_MARKER
  );
}

// ---- the mirror ----------------------------------------------------------------------------------

export type MirrorStore = Pick<
  StateStore,
  | "project"
  | "task"
  | "milestone"
  | "review"
  | "costLedger"
  | "event"
  | "session"
  | "agent"
  | "auditLog"
>;

export interface ProjectsMirrorDeps {
  store: MirrorStore;
  clock: Clock;
  /** Git host for a project. Default: GitHubHost from the vault reference in the settings. */
  hostFor?: (project: ProjectRow, settings: MirrorSettings) => Promise<GitHost> | GitHost;
  /** Needed by the default hostFor. */
  vault?: Vault;
  githubApiBase?: string;
  fetchImpl?: typeof fetch;
  /** Asked once before a board is created. Absent: the settings' `enabled: true` is the consent. */
  human?: MirrorHumanPort;
  /** Human to address approval requests to (the project owner), if known. */
  humanId?: string | null;
  batchSize?: number;
  /** Link shown for a review; default forerunner://reviews/<id>. */
  reviewLink?: (review: ReviewRow) => string;
}

export interface MirrorSyncOptions {
  /** Ignore the cursor and re-assert every task on the board. */
  full?: boolean;
  /** Session to write the run event to; default: a short session of its own. */
  sessionId?: string;
  /** Agent the run is attributed to when it creates its own session; default: first active principal. */
  agentId?: string;
  trigger?: "manual" | "schedule";
  signal?: AbortSignal;
}

export interface MirrorRunCounts {
  scanned: number;
  changed: number;
  created: number;
  updated: number;
  archived: number;
  deleted: number;
  skipped: number;
  errors: number;
}

export interface MirrorRunResult extends MirrorRunCounts {
  projectId: string;
  githubProjectId: string;
  githubProjectUrl: string;
  /** Set when a rate limit stopped the run early; the cursor keeps what was done. */
  stopped: { reason: "rate_limit"; retryAfterMs: number | null } | null;
  sessionId: string | null;
  eventId: string | null;
  durationMs: number;
}

interface Actor {
  session_id: string | null;
  agent_id: string | null;
  human_id: string | null;
}

export class ProjectsMirror {
  private readonly logger = log("projects-mirror");
  private readonly hosts = new Map<string, GitHost>();
  private readonly fieldsEnsured = new Set<string>();

  constructor(private readonly deps: ProjectsMirrorDeps) {}

  /** Mirror one Forerunner project. Throws `tool_not_allowed` when the mirror is not enabled for it. */
  async sync(projectId: string, opts: MirrorSyncOptions = {}): Promise<MirrorRunResult> {
    const { store, clock } = this.deps;
    const started = clock.monotonic();
    const project = await store.project.mustGet(projectId);
    let settings = mirrorSettingsOf(project);
    if (!settings) {
      throw new ForerunnerError(
        "tool_not_allowed",
        `GitHub mirror is not enabled for project "${project.name}"`,
        { details: { projectId, setting: `settings.${MIRROR_SETTINGS_KEY}.enabled` } },
      );
    }
    const owner = settings.owner ?? project.repos.map(ownerFromLocator).find(Boolean) ?? null;
    if (!owner) {
      throw new ForerunnerError(
        "validation",
        "GitHub mirror needs an owner: set settings.github_mirror.owner or link a GitHub repository",
        { details: { projectId } },
      );
    }
    const title = settings.title ?? project.name;
    const session = await this.sessionFor(project, opts);
    const actor: Actor = {
      session_id: session?.id ?? null,
      agent_id: session?.agent_id ?? opts.agentId ?? null,
      human_id: this.deps.humanId ?? null,
    };
    const counts: MirrorRunCounts = {
      scanned: 0,
      changed: 0,
      created: 0,
      updated: 0,
      archived: 0,
      deleted: 0,
      skipped: 0,
      errors: 0,
    };
    let stopped: MirrorRunResult["stopped"] = null;
    let githubProjectId = settings.project_id ?? "";
    let githubProjectUrl = settings.project_url ?? "";
    // The cursor as persisted by the last run. The working copy is reset under `full` so every
    // present task is re-asserted; deleted tasks are still found through the persisted one.
    const persisted: Record<string, number> = { ...(settings.cursor ?? {}) };
    let cursor: Record<string, number> = opts.full ? {} : { ...persisted };
    let failure: unknown = null;

    try {
      opts.signal?.throwIfAborted();
      const host = await this.hostFor(project, settings);

      // 1. The board. Asked once (when a human port is wired), created once.
      if (!githubProjectId) {
        if (this.deps.human && !settings.approved) {
          const answer = await this.deps.human.ask({
            projectId,
            projectName: project.name,
            humanId: this.deps.humanId ?? null,
            owner,
            title,
            why: `Mirror the tasks of "${project.name}" to a GitHub project "${title}" under ${owner} so the work is visible there.`,
            options: [MIRROR_APPROVE_OPTION, MIRROR_DENY_OPTION],
          });
          if (answer !== "approve") {
            await this.audit(
              actor,
              "github.projects.ensure_project",
              `${owner}/${title}`,
              "denied",
              {
                allowed: false,
                denied_reason: "human declined to create the GitHub project",
              },
            );
            throw new ForerunnerError(
              "approval_required",
              `creating the GitHub project "${title}" under ${owner} was not approved`,
              { details: { projectId, owner, title } },
            );
          }
          settings = await this.saveSettings(projectId, { approved: true });
        }
        const info = await host.ensureProject(owner, title);
        await this.audit(
          actor,
          "github.projects.ensure_project",
          `${owner}/${title}`,
          `project ${info.id} #${info.number}`,
        );
        settings = await this.saveSettings(projectId, {
          project_id: info.id,
          project_url: info.url,
          project_number: info.number,
        });
        githubProjectId = info.id;
        githubProjectUrl = info.url;
      }

      // 2. Fields: once per process per board, and again when the field set version moved.
      if (
        settings.fields_version !== MIRROR_FIELDS_VERSION ||
        !this.fieldsEnsured.has(githubProjectId)
      ) {
        const fields = await host.ensureFields(githubProjectId, [...MIRROR_FIELDS]);
        await this.audit(
          actor,
          "github.projects.ensure_fields",
          `${githubProjectId}: ${MIRROR_FIELDS.map((f) => f.name).join(", ")}`,
          `${fields.length} fields`,
        );
        this.fieldsEnsured.add(githubProjectId);
        if (settings.fields_version !== MIRROR_FIELDS_VERSION)
          settings = await this.saveSettings(projectId, { fields_version: MIRROR_FIELDS_VERSION });
      }

      // 3. What changed since the cursor.
      const tasks = await store.task.forProject(
        projectId,
        {},
        { orderBy: [{ column: "created_at" }, { column: "id" }] },
      );
      const changed = tasks.filter((t) => cursor[t.id] !== t.version);
      const present = new Set(tasks.map((t) => t.id));
      const deleted: string[] = [];
      for (const [id, version] of Object.entries(persisted)) {
        if (present.has(id)) continue;
        deleted.push(id);
        // Under `full` the working cursor starts empty: keep the id until its item is archived,
        // so a run that stops early (rate limit, crash) does not forget the deleted task.
        cursor[id] = version;
      }
      counts.scanned = tasks.length;
      counts.changed = changed.length;
      counts.skipped = tasks.length - changed.length;
      // Milestone names once per run (from the store, like everything else on the board).
      const milestones = changed.length
        ? new Map((await store.milestone.forProject(projectId)).map((m) => [m.id, m.name]))
        : new Map<string, string>();

      // 4. Batches; the cursor is saved after each one.
      const batchSize = Math.max(1, this.deps.batchSize ?? DEFAULT_MIRROR_BATCH_SIZE);
      outer: for (let i = 0; i < changed.length; i += batchSize) {
        const batch = changed.slice(i, i + batchSize);
        for (const task of batch) {
          opts.signal?.throwIfAborted();
          try {
            const r = await this.mirrorTask(host, githubProjectId, task, actor, milestones);
            if (r.created) counts.created++;
            else counts.updated++;
            if (r.archived) counts.archived++;
            cursor[task.id] = task.version;
          } catch (e) {
            if (isRateLimit(e)) {
              stopped = { reason: "rate_limit", retryAfterMs: retryAfterOf(e, clock) };
              this.logger.warn("rate limited; stopping this run", {
                projectId,
                mirrored: counts.created + counts.updated,
              });
              break outer;
            }
            counts.errors++;
            throw e;
          }
        }
        settings = await this.saveSettings(projectId, { cursor });
      }

      // 5. Tasks that no longer exist: archive their items.
      if (!stopped) {
        for (const id of deleted) {
          opts.signal?.throwIfAborted();
          try {
            const item = await host.findItem(githubProjectId, id);
            if (item && !item.archived) {
              await host.archiveItem(githubProjectId, item.id);
              await this.audit(
                actor,
                "github.projects.archive_item",
                `task ${id}`,
                `item ${item.id}`,
              );
              counts.archived++;
            }
            counts.deleted++;
            delete cursor[id];
          } catch (e) {
            if (isRateLimit(e)) {
              stopped = { reason: "rate_limit", retryAfterMs: retryAfterOf(e, clock) };
              break;
            }
            counts.errors++;
            throw e;
          }
        }
      }
    } catch (e) {
      failure = e;
    } finally {
      if (counts.created + counts.updated + counts.deleted > 0 || opts.full) {
        try {
          cursor = (await this.saveSettings(projectId, { cursor, last_sync_at: clock.nowIso() }))
            .cursor as Record<string, number>;
        } catch (e) {
          this.logger.error("could not save the mirror cursor", {
            projectId,
            error: errorMessage(e),
          });
          if (!failure) failure = e;
        }
      }
    }

    const durationMs = Math.round(clock.monotonic() - started);
    const payload: JsonObject = {
      project_id: projectId,
      github_project_id: githubProjectId,
      github_project_url: githubProjectUrl,
      full: opts.full === true,
      trigger: opts.trigger ?? "manual",
      duration_ms: durationMs,
      ...counts,
      stopped: stopped ? { ...stopped } : null,
      error: failure ? errorMessage(failure) : null,
    };
    const summary = runSummary(counts, stopped, failure);
    const eventId = await this.writeEvent(session, payload, summary, actor);
    this.logger.info("mirror run", { projectId, ...counts, stopped: stopped?.reason ?? null });
    if (failure) throw failure;
    return {
      projectId,
      githubProjectId,
      githubProjectUrl,
      ...counts,
      stopped,
      sessionId: session?.id ?? null,
      eventId,
      durationMs,
    };
  }

  private async mirrorTask(
    host: GitHost,
    githubProjectId: string,
    task: TaskRow,
    actor: Actor,
    milestones: Map<string, string>,
  ): Promise<{ created: boolean; archived: boolean }> {
    const item = await this.itemFor(task, { milestones });
    const { item: info, created } = await host.upsertItem(githubProjectId, item);
    await this.audit(
      actor,
      "github.projects.upsert_item",
      `task ${task.id} v${task.version} ${task.status}`,
      `item ${info.id} ${created ? "created" : "updated"}`,
    );
    let archived = false;
    if (CLOSED_TASK_STATUSES.includes(task.status) && !info.archived) {
      await host.archiveItem(githubProjectId, info.id);
      await this.audit(actor, "github.projects.archive_item", `task ${task.id}`, `item ${info.id}`);
      archived = true;
    }
    return { created, archived };
  }

  /**
   * Item content from the store only: the task row, its ledger sum, its latest review and its
   * milestone's name (`opts.milestones` is a per-run cache id -> name; absent, one lookup).
   */
  async itemFor(
    task: TaskRow,
    opts: { milestones?: Map<string, string> } = {},
  ): Promise<ProjectItemInput> {
    const sum = await this.deps.store.costLedger.sum({ taskId: task.id });
    const review = (await this.deps.store.review.latestForTask(task.id)) ?? null;
    let milestone: string | null = null;
    if (task.milestone_id) {
      milestone =
        opts.milestones?.get(task.milestone_id) ??
        (await this.deps.store.milestone.get(task.milestone_id))?.name ??
        null;
    }
    return taskToItem(task, {
      costChfMicro: sum.entries > 0 ? sum.chf_micro : null,
      costUsdMicro: sum.entries > 0 ? sum.usd_micro : task.actual_cost_usd_micro,
      review,
      reviewLink: review
        ? (this.deps.reviewLink?.(review) ?? `forerunner://reviews/${review.id}`)
        : null,
      milestone,
    });
  }

  private async hostFor(project: ProjectRow, settings: MirrorSettings): Promise<GitHost> {
    if (this.deps.hostFor) return this.deps.hostFor(project, settings);
    const ref = settings.secret_ref ?? DEFAULT_MIRROR_SECRET_REF;
    const key = `${project.id}|${ref}`;
    const cached = this.hosts.get(key);
    if (cached) return cached;
    if (!this.deps.vault) {
      throw new ForerunnerError(
        "validation",
        "ProjectsMirror needs a vault or a hostFor dependency",
      );
    }
    const host = await githubHostForSecretRef({
      vault: this.deps.vault,
      ref,
      baseUrl: this.deps.githubApiBase,
      clock: this.deps.clock,
      fetchImpl: this.deps.fetchImpl,
      audit: (name) => this.logger.debug("resolved secret reference", { name }),
    });
    this.hosts.set(key, host);
    return host;
  }

  /** Merge a patch into settings.github_mirror with optimistic concurrency (retried). */
  private async saveSettings(
    projectId: string,
    patch: Partial<MirrorSettings>,
  ): Promise<MirrorSettings> {
    for (let attempt = 0; ; attempt++) {
      const current = await this.deps.store.project.mustGet(projectId);
      const existing = (current.settings[MIRROR_SETTINGS_KEY] ?? {}) as JsonObject;
      const merged = { ...existing, ...(patch as JsonObject) };
      try {
        const row = await this.deps.store.project.update(projectId, current.version, {
          settings: { ...current.settings, [MIRROR_SETTINGS_KEY]: merged },
        });
        const s = mirrorSettingsOf(row);
        if (!s)
          throw new ForerunnerError("tool_not_allowed", "GitHub mirror was disabled during a run");
        return s;
      } catch (e) {
        if (e instanceof ForerunnerError && e.code === "version_conflict" && attempt < 5) continue;
        throw e;
      }
    }
  }

  private async sessionFor(
    project: ProjectRow,
    opts: MirrorSyncOptions,
  ): Promise<SessionRow | null> {
    const { store } = this.deps;
    if (opts.sessionId) return store.session.mustGet(opts.sessionId);
    let agentId = opts.agentId ?? null;
    if (!agentId) {
      const [agent] = await store.agent.list(
        { kind: "principal", status: "active" },
        { limit: 1, orderBy: "created_at" },
      );
      agentId = agent?.id ?? null;
    }
    if (!agentId) {
      this.logger.warn("no principal agent; the mirror run gets no session event", {
        projectId: project.id,
      });
      return null;
    }
    return store.session.insert({
      agent_id: agentId,
      project_id: project.id,
      trigger: opts.trigger ?? "manual",
      plan: [{ kind: "mirror", project_id: project.id }],
      status: "running",
      started_at: this.deps.clock.nowIso(),
      summary: "GitHub projects mirror",
      author_agent: agentId,
    });
  }

  /**
   * The run event on the session, or, when the run has no session (no `sessionId`, no
   * `agentId` and no active principal agent), an audit row with the same counts: a run is
   * never silent.
   */
  private async writeEvent(
    session: SessionRow | null,
    payload: JsonObject,
    summary: string,
    actor: Actor,
  ): Promise<string | null> {
    if (!session) {
      try {
        await this.audit(
          actor,
          MIRROR_AUDIT_TOOL,
          `project ${payload.project_id} (${payload.trigger}${payload.full ? ", full" : ""})`,
          summary,
        );
      } catch (e) {
        this.logger.error("could not write the mirror run audit row", { error: errorMessage(e) });
      }
      return null;
    }
    try {
      const ev = await this.deps.store.event.append(session.id, MIRROR_EVENT_TYPE, payload, 0, {
        authorAgent: actor.agent_id,
      });
      // A session the mirror opened for itself is closed again; a borrowed one is left alone.
      if (session.summary === "GitHub projects mirror" && session.status === "running") {
        const cur = await this.deps.store.session.mustGet(session.id);
        if (cur.status === "running") {
          await this.deps.store.session.setStatus(
            cur.id,
            cur.version,
            payload.error ? "failed" : "completed",
            { summary },
          );
        }
      }
      return ev.id;
    } catch (e) {
      this.logger.error("could not write the mirror event", { error: errorMessage(e) });
      return null;
    }
  }

  private async audit(
    actor: Actor,
    tool: string,
    input: string,
    result: string,
    extra: { allowed?: boolean; denied_reason?: string | null } = {},
  ): Promise<void> {
    await this.deps.store.auditLog.append({
      session_id: actor.session_id,
      agent_id: actor.agent_id,
      human_id: actor.human_id,
      tool,
      input_summary: input,
      result_summary: result,
      allowed: extra.allowed ?? true,
      denied_reason: extra.denied_reason ?? null,
    });
  }
}

/** One line with the counts of a run: the session summary and the audit fallback share it. */
export function runSummary(
  counts: MirrorRunCounts,
  stopped: MirrorRunResult["stopped"],
  failure: unknown = null,
): string {
  return (
    `mirror: ${counts.created} created, ${counts.updated} updated, ${counts.archived} archived, ` +
    `${counts.deleted} deleted, ${counts.skipped} unchanged` +
    (counts.errors ? `, ${counts.errors} errors` : "") +
    (stopped ? " (stopped: rate limit)" : "") +
    (failure ? `; error: ${errorMessage(failure)}` : "")
  );
}

function isRateLimit(e: unknown): e is ForerunnerError {
  return e instanceof ForerunnerError && e.code === "provider_rate_limit";
}

/** How long the host asked us to wait, from `retryAfterMs` or `resetAt` (on the injected clock). */
function retryAfterOf(e: ForerunnerError, clock: Clock): number | null {
  const v = e.details.retryAfterMs;
  if (typeof v === "number") return v;
  const at = e.details.resetAt;
  if (typeof at !== "string") return null;
  const resetMs = new Date(at).getTime();
  return Number.isFinite(resetMs) ? Math.max(0, resetMs - clock.now()) : null;
}

// ---- scheduler hook ------------------------------------------------------------------------------

export const MIRROR_AGENT_PREFIX = "mirror:";

/** Pseudo agent id the scheduler uses for mirror runs (one run at a time per project). */
export function mirrorAgentId(projectId: string): string {
  return `${MIRROR_AGENT_PREFIX}${projectId}`;
}

export function isMirrorRequest(req: StartRequest): req is StartRequest & { projectId: string } {
  return req.agentId.startsWith(MIRROR_AGENT_PREFIX) && typeof req.projectId === "string";
}

export interface ScheduleMirrorOptions {
  projectId: string;
  /** Default 15. */
  everyMinutes?: number;
  enabled?: boolean;
}

/**
 * Register a recurring mirror run with the session scheduler. The scheduler's `start`
 * dependency must route mirror requests to the mirror: wrap it with `mirrorStartHandler`.
 */
export function scheduleMirror(
  scheduler: Pick<Scheduler, "add" | "remove">,
  opts: ScheduleMirrorOptions,
): { id: string; agentId: string; remove: () => void } {
  const id = `mirror:${opts.projectId}`;
  scheduler.add({
    id,
    agentId: mirrorAgentId(opts.projectId),
    projectId: opts.projectId,
    kind: "every",
    everyMinutes: Math.max(1, opts.everyMinutes ?? DEFAULT_MIRROR_EVERY_MINUTES),
    timezone: "UTC",
    enabled: opts.enabled ?? true,
  });
  return { id, agentId: mirrorAgentId(opts.projectId), remove: () => scheduler.remove(id) };
}

/**
 * `start` for SchedulerDeps: mirror requests run the mirror, everything else goes to `next`.
 * A rate-limited run returns normally (the cursor keeps the progress; the next tick retries).
 */
export function mirrorStartHandler(
  mirror: Pick<ProjectsMirror, "sync">,
  next?: SchedulerDeps["start"],
  opts: { agentId?: string } = {},
): SchedulerDeps["start"] {
  return async (req: StartRequest) => {
    if (isMirrorRequest(req)) {
      return mirror.sync(req.projectId, {
        trigger: req.trigger === "manual" ? "manual" : "schedule",
        agentId: opts.agentId,
      });
    }
    if (!next) {
      throw new ForerunnerError("validation", `no session starter for agent ${req.agentId}`);
    }
    return next(req);
  };
}

// ---- CLI -----------------------------------------------------------------------------------------

/** The slice of a commander `Command` the mirror needs (kept structural: no commander import here). */
export interface MirrorCliCommand {
  command(nameAndArgs: string): MirrorCliCommand;
  description(text: string): MirrorCliCommand;
  option(flags: string, description?: string): MirrorCliCommand;
  action(fn: (opts: Record<string, unknown>) => void | Promise<void>): MirrorCliCommand;
}

export interface MirrorCliDeps {
  /** Opens the store and a mirror for one command; `close` runs afterwards. */
  open(): Promise<{
    store: Pick<StateStore, "project">;
    mirror: Pick<ProjectsMirror, "sync">;
    close?: () => Promise<void>;
  }>;
  out?: (line: string) => void;
}

/** `fr mirror sync|enable|disable`. */
export function registerMirrorCli(
  program: Pick<MirrorCliCommand, "command">,
  deps: MirrorCliDeps,
): void {
  const out = deps.out ?? ((line: string) => console.log(line));
  const mirror = program
    .command("mirror")
    .description("One-way mirror of tasks to GitHub Projects (the store stays the truth)");

  mirror
    .command("sync")
    .description("Mirror the tasks of a project (or every enabled project) to its GitHub board")
    .option("--project <name-or-id>", "project name or id")
    .option("--all", "every project with the mirror enabled")
    .option("--full", "ignore the cursor and re-assert every task")
    .action(async (opts) => {
      const ctx = await deps.open();
      try {
        const targets = await cliTargets(ctx.store, opts);
        for (const p of targets) {
          const r = await ctx.mirror.sync(p.id, { full: opts.full === true, trigger: "manual" });
          out(
            `${p.name}: ${r.created} created, ${r.updated} updated, ${r.archived} archived, ${r.skipped} unchanged` +
              `${r.stopped ? " (stopped: rate limit, run again later)" : ""} -> ${r.githubProjectUrl || r.githubProjectId}`,
          );
        }
        if (!targets.length) out("No project selected: pass --project <name-or-id> or --all.");
      } finally {
        await ctx.close?.();
      }
    });

  mirror
    .command("enable")
    .description("Turn the mirror on for a project")
    .option("--project <name-or-id>", "project name or id")
    .option(
      "--owner <login>",
      "GitHub user or organisation for the board (default: owner of the first repo)",
    )
    .option("--title <title>", "board title (default: the project name)")
    .option(
      "--secret <ref>",
      `vault reference of the GitHub token (default ${DEFAULT_MIRROR_SECRET_REF})`,
    )
    .action(async (opts) => {
      const ctx = await deps.open();
      try {
        const [p] = await cliTargets(ctx.store, { project: opts.project });
        if (!p) throw new ForerunnerError("validation", "pass --project <name-or-id>");
        const patch: JsonObject = { enabled: true };
        if (typeof opts.owner === "string") patch.owner = opts.owner;
        if (typeof opts.title === "string") patch.title = opts.title;
        if (typeof opts.secret === "string") patch.secret_ref = opts.secret;
        const existing = (p.settings[MIRROR_SETTINGS_KEY] ?? {}) as JsonObject;
        await ctx.store.project.update(p.id, p.version, {
          settings: { ...p.settings, [MIRROR_SETTINGS_KEY]: { ...existing, ...patch } },
        });
        out(`${p.name}: mirror enabled. Run "fr mirror sync --project ${p.name}".`);
      } finally {
        await ctx.close?.();
      }
    });

  mirror
    .command("disable")
    .description("Turn the mirror off for a project (the board is left as it is)")
    .option("--project <name-or-id>", "project name or id")
    .action(async (opts) => {
      const ctx = await deps.open();
      try {
        const [p] = await cliTargets(ctx.store, { project: opts.project });
        if (!p) throw new ForerunnerError("validation", "pass --project <name-or-id>");
        const existing = (p.settings[MIRROR_SETTINGS_KEY] ?? {}) as JsonObject;
        await ctx.store.project.update(p.id, p.version, {
          settings: { ...p.settings, [MIRROR_SETTINGS_KEY]: { ...existing, enabled: false } },
        });
        out(`${p.name}: mirror disabled.`);
      } finally {
        await ctx.close?.();
      }
    });
}

async function cliTargets(
  store: Pick<StateStore, "project">,
  opts: Record<string, unknown>,
): Promise<ProjectRow[]> {
  if (typeof opts.project === "string" && opts.project) {
    const byId = await store.project.get(opts.project);
    const row = byId ?? (await store.project.byName(opts.project));
    if (!row) throw new ForerunnerError("not_found", `project "${opts.project}" not found`);
    return [row];
  }
  if (opts.all === true) {
    return (await store.project.list({}, { limit: 1000 })).filter((p) => mirrorSettingsOf(p));
  }
  return [];
}
