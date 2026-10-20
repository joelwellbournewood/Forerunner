import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { errorMessage, ForerunnerError, join, log, osFacts } from "@forerunner/platform";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { ZodType } from "zod";
import { writeKillRequest } from "../enforcement/killfile.ts";
import {
  AnswerRequestBody,
  ChatRequestBody,
  CreateProjectBody,
  CreateTaskBody,
  type EventView,
  type HealthView,
  KillBody,
  StartSessionBody,
  TransitionTaskBody,
} from "./api-types.ts";
import type { RuntimeApp } from "./compose.ts";
import {
  costView,
  eventView,
  messageView,
  money,
  projectCard,
  projectSummary,
  requestView,
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

export function createDaemonApp(
  rt: RuntimeApp,
  opts: DaemonServerOptions = {},
): { app: Hono; token: string } {
  const token = opts.token ?? randomBytes(24).toString("base64url");
  const app = new Hono();
  const logger = log("daemon");
  const chf = () => rt.chfPerUsd();

  app.onError((err, c) => {
    if (err instanceof ForerunnerError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "validation" ||
              err.code === "version_conflict" ||
              err.code === "claim_conflict"
            ? 409
            : err.code === "approval_required" || err.code === "autonomy_insufficient"
              ? 403
              : err.code === "provider_auth"
                ? 503
                : 500;
      return c.json({ code: err.code, message: err.message, details: err.details }, status);
    }
    logger.error("unhandled", { error: errorMessage(err) });
    return c.json({ code: "internal", message: errorMessage(err) }, 500);
  });

  app.use("*", async (c, next) => {
    if (c.req.path === "/health") return next();
    const header = c.req.header("authorization") ?? "";
    const got = header.startsWith("Bearer ") ? header.slice(7) : (c.req.query("token") ?? "");
    const a = Buffer.from(got);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b))
      return c.json({ code: "provider_auth", message: "missing or invalid daemon token" }, 401);
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

  app.get("/health", async (c) => {
    const active = await rt.store.session.active(rt.agent.id);
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
    };
    return c.json(view);
  });

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
      activeProjectId: rt.conversation?.getActiveProject(h.id) ?? null,
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
    const p = await rt.store.project.insert({
      name: body.name,
      goal: body.goal,
      repos: body.repos ?? [],
      stage: "planning",
      status: "active",
      budget_usd_micro: body.budgetUsdMicro ?? 0,
      autonomy_level: body.autonomyLevel ?? 2,
      summary_cache: body.brief ? { brief: body.brief } : {},
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
      author_human: rt.human.id,
    });
    if (body.brief) {
      await rt.store.queue.enqueue({
        project_id: p.id,
        human_id: rt.human.id,
        kind: "note",
        text: `Project brief:\n${body.brief}`,
        priority: 5,
        status: "queued",
        author_human: rt.human.id,
      });
    }
    rt.events.emit("project", { id: p.id });
    rt.conversation?.setActiveProject(rt.human.id, p.id);
    return c.json(await projectCard(rt.store, p.id, chf(), rt.human.id), 201);
  });

  app.get("/projects/:id", async (c) =>
    c.json(await projectCard(rt.store, c.req.param("id"), chf(), rt.human.id)),
  );
  app.get("/projects/:id/summary", async (c) =>
    c.json(await projectSummary(rt.store, c.req.param("id"), chf())),
  );

  app.get("/projects/:id/tasks", async (c) => {
    const status = c.req.query("status");
    const limit = Math.min(1000, Number(c.req.query("limit") ?? 200));
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
      risk_tier: body.riskTier,
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
    const limit = Math.min(2000, Number(c.req.query("limit") ?? 200));
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
    const afterSeq = Number(c.req.query("afterSeq") ?? 0);
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/event-stream")) {
      const rows = await rt.store.event.list(id, afterSeq, 2000);
      return c.json(rows.map((e) => eventView(e, chf())));
    }
    return streamSSE(c, async (stream) => {
      let seq = afterSeq;
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
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
        while (open) {
          await stream.sleep(1000);
          await flush();
          if (++ticks % 15 === 0)
            await stream.writeSSE({
              event: "heartbeat",
              data: JSON.stringify({ at: rt.clock.nowIso() }),
            });
          const s = await rt.store.session.get(id);
          if (s && ["completed", "stopped", "failed", "killed"].includes(s.status)) {
            await flush();
            break;
          }
        }
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
    return c.json(report);
  });
  app.post("/kill/resume", async (c) => {
    rt.kill.resume();
    return c.json({ ok: true });
  });

  app.get("/inbox", async (c) => {
    const humanId = c.req.query("humanId") ?? rt.human.id;
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
    const r = await rt.store.humanRequest.answer(
      c.req.param("id"),
      body.version,
      body.answer as never,
      rt.human.id,
    );
    rt.events.emit("inbox", {});
    return c.json(requestView(r, null));
  });

  app.post("/messages/:id/read", async (c) => {
    const m = await rt.store.message.markRead(c.req.param("id"));
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
    return c.json({
      reply: r.reply,
      actions: r.actions,
      pendingConfirmation: r.pendingConfirmation
        ? {
            id: r.pendingConfirmation.id,
            readback: r.pendingConfirmation.readback,
            estimate: money(r.pendingConfirmation.estimateUsdMicro, chf()),
          }
        : null,
      ttftMs: r.ttftMs,
      cost: money(r.costUsdMicro, chf()),
      transcriptId: r.transcriptId,
      activeProjectId: r.activeProjectId,
    });
  });

  app.post("/chat/stream", async (c) => {
    const body = await parse(c, ChatRequestBody);
    if (!rt.conversation)
      throw new ForerunnerError("provider_auth", "no model credential configured; run fr setup");
    const conv = rt.conversation;
    return streamSSE(c, async (stream) => {
      const r = await conv.chat({
        humanId: body.humanId,
        agentId: body.agentId,
        projectId: body.projectId,
        text: body.text,
        source: body.source,
        onToken: (t) => void stream.writeSSE({ event: "token", data: t }),
      });
      await stream.writeSSE({
        event: "reply",
        data: JSON.stringify({
          reply: r.reply,
          actions: r.actions,
          pendingConfirmation: r.pendingConfirmation
            ? {
                id: r.pendingConfirmation.id,
                readback: r.pendingConfirmation.readback,
                estimate: money(r.pendingConfirmation.estimateUsdMicro, chf()),
              }
            : null,
          ttftMs: r.ttftMs,
          cost: money(r.costUsdMicro, chf()),
          transcriptId: r.transcriptId,
          activeProjectId: r.activeProjectId,
        }),
      });
    });
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
      ),
    ),
  );

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

  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
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
      rt.events.on("session", onSession);
      rt.events.on("inbox", onInbox);
      rt.events.on("project", onProject);
      try {
        await onInbox();
        while (open) {
          await stream.sleep(15_000);
          await stream.writeSSE({
            event: "heartbeat",
            data: JSON.stringify({ at: rt.clock.nowIso() }),
          });
        }
      } finally {
        rt.events.off("session", onSession);
        rt.events.off("inbox", onInbox);
        rt.events.off("project", onProject);
      }
    }),
  );

  return { app, token };
}

export interface RunningDaemon {
  url: string;
  token: string;
  port: number;
  stop(): Promise<void>;
}

export async function startDaemon(
  rt: RuntimeApp,
  opts: DaemonServerOptions = {},
): Promise<RunningDaemon> {
  const { app, token } = createDaemonApp(rt, opts);
  const host = opts.host ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, hostname: host, port: opts.port ?? 0 });
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
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(file);
      } catch {
        // already gone
      }
    },
  };
}

export type { EventView };
