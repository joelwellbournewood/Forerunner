import { type Clock, errorMessage, ForerunnerError, log, newId } from "@forerunner/platform";
import type { SessionRow, StateStore, TaskRow } from "@forerunner/state";
import type { AutonomyLevel } from "../enforcement/autonomy.ts";
import { SessionBudget } from "../enforcement/budget.ts";
import type { KillSwitch } from "../enforcement/killswitch.ts";
import type { SignedToken, TokenIssuer } from "../enforcement/token.ts";
import { renderStateBrief, type StateBrief } from "./brief.ts";
import { type ChecklistInput, runStartupChecklist } from "./checklist.ts";
import {
  buildPeerFeed,
  detectOverlap,
  extractPathHints,
  overlapBlocks,
  overlapMessage,
  renderPeerFeed,
  TASK_FILES_EVENT,
} from "./peers.ts";

/**
 * One working period of a principal agent (spec E). Code owns the skeleton: checklist, plan
 * within budget, claim-before-work, inbox re-checks between tasks and before writes, handoff
 * and summary at the end. The model decides *what* inside each step through the Planner and
 * the TaskExecutor; both are ports so tests run with fakes.
 */
export type SessionTriggerKind =
  | "manual"
  | "schedule"
  | "message"
  | "ci"
  | "pr_comment"
  | "email"
  | "budget_reset"
  | "remote";

/** Message types that are acted on by reading them into the plan; the rest need a reply. */
const ACK_BY_READING: ReadonlySet<string> = new Set(["handoff", "info", "warning", "decision"]);

export interface PlanItem {
  taskId: string;
  title: string;
  specialist: string;
  estimateUsdMicro: number;
  rationale?: string;
}

export interface SessionPlan {
  items: PlanItem[];
  estimateUsdMicro: number;
  summary: string;
}

export interface PlannerContext {
  brief: StateBrief;
  briefText: string;
  readyTasks: TaskRow[];
  budgetUsdMicro: number;
  reserveShare: number;
  session: SessionRow;
  token: SignedToken;
  budget: SessionBudget;
}

export interface Planner {
  plan(ctx: PlannerContext): Promise<SessionPlan>;
}

export interface TaskExecutionResult {
  outcome:
    | "done"
    | "in_review"
    | "failed"
    | "needs_human"
    | "budget_exceeded"
    | "timeout"
    | "killed";
  summary: string;
  costUsdMicro: number;
  prUrl?: string;
  branch?: string;
  /** Files the task changed (relative to the worktree root), for peer overlap detection. */
  changedFiles?: string[];
  artifacts?: unknown[];
  /** True when automated checks (tier 0) passed, so the task may close without a critic review. */
  checksPassed?: boolean;
}

export interface TaskExecutor {
  execute(ctx: {
    task: TaskRow;
    session: SessionRow;
    token: SignedToken;
    budget: SessionBudget;
    item: PlanItem;
    signal: AbortSignal;
  }): Promise<TaskExecutionResult>;
}

export interface SessionStartOptions {
  agentId: string;
  projectId?: string;
  trigger: SessionTriggerKind;
  budgetCapUsdMicro: number;
  stepCap?: number;
  wallClockMs?: number;
  reserveShare?: number;
  /** Autonomy level for this session; defaults to the project's. */
  autonomy?: AutonomyLevel;
  planApproved?: boolean;
  appVersion?: string;
  runner?: "pc" | "cloud";
  deviceId?: string;
  claimTtlMs?: number;
  /** Tools, paths, domains and secrets the principal may use. */
  grant: {
    allowedTools: string[];
    allowedPaths: string[];
    allowedDomains: string[];
    grantedSecrets: string[];
    maxDepth?: number;
  };
  checklist?: Partial<Pick<ChecklistInput, "git" | "sync" | "repoDirs" | "planUsageShare">>;
  /** Called for every session event (live view). */
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
}

export interface SessionResult {
  sessionId: string;
  status: SessionRow["status"];
  brief: StateBrief;
  plan: SessionPlan | null;
  completed: string[];
  inReview: string[];
  failed: string[];
  skipped: string[];
  needsHuman: string[];
  spentUsdMicro: number;
  steps: number;
  summary: string;
  handoff: Record<string, unknown>;
  stopReason: string;
}

export interface SessionRunnerDeps {
  store: StateStore;
  clock: Clock;
  tokens: TokenIssuer;
  kill: KillSwitch;
  planner: Planner;
  executor: TaskExecutor;
  /** Peer agents to hand off to; default: other principal agents on the project's humans. */
  peersOf?: (agentId: string, projectId: string | undefined) => Promise<string[]>;
}

export class SessionRunner {
  private readonly logger = log("session");

  constructor(private readonly deps: SessionRunnerDeps) {}

  async start(opts: SessionStartOptions): Promise<SessionResult> {
    const { store, clock } = this.deps;
    const agent = await store.agent.mustGet(opts.agentId);
    const project = opts.projectId ? await store.project.mustGet(opts.projectId) : null;
    const autonomy = (opts.autonomy ??
      (project?.autonomy_level as AutonomyLevel | undefined) ??
      2) as AutonomyLevel;
    const stepCap = opts.stepCap ?? 200;
    const wallClockMs = opts.wallClockMs ?? 4 * 60 * 60 * 1000;
    const reserveShare = opts.reserveShare ?? 0.2;
    const claimTtlMs = opts.claimTtlMs ?? 30 * 60 * 1000;

    if (this.deps.kill.isFrozen({ agentId: agent.id })) {
      throw new ForerunnerError("killed", "kill switch is active for this agent; resume it first");
    }
    const active = await store.session.active(agent.id);
    if (active.length > 0) {
      throw new ForerunnerError(
        "claim_conflict",
        `agent ${agent.name} already has an active session ${active[0]?.id}`,
        { details: { sessionId: active[0]?.id } },
      );
    }

    let session = await store.session.insert({
      agent_id: agent.id,
      project_id: project?.id ?? null,
      trigger: opts.trigger,
      plan: {},
      budget_cap_usd_micro: opts.budgetCapUsdMicro,
      step_cap: stepCap,
      spent_usd_micro: 0,
      steps: 0,
      started_at: clock.nowIso(),
      status: "planned",
      summary: "",
      handoff: {},
      runner: opts.runner ?? "pc",
      device_id: opts.deviceId ?? null,
      author_agent: agent.id,
    });
    session = await store.session.start(session.id, session.version);
    const emit = async (type: string, payload: Record<string, unknown> = {}, cost = 0) => {
      await store.event.append(session.id, type, payload as never, cost);
      opts.onEvent?.(type, payload);
    };
    await emit("session.started", {
      trigger: opts.trigger,
      budgetCapUsdMicro: opts.budgetCapUsdMicro,
      stepCap,
      autonomy,
    });

    const budget = new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: opts.budgetCapUsdMicro,
      stepCap,
      deadlineMs: clock.now() + wallClockMs,
      reserveShare,
    });
    const controller = new AbortController();
    const unregister = this.deps.kill.register({
      agentId: agent.id,
      sessionId: session.id,
      controller,
      label: `session ${session.id}`,
    });
    const token = this.deps.tokens.issue({
      runId: newId(clock.now()),
      sessionId: session.id,
      agentId: agent.id,
      ownerHumanId: agent.owner_human_id,
      projectId: project?.id,
      allowedTools: opts.grant.allowedTools,
      allowedPaths: opts.grant.allowedPaths,
      allowedDomains: opts.grant.allowedDomains,
      grantedSecrets: opts.grant.grantedSecrets,
      budgetUsdMicro: opts.budgetCapUsdMicro,
      depth: 0,
      maxDepth: opts.grant.maxDepth ?? 2,
      autonomy,
      planApproved: opts.planApproved ?? false,
      expiresAt: new Date(clock.now() + wallClockMs).toISOString(),
    });

    const completed: string[] = [];
    const inReview: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    const filesByTask = new Map<string, string[]>();
    const overlapNotified = new Set<string>();
    let peerIds: string[] = [];
    const needsHuman: string[] = [];
    let plan: SessionPlan | null = null;
    let brief: StateBrief | null = null;
    let stopReason = "completed";
    let status: SessionRow["status"] = "completed";
    const heldClaims = new Set<string>();

    // Some transitions (in_review, done) clear the claim themselves; release only what we still hold.
    const releaseIfHeld = async (taskId: string, reason: string) => {
      heldClaims.delete(taskId);
      const t = await store.task.get(taskId);
      if (t?.claimed_by === agent.id) await store.task.releaseClaim(taskId, agent.id, reason);
    };
    const releaseAll = async (reason: string) => {
      for (const id of [...heldClaims]) {
        try {
          await releaseIfHeld(id, reason);
        } catch (e) {
          this.logger.warn("release failed", { taskId: id, error: errorMessage(e) });
        }
      }
      heldClaims.clear();
    };

    try {
      // 1. Startup checklist (code, not the model).
      brief = await runStartupChecklist({
        store,
        clock,
        agentId: agent.id,
        projectId: project?.id,
        appVersion: opts.appVersion ?? "0.0.0",
        sessionCapUsdMicro: opts.budgetCapUsdMicro,
        signal: controller.signal,
        ...opts.checklist,
      });
      // Peer feed: what the other agents on the project are doing (spec F).
      peerIds = await (this.deps.peersOf ?? defaultPeers(store))(agent.id, project?.id);
      const peerFeed = async () =>
        buildPeerFeed({ store, clock, agentId: agent.id, projectId: project?.id, peerIds });
      let feed = await peerFeed();
      const feedText = renderPeerFeed(feed);
      const briefText = feedText
        ? `${renderStateBrief(brief)}\n\n${feedText}`
        : renderStateBrief(brief);
      await emit("session.brief", {
        tokensApprox: Math.ceil(briefText.length / 4),
        warnings: brief.warnings,
        unread: brief.inbox.unreadCount,
        ready: brief.tasks.readyCount,
      });
      await emit("peers.feed", {
        peers: feed.peers.map((p) => ({
          agentId: p.agentId,
          name: p.agentName,
          online: p.online,
          claims: p.activeClaims.length,
          openPrs: p.openPullRequests.length,
          filesInFlight: Object.values(p.inFlightFiles).flat().length,
        })),
      });

      // Receipts (spec F): seen messages are delivered and read; ack-required messages that carry
      // information (handoffs, warnings, decisions, info) are acted on by taking them into the
      // plan. Questions and requests count as acted on only once a reply exists (checked at the
      // end of the session). Messages this agent sent that nobody acted on resurface here.
      for (const m of brief.inbox.unread) {
        await store.message.markDelivered(m.id);
        await store.message.markRead(m.id);
        if (m.requiresAck && ACK_BY_READING.has(m.type)) {
          await store.message.markActed(m.id);
          await emit("inbox.acted", { id: m.id, type: m.type });
        }
      }
      const unacked = await store.message.unacknowledged(agent.id, { limit: 50 });
      if (unacked.length) {
        await emit("inbox.unacknowledged", {
          count: unacked.length,
          messages: unacked.slice(0, 20).map((m) => ({
            id: m.id,
            to: m.to_agent_id ?? m.to_human_id,
            type: m.type,
            createdAt: m.created_at,
          })),
        });
      }

      // 2. Plan within budget. Plans over budget are cut before starting.
      const readyTasks = project ? await store.task.readyTasks(project.id, { limit: 100 }) : [];
      plan = await this.deps.planner.plan({
        brief,
        briefText,
        readyTasks,
        budgetUsdMicro: opts.budgetCapUsdMicro,
        reserveShare,
        session,
        token,
        budget,
      });
      plan = cutPlanToBudget(plan, Math.floor(opts.budgetCapUsdMicro * (1 - reserveShare)));
      session = await store.session.patch(session.id, { plan: plan as never });
      await emit("session.planned", {
        items: plan.items.length,
        estimateUsdMicro: plan.estimateUsdMicro,
        summary: plan.summary,
      });

      if (autonomy === 0 || (autonomy === 1 && !opts.planApproved)) {
        await store.humanRequest.insert({
          human_id: agent.owner_human_id,
          project_id: project?.id ?? null,
          session_id: session.id,
          kind: "approval",
          why:
            autonomy === 0
              ? "Advisor mode: the plan is a proposal; approve to run it as a new session."
              : "Assisted mode: approve this session plan before work starts.",
          steps: plan.items.map(
            (i) => `${i.title} (${i.specialist}, ~$${(i.estimateUsdMicro / 1e6).toFixed(2)})`,
          ),
          options: ["approve", "reject"],
          blocking: true,
          risk: "medium",
          change_card: { key: `plan:${session.id}`, plan: plan as never },
          author_agent: agent.id,
        });
        stopReason = "plan_awaiting_approval";
        status = "paused";
        await emit("session.paused", { reason: stopReason });
      } else {
        // 3. Execute, claim-before-work, inbox re-check between tasks.
        for (const item of plan.items) {
          if (controller.signal.aborted) throw new ForerunnerError("killed", "session stopped");
          budget.checkWallClock(clock.now());
          if (budget.noNewWork) {
            skipped.push(item.taskId);
            continue;
          }
          const interrupt = await this.recheckInbox(agent.id, session.id, emit);
          if (interrupt === "stop") {
            stopReason = "stopped_by_message";
            skipped.push(...plan.items.slice(plan.items.indexOf(item)).map((i) => i.taskId));
            break;
          }
          // Overlap check against the peers' current activity before any work starts.
          const planned = readyTasks.find((t) => t.id === item.taskId);
          const work = {
            taskId: item.taskId,
            title: item.title,
            files: planned
              ? extractPathHints(
                  `${planned.title}\n${planned.outcome}\n${planned.acceptance_criteria.join("\n")}`,
                )
              : [],
          };
          feed = await peerFeed();
          const overlaps = detectOverlap(work, feed);
          let blocked = false;
          for (const o of overlaps) {
            const key = `${o.peerId}:${o.kind}:${o.taskId}`;
            if (overlapNotified.has(key)) continue;
            overlapNotified.add(key);
            await emit("peer.overlap", { ...o, plannedTaskId: item.taskId });
            if (o.kind === "task_claimed") continue; // the claim below reports and messages this case
            await store.message.send({
              from_agent_id: agent.id,
              to_agent_id: o.peerId,
              project_id: project?.id ?? null,
              task_id: item.taskId,
              type: "warning",
              body: overlapMessage(work, o),
              requires_ack: false,
              author_agent: agent.id,
            });
            if (overlapBlocks(o)) blocked = true;
          }
          if (blocked) {
            skipped.push(item.taskId);
            await emit("task.skipped", { taskId: item.taskId, reason: "peer_in_flight" });
            continue;
          }
          const claim = await store.task.claim(item.taskId, agent.id, claimTtlMs, clock.now(), {
            reason: `session ${session.id}`,
          });
          if (!claim.ok) {
            skipped.push(item.taskId);
            await emit("task.skipped", {
              taskId: item.taskId,
              reason: claim.reason,
              holder: claim.reason === "held_by" ? claim.holder : undefined,
            });
            if (claim.reason === "held_by") {
              await store.message.send({
                from_agent_id: agent.id,
                to_agent_id: claim.holder,
                project_id: project?.id ?? null,
                task_id: item.taskId,
                type: "info",
                body: `I planned to work on "${item.title}" but you hold the claim; I moved on.`,
                requires_ack: false,
                author_agent: agent.id,
              });
            }
            continue;
          }
          heldClaims.add(item.taskId);
          let task = claim.task;
          if (task.status === "claimed")
            task = await store.task.transition(
              task.id,
              task.version,
              "in_progress",
              `session ${session.id} started work`,
              { agentId: agent.id },
            );
          await emit("task.started", {
            taskId: task.id,
            title: task.title,
            specialist: item.specialist,
            estimateUsdMicro: item.estimateUsdMicro,
          });
          const renew = clock.setTimeout(
            function tick() {
              void store.task.renewClaim(task.id, agent.id, claimTtlMs).catch(() => undefined);
            },
            Math.max(1000, Math.floor(claimTtlMs / 6)),
          );
          let result: TaskExecutionResult;
          try {
            result = await this.deps.executor.execute({
              task,
              session,
              token,
              budget,
              item,
              signal: controller.signal,
            });
          } catch (e) {
            const code = e instanceof ForerunnerError ? e.code : "internal";
            result = {
              outcome:
                code === "budget_exceeded"
                  ? "budget_exceeded"
                  : code === "timeout"
                    ? "timeout"
                    : code === "killed"
                      ? "killed"
                      : "failed",
              summary: errorMessage(e),
              costUsdMicro: 0,
            };
          } finally {
            renew();
          }
          task = await store.task.mustGet(task.id);
          await store.task.patch(task.id, {
            actual_cost_usd_micro: task.actual_cost_usd_micro + result.costUsdMicro,
            ...(result.prUrl ? { pr_url: result.prUrl } : {}),
            ...(result.branch ? { branch: result.branch } : {}),
            ...(task.owner_agent_id ? {} : { owner_agent_id: agent.id }),
          });
          task = await store.task.mustGet(task.id);
          if (result.changedFiles?.length) {
            filesByTask.set(task.id, result.changedFiles);
            await emit(TASK_FILES_EVENT, { taskId: task.id, files: result.changedFiles });
          }
          await emit(
            "task.finished",
            {
              taskId: task.id,
              outcome: result.outcome,
              costUsdMicro: result.costUsdMicro,
              summary: result.summary,
            },
            result.costUsdMicro,
          );
          const closeTier0 =
            result.outcome === "done" && task.risk_tier === 0 && result.checksPassed;
          if (closeTier0) {
            await store.task.transition(
              task.id,
              task.version,
              "in_review",
              "automated checks passed",
              { agentId: agent.id },
            );
            const t2 = await store.task.mustGet(task.id);
            await store.task.transition(
              t2.id,
              t2.version,
              "done",
              "tier 0: automated checks only",
              { agentId: agent.id },
            );
            completed.push(task.id);
          } else if (result.outcome === "done" || result.outcome === "in_review") {
            await store.task.transition(
              task.id,
              task.version,
              "in_review",
              result.summary.slice(0, 200),
              { agentId: agent.id },
            );
            inReview.push(task.id);
          } else if (result.outcome === "needs_human") {
            await store.task.transition(
              task.id,
              task.version,
              "needs_human",
              result.summary.slice(0, 200),
              { agentId: agent.id },
            );
            needsHuman.push(task.id);
          } else if (result.outcome === "failed" || result.outcome === "timeout") {
            await store.task.transition(
              task.id,
              task.version,
              "failed",
              result.summary.slice(0, 200),
              { agentId: agent.id },
            );
            failed.push(task.id);
          } else if (result.outcome === "budget_exceeded") {
            await store.task.transition(
              task.id,
              task.version,
              "needs_human",
              "budget exhausted mid-task",
              { agentId: agent.id },
            );
            needsHuman.push(task.id);
            stopReason = "budget_exceeded";
            await releaseIfHeld(task.id, "budget exhausted");
            skipped.push(...plan.items.slice(plan.items.indexOf(item) + 1).map((i) => i.taskId));
            break;
          } else if (result.outcome === "killed") {
            throw new ForerunnerError("killed", "session stopped during task");
          }
          await releaseIfHeld(task.id, "task finished for this session");
        }
        if (stopReason === "completed" && budget.noNewWork && skipped.length)
          stopReason = "budget_finish_current";
      }
    } catch (e) {
      const code = e instanceof ForerunnerError ? e.code : "internal";
      stopReason = code;
      status =
        code === "killed"
          ? "killed"
          : code === "timeout"
            ? "stopped"
            : code === "budget_exceeded"
              ? "stopped"
              : "failed";
      if (status === "failed")
        this.logger.error("session failed", { sessionId: session.id, error: errorMessage(e) });
      await emit("session.error", { code, message: errorMessage(e) });
    } finally {
      await releaseAll(`session ${stopReason}`);
      unregister();
    }

    // 4. Session end: summary, project summary cache, handoff to peers, notify human.
    await this.ackAnswered(agent.id, emit);
    const spent = (await store.costLedger.sum({ sessionId: session.id })).usd_micro;
    const summary = summarize({
      completed,
      inReview,
      failed,
      skipped,
      needsHuman,
      spent,
      stopReason,
      plan,
    });
    const handoff = {
      done: completed,
      in_flight: inReview,
      in_flight_files: Object.fromEntries(
        inReview.filter((id) => filesByTask.has(id)).map((id) => [id, filesByTask.get(id)]),
      ),
      blocked: [...needsHuman, ...failed],
      next: skipped,
      stop_reason: stopReason,
      spent_usd_micro: spent,
    };
    if (project) {
      await store.project.patch(project.id, {
        summary_cache: {
          ...(project.summary_cache as Record<string, never>),
          goal: project.goal,
          stage: project.stage,
          last_session: {
            id: session.id,
            ended_at: clock.nowIso(),
            summary,
            stop_reason: stopReason,
          },
          next_steps: skipped.slice(0, 3),
          open_questions: needsHuman.length,
          spend_usd_micro: (await store.costLedger.sum({ projectId: project.id })).usd_micro,
        } as never,
      });
    }
    for (const peerId of peerIds) {
      await store.message.send({
        from_agent_id: agent.id,
        to_agent_id: peerId,
        project_id: project?.id ?? null,
        type: "handoff",
        body: summary,
        requires_ack: true,
        author_agent: agent.id,
      });
    }
    await store.message.send({
      from_agent_id: agent.id,
      to_human_id: agent.owner_human_id,
      project_id: project?.id ?? null,
      type: "info",
      body: summary,
      requires_ack: false,
      author_agent: agent.id,
    });
    const finalStatus: SessionRow["status"] =
      status === "completed" && stopReason !== "completed" && stopReason !== "budget_finish_current"
        ? "stopped"
        : status;
    const current = await store.session.mustGet(session.id);
    const patched = await store.session.patch(session.id, {
      summary,
      handoff: handoff as never,
      spent_usd_micro: spent,
      steps: budget.snapshot().steps,
      ended_at: clock.nowIso(),
    });
    try {
      await store.session.setStatus(
        patched.id,
        patched.version,
        finalStatus === "paused" ? "paused" : finalStatus,
      );
    } catch {
      // already terminal (e.g. killed by the kill switch callback)
    }
    void current;
    await emit("session.ended", {
      status: finalStatus,
      stopReason,
      spentUsdMicro: spent,
      completed: completed.length,
      inReview: inReview.length,
      failed: failed.length,
      skipped: skipped.length,
    });
    return {
      sessionId: session.id,
      status: finalStatus,
      brief: brief as StateBrief,
      plan,
      completed,
      inReview,
      failed,
      skipped,
      needsHuman,
      spentUsdMicro: spent,
      steps: budget.snapshot().steps,
      summary,
      handoff,
      stopReason,
    };
  }

  /** Inbox re-check between tasks: a human "stop" message stops the session; questions become requests. */
  private async recheckInbox(
    agentId: string,
    sessionId: string,
    emit: (t: string, p: Record<string, unknown>) => Promise<void>,
  ): Promise<"continue" | "stop"> {
    const unread = await this.deps.store.message.inbox(
      { agentId },
      { unreadOnly: true, limit: 50 },
    );
    let stop = false;
    for (const m of unread) {
      await this.deps.store.message.markDelivered(m.id);
      await this.deps.store.message.markRead(m.id);
      if (/^\s*(stop|halt|pause)\b/i.test(m.body) && m.type !== "handoff") stop = true;
      await emit("inbox.message", { id: m.id, type: m.type, from: m.from_agent_id, sessionId });
      if (m.requires_ack && ACK_BY_READING.has(m.type)) {
        await this.deps.store.message.markActed(m.id);
        await emit("inbox.acted", { id: m.id, type: m.type });
      }
    }
    return stop ? "stop" : "continue";
  }

  /** Questions and requests are acted on once this agent replied to them. */
  private async ackAnswered(
    agentId: string,
    emit: (t: string, p: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    const received = await this.deps.store.message.inbox({ agentId }, { limit: 200 });
    for (const m of received) {
      if (!m.requires_ack || m.acted_at || ACK_BY_READING.has(m.type)) continue;
      const replies = await this.deps.store.message.replies(m.id);
      if (replies.some((r) => r.from_agent_id === agentId)) {
        await this.deps.store.message.markActed(m.id);
        await emit("inbox.acted", { id: m.id, type: m.type, replied: true });
      }
    }
  }
}

export function cutPlanToBudget(plan: SessionPlan, workBudgetUsdMicro: number): SessionPlan {
  const items: PlanItem[] = [];
  let total = 0;
  for (const item of plan.items) {
    if (total + item.estimateUsdMicro > workBudgetUsdMicro) break;
    items.push(item);
    total += item.estimateUsdMicro;
  }
  const cut = plan.items.length - items.length;
  return {
    items,
    estimateUsdMicro: total,
    summary: cut > 0 ? `${plan.summary} (${cut} item(s) cut to fit the budget)` : plan.summary,
  };
}

function summarize(x: {
  completed: string[];
  inReview: string[];
  failed: string[];
  skipped: string[];
  needsHuman: string[];
  spent: number;
  stopReason: string;
  plan: SessionPlan | null;
}): string {
  const parts = [
    `Session ${x.stopReason === "completed" ? "completed" : `ended (${x.stopReason})`}.`,
    `Done: ${x.completed.length}. In review: ${x.inReview.length}. Needs you: ${x.needsHuman.length}. Failed: ${x.failed.length}. Not started: ${x.skipped.length} of ${x.plan?.items.length ?? 0} planned.`,
    `Spent $${(x.spent / 1e6).toFixed(2)}.`,
  ];
  return parts.join(" ");
}

/**
 * Peers for handoffs: the project's explicit members (settings.members, agent ids) when set,
 * otherwise every other active principal agent that has touched the project (tasks, claims,
 * sessions).
 */
function defaultPeers(store: StateStore) {
  return async (agentId: string, projectId: string | undefined): Promise<string[]> => {
    if (!projectId) return [];
    const project = await store.project.mustGet(projectId);
    const all = await store.agent.list({ kind: "principal", status: "active" } as never, {
      limit: 100,
    });
    const members = (project.settings as { members?: unknown }).members;
    if (Array.isArray(members) && members.length) {
      return all.filter((a) => a.id !== agentId && members.includes(a.id)).map((a) => a.id);
    }
    const touched = new Set<string>();
    for (const t of await store.task.list({ project_id: projectId } as never, { limit: 1000 })) {
      if (t.author_agent) touched.add(t.author_agent);
      if (t.claimed_by) touched.add(t.claimed_by);
      if (t.owner_agent_id) touched.add(t.owner_agent_id);
    }
    for (const s of await store.session.forProject(projectId, { limit: 1000 }))
      touched.add(s.agent_id);
    return all.filter((a) => a.id !== agentId && touched.has(a.id)).map((a) => a.id);
  };
}

/** Plans the ready tasks in priority order with the task's own estimate; no model call. */
export class StaticPlanner implements Planner {
  constructor(private readonly defaultEstimateUsdMicro = 500_000) {}
  async plan(ctx: PlannerContext): Promise<SessionPlan> {
    const items = ctx.readyTasks
      .filter((t) => !t.claimed_by || (t.claim_expires && t.claim_expires < ctx.brief.generatedAt))
      .sort((a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at))
      .map((t) => ({
        taskId: t.id,
        title: t.title,
        specialist: t.specialist ?? "coder",
        estimateUsdMicro:
          t.est_cost_usd_micro || t.budget_usd_micro || this.defaultEstimateUsdMicro,
      }));
    return {
      items,
      estimateUsdMicro: items.reduce((s, i) => s + i.estimateUsdMicro, 0),
      summary: `${items.length} ready task(s) in priority order`,
    };
  }
}
