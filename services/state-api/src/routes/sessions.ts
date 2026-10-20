import { SESSION_STATUSES, type SessionRow, type SessionStatus } from "@forerunner/state";
import { requireScope } from "../auth/principal.ts";
import { ApiError, forbidden, notFound } from "../errors.ts";
import { type App, agentName, intParam, principal, type RouteContext } from "../http.ts";
import type { ChangeEvent } from "../realtime.ts";
import { sseLoop } from "../sse.ts";
import { currentChfRate, eventView, sessionView } from "../views.ts";

async function currentTaskOf(ctx: RouteContext, s: SessionRow) {
  if (s.status !== "running" && s.status !== "paused") return null;
  const [run] = await ctx.store.run.forSession(s.id, { orderBy: "created_at desc", limit: 1 });
  if (!run?.task_id) return null;
  const task = await ctx.store.task.get(run.task_id);
  return task ? { id: task.id, title: task.title, specialist: run.specialist } : null;
}

async function toView(ctx: RouteContext, s: SessionRow, rate: number) {
  return sessionView(s, await agentName(ctx.store, s.agent_id), rate, await currentTaskOf(ctx, s));
}

/** Sessions and the live log (spec R.4 "watch the live session log"). */
export function registerSessionRoutes(app: App, ctx: RouteContext): void {
  app.get("/sessions", async (c) => {
    requireScope(principal(c), "read");
    const statusRaw = c.req.query("status");
    const statuses = statusRaw
      ? statusRaw
          .split(",")
          .filter((s): s is SessionStatus => (SESSION_STATUSES as readonly string[]).includes(s))
      : undefined;
    const filter: Record<string, unknown> = {};
    if (c.req.query("agentId")) filter.agent_id = c.req.query("agentId");
    if (c.req.query("projectId")) filter.project_id = c.req.query("projectId");
    if (statuses?.length) filter.status = statuses;
    const rows = await ctx.store.session.list(filter as never, {
      orderBy: "created_at desc",
      limit: intParam(c.req.query("limit"), 50),
    });
    const rate = await currentChfRate(ctx.store, ctx.chfPerUsd);
    const views = [];
    for (const s of rows) views.push(await toView(ctx, s, rate));
    return c.json({ sessions: views });
  });

  app.get("/sessions/:id", async (c) => {
    requireScope(principal(c), "read");
    const s = await ctx.store.session.get(c.req.param("id"));
    if (!s) throw notFound("session", c.req.param("id"));
    return c.json(await toView(ctx, s, await currentChfRate(ctx.store, ctx.chfPerUsd)));
  });

  // JSON page or, with Accept: text/event-stream, a live stream that resumes from afterSeq.
  app.get("/sessions/:id/events", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const sessionId = c.req.param("id");
    const session = await ctx.store.session.get(sessionId);
    if (!session) throw notFound("session", sessionId);
    if (p.kind === "device") {
      const agent = await ctx.store.agent.get(session.agent_id);
      if (agent?.owner_human_id !== p.humanId) throw forbidden("not your agent's session");
    }
    const afterSeqRaw = c.req.query("afterSeq");
    let afterSeq = afterSeqRaw ? Number(afterSeqRaw) : 0;
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new ApiError(400, "validation", "afterSeq must be a non-negative integer");
    }
    const rate = await currentChfRate(ctx.store, ctx.chfPerUsd);
    const wantsStream = (c.req.header("accept") ?? "").includes("text/event-stream");
    if (!wantsStream) {
      const rows = await ctx.store.event.list(
        sessionId,
        afterSeq,
        intParam(c.req.query("limit"), 500, 5000),
      );
      return c.json({ events: rows.map((e) => eventView(e, rate)) });
    }
    const lastEventId = c.req.header("last-event-id");
    if (lastEventId && /^\d+$/.test(lastEventId))
      afterSeq = Math.max(afterSeq, Number(lastEventId));

    let sessionVersion = session.version;
    const sendNew = async (send: (event: string, data: unknown, id?: string) => Promise<void>) => {
      const rows = await ctx.store.event.list(sessionId, afterSeq, 500);
      for (const e of rows) {
        await send("session.event", eventView(e, rate), String(e.seq));
        afterSeq = e.seq;
      }
      const current = await ctx.store.session.get(sessionId);
      if (current && current.version !== sessionVersion) {
        sessionVersion = current.version;
        await send("session.changed", await toView(ctx, current, rate));
      }
    };

    return sseLoop(c, {
      clock: ctx.clock,
      heartbeatMs: ctx.config.heartbeatMs,
      pollMs: ctx.config.pollIntervalMs,
      init: async (send) => {
        await send("ready", { sessionId, afterSeq, at: ctx.clock.nowIso() });
        await sendNew(send);
      },
      subscribe: (wake) =>
        ctx.bus.subscribe(
          () => wake(),
          (e: ChangeEvent) =>
            (e.type === "session.event" || e.type === "session.changed") &&
            e.sessionId === sessionId,
        ),
      flush: sendNew,
    });
  });
}
