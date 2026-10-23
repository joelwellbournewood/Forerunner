import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { email as agentEmail, cloudflare, desktop } from "@forerunner/capabilities";
import { errorMessage, ForerunnerError, join, log, osFacts } from "@forerunner/platform";
import type { LessonStatus } from "@forerunner/state";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodType } from "zod";
import { createDataRoutes } from "../data/routes.ts";
import { writeKillRequest } from "../enforcement/killfile.ts";
import { estimateAccuracyView } from "../estimates/view.ts";
import { createExtensionsRoutes } from "../extensions/routes.ts";
import type { CommandResultView, CommandTurn } from "../loop/ports.ts";
import { createModelWatchRoutes } from "../models/watch-routes.ts";
import type { NotificationEventPayload } from "../notifications/emitter.ts";
import { createNotificationRoutes } from "../notifications/routes.ts";
import { createSharedSecretRoutes } from "../secrets/routes.ts";
import { createRunnerUnlockRoutes } from "../secrets/runner-unlock-routes.ts";
import { applySharedGrantAnswer } from "../secrets/shared-grants.ts";
import { buildPeerFeed } from "../session/peers.ts";
import { applyProjectPlan, defaultRiskTier, ProjectPlanBody } from "../session/project-plan.ts";
import { defaultPeers } from "../session/runner.ts";
import { createSourcesRoutes } from "../sources/routes.ts";
import { createUpdateRoutes } from "../update/screen.ts";
import type { SchemaSyncStatus } from "../update/sync.ts";
import type { VoiceBridgeEntry } from "../voice/bridge.ts";
import type { AudioChunk } from "../voice/pkg.ts";
import {
  decodePcm,
  voiceAnswerView,
  voiceEventView,
  voiceSessionView,
  voiceStatusView,
  voiceTurnView,
} from "../voice/views.ts";
import { DESKTOP_INDICATOR_EVENT, type DesktopIndicatorPayload } from "../wiring/desktop-ports.ts";
import { DecisionLog, StateAudit } from "../wiring/state-ports.ts";
import { ModelWatchUpdates, RegistryConnectorCatalog } from "./adapters.ts";
import {
  AnswerOfferBody,
  AnswerRequestBody,
  type ChatReplyView,
  ChatRequestBody,
  CommandConfirmBody,
  CommandExecuteBody,
  CommandParseBody,
  type CommandParseView,
  type CommandResultJson,
  type CommandSourceBody,
  type ConsolidationProposalView,
  type ConsolidationRunView,
  CreateProjectBody,
  CreateTaskBody,
  type DecisionView,
  type EventView,
  type HealthView,
  type IntakeProposalView,
  IntakeRequestBody,
  type IntakeStatusView,
  KillBody,
  type LessonOfferView,
  type MemoryScopeView,
  type MemoryView,
  type MirrorRunView,
  MirrorSyncBody,
  type MirrorSyncPendingView,
  type PeerFeedView,
  type PendingChangeView,
  PinLessonBody,
  type PlanProjectView,
  StartSessionBody,
  StartVoiceSessionBody,
  type SyncHealth,
  TransitionTaskBody,
  UpdateLessonBody,
  UpdateProjectSettingsBody,
  VoiceAnswerBody,
  VoiceAudioBody,
  VoicePressBody,
  VoiceTextBody,
} from "./api-types.ts";
import { createAuditRoutes } from "./audit-export.ts";
import type { RuntimeApp } from "./compose.ts";
import { createProjectRecord } from "./create-project.ts";
import type { RestartRequestFile } from "./restart.ts";
import { sandboxHealth } from "./sandbox-port.ts";
import { CLIENT_HEADER, isShellStream } from "./shells.ts";
import {
  changeLogView,
  commandDefView,
  costView,
  eventView,
  lessonView,
  messageView,
  milestoneView,
  money,
  projectCard,
  projectSummary,
  requestView,
  reviewsView,
  runView,
  sessionView,
  taskView,
} from "./views.ts";

/**
 * The local daemon API (ADR 0011): Hono over the composed runtime, bearer token, SSE streams.
 * Bound to 127.0.0.1 only. `daemon.json` in the runtime directory tells the shells where it is.
 */
export interface DaemonServerOptions {
  token?: string;
  host?: string;
  port?: number;
}

/**
 * How long `RunningDaemon.stop()` waits for in-flight responses after the SSE streams were
 * ended before it closes the remaining connections itself. The restart contract (ADR 0029)
 * needs a bounded stop: an attached shell holds `/events` open for as long as it runs.
 */
export const STOP_TIMEOUT_MS = 3_000;

/** The schema sync gate as `/health` reports it (spec M); the refusal counter stays internal. */
function syncHealth(s: SchemaSyncStatus): SyncHealth {
  return {
    paused: s.paused,
    local: s.local,
    peer: s.peer,
    minSchema: s.minSchema,
    action: s.action,
    message: s.message,
    checkedAt: s.checkedAt,
  };
}

/**
 * Origins the shells and the dev server use; anything else gets no CORS headers. The opaque
 * origin `null` (sandboxed iframes, `file://` pages, some redirects) is not one: no shell sends
 * it and allowing it is the CWE-942 anti-pattern (security-daemon.test.ts).
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  if (origin === "tauri://localhost") return true;
  try {
    const u = new URL(origin);
    const host = u.hostname;
    return (
      (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "tauri:") &&
      (host === "localhost" ||
        host === "127.0.0.1" ||
        host === "[::1]" ||
        host === "::1" ||
        host === "tauri.localhost" ||
        host.endsWith(".localhost"))
    );
  } catch {
    return false;
  }
}

export function createDaemonApp(
  rt: RuntimeApp,
  opts: DaemonServerOptions = {},
): { app: Hono; token: string; closeStreams: () => void } {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const app = new Hono();
  const logger = log("daemon");
  const chf = () => rt.chfPerUsd();
  const chatReplyView = (
    r: Awaited<ReturnType<NonNullable<RuntimeApp["conversation"]>["chat"]>>,
  ): ChatReplyView => ({
    reply: r.reply,
    actions: r.actions,
    pendingConfirmation: r.pendingConfirmation
      ? {
          id: r.pendingConfirmation.id,
          readback: r.pendingConfirmation.readback,
          estimate: money(r.pendingConfirmation.costUsdMicro ?? 0, chf()),
          commands: r.pendingConfirmation.commands,
          decision: r.pendingConfirmation.decision ?? null,
        }
      : null,
    question: r.question,
    ttftMs: r.ttftMs,
    cost: money(r.costUsdMicro, chf()),
    transcriptId: r.transcriptId,
    activeProjectId: r.activeProjectId,
  });

  // Every open SSE stream registers how to end it: `server.close()` waits for in-flight
  // responses and an EventSource never finishes on its own, so a stop (and "Update and
  // restart") first ends the streams, then closes the server.
  const streams = new Set<() => void>();
  const closeStreams = () => {
    for (const close of [...streams]) close();
  };
  /** Tick every `tickMs` until the client goes away, the daemon stops or `onTick` returns false. */
  const streamUntilClosed = async (
    stream: SSEStreamingApi,
    tickMs: number,
    onTick: () => Promise<boolean | undefined>,
  ): Promise<void> => {
    let open = true;
    let wake: (() => void) | null = null;
    const close = () => {
      open = false;
      wake?.();
    };
    stream.onAbort(close);
    streams.add(close);
    try {
      while (open) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            wake = null;
            resolve();
          }, tickMs);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
        if (!open) break;
        if ((await onTick()) === false) break;
      }
    } finally {
      streams.delete(close);
    }
  };

  app.onError((err, c) => {
    if (err instanceof ForerunnerError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "validation" && err.details?.reason === "bad_query"
            ? 400
            : err.code === "validation" ||
                err.code === "version_conflict" ||
                err.code === "claim_conflict"
              ? 409
              : err.code === "approval_required" || err.code === "autonomy_insufficient"
                ? 403
                : err.code === "provider_auth" || err.code === "unavailable"
                  ? 503
                  : 500;
      // ADR 0025: a stale version or a lost claim is reported as "conflict"; the runtime's own
      // code stays in the details for the log.
      const code = status === 409 ? "conflict" : err.code;
      return c.json(
        { code, message: err.message, details: { ...(err.details ?? {}), cause: err.code } },
        status,
      );
    }
    logger.error("unhandled", { error: errorMessage(err) });
    return c.json({ code: "internal", message: errorMessage(err) }, 500);
  });

  // The shells run the UI from another origin (the dev server, Playwright, tauri://localhost):
  // allow local origins only, with the headers the client sends (ADR 0025).
  app.use(
    "*",
    cors({
      origin: (origin) => (isLocalOrigin(origin) ? origin : ""),
      allowHeaders: ["Authorization", "Content-Type", "Accept"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      // The audit export names its file in Content-Disposition; the UI reads it cross-origin.
      exposeHeaders: ["Content-Disposition"],
      maxAge: 600,
    }),
  );

  // Bearer token on every route. EventSource cannot set headers, so the two SSE routes also
  // accept the token as a query parameter; nothing else does, and query strings of those
  // routes are never logged.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.method === "OPTIONS") return next();
    const header = c.req.header("authorization") ?? "";
    const sseRoute =
      c.req.method === "GET" &&
      (c.req.path === "/events" ||
        /^\/sessions\/[^/]+\/events$/.test(c.req.path) ||
        /^\/voice\/sessions\/[^/]+\/events$/.test(c.req.path));
    const got = header.startsWith("Bearer ")
      ? header.slice(7)
      : sseRoute
        ? (c.req.query("token") ?? "")
        : "";
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return c.json({ code: "unauthorized", message: "missing or invalid daemon token" }, 401);
    return next();
  });

  const parse = async <T>(
    c: { req: { json(): Promise<unknown> } },
    schema: ZodType<T>,
  ): Promise<T> => {
    const body = await c.req.json().catch(() => ({}));
    const r = schema.safeParse(body);
    if (!r.success)
      throw new ForerunnerError(
        "validation",
        r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      );
    return r.data;
  };

  // Numbers in list queries (`?limit=`, `?afterSeq=`) go through one validator, as the state
  // service's `intParam` does: anything but a non-negative integer is a 400 before any store
  // call, never a NaN that fails in SQL and comes back as a 500 carrying the driver's text.
  const intQuery = (
    c: { req: { query(name: string): string | undefined } },
    name: string,
    fallback: number,
    max: number,
  ): number => {
    const raw = c.req.query(name);
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0)
      throw new ForerunnerError("validation", `${name} must be a non-negative integer`, {
        details: { reason: "bad_query", param: name },
      });
    return Math.min(n, max);
  };

  // Rows of another human on a shared state (ADR 0041 item 4): the daemon reads and answers
  // as its own human only, the way the state service forces a device's own human.
  const NOT_YOURS = { code: "forbidden" } as const;

  app.get("/health", async (c) => {
    const active = await rt.store.session.active(rt.agent.id);
    const extensions = await rt.extensions.list();
    const view: HealthView = {
      ok: true,
      version: rt.appVersion,
      profile: rt.config?.profile ?? "default",
      uptimeMs: rt.clock.now() - rt.startedAt,
      platform: osFacts().platform,
      stateUrl: (rt.config?.stateUrl ?? "sqlite").replace(/\/\/[^@]*@/, "//[REDACTED]@"),
      vaultBackend: rt.vault.backend,
      activeSessions: active.filter((s) => s.summary !== "conversation").length,
      killActive: rt.kill.isFrozen({ agentId: rt.agent.id }),
      sandbox: sandboxHealth(rt.sandbox.detection),
      extensions: {
        enabled: extensions.filter((e) => e.status === "enabled").length,
        pending: extensions.filter((e) => e.status === "pending_approval").length,
      },
      sync: syncHealth(rt.schemaSync.status()),
    };
    return c.json(view);
  });

  // Module sub-apps behind the same bearer check: the Extensions panel (spec K.6, L.5), the
  // updates screen (spec M) and the model watch (spec D). Each keeps its own error mapping.
  app.route(
    "/",
    createExtensionsRoutes({ registry: rt.extensions, actor: () => ({ humanId: rt.human.id }) }),
  );
  app.route(
    "/",
    createUpdateRoutes({
      manager: rt.updates,
      clock: rt.clock,
      extensions: rt.store.extension,
      catalog: new RegistryConnectorCatalog(rt.extensions.catalog),
      modelWatch: new ModelWatchUpdates(rt.modelWatch),
      humanId: rt.human.id,
    }),
  );
  app.route("/model-watch", createModelWatchRoutes({ watch: rt.modelWatch }));
  // Notifications (spec R.6, ADR 0017, ADR 0038): preferences, a test send, the recent list.
  app.route(
    "/",
    createNotificationRoutes({ notifier: rt.notifier, actor: () => ({ humanId: rt.human.id }) }),
  );
  // Cloudflare panel routes (spec S.5, ADR 0035): the project's settings with the secret by
  // reference, and the token's real scopes. Structural handlers, adapted to Hono's context;
  // the API base comes from the project's settings (the stand-in sets it to 127.0.0.1).
  for (const route of cloudflare.cloudflareRoutes({
    projects: rt.store.project,
    vault: rt.vault,
    clock: rt.clock,
  })) {
    app.get(route.path, (c) =>
      route.handler({
        req: { param: (name) => c.req.param(name as never) as string | undefined },
        json: (body, status) => c.json(body, (status ?? 200) as ContentfulStatusCode),
      }),
    );
  }
  // Desktop control (spec L.4, S.32; ADR 0021, ADR 0039): status with what is installed and
  // missing, the signed-in human's allowlist, live revoke (open to any caller) and resume (the
  // daemon's human). Structural handlers adapted to Hono's context, as for Cloudflare.
  for (const route of desktop.desktopRouteTable({
    controller: rt.desktop.controller,
    allowlist: rt.desktop.allowlist,
    clock: rt.clock,
    detect: rt.desktop.detect,
    audit: new StateAudit(rt.store),
    humanFor: () => rt.human.id,
  })) {
    app.on(route.method, route.path, (c) =>
      route.handler({
        req: {
          param: (name) => c.req.param(name as never) as string | undefined,
          query: (name) => c.req.query(name),
          json: () => c.req.json(),
          header: (name) => c.req.header(name),
        },
        json: (body, status) => c.json(body, (status ?? 200) as ContentfulStatusCode),
      }),
    );
  }
  // Agent email (spec S.15, S.28, S.29, T.14; ADR 0066): the Settings -> Capabilities -> Email
  // routes (settings per agent, the sent log, pause and resume for the tray, marker rotation,
  // the command audit) over the capability's own ports. The daemon's human is the signed-in
  // human and the identity port the owner check: another human's agent answers 403 before
  // any read or write. Every change is one `email.settings` audit row; the policy reads the
  // settings row per call, so a changed mode or a pause holds the very next send.
  for (const route of agentEmail.emailRouteTable({
    settings: rt.capabilities.email.ports.settings,
    sentLog: rt.capabilities.email.ports.sentLog,
    identity: rt.capabilities.email.ports.identity,
    clock: rt.clock,
    audit: rt.store.auditLog,
    commandAudit: agentEmail.emailCommandAudit({ auditLog: rt.store.auditLog, clock: rt.clock }),
    humanFor: () => rt.human.id,
  })) {
    app.on(route.method, route.path, (c) =>
      route.handler({
        req: {
          param: (name) => c.req.param(name as never) as string | undefined,
          query: (name) => c.req.query(name),
          json: () => c.req.json(),
          header: (name) => c.req.header(name),
        },
        json: (body, status) => c.json(body, (status ?? 200) as ContentfulStatusCode),
      }),
    );
  }
  // Files and data (spec L.1, A.3, K.2): the Data tab routes (list, register or upload, import,
  // describe, sample, delete); the daemon's human is the actor, so DELETE always has one.
  app.route(
    "/",
    createDataRoutes({
      assets: rt.data.assets,
      importer: rt.data.importer,
      actor: () => ({ humanId: rt.human.id }),
    }),
  );
  // Source discovery (spec A.4, ADR 0056): connected sources, scans, proposals and accepts;
  // the daemon's human is the actor and another human's source answers 403 forbidden.
  app.route(
    "/",
    createSourcesRoutes({ discovery: rt.sources, actor: () => ({ humanId: rt.human.id }) }),
  );
  // Audit log export (spec S.9, ADR 0050): `GET /audit/export` streams the install's human's
  // rows and their agents' in pages, as JSON lines or CSV, with the summaries as stored.
  app.route(
    "/",
    createAuditRoutes({ store: rt.store, clock: rt.clock, humanId: () => rt.human.id }),
  );
  // Shared secrets (spec S.13, ADR 0065): the owner proposes, lists and revokes grants of a
  // secret in this install's vault; the value is wrapped here and never in a body.
  app.route("/", createSharedSecretRoutes({ sharedSecrets: rt.sharedSecrets }));
  // Cloud runner vault unlock (spec S.12, ADR 0068): the inbox's unlock card has the runner's
  // vault key wrapped to the challenge here, where the OS keyring is; the key never leaves.
  app.route(
    "/",
    createRunnerUnlockRoutes({
      vault: rt.vault,
      clock: rt.clock,
      auditLog: rt.store.auditLog,
      humanId: () => rt.human.id,
    }),
  );

  app.get("/me", async (c) => {
    const h = await rt.store.human.mustGet(rt.human.id);
    return c.json({
      id: h.id,
      name: h.name,
      email: h.email,
      timezone: h.timezone,
      defaultAutonomy: h.default_autonomy,
      monthlyCap: money(h.monthly_cap_usd_micro, chf()),
      agent: rt.agent,
      // The registry's record wins (a switch by chat, voice or the UI all land there).
      activeProjectId:
        (await rt.commands.activeProject(h.id)) ?? rt.conversation?.getActiveProject(h.id) ?? null,
      provider: rt.provider?.name ?? null,
    });
  });

  app.get("/agents", async (c) => {
    const rows = await rt.store.agent.list(undefined, { limit: 100 });
    return c.json(
      rows.map((a) => ({
        id: a.id,
        name: a.name,
        ownerHumanId: a.owner_human_id,
        kind: a.kind,
        status: a.status,
      })),
    );
  });

  app.get("/projects", async (c) => {
    const rows = await rt.store.project.active({ limit: 100 });
    return c.json(
      await Promise.all(rows.map((p) => projectCard(rt.store, p.id, chf(), rt.human.id))),
    );
  });

  app.post("/projects", async (c) => {
    const body = await parse(c, CreateProjectBody);
    // The same path an accepted source proposal takes (create-project.ts, spec A.4).
    const p = await createProjectRecord(rt, body);
    // The standard doc set (spec G.5): a pull request on the linked repository, or the
    // project's data dir. The gap is recorded on the project; the creation never fails on it.
    // A creation that asks for the intake (spec A.2) leaves the set to the intake's approval,
    // which drafts the docs from the brief and scaffolds only what the draft left out.
    if (body.intake === true) {
      logger.info("project docs deferred to the intake", { projectId: p.id });
    } else {
      try {
        await rt.docs.scaffoldProject(p);
      } catch (e) {
        logger.warn("project docs not scaffolded", { projectId: p.id, error: errorMessage(e) });
      }
    }
    // PM intake (spec A.2): asked for, the proposal is drafted in the background and lands in
    // the inbox; the card answers now. A failure is recorded on the project (the status route).
    if (body.intake === true) void rt.intake.enqueue(p.id).catch(() => undefined);
    return c.json(await projectCard(rt.store, p.id, chf(), rt.human.id), 201);
  });

  // PM intake (spec A.2, ADR 0055): one model call on the planning rung, one blocking approval
  // request with the whole proposal; nothing is written until the inbox answers it (the answer
  // route's `syncApprovals` applies it). The project is looked up first so an unknown project
  // is 404 whatever the body.
  app.post("/projects/:id/intake", async (c) => {
    const project = await rt.store.project.mustGet(c.req.param("id"));
    const body = await parse(c, IntakeRequestBody);
    const r = await rt.intake.propose(
      project.id,
      body.brief !== undefined ? { brief: body.brief } : {},
    );
    rt.events.emit("project", { id: project.id });
    const view: IntakeProposalView = {
      pending: true,
      projectId: r.projectId,
      requestId: r.requestId,
      reused: r.reused,
      summary: r.summary,
      estimateUsdMicro: r.estimateUsdMicro,
      costUsdMicro: r.costUsdMicro,
      docsTarget: r.docsTarget,
    };
    return c.json(view, 202);
  });
  app.get("/projects/:id/intake", async (c) => {
    const s = await rt.intake.status(c.req.param("id"));
    const view: IntakeStatusView = {
      projectId: s.projectId,
      state: s.state,
      requestId: s.requestId,
      outcome: s.outcome,
      appliedAt: s.appliedAt,
      docs: s.docs,
      error: s.error,
    };
    return c.json(view);
  });

  app.get("/projects/:id", async (c) =>
    c.json(await projectCard(rt.store, c.req.param("id"), chf(), rt.human.id)),
  );
  app.get("/projects/:id/summary", async (c) =>
    c.json(await projectSummary(rt.store, c.req.param("id"), chf())),
  );

  app.get("/projects/:id/tasks", async (c) => {
    const status = c.req.query("status");
    const limit = intQuery(c, "limit", 200, 1000);
    const rows = await rt.store.task.list(
      { project_id: c.req.param("id"), ...(status ? { status } : {}) } as never,
      { limit, orderBy: [{ column: "priority", direction: "desc" }, { column: "created_at" }] },
    );
    return c.json(rows.map((t) => taskView(t, chf())));
  });

  app.post("/projects/:id/tasks", async (c) => {
    const body = await parse(c, CreateTaskBody);
    const project = await rt.store.project.mustGet(c.req.param("id"));
    const t = await rt.store.task.insert({
      project_id: project.id,
      milestone_id: body.milestoneId ?? null,
      title: body.title,
      outcome: body.outcome,
      acceptance_criteria: body.acceptanceCriteria,
      // A task that names no tier gets the project's default: 0 in small-project mode (B.6).
      risk_tier: body.riskTier ?? defaultRiskTier(project),
      status: body.status,
      priority: body.priority,
      depends_on: body.dependsOn,
      budget_usd_micro: body.budgetUsdMicro,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "created from the app",
      author_human: rt.human.id,
    });
    rt.events.emit("project", { id: project.id });
    return c.json(taskView(t, chf()), 201);
  });

  // The plan writer (spec B.6): a plan becomes milestone and task rows shaped by the project's
  // mode; one milestone and a flat task list in small-project mode. The project is looked up
  // first so an unknown project is 404 whatever the body.
  app.post("/projects/:id/plan", async (c) => {
    const project = await rt.store.project.mustGet(c.req.param("id"));
    const body = await parse(c, ProjectPlanBody);
    const applied = await applyProjectPlan(rt.store, project, body, { humanId: rt.human.id });
    rt.events.emit("project", { id: project.id });
    const view: PlanProjectView = {
      milestones: applied.milestones.map(milestoneView),
      reusedMilestone: applied.reusedMilestone ? milestoneView(applied.reusedMilestone) : null,
      merged: applied.merged,
      tasks: applied.tasks.map((t) => taskView(t, chf())),
    };
    return c.json(view, 201);
  });

  app.post("/tasks/:id/transition", async (c) => {
    const body = await parse(c, TransitionTaskBody);
    const t = await rt.store.task.transition(
      c.req.param("id"),
      body.version,
      body.to as never,
      body.reason,
      { humanId: rt.human.id },
    );
    rt.events.emit("project", { id: t.project_id });
    return c.json(taskView(t, chf()));
  });

  app.get("/projects/:id/runs", async (c) => {
    const limit = intQuery(c, "limit", 200, 2000);
    const tasks = await rt.store.task.list({ project_id: c.req.param("id") } as never, {
      limit: 2000,
    });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const runs = (
      await rt.store.run.list({} as never, {
        orderBy: [{ column: "created_at", direction: "desc" }],
        limit: 5000,
      })
    )
      .filter((r) => r.task_id && byId.has(r.task_id))
      .slice(0, limit);
    const out = [];
    for (const r of runs) {
      const review = r.task_id ? await rt.store.review.latestForTask(r.task_id) : undefined;
      out.push(
        runView(
          r,
          chf(),
          r.task_id ? byId.get(r.task_id) : undefined,
          review ? { id: review.id, verdict: review.verdict } : null,
        ),
      );
    }
    return c.json(out);
  });

  app.get("/sessions", async (c) => {
    const agentId = c.req.query("agentId");
    const projectId = c.req.query("projectId");
    const status = c.req.query("status");
    const rows = await rt.store.session.list(
      {
        ...(agentId ? { agent_id: agentId } : {}),
        ...(projectId ? { project_id: projectId } : {}),
        ...(status ? { status } : {}),
      } as never,
      { orderBy: [{ column: "created_at", direction: "desc" }], limit: 100 },
    );
    const names = new Map<string, string>();
    const out = [];
    for (const s of rows.filter((r) => r.summary !== "conversation")) {
      if (!names.has(s.agent_id))
        names.set(s.agent_id, (await rt.store.agent.get(s.agent_id))?.name ?? s.agent_id);
      out.push(sessionView(s, names.get(s.agent_id) ?? s.agent_id, chf()));
    }
    return c.json(out);
  });

  app.post("/sessions", async (c) => {
    const body = await parse(c, StartSessionBody);
    const result = await rt.scheduler.request({
      agentId: body.agentId,
      projectId: body.projectId,
      trigger: body.trigger,
      reason: body.reason ?? "started from the app",
      ...(body.budgetUsdMicro ? { budgetUsdMicro: body.budgetUsdMicro } : {}),
    } as never);
    return c.json({ result }, 202);
  });

  app.get("/sessions/:id", async (c) => {
    const s = await rt.store.session.mustGet(c.req.param("id"));
    const name = (await rt.store.agent.get(s.agent_id))?.name ?? s.agent_id;
    const last = (await rt.store.event.list(s.id, 0, 10_000))
      .filter((e) => e.type === "task.started" || e.type === "task.finished")
      .at(-1);
    const current =
      last?.type === "task.started"
        ? {
            id: String((last.payload as { taskId: string }).taskId),
            title: String((last.payload as { title: string }).title),
            specialist: String((last.payload as { specialist: string }).specialist),
          }
        : null;
    return c.json(sessionView(s, name, chf(), current));
  });

  app.get("/sessions/:id/events", async (c) => {
    const id = c.req.param("id");
    const afterSeq = intQuery(c, "afterSeq", 0, Number.MAX_SAFE_INTEGER);
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
      const rows = await rt.store.event.list(id, afterSeq, 2000);
      return c.json(rows.map((e) => eventView(e, chf())));
    }
    return streamSSE(c, async (stream) => {
      let seq = afterSeq;
      const flush = async () => {
        const rows = await rt.store.event.list(id, seq, 500);
        for (const e of rows) {
          seq = e.seq;
          await stream.writeSSE({
            event: "session.event",
            data: JSON.stringify(eventView(e, chf())),
            id: String(e.seq),
          });
        }
      };
      await flush();
      const listener = () => {
        void flush();
      };
      rt.events.on("session", listener);
      try {
        let ticks = 0;
        await streamUntilClosed(stream, 1000, async () => {
          await flush();
          if (++ticks % 15 === 0)
            await stream.writeSSE({
              event: "heartbeat",
              data: JSON.stringify({ at: rt.clock.nowIso() }),
            });
          const s = await rt.store.session.get(id);
          if (s && ["completed", "stopped", "failed", "killed"].includes(s.status)) {
            await flush();
            return false;
          }
          return true;
        });
      } finally {
        rt.events.off("session", listener);
      }
    });
  });

  app.post("/sessions/:id/stop", async (c) => {
    const s = await rt.store.session.mustGet(c.req.param("id"));
    const report = await rt.kill.stop({ sessionId: s.id }, "stopped from the app");
    rt.kill.resume();
    return c.json(report);
  });

  app.post("/kill", async (c) => {
    const body = await parse(c, KillBody);
    const report = await rt.kill.stop(body.scope, body.reason ?? "kill switch from the app");
    const killActive = rt.kill.isFrozen({ agentId: rt.agent.id });
    writeKillRequest(
      {
        scope: body.scope,
        reason: body.reason ?? "kill switch from the app",
        requestedAt: rt.clock.nowIso(),
        requestedBy: "daemon",
      },
      rt.dirs.runtime,
    );
    rt.events.emit("session", { type: "kill", payload: report });
    return c.json({ killActive, ...report });
  });
  app.post("/kill/resume", async (c) => {
    rt.kill.resume();
    rt.events.emit("session", { type: "kill.resumed", payload: {} });
    return c.json({ killActive: rt.kill.isFrozen({ agentId: rt.agent.id }), ok: true });
  });

  app.get("/inbox", async (c) => {
    // The inbox is the daemon's human's own; `?humanId=` naming anyone else is refused.
    const humanId = rt.human.id;
    const asked = c.req.query("humanId");
    if (asked !== undefined && asked !== "" && asked !== humanId)
      return c.json({ ...NOT_YOURS, message: "not your inbox" }, 403);
    const requests = await rt.store.humanRequest.open({ humanId }, { limit: 200 });
    const messages = await rt.store.message.inbox(
      { humanId },
      { limit: 200, orderBy: [{ column: "created_at", direction: "desc" }] },
    );
    const names = new Map<string, string>();
    const projects = new Map<string, string>();
    const reqViews = [];
    for (const r of requests) {
      if (r.project_id && !projects.has(r.project_id))
        projects.set(
          r.project_id,
          (await rt.store.project.get(r.project_id))?.name ?? r.project_id,
        );
      reqViews.push(requestView(r, r.project_id ? (projects.get(r.project_id) ?? null) : null));
    }
    const msgViews = [];
    for (const m of messages) {
      if (!names.has(m.from_agent_id))
        names.set(
          m.from_agent_id,
          (await rt.store.agent.get(m.from_agent_id))?.name ?? m.from_agent_id,
        );
      msgViews.push(messageView(m, names.get(m.from_agent_id) ?? m.from_agent_id));
    }
    return c.json({
      requests: reqViews,
      messages: msgViews,
      blockingCount: requests.filter((r) => r.blocking).length,
    });
  });

  app.post("/requests/:id/answer", async (c) => {
    const body = await parse(c, AnswerRequestBody);
    // A request addressed to another human (shared Postgres) is not this human's to answer.
    const asked = await rt.store.humanRequest.mustGet(c.req.param("id"));
    if (asked.human_id !== null && asked.human_id !== rt.human.id)
      return c.json({ ...NOT_YOURS, message: "not your request" }, 403);
    // The answer, its decision-log entry and, for a shared-secret card (spec S.13, ADR 0065),
    // the grant it moves are one write, as in the state service's answer route.
    const r = await rt.store.transaction(async (tx) => {
      const answered = await tx.humanRequest.answer(
        c.req.param("id"),
        body.version,
        body.answer as never,
        rt.human.id,
      );
      await new DecisionLog(tx).recordAnswer(answered, rt.human.id);
      await applySharedGrantAnswer(tx, answered, rt.human.id, {
        clock: rt.clock,
        installId: rt.remote.device?.id ?? null,
      });
      return answered;
    });
    // An answered extension grant or model watch decision is applied at once.
    await rt.syncApprovals();
    rt.events.emit("inbox", {});
    return c.json(requestView(r, null));
  });

  // Project settings (mirror, sandbox and other switches); the mirror schedule follows the
  // settings, so enabling the mirror here registers its run and disabling removes it.
  app.put("/projects/:id/settings", async (c) => {
    const body = await parse(c, UpdateProjectSettingsBody);
    const current = await rt.store.project.mustGet(c.req.param("id"));
    const merged: Record<string, unknown> = { ...(current.settings as Record<string, unknown>) };
    for (const [k, v] of Object.entries(body.settings)) {
      const prev = merged[k];
      merged[k] =
        v && typeof v === "object" && !Array.isArray(v) && prev && typeof prev === "object"
          ? { ...(prev as Record<string, unknown>), ...(v as Record<string, unknown>) }
          : v;
    }
    const updated = await rt.store.project.update(current.id, body.version, {
      settings: merged as never,
    });
    const mirrors = await rt.refreshMirrorSchedules();
    rt.events.emit("project", { id: updated.id });
    return c.json({
      id: updated.id,
      version: updated.version,
      settings: updated.settings,
      mirrorScheduled: mirrors.includes(updated.id),
    });
  });

  // A manual run answers at once: the run's counts, or 202 with the approval request the
  // mirror filed (the run goes on in the background and finishes once the inbox answers it).
  app.post("/projects/:id/mirror/sync", async (c) => {
    const body = await parse(c, MirrorSyncBody);
    const r = await rt.mirrorSync(c.req.param("id"), { full: body.full === true });
    if (r.state === "pending") {
      const view: MirrorSyncPendingView = {
        pending: true,
        projectId: r.projectId,
        requestId: r.requestId,
      };
      return c.json(view, 202);
    }
    return c.json(r.result satisfies MirrorRunView);
  });

  app.get("/projects/:id/peers", async (c) => {
    const projectId = c.req.param("id");
    await rt.store.project.mustGet(projectId);
    const peerIds = await defaultPeers(rt.store)(rt.agent.id, projectId);
    const feed = await buildPeerFeed({
      store: rt.store,
      clock: rt.clock,
      agentId: rt.agent.id,
      projectId,
      peerIds,
      schemaSync: rt.schemaSync,
    });
    return c.json(feed satisfies PeerFeedView);
  });

  app.get("/projects/:id/decisions", async (c) => {
    const rows = await new DecisionLog(rt.store).current(c.req.param("id"));
    const views: DecisionView[] = rows.map((d) => ({
      id: d.id,
      projectId: d.project_id,
      question: d.question,
      options: (d.options as unknown as string[]) ?? [],
      chosen: d.chosen,
      decidedBy: d.decided_by,
      rationale: d.rationale,
      supersedes: d.supersedes ?? null,
      createdAt: d.created_at,
    }));
    return c.json(views);
  });

  app.post("/messages/:id/read", async (c) => {
    // Receipts come from the addressee only (spec F.2): the human the message names, or the
    // owner of the agent it names. An addressee the store cannot resolve is nobody's.
    const existing = await rt.store.message.mustGet(c.req.param("id"));
    const addressee =
      existing.to_human_id ??
      (existing.to_agent_id
        ? ((await rt.store.agent.get(existing.to_agent_id))?.owner_human_id ?? "")
        : null);
    if (addressee !== null && addressee !== rt.human.id)
      return c.json({ ...NOT_YOURS, message: "only the addressee marks a message read" }, 403);
    const m = await rt.store.message.markRead(existing.id);
    rt.events.emit("inbox", {});
    return c.json(messageView(m, ""));
  });

  app.post("/chat", async (c) => {
    const body = await parse(c, ChatRequestBody);
    if (!rt.conversation)
      throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
    const r = await rt.conversation.chat({
      humanId: body.humanId,
      agentId: body.agentId,
      projectId: body.projectId,
      text: body.text,
      source: body.source,
    });
    return c.json(chatReplyView(r));
  });

  app.post("/chat/stream", async (c) => {
    const body = await parse(c, ChatRequestBody);
    if (!rt.conversation)
      throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
    const conv = rt.conversation;
    return streamSSE(c, async (stream) => {
      let r: Awaited<ReturnType<typeof conv.chat>>;
      try {
        r = await conv.chat({
          humanId: body.humanId,
          agentId: body.agentId,
          projectId: body.projectId,
          text: body.text,
          source: body.source,
          onToken: (t) =>
            void stream.writeSSE({ event: "token", data: JSON.stringify({ text: t }) }),
        });
      } catch (e) {
        const code = e instanceof ForerunnerError ? e.code : "internal";
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ code, message: errorMessage(e) }),
        });
        return;
      }
      await stream.writeSSE({ event: "reply", data: JSON.stringify(chatReplyView(r)) });
    });
  });

  // -------------------------------------------------------------------------------------
  // Reviews tab (spec H, K.2): findings, grades, verdicts, grade trend

  app.get("/projects/:id/reviews", async (c) => {
    const projectId = c.req.param("id");
    await rt.store.project.mustGet(projectId);
    const limit = intQuery(c, "limit", 200, 1000);
    return c.json(await reviewsView(rt.store, { projectId, limit }));
  });
  app.get("/tasks/:id/reviews", async (c) => {
    const taskId = c.req.param("id");
    await rt.store.task.mustGet(taskId);
    return c.json(await reviewsView(rt.store, { taskId }));
  });

  // -------------------------------------------------------------------------------------
  // Memory views (spec G, K.5): per scope, search, edit, delete, pin, consolidation

  app.get("/memory/scopes", async (c) => {
    const out: MemoryScopeView[] = [];
    const count = async (scope: "agent_private" | "critic" | "shared", owner?: string) => {
      const rows = await rt.memory.list({ scope, ownerAgentId: owner, limit: 10_000 });
      return { active: rows.length, pinned: rows.filter((l) => l.pinned).length };
    };
    for (const a of await rt.store.agent.principals(rt.human.id))
      out.push({
        scope: "agent_private",
        ownerAgentId: a.id,
        label: a.name,
        ...(await count("agent_private", a.id)),
      });
    out.push({ scope: "critic", ownerAgentId: null, label: "Critic", ...(await count("critic")) });
    out.push({ scope: "shared", ownerAgentId: null, label: "Shared", ...(await count("shared")) });
    return c.json(out);
  });

  app.get("/memory", async (c) => {
    const scope = c.req.query("scope") ?? "shared";
    if (scope !== "agent_private" && scope !== "critic" && scope !== "shared")
      throw new ForerunnerError("validation", `unknown memory scope ${scope}`);
    const ownerAgentId = c.req.query("agentId") || undefined;
    const projectId = c.req.query("projectId");
    const text = c.req.query("q") || undefined;
    const tag = c.req.query("tag");
    const status = c.req.query("status") as LessonStatus | undefined;
    if (status && status !== "active" && status !== "retired" && status !== "proposed")
      throw new ForerunnerError("validation", `unknown lesson status ${status}`);
    const rows = await rt.memory.list({
      scope,
      ...(ownerAgentId ? { ownerAgentId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(text ? { text } : {}),
      ...(tag ? { tags: [tag] } : {}),
      ...(status ? { status } : {}),
      limit: intQuery(c, "limit", 200, 1000),
    });
    const view: MemoryView = {
      scope,
      ownerAgentId: ownerAgentId ?? null,
      query: text ?? "",
      lessons: rows.map(lessonView),
    };
    return c.json(view);
  });

  app.put("/memory/lessons/:id", async (c) => {
    const body = await parse(c, UpdateLessonBody);
    const row = await rt.memory.edit(c.req.param("id"), body, { humanId: rt.human.id });
    return c.json(lessonView(row));
  });
  app.post("/memory/lessons/:id/pin", async (c) => {
    const body = await parse(c, PinLessonBody);
    return c.json(lessonView(await rt.memory.pin(c.req.param("id"), body.pinned)));
  });
  app.delete("/memory/lessons/:id", async (c) =>
    c.json(lessonView(await rt.memory.remove(c.req.param("id")))),
  );

  // Cross-project sharing (spec G.6): the human proposes, the critic decides at the next
  // session end, the offers are answered here or in the inbox (applied either way).
  app.post("/memory/lessons/:id/propose", async (c) =>
    c.json(lessonView(await rt.memory.proposeSharing(c.req.param("id")))),
  );
  app.get("/memory/promotions", async (c) =>
    c.json((await rt.memory.pendingProposals()).map(lessonView)),
  );
  app.get("/memory/offers", async (c) => {
    const rows = await rt.memory.offers({ limit: intQuery(c, "limit", 100, 1000) });
    return c.json(rows satisfies LessonOfferView[]);
  });
  app.post("/memory/offers/:id/answer", async (c) => {
    const body = await parse(c, AnswerOfferBody);
    const view = await rt.memory.answerOffer(c.req.param("id"), body.answer);
    rt.events.emit("inbox", {});
    return c.json(view satisfies LessonOfferView);
  });

  app.get("/memory/consolidation", async (c) => {
    const rows = await rt.memory.proposals({
      limit: intQuery(c, "limit", 50, 200),
    });
    return c.json(rows satisfies ConsolidationProposalView[]);
  });
  app.post("/memory/consolidation/run", async (c) => {
    const run = await rt.memory.propose();
    if (run.requestId) rt.events.emit("inbox", {});
    return c.json(run satisfies ConsolidationRunView);
  });

  // -------------------------------------------------------------------------------------
  // Commands (spec Q): the registry, parse, execute, confirm, the change log, undo. The UI,
  // the palette and the phone call the same commands chat and voice do; the daemon builds
  // the turn (the human, the principal, the active project, the device) itself.

  const turnFor = async (body: {
    source?: CommandSourceBody;
    projectId?: string;
    deviceId?: string;
    wordsUsed?: string;
  }): Promise<CommandTurn> => {
    const active = (await rt.commands.activeProject(rt.human.id)) ?? body.projectId ?? null;
    return {
      humanId: rt.human.id,
      agentId: rt.agent.id,
      activeProjectId: body.projectId ?? active,
      sessionId: await conversationSessionId(rt),
      source: body.source ?? "text",
      wordsUsed: body.wordsUsed ?? "",
      deviceId: body.deviceId ?? null,
    };
  };
  const commandResult = (r: CommandResultView): CommandResultJson => {
    const { costUsdMicro, ...rest } = r;
    const projectId = (r.card as { projectId?: unknown } | null | undefined)?.projectId;
    if ((r.status === "done" || r.status === "partial") && typeof projectId === "string")
      rt.events.emit("project", { id: projectId });
    if (r.status === "pending") rt.events.emit("inbox", {});
    return {
      ...rest,
      ...(typeof costUsdMicro === "number" ? { cost: money(costUsdMicro, chf()) } : {}),
    };
  };

  app.get("/commands", (c) =>
    c.json(
      rt.commands.registry
        .list()
        .map((def) => commandDefView(def, rt.commands.registry.schemaJson(def.name))),
    ),
  );
  app.post("/commands/parse", async (c) => {
    const body = await parse(c, CommandParseBody);
    const turn = await turnFor({ ...body, wordsUsed: body.text });
    const parsed = await rt.commands.parse(body.text, turn);
    const view: CommandParseView = {
      commands: parsed.commands,
      question: parsed.question ?? null,
      matched: parsed.matched,
    };
    return c.json(view);
  });
  app.post("/commands/execute", async (c) => {
    const body = await parse(c, CommandExecuteBody);
    const turn = await turnFor(body);
    const by = { kind: "human", id: rt.human.id } as const;
    const calls = body.commands.map((cmd) => ({ name: cmd.name, params: cmd.params ?? {} }));
    const r = await rt.commands.compose(calls, turn, {
      ...(body.confirm === "tap" ? { confirmation: { kind: "tap", by } } : {}),
    });
    return c.json(commandResult(r));
  });
  app.get("/commands/pending", (c) => {
    const rows: PendingChangeView[] = rt.commands.pending(rt.human.id).map((p) => ({
      id: p.id,
      humanId: p.humanId,
      card: p.cardJson,
      decision: p.decision,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      readback: p.readback,
      wordsUsed: p.wordsUsed,
    }));
    return c.json(rows);
  });
  app.post("/commands/:id/confirm", async (c) => {
    const body = await parse(c, CommandConfirmBody);
    const by = { kind: "human", id: rt.human.id } as const;
    const id = c.req.param("id");
    let r: CommandResultView;
    if (body.answer === "device") {
      if (!body.deviceId) throw new ForerunnerError("validation", "deviceId is required");
      r = await rt.commands.confirm(id, {
        kind: "device",
        deviceId: body.deviceId,
        biometric: body.biometric === true,
        by,
      });
    } else {
      r = await rt.commands.confirm(id, { kind: body.answer, by });
    }
    rt.events.emit("inbox", {});
    return c.json(commandResult(r));
  });
  app.post("/commands/:id/cancel", async (c) => {
    const r = await rt.commands.cancel(c.req.param("id"), { kind: "human", id: rt.human.id });
    rt.events.emit("inbox", {});
    return c.json(commandResult(r));
  });
  app.get("/changes", async (c) => {
    const rows = await rt.commands.changeLog({
      humanId: rt.human.id,
      ...(c.req.query("projectId") ? { projectId: c.req.query("projectId") } : {}),
      undoable: c.req.query("undoable") === "true",
      limit: intQuery(c, "limit", 100, 1000),
    });
    const now = rt.clock.nowIso();
    return c.json(rows.map((row) => changeLogView(row, now)));
  });
  app.post("/changes/:id/undo", async (c) => {
    const turn = await turnFor({ wordsUsed: "undo" });
    return c.json(commandResult(await rt.commands.undo(c.req.param("id"), turn)));
  });

  app.get("/costs", async (c) =>
    c.json(
      await costView(
        rt.store,
        {
          projectId: c.req.query("projectId"),
          from: c.req.query("from"),
          to: c.req.query("to"),
          humanId: rt.human.id,
        },
        chf(),
        rt.costLedger,
      ),
    ),
  );

  // Estimate accuracy (spec I): what the Performance screen shows next to the cost view.
  app.get("/costs/estimates", (c) => c.json(estimateAccuracyView(rt.estimates, rt.clock.nowIso())));

  app.get("/settings", async (c) => {
    const h = await rt.store.human.mustGet(rt.human.id);
    const projects = await rt.store.project.active({ limit: 100 });
    const rows = [
      {
        key: "human.default_autonomy",
        scope: "human",
        scopeId: h.id,
        value: h.default_autonomy,
        description: "Autonomy level for new projects (0 advisor to 4 autopilot)",
        risk: "medium",
      },
      {
        key: "human.monthly_cap",
        scope: "human",
        scopeId: h.id,
        value: money(h.monthly_cap_usd_micro, chf()),
        description: "Hard monthly spend cap",
        risk: "high",
      },
      {
        key: "human.timezone",
        scope: "human",
        scopeId: h.id,
        value: h.timezone,
        description: "Time zone for schedules and quiet hours",
        risk: "low",
      },
      {
        key: "runtime.provider",
        scope: "global",
        scopeId: null,
        value: rt.provider?.name ?? "none",
        description: "Model provider in use",
        risk: "low",
      },
      {
        key: "runtime.registry",
        scope: "global",
        scopeId: null,
        value: rt.registry.dir,
        description: "Specialist registry directory",
        risk: "low",
      },
      ...projects.flatMap((p) => [
        {
          key: "project.autonomy",
          scope: "project",
          scopeId: p.id,
          value: p.autonomy_level,
          description: `Autonomy for ${p.name}`,
          risk: "medium",
        },
        {
          key: "project.budget",
          scope: "project",
          scopeId: p.id,
          value: money(p.budget_usd_micro, chf()),
          description: `Budget for ${p.name}`,
          risk: "medium",
        },
      ]),
    ];
    return c.json(rows);
  });

  // -------------------------------------------------------------------------------------
  // Voice (spec O, Q.4; ADR 0012, ADR 0048): the voice loop over the conversation agent. A
  // shell opens a session, pushes captured audio (push-to-talk press, chunks, release) or a
  // typed line, streams the loop's events (first audio, read-back = approval needed, done)
  // and answers a read-back by voice (a spoken turn) or by tap. Every state change goes
  // through the command registry with the read-back rules; `voice.turn` and `voice.approval`
  // rows land on the conversation session, the session's start, stop and approval decisions
  // in the audit log. Without a provider pair the status says why and a start is 503.

  const voiceAudioMeta = VoiceAudioBody.omit({ pcm: true });

  app.get("/voice/status", async (c) => c.json(voiceStatusView(await rt.voice.status())));

  app.post("/voice/sessions", async (c) => {
    const body = await parse(c, StartVoiceSessionBody);
    const session = await rt.voice.start(body);
    return c.json(voiceSessionView(session, chf()), 201);
  });

  app.get("/voice/sessions/:id", (c) =>
    c.json(voiceSessionView(rt.voice.mustGet(c.req.param("id")), chf())),
  );

  app.post("/voice/sessions/:id/stop", async (c) => {
    const session = await rt.voice.stop(c.req.param("id"));
    return c.json(voiceSessionView(session, chf()));
  });

  app.post("/voice/sessions/:id/press", async (c) => {
    const session = rt.voice.mustGet(c.req.param("id"));
    const body = await parse(c, VoicePressBody);
    session.bridge.press(body.pressed);
    return c.json(voiceSessionView(session, chf()));
  });

  // One captured chunk: JSON with base64 PCM, or the raw bytes as octet-stream with the
  // format in the query (the shell's cheaper path). Nothing of it is stored or logged.
  app.post("/voice/sessions/:id/audio", async (c) => {
    const session = rt.voice.mustGet(c.req.param("id"));
    const type = c.req.header("content-type") ?? "";
    let chunk: AudioChunk;
    if (type.includes("application/octet-stream")) {
      const meta = voiceAudioMeta.safeParse({
        sampleRate: Number(c.req.query("sampleRate")),
        channels: Number(c.req.query("channels") ?? 1),
        timestampMs: Number(c.req.query("timestampMs") ?? 0),
      });
      if (!meta.success)
        throw new ForerunnerError(
          "validation",
          meta.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        );
      chunk = decodePcm(Buffer.from(await c.req.arrayBuffer()), meta.data);
    } else {
      const body = await parse(c, VoiceAudioBody);
      chunk = decodePcm(Buffer.from(body.pcm, "base64"), body);
    }
    session.bridge.push(chunk);
    return c.json(voiceSessionView(session, chf()));
  });

  // The text fallback (shells without audio capture): one turn through the same loop, the
  // same approval rules and TTS; answers once the turn has ended.
  app.post("/voice/sessions/:id/text", async (c) => {
    const session = rt.voice.mustGet(c.req.param("id"));
    const body = await parse(c, VoiceTextBody);
    const turn = await session.bridge.text(body.text);
    if (turn.pending || turn.approval) rt.events.emit("inbox", {});
    return c.json(voiceTurnView(turn, chf()));
  });

  // A tap confirms the read-back through the registry as a tap; "no" cancels the card.
  app.post("/voice/sessions/:id/answer", async (c) => {
    const session = rt.voice.mustGet(c.req.param("id"));
    const body = await parse(c, VoiceAnswerBody);
    const r = await session.bridge.answer(body.answer, { kind: "human", id: rt.human.id });
    rt.events.emit("inbox", {});
    return c.json(voiceAnswerView(r, body.answer, chf()));
  });

  app.get("/voice/sessions/:id/events", async (c) => {
    const session = rt.voice.mustGet(c.req.param("id"));
    const bridge = session.bridge;
    // A resume point that is not a number is refused, never a silent replay of nothing.
    const rawAfter = c.req.query("afterSeq");
    const afterSeq = rawAfter === undefined || rawAfter === "" ? 0 : Number(rawAfter);
    if (!Number.isFinite(afterSeq) || afterSeq < 0)
      throw new ForerunnerError("validation", "afterSeq must be a non-negative number");
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
      return c.json(bridge.eventsAfter(afterSeq).map((e) => voiceEventView(e, chf())));
    }
    return streamSSE(c, async (stream) => {
      const write = (entry: VoiceBridgeEntry) =>
        stream.writeSSE({
          event: "voice.event",
          data: JSON.stringify(voiceEventView(entry, chf())),
          id: String(entry.seq),
        });
      // Replay what the stream missed, then go live; events that arrive during the replay
      // are held and written in order once, never twice.
      let replaying = true;
      let last = afterSeq;
      const held: VoiceBridgeEntry[] = [];
      const unsubscribe = bridge.subscribe((entry) => {
        if (replaying) {
          held.push(entry);
          return;
        }
        if (entry.seq <= last) return;
        last = entry.seq;
        void write(entry);
      });
      try {
        for (const entry of bridge.eventsAfter(afterSeq)) {
          last = entry.seq;
          await write(entry);
        }
        replaying = false;
        for (const entry of held.splice(0)) {
          if (entry.seq <= last) continue;
          last = entry.seq;
          await write(entry);
        }
        let ticks = 0;
        await streamUntilClosed(stream, 1000, async () => {
          if (++ticks % 15 === 0)
            await stream.writeSSE({
              event: "heartbeat",
              data: JSON.stringify({ at: rt.clock.nowIso() }),
            });
          return !bridge.ended;
        });
      } finally {
        unsubscribe();
      }
    });
  });

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const onSession = (e: { type: string; payload: Record<string, unknown> }) => {
        void stream.writeSSE({
          event: "session.changed",
          data: JSON.stringify({ type: e.type, payload: e.payload }),
        });
      };
      const onInbox = async () => {
        const open = await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 500 });
        void stream.writeSSE({
          event: "inbox.changed",
          data: JSON.stringify({ blockingCount: open.filter((r) => r.blocking).length }),
        });
      };
      const onProject = (p: { id: string }) =>
        void stream.writeSSE({ event: "project.changed", data: JSON.stringify(p) });
      const onExtension = (e: { type: string; extensionId: string; name: string }) =>
        void stream.writeSSE({
          event: "extension.changed",
          data: JSON.stringify({ type: e.type, id: e.extensionId, name: e.name }),
        });
      // "Update and restart": the UI learns the daemon is going down before the stream ends.
      const onRestart = (r: RestartRequestFile) =>
        void stream.writeSSE({
          event: "restart.requested",
          data: JSON.stringify({
            reason: r.reason,
            targetVersion: r.targetVersion,
            fromVersion: r.fromVersion,
            exitCode: r.exitCode,
          }),
        });
      // The desktop channel's delivery (ADR 0031 point 2): `{ title, body, level, route }` plus
      // the record id and kind. Every stream gets the frame; only a shell (one that shows it
      // as a toast, `shells.ts`) counts as attached for the channel's OS fallback.
      const onNotification = (p: NotificationEventPayload) =>
        void stream.writeSSE({ event: "notification", data: JSON.stringify(p) });
      // The desktop control indicator (spec S.32): the shells show a banner while `on` is true.
      const onDesktopIndicator = (p: DesktopIndicatorPayload) =>
        void stream.writeSSE({ event: DESKTOP_INDICATOR_EVENT, data: JSON.stringify(p) });
      const detachShell = isShellStream({
        client: c.req.query("client"),
        clientHeader: c.req.header(CLIENT_HEADER),
        bearerHeader: (c.req.header("authorization") ?? "").startsWith("Bearer "),
      })
        ? rt.shells.attach()
        : () => undefined;
      rt.events.on("session", onSession);
      rt.events.on("inbox", onInbox);
      rt.events.on("project", onProject);
      rt.events.on("extension", onExtension);
      rt.events.on("restart", onRestart);
      rt.events.on("notification", onNotification);
      rt.events.on(DESKTOP_INDICATOR_EVENT, onDesktopIndicator);
      try {
        await onInbox();
        await streamUntilClosed(stream, 15_000, async () => {
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ at: rt.clock.nowIso() }),
          });
          return true;
        });
      } finally {
        rt.events.off("session", onSession);
        rt.events.off("inbox", onInbox);
        rt.events.off("project", onProject);
        rt.events.off("extension", onExtension);
        rt.events.off("restart", onRestart);
        rt.events.off("notification", onNotification);
        rt.events.off(DESKTOP_INDICATOR_EVENT, onDesktopIndicator);
        detachShell();
      }
    }),
  );

  return { app, token, closeStreams };
}

export interface RunningDaemon {
  url: string;
  token: string;
  port: number;
  /**
   * End the SSE streams, stop accepting connections and wait for in-flight responses; after
   * `timeoutMs` (default STOP_TIMEOUT_MS) the remaining connections are closed. Always returns.
   */
  stop(opts?: { timeoutMs?: number }): Promise<void>;
}

export async function startDaemon(
  rt: RuntimeApp,
  opts: DaemonServerOptions = {},
): Promise<RunningDaemon> {
  const { app, token, closeStreams } = createDaemonApp(rt, opts);
  const host = opts.host ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, hostname: host, port: opts.port ?? 0 });
  // Node's http.Server has these; the HTTP/2 server types do not, so they are optional here.
  const sockets = server as unknown as {
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  const port = await new Promise<number>((resolve, reject) => {
    server.once("listening", () => {
      const a = server.address();
      resolve(typeof a === "object" && a ? a.port : Number(opts.port ?? 0));
    });
    server.once("error", reject);
  });
  mkdirSync(rt.dirs.runtime, { recursive: true });
  const file = join(rt.dirs.runtime, "daemon.json");
  writeFileSync(
    file,
    JSON.stringify(
      {
        url: `http://${host}:${port}`,
        token,
        pid: process.pid,
        version: rt.appVersion,
        startedAt: rt.clock.nowIso(),
      },
      null,
      2,
    ),
  );
  try {
    chmodSync(file, 0o600);
  } catch {
    // best effort on Windows
  }
  log("daemon").info("listening", { url: `http://${host}:${port}`, file });
  return {
    url: `http://${host}:${port}`,
    token,
    port,
    async stop(stopOpts = {}) {
      const timeoutMs = stopOpts.timeoutMs ?? STOP_TIMEOUT_MS;
      closeStreams();
      await new Promise<void>((resolve) => {
        // A keep-alive socket whose SSE response has just ended is idle, not closed: sweep the
        // idle ones until the server reports closed, and close the rest at the deadline.
        const sweep = setInterval(() => sockets.closeIdleConnections?.(), 25);
        const done = () => {
          clearInterval(sweep);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          log("daemon").warn("connections still open at stop; closing them", { timeoutMs });
          sockets.closeAllConnections?.();
          done();
        }, timeoutMs);
        server.close(done);
        sockets.closeIdleConnections?.();
      });
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    },
  };
}

export type { EventView };

/** The principal's conversation session: the activity log of changes made outside a chat turn. */
async function conversationSessionId(rt: RuntimeApp): Promise<string> {
  if (rt.conversation) return rt.conversation.conversationSessionId(rt.agent.id, null);
  const existing = await rt.store.session.list(
    { agent_id: rt.agent.id, trigger: "manual", summary: "conversation" } as never,
    { limit: 1 },
  );
  if (existing[0]) return existing[0].id;
  const row = await rt.store.session.insert({
    agent_id: rt.agent.id,
    project_id: null,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 0,
    step_cap: 1_000_000,
    spent_usd_micro: 0,
    steps: 0,
    started_at: rt.clock.nowIso(),
    status: "planned",
    summary: "conversation",
    handoff: {},
    runner: "pc",
    author_agent: rt.agent.id,
  });
  return row.id;
}
