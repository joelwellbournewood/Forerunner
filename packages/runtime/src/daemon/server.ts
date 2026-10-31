import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { email as agentEmail, cloudflare, desktop } from "@forerunner/capabilities";
import { errorMessage, ForerunnerError, join, log, osFacts, redact } from "@forerunner/platform";
import type { LessonStatus, MilestoneRow, SessionRow } from "@forerunner/state";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodType } from "zod";
import { createDataRoutes } from "../data/routes.ts";
import { createDeviceRoutes } from "../devices/routes.ts";
import { writeKillRequest } from "../enforcement/killfile.ts";
import { estimateAccuracyView } from "../estimates/view.ts";
import { createExtensionsRoutes, type DeviceConfirmation } from "../extensions/routes.ts";
import type { ExtensionView } from "../extensions/types.ts";
import { sessionOfStart } from "../loop/commands.ts";
import type { CommandResultView, CommandTurn } from "../loop/ports.ts";
import { FAST_MODE_SETTING, fastModeDescription, fastModeOf } from "../models/fast-mode.ts";
import { speedQualityOffsetOf } from "../models/ladder.ts";
import { parseAgentModelConfig } from "../models/run-settings.ts";
import { createModelWatchRoutes } from "../models/watch-routes.ts";
import type { NotificationEventPayload } from "../notifications/emitter.ts";
import { createNotificationRoutes } from "../notifications/routes.ts";
import { providerCapabilities } from "../provider/types.ts";
import { createSharedSecretRoutes } from "../secrets/routes.ts";
import { createRunnerUnlockRoutes } from "../secrets/runner-unlock-routes.ts";
import { applySharedGrantAnswer } from "../secrets/shared-grants.ts";
import { createSecretStoreRoutes } from "../secrets/store-routes.ts";
import { buildPeerFeed } from "../session/peers.ts";
import {
  applyProjectPlan,
  defaultRiskTier,
  describeMilestoneChange,
  MILESTONE_AUDIT_TOOL,
  ProjectPlanBody,
} from "../session/project-plan.ts";
import { defaultPeers } from "../session/runner.ts";
import type { StartRequest } from "../session/triggers.ts";
import { createPlanAllowanceRoutes } from "../setup/plan-allowance-routes.ts";
import { createSetupRoutes } from "../setup/routes.ts";
import { createSourcesRoutes } from "../sources/routes.ts";
import { createUpdateRoutes } from "../update/screen.ts";
import type { SchemaSyncStatus } from "../update/sync.ts";
import type { VoiceBridgeEntry } from "../voice/bridge.ts";
import { createVoiceInstallRoutes } from "../voice/install-routes.ts";
import type { AudioChunk } from "../voice/pkg.ts";
import type { SpeakEntry } from "../voice/speak.ts";
import {
  decodePcm,
  speakEventView,
  speakView,
  voiceAnswerView,
  voiceEventView,
  voiceSessionView,
  voiceStatusView,
  voiceTurnView,
} from "../voice/views.ts";
import { DESKTOP_INDICATOR_EVENT, type DesktopIndicatorPayload } from "../wiring/desktop-ports.ts";
import { assertAnswerAccepted, NOT_AN_OPTION } from "../wiring/request-answers.ts";
import { DecisionLog, StateAudit } from "../wiring/state-ports.ts";
import { ModelWatchUpdates, RegistryConnectorCatalog } from "./adapters.ts";
import {
  AnswerOfferBody,
  AnswerRequestBody,
  ChangeMilestoneBody,
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
  PERFORMANCE_DEFAULT_DAYS,
  PERFORMANCE_MAX_DAYS,
  type PeerFeedView,
  type PendingChangeView,
  PinLessonBody,
  type PlanProjectView,
  RenameAgentBody,
  SetTaskDependenciesBody,
  SpeakBody,
  type SpeakStartedView,
  type StartCheckView,
  StartSessionBody,
  type StartSessionView,
  StartVoiceSessionBody,
  type SyncHealth,
  TransitionTaskBody,
  UpdateLessonBody,
  UpdateProjectSettingsBody,
  VoiceAnswerBody,
  VoiceAudioBody,
  VoiceHeardBody,
  VoiceHeardView,
  VoicePressBody,
  VoiceTextBody,
} from "./api-types.ts";
import { createAuditRoutes } from "./audit-export.ts";
import type { RuntimeApp } from "./compose.ts";
import { conversationSessionId } from "./conversation-session.ts";
import { createProjectRecord } from "./create-project.ts";
import { createDocsRoutes } from "./docs-routes.ts";
import { buildModelSettingsView } from "./model-settings-view.ts";
import { ownsProject, ownsSession } from "./ownership.ts";
import { createQueueRoutes } from "./queue-routes.ts";
import type { RestartRequestFile } from "./restart.ts";
import { sandboxHealth } from "./sandbox-port.ts";
import { CLIENT_HEADER, isShellStream, isSpeechPlayerStream } from "./shells.ts";
import {
  agentView,
  changeLogView,
  commandDefView,
  costView,
  effortCapsOf,
  eventView,
  lessonView,
  messageView,
  milestoneView,
  money,
  performanceView,
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
  /**
   * `POST /shutdown` (U-018, ADR 0094): how the process ends once the route has stopped every
   * run. `fr daemon` closes the server and the runtime and exits 0. Without it (tests, embedded
   * uses) the route refuses with 409, so nothing is stopped by a call that cannot end the
   * process.
   */
  onShutdown?: () => void;
}

/** How long `POST /shutdown` waits after answering before it ends the process. */
export const SHUTDOWN_DELAY_MS = 100;

/** `tool` of the audit row `POST /agents/:id/rename` writes (U-025): the old and new name. */
export const AGENT_RENAME_AUDIT_TOOL = "agent.rename";

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

/** How long `POST /sessions` waits for a started run to create its session (U-003). */
export const SESSION_START_WAIT_MS = 15_000;

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
  /**
   * A numbered event stream as SSE: replay what the stream missed after `afterSeq`, then go
   * live; events that arrive during the replay are held and written in order once, never
   * twice. Ends with the source (a stopped voice session, an ended utterance) or the client.
   */
  const streamNumbered = <E extends { seq: number }>(
    c: Parameters<typeof streamSSE>[0],
    source: {
      eventsAfter(seq: number): E[];
      subscribe(listener: (entry: E) => void): () => void;
      ended(): boolean;
    },
    afterSeq: number,
    frame: (entry: E) => { event: string; data: string },
  ) =>
    streamSSE(c, async (stream) => {
      const write = (entry: E) => stream.writeSSE({ ...frame(entry), id: String(entry.seq) });
      let replaying = true;
      let last = afterSeq;
      const held: E[] = [];
      const unsubscribe = source.subscribe((entry) => {
        if (replaying) {
          held.push(entry);
          return;
        }
        if (entry.seq <= last) return;
        last = entry.seq;
        void write(entry);
      });
      try {
        for (const entry of source.eventsAfter(afterSeq)) {
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
          return !source.ended();
        });
      } finally {
        unsubscribe();
      }
    });
  /**
   * The resume point of a numbered stream: `?afterSeq=` (one that is not a number is refused)
   * or the `Last-Event-ID` header, whichever is later. An EventSource reconnects to the URL it
   * was given, so its `afterSeq` stays that of the first subscription, and sends the id of the
   * last frame it received (every frame's `id` is its seq) in the header: without the header a
   * reconnect would replay what the client already acted on (a `barge_in` that silences the
   * reply playing now). A header that is not a non-negative integer is ignored: the browser
   * sends whatever id it last saw, and the query still bounds the replay.
   */
  const afterSeqOf = (c: {
    req: { query(name: string): string | undefined; header(name: string): string | undefined };
  }): number => {
    const rawAfter = c.req.query("afterSeq");
    const afterSeq = rawAfter === undefined || rawAfter === "" ? 0 : Number(rawAfter);
    if (!Number.isFinite(afterSeq) || afterSeq < 0)
      throw new ForerunnerError("validation", "afterSeq must be a non-negative number");
    const rawLast = c.req.header("last-event-id")?.trim() ?? "";
    const lastEventId = /^\d{1,15}$/.test(rawLast) ? Number(rawLast) : 0;
    return Math.max(afterSeq, lastEventId);
  };

  app.onError((err, c) => {
    if (err instanceof ForerunnerError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "validation" &&
              (err.details?.reason === "bad_query" || err.details?.reason === NOT_AN_OPTION)
            ? 400
            : err.code === "validation" ||
                err.code === "version_conflict" ||
                err.code === "claim_conflict"
              ? 409
              : err.code === "approval_required" || err.code === "autonomy_insufficient"
                ? 403
                : err.code === "injection_suspected"
                  ? 422
                  : err.code === "provider_auth" || err.code === "unavailable"
                    ? 503
                    : 500;
      // ADR 0025: a stale version or a lost claim is reported as "conflict"; the runtime's own
      // code stays in the details for the log. A text the injection gate refused (a lesson
      // proposed for the shared store, spec G.6) is the client's input, not a daemon failure:
      // 422 with the code, so the page shows the reason instead of a server error.
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
      // Last-Event-ID: an EventSource from the UI's origin resends it when it reconnects.
      allowHeaders: ["Authorization", "Content-Type", "Accept", "Last-Event-ID"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      // The audit export names its file in Content-Disposition; the UI reads it cross-origin.
      exposeHeaders: ["Content-Disposition"],
      maxAge: 600,
    }),
  );

  // Bearer token on every route. EventSource cannot set headers, so the SSE routes also
  // accept the token as a query parameter; nothing else does, and query strings of those
  // routes are never logged.
  app.use("*", async (c, next) => {
    if (c.req.path === "/health" || c.req.method === "OPTIONS") return next();
    const header = c.req.header("authorization") ?? "";
    const sseRoute =
      c.req.method === "GET" &&
      (c.req.path === "/events" ||
        /^\/sessions\/[^/]+\/events$/.test(c.req.path) ||
        /^\/voice\/sessions\/[^/]+\/events$/.test(c.req.path) ||
        /^\/speak\/[^/]+\/events$/.test(c.req.path));
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
    createExtensionsRoutes({
      registry: rt.extensions,
      actor: () => ({ humanId: rt.human.id }),
      // Add in the panel is confirmed there (U-026, ADR 0096) at the bar of every high-risk
      // change on this PC: the command registry's policy on a paired device row.
      confirmOnDevice: (answer, extension) => confirmGrantOnDevice(rt, answer, extension),
    }),
  );
  app.route(
    "/",
    createUpdateRoutes({
      manager: rt.updates,
      clock: rt.clock,
      configError: rt.updateConfigError,
      extensions: rt.store.extension,
      catalog: new RegistryConnectorCatalog(rt.extensions.catalog),
      modelWatch: new ModelWatchUpdates(rt.modelWatch),
      humanId: rt.human.id,
    }),
  );
  app.route("/model-watch", createModelWatchRoutes({ watch: rt.modelWatch }));
  // Settings -> Voice (ADR 0090): the voice profile and its install job with progress.
  app.route("/", createVoiceInstallRoutes({ jobs: rt.voiceInstall }));
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
  // settings row per call, so a changed mode or a pause holds the very next send. The sending
  // mode is not the route's to change: it is the registry's `email.mode.set` (spec Q, high
  // risk: a change card, a confirmation on a paired device, one change log row with undo,
  // `POST /commands/execute`), so a PUT that would change it is a 403 naming the command.
  for (const route of agentEmail.emailRouteTable({
    settings: rt.capabilities.email.ports.settings,
    sentLog: rt.capabilities.email.ports.sentLog,
    identity: rt.capabilities.email.ports.identity,
    clock: rt.clock,
    audit: rt.store.auditLog,
    commandAudit: agentEmail.emailCommandAudit({ auditLog: rt.store.auditLog, clock: rt.clock }),
    humanFor: () => rt.human.id,
    modeChangeCommand: "email.mode.set",
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
  // The project page's Next session panel (spec J.2, U-004) and Docs tab (spec G.5, U-005): the
  // daemon's human's queue items, and the standard doc set as this install has it.
  const daemonWho = () => ({ humanId: rt.human.id, agentId: rt.agent.id });
  app.route("/", createQueueRoutes({ store: rt.store, who: daemonWho, events: rt.events }));
  app.route(
    "/",
    createDocsRoutes({
      store: rt.store,
      docsDirsFor: (project) => rt.docs.docsDirsFor(project),
      who: daemonWho,
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
  // The mailbox passwords and cloud voice keys typed in the app (U-054): an allowlist, the
  // value to the vault only.
  app.route(
    "/",
    createSecretStoreRoutes({
      vault: rt.vault,
      clock: rt.clock,
      store: rt.store,
      humanId: rt.human.id,
    }),
  );
  // Cloud runner vault unlock (spec S.12, ADR 0068): the inbox's unlock card has the runner's
  // vault key wrapped to the challenge here, where the OS keyring is; the key never leaves.
  app.route(
    "/",
    createRunnerUnlockRoutes({
      vault: rt.vault,
      clock: rt.clock,
      auditLog: rt.store.auditLog,
      requests: rt.store.humanRequest,
      humanId: () => rt.human.id,
    }),
  );
  // Settings -> Devices (spec R.2): list, start a pairing (code, expiry, the fr:// link of the
  // QR) and revoke at once; the state service's admin token stays in this process.
  app.route("/", createDeviceRoutes({ devices: rt.devices }));
  // The setup assistant (ADR 0092): credentials pasted in the app, checked and stored like
  // `fr setup`; `finish` restarts the daemon when the runtime must pick up a new credential.
  app.route(
    "/",
    createSetupRoutes({
      dirs: rt.dirs,
      vault: rt.vault,
      env: rt.env,
      clock: rt.clock,
      store: rt.store,
      humanId: rt.human.id,
      appVersion: rt.appVersion,
      restarter: rt.restarter,
      ...(rt.fetchImpl ? { fetchImpl: rt.fetchImpl } : {}),
    }),
  );
  // Settings -> Claude subscription allowance (U-052): CHF in, USD stored as the runtime reads it.
  app.route(
    "/",
    createPlanAllowanceRoutes({
      dirs: rt.dirs,
      env: rt.env,
      vault: rt.vault,
      clock: rt.clock,
      store: rt.store,
      humanId: rt.human.id,
      chfPerUsd: rt.chfPerUsd,
      current: () => rt.billing.planAllowance,
      onChanged: (a) => {
        rt.billing.planAllowance = a;
      },
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
      // This PC's own device row: what a high-risk confirmation from the desktop app names.
      desktopDeviceId: rt.remote.device?.id ?? null,
      agent: rt.agent,
      // The registry's record wins (a switch by chat, voice or the UI all land there).
      activeProjectId:
        (await rt.commands.activeProject(h.id)) ?? rt.conversation?.getActiveProject(h.id) ?? null,
      provider: rt.provider?.name ?? null,
    });
  });

  app.get("/agents", async (c) => {
    const rows = await rt.store.agent.list(undefined, { limit: 100 });
    return c.json(rows.map(agentView));
  });

  // Settings -> Your agent (U-025): the signed-in human renames their principal agent. Another
  // human's agent is 403 before the body is read; the name is checked by `RenameAgentBody`
  // (trimmed, 1 to 60 characters, no control characters) and against the human's other agents
  // here, case-insensitively (the store's unique index is per owner and exact). The versioned
  // update and its audit row are one write; then the process's own record of the principal
  // (`rt.agent`: `/me`, commit authors, notifications) takes the name and the shells re-read
  // `/me` and `/agents` on `agent.changed`. Rows that name the agent by id (sessions, messages,
  // peers, email) read the name when they are shown, so they follow without a write.
  app.post("/agents/:id/rename", async (c) => {
    const existing = await rt.store.agent.mustGet(c.req.param("id"));
    if (existing.owner_human_id !== rt.human.id)
      return c.json({ ...NOT_YOURS, message: "not your agent" }, 403);
    if (existing.kind !== "principal")
      throw new ForerunnerError(
        "validation",
        `${existing.name} is your ${existing.kind} agent; only your principal agent is renamed here`,
        { details: { agentId: existing.id, kind: existing.kind } },
      );
    const { name } = await parse(c, RenameAgentBody);
    if (name === existing.name) return c.json(agentView(existing));
    const wanted = name.toLowerCase();
    const taken = (await rt.store.agent.forOwner(rt.human.id)).find(
      (a) => a.id !== existing.id && a.name.toLowerCase() === wanted,
    );
    if (taken)
      throw new ForerunnerError(
        "validation",
        `you already have an agent named ${taken.name}; choose another name`,
        { details: { agentId: existing.id, takenBy: taken.id } },
      );
    const renamed = await rt.store.transaction(async (tx) => {
      const after = await tx.agent.update(existing.id, existing.version, {
        name,
        author_human: rt.human.id,
      });
      await tx.auditLog.append({
        tool: AGENT_RENAME_AUDIT_TOOL,
        allowed: true,
        human_id: rt.human.id,
        agent_id: after.id,
        input_summary: redact(`${JSON.stringify(existing.name)} -> ${JSON.stringify(after.name)}`),
        result_summary: `version ${after.version}`,
      });
      return after;
    });
    if (renamed.id === rt.agent.id) rt.agent.name = renamed.name;
    rt.events.emit("agent", { id: renamed.id, name: renamed.name });
    return c.json(agentView(renamed));
  });

  app.get("/projects", async (c) => {
    const rows = await rt.store.project.active({ limit: 100 });
    return c.json(
      await Promise.all(rows.map((p) => projectCard(rt.store, p.id, chf(), rt.human.id))),
    );
  });

  app.post("/projects", async (c) => {
    const body = await parse(c, CreateProjectBody);
    // The same path an accepted source proposal takes, and the chat's `project.create` through
    // its port (create-project.ts, spec A.4, G.5): the row, the brief, and the standard doc
    // set as a pull request on the linked repository or the project's workspace (deferred to
    // the intake's approval with `intake: true`); the creation never fails on the docs.
    const p = await createProjectRecord(rt, body);
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
    // U-040: a dependency that is no task of the project (a typo) or a cancelled one would
    // keep the task from ever running; it is refused with the names, nothing is written.
    const dependsOn = await rt.store.task.checkDependencies(project.id, null, body.dependsOn);
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
      depends_on: dependsOn,
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

  // Milestones (spec B.5): the rows with the reason and author of their last change, and a
  // change from the app that records the human's reason with the version check; each change
  // also leaves its history (before -> after, the reason) as one audit row in the same
  // transaction, so a refused change leaves none.
  app.get("/projects/:id/milestones", async (c) => {
    const project = await rt.store.project.mustGet(c.req.param("id"));
    const rows = await rt.store.milestone.forProject(project.id);
    return c.json(rows.map(milestoneView));
  });

  app.post("/milestones/:id", async (c) => {
    const body = await parse(c, ChangeMilestoneBody);
    const patch: Partial<MilestoneRow> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.successCriteria !== undefined) patch.success_criteria = body.successCriteria;
    if (body.targetDate !== undefined) patch.target_date = body.targetDate;
    if (body.status !== undefined) patch.status = body.status;
    const m = await rt.store.transaction(async (tx) => {
      const before = await tx.milestone.mustGet(c.req.param("id"));
      const after = await tx.milestone.change(before.id, body.version, patch, body.reason, {
        humanId: rt.human.id,
      });
      await tx.auditLog.append({
        tool: MILESTONE_AUDIT_TOOL,
        allowed: true,
        human_id: rt.human.id,
        agent_id: null,
        input_summary: redact(describeMilestoneChange(before, after)),
        result_summary: redact(`reason: ${after.reason}`),
      });
      return after;
    });
    rt.events.emit("project", { id: m.project_id });
    return c.json(milestoneView(m));
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
    // A person's move (Cancel, Mark failed, Needs me, Send to review) stops the task's run if
    // one is going; the session goes on with its other tasks and leaves the task as set (U-039).
    rt.kill.stopTask(t.id, `${t.status} by you: ${body.reason}`);
    rt.events.emit("project", { id: t.project_id });
    return c.json(taskView(t, chf()));
  });

  // The tasks a task waits on, changed after it was created (U-040): checked as at creation,
  // plus the task itself and a cycle, with the version the screen loaded and the reason.
  app.post("/tasks/:id/dependencies", async (c) => {
    const body = await parse(c, SetTaskDependenciesBody);
    const t = await rt.store.task.setDependencies(
      c.req.param("id"),
      body.version,
      body.dependsOn,
      body.reason,
      { humanId: rt.human.id },
    );
    rt.events.emit("project", { id: t.project_id });
    return c.json(taskView(t, chf()));
  });

  // What a session started now would plan (U-040): the Start dialog names the tasks that would
  // run, those left out for budget and those waiting on another task.
  app.get("/projects/:id/start-check", async (c) => {
    const budget = intQuery(c, "budgetUsdMicro", 0, Number.MAX_SAFE_INTEGER);
    const r = await rt.startCheck(c.req.param("id"), budget > 0 ? budget : undefined);
    const rate = chf();
    const named = (t: { taskId: string; title: string; estimateUsdMicro: number }) => ({
      taskId: t.taskId,
      title: t.title,
      estimate: money(t.estimateUsdMicro, rate),
    });
    const view: StartCheckView = {
      projectId: r.projectId,
      sessionBudget: money(r.sessionBudgetUsdMicro, rate),
      workBudget: money(r.workBudgetUsdMicro, rate),
      ready: r.ready,
      runnable: r.runnable.map(named),
      overBudget: r.overBudget.map(named),
      waiting: r.waiting.map((w) => ({
        taskId: w.taskId,
        title: w.title,
        waitsOn: w.waitsOn.map((d) => ({ taskId: d.id, title: d.title, status: d.status })),
      })),
    };
    return c.json(view);
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

  // The start dialog opens the session it started (U-003): a started run is waited for until its
  // `session.started` (its row exists then), its end, or SESSION_START_WAIT_MS. A run that fails
  // before its session begins (the kill switch, no model credential) answers that error.
  app.post("/sessions", async (c) => {
    const body = await parse(c, StartSessionBody);
    let begun: () => void = () => undefined;
    const sessionBegun = new Promise<"begun">((resolve) => {
      begun = () => resolve("begun");
    });
    const onSession = (e: { type?: string; agentId?: string }) => {
      if (e.type === "session.started" && e.agentId === body.agentId) begun();
    };
    // Listen before asking: the run can begin before `requestStart` returns.
    rt.events.on("session", onSession);
    const waited = new AbortController();
    try {
      const entry = await rt.scheduler.requestStart({
        agentId: body.agentId,
        projectId: body.projectId,
        trigger: body.trigger,
        reason: body.reason ?? "started from the app",
        ...(body.budgetUsdMicro ? { budgetUsdMicro: body.budgetUsdMicro } : {}),
      } as StartRequest);
      let session: StartSessionView["session"] = null;
      if (entry.result === "started") {
        const ended = rt.scheduler.runOutcome(entry.id) ?? new Promise<never>(() => undefined);
        const timedOut = rt.clock.sleep(SESSION_START_WAIT_MS, waited.signal).then(
          () => "timeout" as const,
          () => "timeout" as const,
        );
        const first = await Promise.race([sessionBegun, ended, timedOut]);
        if (typeof first === "object" && !first.ok) throw first.error;
        const row = await sessionOfStart(rt.store, body.agentId, entry);
        if (row) {
          const name = (await rt.store.agent.get(row.agent_id))?.name ?? row.agent_id;
          session = sessionView(row, name, chf());
        }
      }
      const view: StartSessionView = { result: entry.result, startId: entry.id, session };
      return c.json(view, 202);
    } finally {
      waited.abort();
      rt.events.off("session", onSession);
    }
  });

  app.get("/sessions/:id", async (c) =>
    c.json(await liveSessionView(await rt.store.session.mustGet(c.req.param("id")))),
  );
  /** The live view's session: the row, the agent's name and the task in flight. */
  const liveSessionView = async (s: SessionRow) => {
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
    return sessionView(s, name, chf(), current);
  };

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

  // The live view's Stop: end this session's runs and freeze nothing. A kill the person set
  // with Stop all stays in force, here and after a restart (U-032: this was a stop followed by
  // `resume()`, which lifted it). The answer is the session, the shape the live view reads; it
  // was the kill report, which the view refused as a malformed answer.
  app.post("/sessions/:id/stop", async (c) => {
    const s = await rt.store.session.mustGet(c.req.param("id"));
    await rt.kill.stop({ sessionId: s.id }, "stopped from the app", { freeze: false });
    return c.json(await liveSessionView(await rt.store.session.mustGet(s.id)));
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
  // The desktop shell's Quit (U-018, ADR 0094): stop every run and the processes it started
  // (as the kill switch does, but nothing is written to kill.json, so the next start is not
  // stopped), answer, then end the process the way a SIGTERM does. Exit code 0 means "stopped
  // on purpose" to every shell, so nothing restarts it.
  app.post("/shutdown", async (c) => {
    if (!opts.onShutdown)
      return c.json({ code: "conflict", message: "this daemon cannot be stopped over HTTP" }, 409);
    const report = await rt.kill.stop("all", "Forerunner quit");
    logger.info("shutdown requested", { ...report });
    setTimeout(opts.onShutdown, SHUTDOWN_DELAY_MS);
    return c.json({ stopping: true, ...report }, 202);
  });
  app.post("/kill/resume", async (c) => {
    // The request file makes a kill survive a crash; once resumed it must not come back on the
    // next start (U-019). The daemon's kill switch removes it on every resume (`onResume` in
    // compose.ts), so the phone's start lifts it the same way (U-032).
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
    // U-034: an answer the card cannot act on (none of its options, for a card whose answer
    // must be one) is refused with the options, 400, and the request stays open; before, it
    // closed the card and the sync recorded `unrecognized_answer`, stranding the task.
    if (asked.status === "open") assertAnswerAccepted(asked, body.answer);
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
    // The handover schedule follows `settings.handover` the same way (ADR 0060).
    const jobs = await rt.jobs.refreshSchedules();
    rt.events.emit("project", { id: updated.id });
    return c.json({
      id: updated.id,
      version: updated.version,
      settings: updated.settings,
      mirrorScheduled: mirrors.includes(updated.id),
      handoverScheduled: jobs.handover.includes(updated.id),
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

  // The conversation is the signed-in human's (spec O.9: a line said to this daemon speaks for
  // its human's agent and may stop or reach that agent's live session, never another human's);
  // a body naming another human is refused before anything is parsed, as `/inbox` refuses.
  const notYourConversation = (c: Context, humanId: string) =>
    humanId === rt.human.id
      ? null
      : c.json({ ...NOT_YOURS, message: "not your conversation" }, 403);

  app.post("/chat", async (c) => {
    const body = await parse(c, ChatRequestBody);
    const refused = notYourConversation(c, body.humanId);
    if (refused) return refused;
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
    const refused = notYourConversation(c, body.humanId);
    if (refused) return refused;
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
      // The bearer of the daemon token is the human at this PC, and this PC is a paired
      // device (its row, `/me.desktopDeviceId`). An answer that names no device is answered
      // by that row, noted in the audit log, and so is the literal `desktop` an older settings
      // screen sent when the shell had no install id; any other id is checked as given, so a
      // foreign, revoked or unknown id is refused by the registry's policy.
      const thisPc = !body.deviceId || body.deviceId === "desktop";
      const deviceId = thisPc ? rt.remote.device?.id : body.deviceId;
      if (!deviceId) {
        throw new ForerunnerError(
          "validation",
          "deviceId is required: this daemon has no desktop device row to answer for",
        );
      }
      r = await rt.commands.confirm(id, {
        kind: "device",
        deviceId,
        biometric: body.biometric === true,
        by,
      });
      // The substitution is audited after the registry answered, with its outcome: a mapped
      // answer for a card that does not exist or that the policy refused is not "allowed".
      if (thisPc) {
        const accepted = r.status !== "refused";
        await rt.store.auditLog.append({
          tool: "daemon.confirm_device",
          allowed: accepted,
          denied_reason: accepted ? null : `${r.code ?? "refused"}: ${r.reason ?? ""}`,
          agent_id: rt.agent.id,
          human_id: rt.human.id,
          input_summary: JSON.stringify({ pendingId: id, deviceId, given: body.deviceId ?? null }),
          result_summary: `device answer naming no device row: this PC's own desktop row answered; ${r.status}`,
          cost_usd_micro: 0,
          occurred_at: rt.clock.nowIso(),
          author_agent: rt.agent.id,
        });
      }
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

  // Performance (spec D.7, D.19): per mode the time to first token and total time against
  // target, from the Run rows and the chat and voice turns of the window, and the effort in
  // force. `?days=` is a positive integer (7 by default, at most 90); an unknown project is 404.
  app.get("/performance", async (c) => {
    const raw = c.req.query("days");
    let days = PERFORMANCE_DEFAULT_DAYS;
    if (raw !== undefined && raw !== "") {
      // Decimal digits only: Number() would also take "0x10", "1e1", " 7" or "7.0".
      const n = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
      if (!Number.isInteger(n) || n < 1)
        throw new ForerunnerError("validation", "days must be a positive integer", {
          details: { reason: "bad_query", param: "days" },
        });
      days = Math.min(n, PERFORMANCE_MAX_DAYS);
    }
    return c.json(
      await performanceView(rt.store, {
        humanId: rt.human.id,
        projectId: c.req.query("projectId") || null,
        days,
        nowIso: rt.clock.nowIso(),
        modelConfig: rt.modelConfig(),
        effortCaps: effortCapsOf(rt.registry),
        // The principal's D.4 effort overrides (spec D.4, ADR 0072), read per request so a
        // `model.settings.set` change shows at once; a malformed document applies none, as the
        // runs read it.
        agentModelConfig: parseAgentModelConfig(
          (await rt.store.agent.get(rt.agent.id))?.model_config,
        ).config,
      }),
    );
  });

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
        key: "human.calibration",
        scope: "human",
        scopeId: h.id,
        value: h.notify_prefs.calibration ?? null,
        description:
          "Monthly critic calibration over the golden eval sets: enabled, day, time, budget_usd, tier (defaults: on, day 1, 06:00, USD 10, tier 1)",
        risk: "medium",
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
        {
          key: "project.handover",
          scope: "project",
          scopeId: p.id,
          value: p.settings.handover ?? null,
          description: `Monthly handover test on ${p.name}: enabled, day, time, budget_usd, seed (off until enabled)`,
          risk: "medium",
        },
        {
          // Opus fast mode (spec D.20, ADR 0057): the effect and the surcharge both ways, from
          // the price table in force; changed through `settings.set` like any SETTING_SPECS key.
          key: `project.${FAST_MODE_SETTING}`,
          scope: "project",
          scopeId: p.id,
          value: fastModeOf(p.settings),
          description: fastModeDescription(rt.pricingTable()),
          risk: "medium",
        },
        {
          // The slider (spec D.16): -1 speed, 0 balanced, +1 quality, as every mode reads it.
          key: "project.speed_quality_offset",
          scope: "project",
          scopeId: p.id,
          value: speedQualityOffsetOf(p.settings),
          description: `Speed versus quality for ${p.name}: every mode's effort one step down or up`,
          risk: "low",
        },
      ]),
    ];
    return c.json(rows);
  });

  // Model settings per agent and specialist (spec D.4, ADR 0072): what the settings screen
  // shows; every change goes through `model.settings.set` on POST /commands/execute.
  app.get("/settings/models", async (c) => {
    const principal = await rt.store.agent.mustGet(rt.agent.id);
    const config = rt.modelConfig();
    return c.json(
      buildModelSettingsView({
        provider: rt.provider
          ? { name: rt.provider.name, capabilities: providerCapabilities(rt.provider) }
          : null,
        ladder: config.ladder,
        modeDefaults: config.modeDefaults,
        principal,
        others: [{ id: rt.criticAgent.id, name: rt.criticAgent.name, kind: "critic" }],
        specialists: rt.registry.runnableSpecialists(),
      }),
    );
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
    c.json(voiceSessionView(rt.voice.mustGet(c.req.param("id")), chf(), { recent: true })),
  );

  app.post("/voice/sessions/:id/stop", async (c) => {
    const session = await rt.voice.stop(c.req.param("id"));
    return c.json(voiceSessionView(session, chf()));
  });

  app.post("/voice/sessions/:id/press", async (c) => {
    const session = rt.voice.mustGet(c.req.param("id"));
    const body = await parse(c, VoicePressBody);
    // A press always counts: one that came while the last turn transcribes is queued by the
    // loop and answered once the new turn listens (or the session stopped).
    if (body.pressed) await session.bridge.pressAndWait(body.replyMode, c.req.raw.signal);
    else session.bridge.press(false, body.replyMode);
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
    const b = session.bridge;
    return c.json({ id: session.id, state: b.state, turn: b.currentTurn, lastSeq: b.lastSeq });
  });

  // The text fallback (shells without audio capture): one turn through the same loop, the
  // same approval rules and TTS; answers once the turn has ended.
  app.post("/voice/sessions/:id/text", async (c) => {
    const session = rt.voice.mustGet(c.req.param("id"));
    const body = await parse(c, VoiceTextBody);
    const turn = await session.bridge.text(body.text, body.replyMode);
    if (turn.pending || turn.approval) rt.events.emit("inbox", {});
    return c.json(voiceTurnView(turn, chf()));
  });

  // What the human heard (the panel's player): release to the first reply chunk at the
  // speaker, measured in the page. One figure per turn; the daemon-side figure stays as it was.
  app.post("/voice/sessions/:id/heard", async (c) => {
    const session = rt.voice.mustGet(c.req.param("id"));
    const body = await parse(c, VoiceHeardBody);
    return c.json(VoiceHeardView.parse(session.bridge.heard(body.turn, body.heardFirstAudioMs)));
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
    const afterSeq = afterSeqOf(c);
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
      return c.json(bridge.eventsAfter(afterSeq).map((e) => voiceEventView(e, chf())));
    }
    return streamNumbered<VoiceBridgeEntry>(
      c,
      {
        eventsAfter: (seq) => bridge.eventsAfter(seq),
        subscribe: (l) => bridge.subscribe(l),
        ended: () => bridge.ended,
      },
      afterSeq,
      (entry) => ({ event: "voice.event", data: JSON.stringify(voiceEventView(entry, chf())) }),
    );
  });

  // -------------------------------------------------------------------------------------
  // Read aloud (spec A.6, L.6; ADR 0063): the project summary or a session summary through
  // the registry's TTS, streamed as a voice turn's reply is. No model call; another human's
  // project or session is refused; one voice at a time; the text is echoed; one `voice.speak`
  // row and audit row per utterance, never audio.

  const who = () => ({ humanId: rt.human.id, agentId: rt.agent.id });

  app.post("/projects/:id/speak", async (c) => {
    const body = await parse(c, SpeakBody);
    const p = await rt.store.project.mustGet(c.req.param("id"));
    if (!ownsProject(p, who())) return c.json({ ...NOT_YOURS, message: "not your project" }, 403);
    const summary = await projectSummary(rt.store, p.id, chf());
    const u = await rt.speech.say({
      text: summary.spoken,
      subject: { kind: "project", id: p.id, name: p.name },
      source: "ui",
      player: "requester",
      ...(body.language ? { language: body.language } : {}),
    });
    return c.json(speakView(u), 201);
  });

  app.post("/sessions/:id/speak", async (c) => {
    const body = await parse(c, SpeakBody);
    const s = await rt.store.session.mustGet(c.req.param("id"));
    const agent = await rt.store.agent.get(s.agent_id);
    if (!ownsSession(s, agent, who()))
      return c.json({ ...NOT_YOURS, message: "not your session" }, 403);
    const text = s.summary === "conversation" ? "" : s.summary.trim();
    if (!text) throw new ForerunnerError("validation", "the session has no summary yet");
    const u = await rt.speech.say({
      text,
      subject: { kind: "session", id: s.id, projectId: s.project_id },
      source: "ui",
      player: "requester",
      ...(body.language ? { language: body.language } : {}),
    });
    return c.json(speakView(u), 201);
  });

  app.get("/speak/:id", (c) => c.json(speakView(rt.speech.mustGet(c.req.param("id")))));

  app.post("/speak/:id/cancel", async (c) =>
    c.json(speakView(await rt.speech.cancel(c.req.param("id")))),
  );

  app.get("/speak/:id/events", async (c) => {
    const u = rt.speech.mustGet(c.req.param("id"));
    const afterSeq = afterSeqOf(c);
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
      return c.json(u.eventsAfter(afterSeq).map((e) => speakEventView(e)));
    }
    return streamNumbered<SpeakEntry>(
      c,
      {
        eventsAfter: (seq) => u.eventsAfter(seq),
        subscribe: (l) => u.subscribe(l),
        ended: () => u.ended,
      },
      afterSeq,
      (entry) => ({ event: "speak.event", data: JSON.stringify(speakEventView(entry)) }),
    );
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
      // A renamed agent (U-025): the shells re-read `/me` and `/agents`.
      const onAgent = (a: { id: string; name: string }) =>
        void stream.writeSSE({
          event: "agent.changed",
          data: JSON.stringify({ id: a.id, name: a.name }),
        });
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
      // Something is being read aloud (ADR 0063): a speech player attaches to
      // `/speak/:id/events`; a stream that declared `?speech=play` counts as one.
      const onSpeak = (p: SpeakStartedView) =>
        void stream.writeSSE({ event: "speak.started", data: JSON.stringify(p) });
      const detachShell = isShellStream({
        client: c.req.query("client"),
        clientHeader: c.req.header(CLIENT_HEADER),
        bearerHeader: (c.req.header("authorization") ?? "").startsWith("Bearer "),
      })
        ? rt.shells.attach()
        : () => undefined;
      const detachPlayer = isSpeechPlayerStream({ speech: c.req.query("speech") })
        ? rt.speechPlayers.attach()
        : () => undefined;
      rt.events.on("session", onSession);
      rt.events.on("inbox", onInbox);
      rt.events.on("project", onProject);
      rt.events.on("agent", onAgent);
      rt.events.on("extension", onExtension);
      rt.events.on("restart", onRestart);
      rt.events.on("notification", onNotification);
      rt.events.on(DESKTOP_INDICATOR_EVENT, onDesktopIndicator);
      rt.events.on("speak", onSpeak);
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
        rt.events.off("agent", onAgent);
        rt.events.off("extension", onExtension);
        rt.events.off("restart", onRestart);
        rt.events.off("notification", onNotification);
        rt.events.off(DESKTOP_INDICATOR_EVENT, onDesktopIndicator);
        rt.events.off("speak", onSpeak);
        detachShell();
        detachPlayer();
      }
    }),
  );

  return { app, token, closeStreams };
}

export const DAEMON_FILE = "daemon.json";

/**
 * Remove `daemon.json` at stop only while it still names this daemon (its pid and its token):
 * another daemon that started meanwhile wrote its own address there, and deleting that would
 * leave the shells with no way to find it (U-065). Returns whether the file was removed.
 */
export function removeOwnDaemonFile(file: string, own: { pid: number; token: string }): boolean {
  let recorded: { pid?: unknown; token?: unknown };
  try {
    recorded = JSON.parse(readFileSync(file, "utf8")) as typeof recorded;
  } catch {
    // Gone already, or not ours to judge: leave whatever is there.
    return false;
  }
  if (recorded.pid !== own.pid || recorded.token !== own.token) {
    log("daemon").warn("daemon.json names another daemon; leaving it", {
      file,
      pid: typeof recorded.pid === "number" ? recorded.pid : null,
    });
    return false;
  }
  try {
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
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
  const file = join(rt.dirs.runtime, DAEMON_FILE);
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
      removeOwnDaemonFile(file, { pid: process.pid, token });
    },
  };
}

export type { EventView };

/**
 * The Extensions panel's confirmation of a grant (U-026, ADR 0096), checked exactly like a
 * high-risk change card's device answer (`POST /commands/:id/confirm`, ADR 0030): the command
 * registry's `ConfirmationPolicy` at `needs_device`, against the device row. An answer that
 * names no device (or the literal `desktop`) is answered by this PC's own desktop row; any other
 * id is checked as given, so a foreign, revoked or unknown device, a web page and a phone
 * without its biometric are refused. Every answer, accepted or refused, is an
 * `extensions.confirm_device` audit row; a refusal throws `approval_required` with the reason.
 */
export async function confirmGrantOnDevice(
  rt: RuntimeApp,
  answer: DeviceConfirmation,
  extension: Pick<ExtensionView, "id" | "name" | "kind">,
): Promise<void> {
  const thisPc = !answer.deviceId || answer.deviceId === "desktop";
  const deviceId = thisPc ? (rt.remote.device?.id ?? null) : answer.deviceId;
  let refused: string | null = null;
  try {
    if (!deviceId) {
      throw new ForerunnerError(
        "approval_required",
        "this PC has no paired device row to confirm with; restart Forerunner, then confirm again",
      );
    }
    const device = await rt.store.device.get(deviceId);
    rt.commands.executor.policy.check(
      "needs_device",
      {
        kind: "device",
        deviceId,
        biometric: answer.biometric,
        by: { kind: "human", id: rt.human.id },
      },
      { humanId: rt.human.id, emailToken: "", device },
    );
  } catch (e) {
    refused = errorMessage(e);
    throw e;
  } finally {
    await rt.store.auditLog.append({
      tool: "extensions.confirm_device",
      allowed: refused === null,
      denied_reason: refused,
      agent_id: null,
      human_id: rt.human.id,
      input_summary: JSON.stringify({
        extensionId: extension.id,
        name: extension.name,
        kind: extension.kind,
        deviceId,
        given: answer.deviceId,
      }),
      result_summary: refused === null ? "confirmed on a paired device" : "refused",
      cost_usd_micro: 0,
      occurred_at: rt.clock.nowIso(),
      author_human: rt.human.id,
    });
  }
}
