import { REMOTE_TARGETS, type RemoteCommandRow } from "@forerunner/state";
import { z } from "zod";
import { type Principal, requireScope, requireSigned } from "../auth/principal.ts";
import { ApiError, forbidden, notFound } from "../errors.ts";
import { type App, announce, intParam, parseBody, principal, type RouteContext } from "../http.ts";
import { remoteCommandView } from "../views.ts";

export const REMOTE_COMMANDS = ["start", "pause", "stop", "kill"] as const;

const RemoteCommandBody = z.object({
  target: z.enum(REMOTE_TARGETS),
  targetDeviceId: z.string().optional(),
  command: z.enum(REMOTE_COMMANDS),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Admin callers name the issuing device; devices are their own issuer. */
  deviceId: z.string().optional(),
});

const ResultBody = z.object({ result: z.unknown().optional() });

export async function enqueueRemoteCommand(
  ctx: RouteContext,
  p: Principal,
  body: z.infer<typeof RemoteCommandBody>,
): Promise<RemoteCommandRow> {
  const deviceId = p.kind === "device" ? p.deviceId : body.deviceId;
  if (!deviceId) throw new ApiError(400, "validation", "deviceId is required for admin callers");
  if (body.targetDeviceId) {
    const target = await ctx.store.device.get(body.targetDeviceId);
    if (!target) throw notFound("device", body.targetDeviceId);
    if (p.kind === "device" && target.owner_human_id !== p.humanId) {
      throw forbidden("target device belongs to another human");
    }
  }
  const row = await ctx.store.remoteCommand.enqueue({
    device_id: deviceId,
    target: body.target,
    target_device_id: body.targetDeviceId ?? null,
    command: body.command,
    params: body.params as never,
    author_human: p.humanId,
  });
  announce(ctx, "remote_command.changed", "remote_command", row, {
    humanId: p.kind === "device" ? p.humanId : null,
    payload: { status: row.status, target: row.target, command: row.command },
  });
  return row;
}

async function assertOwner(ctx: RouteContext, p: Principal, row: RemoteCommandRow): Promise<void> {
  if (p.kind === "admin") return;
  if (row.device_id === p.deviceId) return;
  const issuer = await ctx.store.device.get(row.device_id);
  if (issuer?.owner_human_id !== p.humanId) throw forbidden("not your command");
}

/**
 * Remote control (spec R.4): the phone enqueues; the PC runtime or the cloud runner polls
 * `GET /remote/commands/pending` (or listens on /events) and picks one up atomically, so two
 * runners never execute the same command. Completion and failure are reported back.
 */
export function registerRemoteRoutes(app: App, ctx: RouteContext): void {
  app.post("/remote/commands", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:remote");
    const body = await parseBody(c, RemoteCommandBody);
    const row = await enqueueRemoteCommand(ctx, p, body);
    return c.json(remoteCommandView(row), 201);
  });

  // Atomic pick-up for runners. Declared before "/remote/commands/:id" so "pending" is not an id.
  app.get("/remote/commands/pending", async (c) => {
    const p = principal(c);
    if (p.kind !== "admin") throw forbidden("only runtimes pick commands up");
    const targetRaw = c.req.query("target");
    if (!targetRaw || !(REMOTE_TARGETS as readonly string[]).includes(targetRaw)) {
      throw new ApiError(400, "validation", "target must be pc or cloud");
    }
    const target = targetRaw as (typeof REMOTE_TARGETS)[number];
    const deviceId = c.req.query("deviceId") || undefined;
    const row = await ctx.store.remoteCommand.pickUp(target, deviceId ? { deviceId } : {});
    if (!row) return c.body(null, 204);
    const issuer = await ctx.store.device.get(row.device_id);
    announce(ctx, "remote_command.changed", "remote_command", row, {
      humanId: issuer?.owner_human_id ?? null,
      payload: { status: row.status, target: row.target, command: row.command },
    });
    return c.json(remoteCommandView(row));
  });

  app.get("/remote/commands", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const status = c.req.query("status");
    const limit = intParam(c.req.query("limit"), 100);
    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (p.kind === "device") {
      const mine = await ctx.store.device.list({ owner_human_id: p.humanId });
      filter.device_id = mine.map((d) => d.id);
    } else if (c.req.query("deviceId")) filter.device_id = c.req.query("deviceId");
    const rows = await ctx.store.remoteCommand.list(filter as never, {
      orderBy: "created_at desc",
      limit,
    });
    return c.json({ commands: rows.map(remoteCommandView) });
  });

  app.get("/remote/commands/:id", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const row = await ctx.store.remoteCommand.get(c.req.param("id"));
    if (!row) throw notFound("command", c.req.param("id"));
    await assertOwner(ctx, p, row);
    return c.json(remoteCommandView(row));
  });

  for (const outcome of ["complete", "fail"] as const) {
    app.post(`/remote/commands/:id/${outcome}`, async (c) => {
      const p = principal(c);
      if (p.kind !== "admin") throw forbidden("only runtimes report command outcomes");
      const body = await parseBody(c, ResultBody);
      const id = c.req.param("id");
      if (!(await ctx.store.remoteCommand.exists(id))) throw notFound("command", id);
      const result = (body.result ?? null) as never;
      const row =
        outcome === "complete"
          ? await ctx.store.remoteCommand.complete(id, result)
          : await ctx.store.remoteCommand.fail(id, result);
      const issuer = await ctx.store.device.get(row.device_id);
      announce(ctx, "remote_command.changed", "remote_command", row, {
        humanId: issuer?.owner_human_id ?? null,
        payload: { status: row.status, target: row.target, command: row.command },
      });
      return c.json(remoteCommandView(row));
    });
  }
}
