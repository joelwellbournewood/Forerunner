import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { StateStore, TaskRow } from "@forerunner/state";
import type { BriefTask, StateBrief } from "./brief.ts";

/**
 * Fixed startup checklist run by code, not the model (spec E): version check, git fetch, pull
 * shared state, inbox, open human requests, critic findings, budget, diff since last session.
 * Output: a StateBrief. Every step is best effort and records a warning instead of failing the
 * session, except reading the store itself.
 */
export interface GitPort {
  /** Fetch all remotes of the project's repositories; returns a one-line detail. */
  fetch(repoDirs: string[], signal?: AbortSignal): Promise<string>;
}

export interface SyncPort {
  /** Pull shared state (no-op for a local store). */
  pull(signal?: AbortSignal): Promise<string>;
}

export interface ChecklistInput {
  store: StateStore;
  clock: Clock;
  agentId: string;
  projectId?: string;
  appVersion: string;
  sessionCapUsdMicro: number;
  git?: GitPort;
  sync?: SyncPort;
  repoDirs?: string[];
  planUsageShare?: () => Promise<number | null> | number | null;
  signal?: AbortSignal;
  /** How many rows to load per list; the renderer trims further. */
  limit?: number;
}

function toBriefTask(t: TaskRow): BriefTask {
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    riskTier: t.risk_tier,
    priority: t.priority,
    claimedBy: t.claimed_by,
    attempt: t.attempt,
    prUrl: t.pr_url,
  };
}

export function monthStartIso(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

export async function runStartupChecklist(input: ChecklistInput): Promise<StateBrief> {
  const { store, clock, agentId } = input;
  const logger = log("checklist");
  const limit = input.limit ?? 50;
  const warnings: string[] = [];
  const agent = await store.agent.mustGet(agentId);
  const human = await store.human.mustGet(agent.owner_human_id);
  const project = input.projectId ? await store.project.mustGet(input.projectId) : null;

  // 1. version check
  let latestRelease: string | null = null;
  try {
    latestRelease = (await store.release.latest("stable", "published"))?.release_version ?? null;
  } catch (e) {
    warnings.push(`version check failed: ${errorMessage(e)}`);
  }
  const updateAvailable = !!latestRelease && latestRelease !== input.appVersion;

  // 2. git fetch
  let git = { fetched: false, detail: "no repositories" };
  if (input.git && input.repoDirs?.length) {
    try {
      git = { fetched: true, detail: await input.git.fetch(input.repoDirs, input.signal) };
    } catch (e) {
      git = { fetched: false, detail: `fetch failed: ${errorMessage(e)}` };
      warnings.push(git.detail);
    }
  }

  // 3. pull shared state
  let sharedState = { synced: true, detail: "local store" };
  if (input.sync) {
    try {
      sharedState = { synced: true, detail: await input.sync.pull(input.signal) };
    } catch (e) {
      sharedState = { synced: false, detail: `sync failed: ${errorMessage(e)}` };
      warnings.push(sharedState.detail);
    }
  }

  // 4. inbox
  const unread = await store.message.inbox({ agentId }, { unreadOnly: true, limit });
  const unreadCount = await store.message.count({ to_agent_id: agentId, read_at: null } as never);
  const unackSent = await store.message.unacknowledged(agentId, { limit });
  const agentNames = new Map<string, string>();
  for (const m of unread) {
    if (!agentNames.has(m.from_agent_id))
      agentNames.set(
        m.from_agent_id,
        (await store.agent.get(m.from_agent_id))?.name ?? m.from_agent_id,
      );
  }

  // 5. open human requests
  const openRequests = await store.humanRequest.open(
    { humanId: human.id, ...(project ? { projectId: project.id } : {}) },
    { limit },
  );
  const openRequestCount = await store.humanRequest.count({
    status: "open",
    human_id: human.id,
    ...(project ? { project_id: project.id } : {}),
  } as never);

  // 6. open critic findings on this project's tasks
  const projectTasks = project
    ? await store.task.list({ project_id: project.id } as never, { limit: 1000 })
    : [];
  const taskIds = new Set(projectTasks.map((t) => t.id));
  const allOpenFindings = await store.finding.list({ status: "open" } as never, { limit: 500 });
  const openFindings = allOpenFindings.filter(
    (f) => !project || (f.task_id && taskIds.has(f.task_id)),
  );

  // 7. budget
  const monthSpent = await store.costLedger.sum({
    humanId: human.id,
    from: monthStartIso(clock.now()),
  });
  const projectSpent = project
    ? await store.costLedger.sum({ projectId: project.id })
    : { usd_micro: 0, chf_micro: 0 };
  let planUsageShare: number | null = null;
  try {
    planUsageShare = (await input.planUsageShare?.()) ?? null;
  } catch (e) {
    warnings.push(`plan usage unknown: ${errorMessage(e)}`);
  }
  if (human.monthly_cap_usd_micro > 0 && monthSpent.usd_micro >= human.monthly_cap_usd_micro * 0.8)
    warnings.push("monthly cap at 80% or more");

  // 8. diff since last session
  const lastSession = await store.session.latestForAgent(agentId);
  const since = lastSession?.ended_at ?? lastSession?.started_at ?? null;
  const changed = since ? projectTasks.filter((t) => t.updated_at > since) : [];

  // tasks and peers
  const ready = project ? await store.task.readyTasks(project.id, { limit }) : [];
  const claimedByMe = await store.task.claimedBy(agentId);
  const claimedByOthers = projectTasks.filter(
    (t) =>
      t.claimed_by &&
      t.claimed_by !== agentId &&
      t.claim_expires &&
      t.claim_expires > clock.nowIso(),
  );
  const peerIds = [...new Set(claimedByOthers.map((t) => t.claimed_by as string))];
  const peers = [];
  for (const pid of peerIds) {
    const peer = await store.agent.get(pid);
    const handoffs = await store.message.list(
      { from_agent_id: pid, to_agent_id: agentId, type: "handoff" } as never,
      { orderBy: [{ column: "created_at", direction: "desc" }], limit: 1 },
    );
    peers.push({
      agentId: pid,
      agentName: peer?.name ?? pid,
      activeClaims: claimedByOthers.filter((t) => t.claimed_by === pid).length,
      lastHandoff: handoffs[0]?.body ?? null,
    });
  }
  const queue = project ? await store.queue.pending(project.id, { limit }) : [];
  const queueCount = project
    ? await store.queue.count({ project_id: project.id, status: "queued" } as never)
    : 0;

  const brief: StateBrief = {
    generatedAt: clock.nowIso(),
    agent: { id: agent.id, name: agent.name },
    human: { id: human.id, name: human.name, timezone: human.timezone },
    project: project
      ? {
          id: project.id,
          name: project.name,
          goal: project.goal,
          stage: project.stage,
          autonomy: project.autonomy_level,
          summary: project.summary_cache,
        }
      : null,
    version: { app: input.appVersion, latestRelease, updateAvailable },
    git,
    sharedState,
    inbox: {
      unread: unread.map((m) => ({
        id: m.id,
        from: agentNames.get(m.from_agent_id) ?? m.from_agent_id,
        type: m.type,
        body: m.body,
        requiresAck: m.requires_ack,
        createdAt: m.created_at,
      })),
      unreadCount,
      unacknowledgedSent: unackSent.length,
    },
    humanRequests: {
      open: openRequests.map((r) => ({
        id: r.id,
        kind: r.kind,
        why: r.why,
        blocking: r.blocking,
        options: r.options.map(String),
      })),
      openCount: openRequestCount,
    },
    findings: {
      open: openFindings.slice(0, limit).map((f) => ({
        id: f.id,
        taskId: f.task_id,
        severity: f.severity,
        description: f.description,
        requiredAction: f.required_action,
      })),
      openCount: openFindings.length,
    },
    budget: {
      monthSpentUsdMicro: monthSpent.usd_micro,
      monthCapUsdMicro: human.monthly_cap_usd_micro,
      projectSpentUsdMicro: projectSpent.usd_micro,
      projectCapUsdMicro: project?.budget_usd_micro ?? 0,
      sessionCapUsdMicro: input.sessionCapUsdMicro,
      planUsageShare,
    },
    lastSession: lastSession
      ? {
          id: lastSession.id,
          endedAt: lastSession.ended_at,
          summary: lastSession.summary,
          handoff: (lastSession.handoff as Record<string, unknown> | null) ?? null,
        }
      : null,
    changesSinceLastSession: {
      tasks: changed.slice(0, limit).map(toBriefTask),
      count: changed.length,
    },
    tasks: {
      ready: ready.map(toBriefTask),
      readyCount: ready.length,
      claimedByMe: claimedByMe.map(toBriefTask),
      claimedByOthers: claimedByOthers.map(toBriefTask),
    },
    peers,
    queue: {
      items: queue.map((q) => ({
        id: q.id,
        version: q.version,
        kind: q.kind,
        text: q.text,
        priority: q.priority,
      })),
      count: queueCount,
    },
    warnings,
  };
  logger.debug("checklist done", {
    unread: unreadCount,
    requests: openRequestCount,
    findings: openFindings.length,
    ready: ready.length,
    warnings: warnings.length,
  });
  return brief;
}
