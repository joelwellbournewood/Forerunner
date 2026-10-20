import { z } from "zod";
import { requireScope, requireSigned, resolveHumanId } from "../auth/principal.ts";
import { ApiError, forbidden } from "../errors.ts";
import { type App, announce, parseBody, principal, type RouteContext } from "../http.ts";
import { deviceView } from "../views.ts";

const StartPairingBody = z.object({
  humanId: z.string().min(1),
  kind: z.enum(["phone", "web"]).default("phone"),
  scopes: z.array(z.string()).optional(),
  name: z.string().max(120).optional(),
  ttlSeconds: z.number().int().min(30).max(3600).optional(),
});

const CompletePairingBody = z.object({
  code: z.string().min(4).max(32),
  publicKey: z.string().min(40).max(64),
  proof: z.string().min(80).max(128),
  name: z.string().max(120).optional(),
  platform: z.string().min(1).max(40),
  pushToken: z.string().max(512).optional(),
});

const RevokeBody = z.object({ version: z.number().int().optional() });

/** Pairing, /me, device listing and revocation (spec R.2, R.7; ADR 0009). */
export function registerDeviceRoutes(app: App, ctx: RouteContext, publicApp: App): void {
  // The phone has no credentials yet when it completes a pairing: public route, rate limited by IP.
  publicApp.post("/pairing/complete", async (c) => {
    const body = await parseBody(c, CompletePairingBody);
    const result = await ctx.pairing.complete(body);
    announce(ctx, "device.changed", "device", result.device, {
      humanId: result.device.owner_human_id,
      payload: { revoked: false },
    });
    return c.json(
      {
        deviceId: result.device.id,
        humanId: result.device.owner_human_id,
        kind: result.device.kind,
        token: result.session.token,
        expiresAt: result.session.record.expiresAt,
        scopes: result.session.record.scopes,
        schemaVersion: ctx.codeSchemaVersion,
      },
      201,
    );
  });

  app.post("/pairing/start", async (c) => {
    const p = principal(c);
    if (p.kind !== "admin") throw forbidden("only the desktop runtime starts a pairing");
    const body = await parseBody(c, StartPairingBody);
    const pending = await ctx.pairing.start({
      humanId: body.humanId,
      kind: body.kind,
      scopes: body.scopes,
      name: body.name,
      ttlMs: body.ttlSeconds === undefined ? undefined : body.ttlSeconds * 1000,
    });
    return c.json(
      {
        code: pending.code,
        expiresAt: pending.expiresAt,
        kind: pending.kind,
        scopes: pending.scopes,
        /** What the QR encodes: the phone needs the service URL and the code only. */
        qr: { v: 1, code: pending.code, humanId: pending.humanId, kind: pending.kind },
      },
      201,
    );
  });

  app.get("/me", async (c) => {
    const p = principal(c);
    if (p.kind === "admin") {
      return c.json({
        principal: "admin",
        scopes: p.scopes,
        humanId: null,
        deviceId: null,
        installId: p.installId,
      });
    }
    const human = await ctx.store.human.get(p.humanId);
    return c.json({
      principal: "device",
      deviceId: p.deviceId,
      humanId: p.humanId,
      humanName: human?.name ?? null,
      kind: p.device.kind,
      scopes: p.scopes,
      expiresAt: p.token.expiresAt,
      signed: p.signed,
      schemaVersion: ctx.codeSchemaVersion,
    });
  });

  app.get("/devices", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const humanId = resolveHumanId(p, c.req.query("humanId"));
    const rows = humanId
      ? await ctx.store.device.list({ owner_human_id: humanId }, { orderBy: "paired_at desc" })
      : await ctx.store.device.list(undefined, { orderBy: "paired_at desc" });
    return c.json({ devices: rows.map(deviceView) });
  });

  app.get("/devices/:id", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const d = await ctx.store.device.get(c.req.param("id"));
    if (!d) throw new ApiError(404, "not_found", "device not found");
    if (p.kind === "device" && d.owner_human_id !== p.humanId) throw forbidden("not your device");
    return c.json(deviceView(d));
  });

  // Lost phone: the desktop revokes; tokens die with the row and the next request is refused.
  app.post("/devices/:id/revoke", async (c) => {
    const p = principal(c);
    requireSigned(p);
    if (p.kind !== "admin") throw forbidden("devices are revoked from the desktop");
    const body = await parseBody(c, RevokeBody);
    const id = c.req.param("id");
    const current = await ctx.store.device.get(id);
    if (!current) throw new ApiError(404, "not_found", "device not found");
    const row = current.revoked
      ? current
      : await ctx.store.device.revoke(id, body.version ?? current.version);
    const tokensRemoved = await ctx.tokens.revokeDevice(id);
    announce(ctx, "device.changed", "device", row, {
      humanId: row.owner_human_id,
      payload: { revoked: true },
    });
    return c.json({ device: deviceView(row), tokensRevoked: tokensRemoved });
  });
}
