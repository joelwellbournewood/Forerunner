import { mkdir, writeFile } from "node:fs/promises";
import { join } from "@forerunner/platform";
import { type JsonValue, TASK_STATUSES, type TaskStatus } from "@forerunner/state";
import { z } from "zod";
import { requireScope, requireSigned } from "../auth/principal.ts";
import { ApiError, forbidden, notFound } from "../errors.ts";
import { type App, announce, intParam, parseBody, principal, type RouteContext } from "../http.ts";
import {
  currentChfRate,
  dataAssetView,
  decisionView,
  projectCard,
  queueItemView,
  taskView,
} from "../views.ts";

const TransitionBody = z.object({
  version: z.number().int(),
  to: z.enum(TASK_STATUSES),
  reason: z.string().min(1).max(2000),
});

const DecisionBody = z.object({
  question: z.string().min(1).max(2000),
  options: z.array(z.unknown()).default([]),
  chosen: z.string().min(1).max(2000),
  rationale: z.string().max(4000).default(""),
  supersedes: z.string().optional(),
});

const QueueBody = z.object({
  kind: z.enum(["note", "task", "idea", "correction", "voice_note"]).default("note"),
  text: z.string().min(1).max(10_000),
  priority: z.number().int().min(-10).max(10).default(0),
  transcript: z.string().max(50_000).optional(),
});

const SAFE_NAME = /[^A-Za-z0-9._-]+/g;

/** Projects, tasks, decisions, the next-session queue and uploads. */
export function registerProjectRoutes(app: App, ctx: RouteContext): void {
  const rate = () => currentChfRate(ctx.store, ctx.chfPerUsd);

  app.get("/projects", async (c) => {
    requireScope(principal(c), "read");
    const includeInactive = c.req.query("all") === "1";
    const rows = includeInactive
      ? await ctx.store.project.list(undefined, { orderBy: "name" })
      : await ctx.store.project.active();
    const r = await rate();
    const now = ctx.clock.nowIso();
    const cards = [];
    for (const p of rows) cards.push(await projectCard(ctx.store, p, r, now));
    return c.json({ projects: cards });
  });

  app.get("/projects/:id", async (c) => {
    requireScope(principal(c), "read");
    const p = await ctx.store.project.get(c.req.param("id"));
    if (!p) throw notFound("project", c.req.param("id"));
    return c.json(await projectCard(ctx.store, p, await rate(), ctx.clock.nowIso()));
  });

  app.get("/projects/:id/milestones", async (c) => {
    requireScope(principal(c), "read");
    const rows = await ctx.store.milestone.forProject(c.req.param("id"));
    return c.json({
      milestones: rows.map((m) => ({
        id: m.id,
        projectId: m.project_id,
        name: m.name,
        successCriteria: m.success_criteria,
        targetDate: m.target_date,
        status: m.status,
        orderIndex: m.order_index,
        version: m.version,
      })),
    });
  });

  app.get("/projects/:id/tasks", async (c) => {
    requireScope(principal(c), "read");
    const projectId = c.req.param("id");
    if (!(await ctx.store.project.exists(projectId))) throw notFound("project", projectId);
    const statusRaw = c.req.query("status");
    const statuses = statusRaw
      ? statusRaw
          .split(",")
          .filter((s): s is TaskStatus => (TASK_STATUSES as readonly string[]).includes(s))
      : undefined;
    const rows = await ctx.store.task.forProject(projectId, statuses ? { status: statuses } : {}, {
      limit: intParam(c.req.query("limit"), 200),
      offset: intParam(c.req.query("offset"), 0, 100_000),
      orderBy: [{ column: "priority", direction: "desc" }, { column: "created_at" }],
    });
    const r = await rate();
    return c.json({ tasks: rows.map((t) => taskView(t, r)) });
  });

  app.get("/tasks/:id", async (c) => {
    requireScope(principal(c), "read");
    const t = await ctx.store.task.get(c.req.param("id"));
    if (!t) throw notFound("task", c.req.param("id"));
    return c.json(taskView(t, await rate()));
  });

  // Phone edits of a task's status go through the same workflow graph and version check as
  // the runtime; a stale version is a 409 the UI resolves by reloading.
  app.post("/tasks/:id/transition", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:approvals");
    const body = await parseBody(c, TransitionBody);
    const id = c.req.param("id");
    if (!(await ctx.store.task.exists(id))) throw notFound("task", id);
    const row = await ctx.store.task.transition(id, body.version, body.to, body.reason, {
      humanId: p.humanId,
    });
    announce(ctx, "task.changed", "task", row, {
      projectId: row.project_id,
      payload: { status: row.status, claimedBy: row.claimed_by },
    });
    return c.json(taskView(row, await rate()));
  });

  app.get("/projects/:id/decisions", async (c) => {
    requireScope(principal(c), "read");
    const all = c.req.query("all") === "1";
    const projectId = c.req.param("id");
    const rows = all
      ? await ctx.store.decision.list({ project_id: projectId }, { orderBy: "created_at desc" })
      : await ctx.store.decision.current(projectId);
    return c.json({ decisions: rows.map(decisionView) });
  });

  app.post("/projects/:id/decisions", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:approvals");
    const projectId = c.req.param("id");
    if (!(await ctx.store.project.exists(projectId))) throw notFound("project", projectId);
    const body = await parseBody(c, DecisionBody);
    const decidedBy = p.kind === "device" ? p.humanId : "runtime";
    const input = {
      project_id: projectId,
      question: body.question,
      options: body.options as JsonValue[],
      chosen: body.chosen,
      decided_by: decidedBy,
      rationale: body.rationale,
      author_human: p.humanId,
    };
    const row = body.supersedes
      ? await ctx.store.decision.supersede(body.supersedes, input)
      : await ctx.store.decision.record(input);
    announce(ctx, "decision.changed", "decision", row, { projectId });
    return c.json(decisionView(row), 201);
  });

  app.get("/projects/:id/queue", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const rows = await ctx.store.queue.pending(c.req.param("id"));
    const visible = p.kind === "admin" ? rows : rows.filter((q) => q.human_id === p.humanId);
    return c.json({ items: visible.map(queueItemView) });
  });

  // "Add notes, tasks and ideas" from the phone (spec R.5): they wait for the next session.
  app.post("/projects/:id/queue", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:queue");
    const projectId = c.req.param("id");
    if (!(await ctx.store.project.exists(projectId))) throw notFound("project", projectId);
    const body = await parseBody(c, QueueBody);
    const humanId = p.kind === "device" ? p.humanId : c.req.query("humanId");
    if (!humanId) throw new ApiError(400, "validation", "humanId query parameter is required");
    const row = await ctx.store.queue.enqueue({
      project_id: projectId,
      human_id: humanId,
      kind: body.kind,
      text: body.text,
      priority: body.priority,
      transcript: body.transcript ?? null,
      author_human: humanId,
    });
    announce(ctx, "queue_item.changed", "queue_item", row, {
      humanId,
      projectId,
      payload: { status: row.status },
    });
    return c.json(queueItemView(row), 201);
  });

  app.get("/projects/:id/uploads", async (c) => {
    requireScope(principal(c), "read");
    const rows = await ctx.store.dataAsset.forProject(c.req.param("id"));
    return c.json({ uploads: rows.map(dataAssetView) });
  });

  // Photos, files and documents from the phone. The file lands under
  // <data>/uploads/<project>/<asset id>-<safe name>; only metadata is ever exposed.
  app.post("/projects/:id/uploads", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:queue");
    const projectId = c.req.param("id");
    if (!(await ctx.store.project.exists(projectId))) throw notFound("project", projectId);
    const form = await c.req.parseBody({ all: false });
    const file = form.file;
    if (!(file instanceof File)) {
      throw new ApiError(400, "validation", "multipart field 'file' is required");
    }
    if (file.size > ctx.config.uploadMaxBytes) {
      throw new ApiError(413, "payload_too_large", "upload exceeds the size cap", {
        maxBytes: ctx.config.uploadMaxBytes,
      });
    }
    const safeName =
      (file.name || "upload")
        .replace(SAFE_NAME, "_")
        .replace(/\.{2,}/g, ".")
        .replace(/^[._-]+/, "")
        .slice(0, 120) || "upload";
    const registeredBy = p.kind === "device" ? p.humanId : "runtime";
    const deviceId = p.kind === "device" ? p.deviceId : null;
    if (p.kind === "device" && p.device.kind !== "phone" && p.device.kind !== "web") {
      throw forbidden("only paired clients upload");
    }
    const dir = join(ctx.config.uploadsDir, projectId);
    await mkdir(dir, { recursive: true });
    const kind = typeof form.kind === "string" && form.kind ? form.kind.slice(0, 40) : "upload";
    const row = await ctx.store.transaction(async (tx) => {
      const asset = await tx.dataAsset.insert({
        project_ids: [projectId],
        locator: join(dir, "pending"),
        size_bytes: file.size,
        owner_device_id: deviceId,
        kind,
        sample: { contentType: file.type || null, originalName: file.name || null },
        registered_by: registeredBy,
        author_human: p.humanId,
      });
      const path = join(dir, `${asset.id}-${safeName}`);
      await writeFile(path, new Uint8Array(await file.arrayBuffer()), { mode: 0o600 });
      return tx.dataAsset.patch(asset.id, { locator: path });
    });
    return c.json(dataAssetView(row), 201);
  });
}
