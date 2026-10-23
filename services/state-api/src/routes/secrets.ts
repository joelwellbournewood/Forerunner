import {
  proposeSharedGrant,
  revokeSharedGrant,
  SECRET_NAME_PATTERN,
  serveSharedBlob,
  sharedGrantView,
  wrapTargetsFor,
} from "@forerunner/runtime/secrets/shared-grants";
import type { SecretGrantRow } from "@forerunner/state";
import { z } from "zod";
import { type Principal, requireScope, requireSigned, resolveHumanId } from "../auth/principal.ts";
import { ApiError, forbidden, notFound } from "../errors.ts";
import {
  type App,
  announce,
  parseBody,
  parseQuery,
  principal,
  type RouteContext,
} from "../http.ts";

/**
 * Shared secrets (spec S.13, ADR 0065). The rules live in
 * `@forerunner/runtime/secrets/shared-grants`; these routes are the HTTP face for an install
 * that reaches the shared state through the service:
 *
 * - installs (admin principals) list wrap targets, propose a grant with the value already
 *   wrapped per install, and fetch the wrapped copy for their own agent; a device principal
 *   (a phone, the approvals web) never receives a blob (spec R.7);
 * - the other human's approval is an ordinary `human_request` answered through
 *   `POST /requests/:id/answer`, where `answerRequestAs` applies it to the grant in the same
 *   transaction (risk `high`: signed plus the biometric assertion from a device);
 * - the owner revokes from their install or their own signed device.
 */

const WrapKeysQuery = z.object({ agentIds: z.string().min(1) });

const Base64 = z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64");
const WrappedBlob = z.object({
  v: z.literal(1),
  ephemeralPublicKey: Base64.max(44),
  salt: Base64.max(44),
  iv: Base64.max(16),
  ciphertext: Base64.max(400_000),
  tag: Base64.max(24),
});

const ProposeBody = z.object({
  ownerHumanId: z.string().min(1),
  name: z.string().regex(SECRET_NAME_PATTERN, "invalid secret name"),
  kind: z.string().max(40).optional(),
  why: z.string().max(2000).optional(),
  agentIds: z.array(z.string().min(1)).min(1).max(50),
  blobs: z
    .array(z.object({ agentId: z.string().min(1), deviceId: z.string().min(1), blob: WrappedBlob }))
    .min(1)
    .max(200),
});

const BlobQuery = z.object({
  name: z.string().regex(SECRET_NAME_PATTERN, "invalid secret name"),
  agentId: z.string().min(1),
  deviceId: z.string().min(1),
});

function installOnly(p: Principal, what: string): asserts p is Principal & { kind: "admin" } {
  if (p.kind !== "admin") throw forbidden(`${what}: installs only; a device never holds a secret`);
}

/** A device sees the grants it owns or must approve; the runtime sees everything. */
function canSee(p: Principal, g: SecretGrantRow): boolean {
  if (p.kind === "admin") return true;
  return g.owner_human_id === p.humanId || g.required_human_ids.includes(p.humanId);
}

async function announceRequests(
  ctx: RouteContext,
  ids: string[],
  payload: Record<string, unknown>,
): Promise<void> {
  for (const id of ids) {
    const r = await ctx.store.humanRequest.get(id);
    if (!r) continue;
    announce(ctx, "human_request.changed", "human_request", r, {
      humanId: r.human_id,
      projectId: r.project_id,
      payload: { status: r.status, blocking: r.blocking, ...payload },
    });
  }
}

export function registerSecretRoutes(app: App, ctx: RouteContext): void {
  // Which installs a secret shared with these agents must be wrapped to (public keys only).
  app.get("/secrets/wrap-keys", async (c) => {
    const p = principal(c);
    installOnly(p, "wrap keys");
    const q = parseQuery(c, WrapKeysQuery);
    const agentIds = [
      ...new Set(
        q.agentIds
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    if (agentIds.length === 0) throw new ApiError(400, "validation", "agentIds is required");
    return c.json({ targets: await wrapTargetsFor(ctx.store, agentIds) });
  });

  // The owner's install files a grant; the value arrives wrapped per install, never in clear.
  app.post("/secrets/shared", async (c) => {
    const p = principal(c);
    installOnly(p, "proposing a shared secret");
    const body = await parseBody(c, ProposeBody);
    const { grant, requests } = await proposeSharedGrant(ctx.store, body, {
      clock: ctx.clock,
      installId: p.installId,
    });
    for (const r of requests) {
      announce(ctx, "human_request.changed", "human_request", r, {
        humanId: r.human_id,
        projectId: null,
        payload: { status: r.status, blocking: r.blocking, kind: r.kind },
      });
    }
    return c.json({ grant: sharedGrantView(grant), requestIds: requests.map((r) => r.id) }, 201);
  });

  // The wrapped copy for one agent on one install: active grants only, the named agent only,
  // the install the copy was wrapped for only. Registered before `/secrets/shared/:id`.
  app.get("/secrets/shared/blob", async (c) => {
    const p = principal(c);
    installOnly(p, "reading a shared secret");
    const q = parseQuery(c, BlobQuery);
    const { grant, blob } = await serveSharedBlob(ctx.store, q, {
      clock: ctx.clock,
      installId: p.installId,
    });
    return c.json({
      grantId: grant.id,
      name: grant.name,
      ownerHumanId: grant.owner_human_id,
      agentId: blob.agent_id,
      deviceId: blob.device_id,
      blob: blob.blob,
    });
  });

  app.get("/secrets/shared", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const humanId = resolveHumanId(p, c.req.query("humanId"));
    const rows = humanId
      ? await ctx.store.secretGrant.forHuman(humanId)
      : await ctx.store.secretGrant.list(undefined, { orderBy: "created_at desc" });
    return c.json({ grants: rows.map(sharedGrantView) });
  });

  app.get("/secrets/shared/:id", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const g = await ctx.store.secretGrant.get(c.req.param("id"));
    if (!g || !canSee(p, g)) throw notFound("secret grant", c.req.param("id"));
    return c.json({ grant: sharedGrantView(g) });
  });

  // The owner ends a grant at any time: from their install, or from their own signed device.
  app.post("/secrets/shared/:id/revoke", async (c) => {
    const p = principal(c);
    requireSigned(p);
    requireScope(p, "write:approvals");
    const g = await ctx.store.secretGrant.get(c.req.param("id"));
    if (!g || !canSee(p, g)) throw notFound("secret grant", c.req.param("id"));
    if (p.kind === "device" && g.owner_human_id !== p.humanId) {
      throw forbidden("only the owner revokes a shared secret");
    }
    const row = await revokeSharedGrant(ctx.store, g.id, {
      clock: ctx.clock,
      installId: p.kind === "admin" ? p.installId : p.deviceId,
      by: p.kind === "device" ? p.humanId : g.owner_human_id,
    });
    await announceRequests(ctx, row.request_ids, { grantId: row.id });
    return c.json({ grant: sharedGrantView(row) });
  });
}
