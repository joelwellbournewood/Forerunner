import { createHash } from "node:crypto";
import { REMOTE_TARGETS, type RemoteCommandRow } from "@forerunner/state";
import { z } from "zod";
import { type Principal, requireScope, requireSigned } from "../auth/principal.ts";
import { ApiError, forbidden, notFound } from "../errors.ts";
import { type App, announce, intParam, parseBody, principal, type RouteContext } from "../http.ts";
import { idempotencyKeyOf, type OutboxResult } from "../outbox.ts";
import { remoteCommandView } from "../views.ts";

export const REMOTE_COMMANDS = ["start", "pause", "stop", "kill"] as const;
/** The envelope's `clientId` (the phone's outbox key); the bound the daemon's envelope schema has. */
export const CLIENT_ID_MAX = 200;

const RemoteCommandBody = z.object({
  target: z.enum(REMOTE_TARGETS),
  targetDeviceId: z.string().optional(),
  command: z.enum(REMOTE_COMMANDS),
  params: z.record(z.string(), z.unknown()).default({}),
  /** Admin callers name the issuing device; devices are their own issuer. */
  deviceId: z.string().optional(),
});
export type RemoteCommandInput = z.infer<typeof RemoteCommandBody>;

const ResultBody = z.object({ result: z.unknown().optional() });

export async function enqueueRemoteCommand(
  ctx: RouteContext,
  p: Principal,
  body: RemoteCommandInput,
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

/**
 * The envelope's `clientId` when the body carries one (the phone's plan and chat envelopes,
 * ADR 0032 item 4). A clientId that is not a string of 1 to `CLIENT_ID_MAX` characters is a
 * validation error rather than a command the daemon would fail as malformed.
 */
export function envelopeClientId(params: Record<string, unknown>): string | undefined {
  const raw = params.clientId;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > CLIENT_ID_MAX) {
    throw new ApiError(
      400,
      "validation",
      `params.clientId must be a string of 1 to ${CLIENT_ID_MAX} characters`,
    );
  }
  return raw;
}

/** JSON with object keys sorted and undefined members dropped, so equal bodies hash equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const members = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 of the command body (target, target device, command, params): what "the same envelope" means. */
export function commandFingerprint(body: RemoteCommandInput): string {
  const canonical = stableJson({
    target: body.target,
    targetDeviceId: body.targetDeviceId ?? null,
    command: body.command,
    params: body.params,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * What the idempotency store remembers for an enqueue, on both routes: the row's id, version
 * and status (what the phone's outbox reads back) and the body's fingerprint.
 */
export interface RemoteEnqueueResult {
  id: string;
  version: number;
  status: string;
  fingerprint: string;
}

export function remoteEnqueueResult(
  row: RemoteCommandRow,
  fingerprint: string,
): RemoteEnqueueResult {
  return { id: row.id, version: row.version, status: row.status, fingerprint };
}

function storedEnqueue(result: OutboxResult): Partial<RemoteEnqueueResult> | undefined {
  const r = result.result;
  if (r === null || typeof r !== "object" || typeof (r as { id?: unknown }).id !== "string") {
    return undefined;
  }
  return r as Partial<RemoteEnqueueResult>;
}

/**
 * Enqueue once per issuing device and envelope `clientId` (spec R.3, R.4). The phone's
 * outbox POSTs an envelope until it is acknowledged, and a lost answer makes it send the
 * same envelope again (directly, or through `POST /sync/outbox` as a `remote.enqueue`
 * action under the same clientId); without this, every copy became a `remote_command` row
 * the PC executed, and one tap started two sessions. The key space is the outbox's
 * (`idempotencyKeyOf`): the second copy returns the first row (`fresh: false`), creates
 * nothing and announces nothing; a different body under the same clientId is 409
 * (`version_conflict`), as is a clientId the outbox already spent on another action. Admin
 * callers and commands without a clientId are enqueued every time, as before. The record
 * lives a week (`IDEMPOTENCY_TTL_MS`); the daemon's watcher refuses a replay that is older
 * or slipped past this service (`packages/runtime`, `RemoteCommandWatcher`).
 */
export async function enqueueRemoteCommandOnce(
  ctx: RouteContext,
  p: Principal,
  body: RemoteCommandInput,
): Promise<{ row: RemoteCommandRow; fresh: boolean }> {
  const clientId = envelopeClientId(body.params);
  if (p.kind !== "device" || clientId === undefined) {
    return { row: await enqueueRemoteCommand(ctx, p, body), fresh: true };
  }
  const fingerprint = commandFingerprint(body);
  let created: RemoteCommandRow | undefined;
  const { result, fresh } = await ctx.idempotency.run(idempotencyKeyOf(p), clientId, async () => {
    created = await enqueueRemoteCommand(ctx, p, body);
    return { clientId, status: "applied", result: remoteEnqueueResult(created, fingerprint) };
  });
  if (fresh && created) return { row: created, fresh: true };
  const stored = storedEnqueue(result);
  if (!stored || typeof stored.id !== "string") {
    throw new ApiError(
      409,
      "version_conflict",
      `clientId ${clientId} was already used by this device for another action`,
      { clientId, ...(result.code ? { earlier: result.code } : {}) },
    );
  }
  if (stored.fingerprint !== undefined && stored.fingerprint !== fingerprint) {
    throw new ApiError(
      409,
      "version_conflict",
      `clientId ${clientId} was already used by this device for a different command`,
      { clientId, commandId: stored.id },
    );
  }
  const row = await ctx.store.remoteCommand.get(stored.id);
  if (!row) throw notFound("command", stored.id);
  return { row, fresh: false };
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
  // 201 with the new row; 200 with the first row when a device repeats an envelope's clientId.
  app.post("/remote/commands", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:remote");
    const body = await parseBody(c, RemoteCommandBody);
    const { row, fresh } = await enqueueRemoteCommandOnce(ctx, p, body);
    return c.json(remoteCommandView(row), fresh ? 201 : 200);
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
    const ownerHumanId = c.req.query("humanId") || undefined;
    const agentId = c.req.query("agentId") || undefined;
    const row = await ctx.store.remoteCommand.pickUp(target, { deviceId, ownerHumanId, agentId });
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
