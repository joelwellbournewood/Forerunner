/**
 * Daemon routes for notifications, mounted by the orchestrator at the daemon root. The settings
 * screen reads and writes `GET/PUT /notifications/prefs`, "Send a test" is
 * `POST /notifications/test`, and the recent list is `GET /notifications/recent`. `actor()`
 * names the human the daemon serves (ADR 0011: one human per install).
 */
import { ForerunnerError } from "@forerunner/platform";
import { Hono } from "hono";
import { z } from "zod";
import type { Notifier } from "./notifier.ts";
import { NotificationPrefsPatch } from "./prefs.ts";
import { CHANNEL_NAMES, NOTIFICATION_KINDS, URGENCIES } from "./types.ts";

export interface NotificationRoutesDeps {
  notifier: Notifier;
  actor: () => { humanId: string };
}

export const ChannelStatusView = z.object({
  name: z.enum(CHANNEL_NAMES),
  available: z.boolean(),
  configured: z.boolean(),
  reason: z.string().nullable(),
});

export const NotificationPrefsView = z.object({
  prefs: z.object({
    channels: z.partialRecord(z.enum(NOTIFICATION_KINDS), z.array(z.enum(CHANNEL_NAMES))),
    quiet_hours: z.object({ start: z.string(), end: z.string() }).nullable(),
    timezone: z.string().nullable(),
    digest_time: z.string().nullable(),
    telegram_chat_id: z.string().nullable(),
    signal_number: z.string().nullable(),
    email: z.string().nullable(),
    notify_channel: z.enum([...CHANNEL_NAMES, "push"]).nullable(),
    voice_alerts: z.boolean(),
  }),
  resolved: z.object({ timezone: z.string(), email: z.string().nullable() }),
  channels: z.array(ChannelStatusView),
});
export type NotificationPrefsView = z.infer<typeof NotificationPrefsView>;

export const DeliveryView = z.object({
  channel: z.enum(CHANNEL_NAMES),
  status: z.enum(["delivered", "failed", "unavailable", "skipped"]),
  reason: z.string().nullable(),
  attempts: z.number().int(),
  at: z.string(),
});

export const NotificationRecordView = z.object({
  id: z.string(),
  kind: z.enum(NOTIFICATION_KINDS),
  humanId: z.string(),
  title: z.string(),
  body: z.string(),
  link: z.string(),
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  urgency: z.enum(URGENCIES),
  outcome: z.enum(["delivered", "failed", "held", "digested", "deduped", "no_channel"]),
  heldFor: z.enum(["quiet_hours", "digest"]).nullable(),
  deliveries: z.array(DeliveryView),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type NotificationRecordView = z.infer<typeof NotificationRecordView>;

function toView(r: ReturnType<Notifier["recent"]>[number]): NotificationRecordView {
  return {
    id: r.id,
    kind: r.notification.kind,
    humanId: r.notification.humanId,
    title: r.notification.title,
    body: r.notification.body,
    link: r.notification.link,
    projectId: r.notification.projectId ?? null,
    sessionId: r.notification.sessionId ?? null,
    urgency: r.urgency,
    outcome: r.outcome,
    heldFor: r.heldFor,
    deliveries: r.deliveries,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
  };
}

function errorBody(e: unknown): {
  code: string;
  message: string;
  details: Record<string, unknown>;
} {
  if (e instanceof ForerunnerError) return { code: e.code, message: e.message, details: e.details };
  return { code: "internal", message: e instanceof Error ? e.message : String(e), details: {} };
}

export function createNotificationRoutes(deps: NotificationRoutesDeps): Hono {
  const app = new Hono();

  app.onError((e, c) => {
    const body = errorBody(e);
    if (body.code === "not_found") return c.json(body, 404);
    if (body.code === "validation") return c.json(body, 400);
    return c.json(body, 500);
  });

  app.get("/notifications/prefs", async (c) =>
    c.json(await deps.notifier.getPrefs(deps.actor().humanId)),
  );

  app.put("/notifications/prefs", async (c) => {
    const raw = await c.req.json().catch(() => null);
    const parsed = NotificationPrefsPatch.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          code: "validation",
          message: "notification preferences are malformed",
          details: { issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
        },
        400,
      );
    }
    return c.json(await deps.notifier.setPrefs(deps.actor().humanId, parsed.data));
  });

  app.post("/notifications/test", async (c) =>
    c.json({ deliveries: await deps.notifier.sendTest(deps.actor().humanId) }),
  );

  app.get("/notifications/recent", (c) => {
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;
    const rows = deps.notifier.recent({ humanId: deps.actor().humanId, limit });
    return c.json({ notifications: rows.map(toView) });
  });

  app.get("/notifications/pending", (c) => {
    const p = deps.notifier.pending(deps.actor().humanId);
    return c.json({ held: p.held.map(toView), digest: p.digest.map(toView) });
  });

  return app;
}
