import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { email as agentEmail } from "@forerunner/capabilities";
import { appDirs, join, Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAEMON_ROUTES } from "../src/daemon/api-types.ts";
import { composeRuntime, osNotifierEnabled, type RuntimeApp } from "../src/daemon/compose.ts";
import { RESTART_EXIT_CODE } from "../src/daemon/restart.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { NotificationEventPayload } from "../src/notifications/emitter.ts";
import type { NotificationKind, NotificationRecord } from "../src/notifications/types.ts";
import { NOTIFY_PREFS_TOOL } from "../src/wiring/notification-ports.ts";
import {
  FAKE_CATALOG_ID,
  fakeCatalogEntry,
  inMemoryConnectorFactory,
  testCatalog,
} from "./extensions-helpers.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * The notification module inside the running system (ADR 0038): `composeRuntime` builds the
 * channels and the notifier, binds the producers to the real sources (the human request path,
 * the session runner, the kill switch, the restarter, the critic's escalations) and the daemon
 * serves the routes and the `notification` SSE event. Fake provider, `sqlite::memory:`,
 * SimulatedClock, injected OS tools and Telegram fetch; no network.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const str = (v: unknown): string => String(v);
// not-a-secret
const BOT_TOKEN = ["123456789", "AAFakeTelegramBotTokenValue", "0123456789"].join(":");

describe("notifications wired into the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock("2026-03-05T08:00:00Z"); // 09:00 in Europe/Zurich
  const exits: number[] = [];
  const runs: string[][] = [];
  const telegramCalls: string[] = [];
  const logs: LogRecord[] = [];
  const vault = new MemoryVault({ telegram_bot_token: BOT_TOKEN });
  let stopLogs: () => void = () => undefined;
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const put = (path: string, body: unknown) =>
    req(path, { method: "PUT", body: JSON.stringify(body) });
  const post = (path: string, body: unknown = {}) =>
    req(path, { method: "POST", body: JSON.stringify(body) });
  /** The next resolved record of `kind` (held records count when `held` is true). */
  const nextRecord = (kind: NotificationKind, opts: { held?: boolean } = {}) =>
    new Promise<NotificationRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`no ${kind} notification within 15 s`));
      }, 15_000);
      const off = rt.notifier.emitter.on("record", (r) => {
        if (r.notification.kind !== kind) return;
        if (r.outcome === "held" && !opts.held) return;
        clearTimeout(timer);
        off();
        resolve(r);
      });
    });
  const insertRequest = (over: { blocking: boolean; why: string; kind?: "info" | "approval" }) =>
    rt.store.humanRequest.insert({
      human_id: rt.human.id,
      project_id: null,
      task_id: null,
      session_id: null,
      kind: over.kind ?? "info",
      why: over.why,
      steps: [],
      options: [],
      blocking: over.blocking,
      risk: "low",
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-notify-wiring-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    stopLogs = Logger.addSink((r) => logs.push(r));
    const { factory } = inMemoryConnectorFactory();
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault,
      provider: new ScriptedProvider([{ text: "Hello from the fake agent." }], clock),
      registryDir: REGISTRY,
      identity: {
        humanName: "J",
        email: "j@example.test",
        timezone: "Europe/Zurich",
        agentName: "Alice",
      },
      appVersion: "0.1.0-test",
      connectors: factory,
      catalog: testCatalog([fakeCatalogEntry()]),
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      exit: (code) => {
        exits.push(code);
      },
      notifications: {
        platform: "linux",
        osNotifier: true,
        which: async (cmd) => `/usr/bin/${cmd}`,
        run: async (argv) => {
          runs.push([...argv]);
          return {
            code: 0,
            signal: null,
            stdout: "",
            stderr: "",
            truncated: false,
            timedOut: false,
            durationMs: 1,
          };
        },
        fetch: async (url) => {
          telegramCalls.push(url);
          // A hostile answer: the API echoes the request URL, token included.
          return new Response(
            JSON.stringify({ ok: false, description: `Bad Request: chat not found for ${url}` }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        },
      },
    });
    ({ app, token } = createDaemonApp(rt));
    const created = await post("/projects", {
      name: "Demo",
      goal: "Notify the human",
      brief: "A longer brief",
      repos: [],
      budgetUsdMicro: 10_000_000,
    });
    projectId = str((await json(created)).id);
  }, 120_000);
  afterAll(async () => {
    stopLogs();
    await rt?.close();
  });

  it("exposes the notifier on the runtime and the routes in the route table", () => {
    expect(rt.notifier).toBeDefined();
    expect(typeof rt.notifications.requestOpened).toBe("function");
    for (const key of [
      "notificationPrefs",
      "setNotificationPrefs",
      "testNotification",
      "recentNotifications",
      "pendingNotifications",
    ] as const) {
      expect(DAEMON_ROUTES[key]).toContain("/notifications/");
    }
    expect(DAEMON_ROUTES.events).toContain("notification");
  });

  it("the OS notifier is on for a set-up install, off for a bare one, and the env decides", () => {
    expect(osNotifierEnabled({}, null)).toBe(false);
    expect(osNotifierEnabled({}, { version: 1 } as never)).toBe(true);
    expect(osNotifierEnabled({ FORERUNNER_OS_NOTIFY: "0" }, { version: 1 } as never)).toBe(false);
    expect(osNotifierEnabled({ FORERUNNER_OS_NOTIFY: "1" }, null)).toBe(true);
    expect(osNotifierEnabled({ FORERUNNER_OS_NOTIFY: "1" }, null, false)).toBe(false);
  });

  it("prefs routes: the channel statuses of this daemon, a write that leaves an audit row naming the keys only, 400 on bad input", async () => {
    const view = await json(await req("/notifications/prefs"));
    expect(view.resolved).toEqual({ timezone: "Europe/Zurich", email: "j@example.test" });
    const channels = Object.fromEntries(
      (view.channels as Json[]).map((c) => [
        c.name,
        { configured: c.configured, reason: c.reason },
      ]),
    );
    expect(channels).toEqual({
      desktop: { configured: true, reason: null },
      telegram: { configured: false, reason: "no Telegram chat id" },
      signal: { configured: false, reason: "no Signal sender account configured" },
      email: { configured: false, reason: "no email sender: enable the agent email capability" },
      voice: { configured: false, reason: "voice alerts are off (set voice_alerts to true)" },
    });

    const saved = await put("/notifications/prefs", {
      telegram_chat_id: "4242",
      digest_time: null,
    });
    expect(saved.status).toBe(200);
    const after = await json(saved);
    expect((after.prefs as Json).telegram_chat_id).toBe("4242");
    const rows = await rt.store.auditLog.list({ tool: NOTIFY_PREFS_TOOL } as never, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allowed: true,
      human_id: rt.human.id,
      input_summary: "keys: telegram_chat_id",
      result_summary: "notification preferences saved",
    });
    expect(JSON.stringify(rows[0])).not.toContain("4242");

    const bad = await put("/notifications/prefs", { quiet_hours: { start: "8:00", end: "x" } });
    expect(bad.status).toBe(400);
    expect((await json(bad)).code).toBe("validation");
    // Back to the default so the next tests use the desktop channel first.
    expect((await put("/notifications/prefs", { telegram_chat_id: null })).status).toBe(200);
  });

  it("a non-blocking human request is a normal notification; without a shell it reaches the OS notifier and leaves an audit row", async () => {
    const pending = nextRecord("request_opened");
    const row = await insertRequest({ blocking: false, why: "Which colour for the button?" });
    const record = await pending;
    expect(record).toMatchObject({ urgency: "normal", outcome: "delivered" });
    expect(record.notification).toMatchObject({
      title: "Information is needed",
      body: "Which colour for the button?",
      link: "/inbox",
      dedupeKey: `request:${row.id}`,
    });
    expect(record.deliveries[0]).toMatchObject({
      channel: "desktop",
      status: "delivered",
      reason: "notify-send",
    });
    const argv = runs.at(-1);
    expect(argv?.slice(0, 4)).toEqual([
      "notify-send",
      "--app-name=Forerunner",
      "--urgency=normal",
      "--",
    ]);
    expect(argv?.[4]).toBe("Information is needed");
    const rows = await rt.store.auditLog.list({ tool: "notify.desktop" } as never, { limit: 50 });
    expect(rows.some((r) => r.allowed && r.input_summary.includes(record.id))).toBe(true);
  });

  it("a blocking human request is urgent (critical on the OS notifier)", async () => {
    const pending = nextRecord("request_blocking");
    await insertRequest({ blocking: true, why: "Merge to main?", kind: "approval" });
    const record = await pending;
    expect(record).toMatchObject({ urgency: "urgent", outcome: "delivered" });
    expect(record.notification.title).toBe("An approval is needed (work is blocked)");
    expect(runs.at(-1)?.[2]).toBe("--urgency=critical");
  });

  it("an extension waiting for approval files a blocking request, so the human is woken", async () => {
    const pending = nextRecord("request_blocking");
    const added = await post("/extensions", { catalogId: FAKE_CATALOG_ID });
    expect(added.status).toBe(202);
    const record = await pending;
    expect(record.urgency).toBe("urgent");
    expect(record.notification.kind).toBe("request_blocking");
    const open = await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 });
    expect(open.some((r) => r.id === record.notification.dedupeKey.replace("request:", ""))).toBe(
      true,
    );
  });

  it("with a shell on /events the desktop channel delivers the toast as the SSE event `notification` with the shape the shell parses", async () => {
    const res = await req("/events", { headers: { accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value);
    expect(text).toContain("event: inbox.changed");
    // The token in the Authorization header and nothing declared: today's desktop shell.
    expect(rt.shells.count()).toBe(1);
    const osRunsBefore = runs.length;
    const pending = nextRecord("request_opened");
    const row = await insertRequest({ blocking: false, why: "Shell test" });
    const record = await pending;
    expect(record.deliveries[0]).toMatchObject({ channel: "desktop", status: "delivered" });
    expect(record.deliveries[0]?.reason).toBe("shell");
    expect(runs.length).toBe(osRunsBefore);
    for (let i = 0; i < 5 && !text.includes("event: notification"); i++) {
      text += decoder.decode((await reader.read()).value);
    }
    const frame = text
      .split("\n\n")
      .map((f) => f.split("\n"))
      .find((lines) => lines.includes("event: notification"));
    if (!frame) throw new Error(`no notification frame in:\n${text}`);
    const data = JSON.parse(
      frame.find((l) => l.startsWith("data: "))?.slice(6) ?? "{}",
    ) as NotificationEventPayload;
    expect(data).toMatchObject({
      id: record.id,
      kind: "request_opened",
      title: "Information is needed",
      body: "Shell test",
      level: "normal",
      route: "/inbox",
      humanId: rt.human.id,
      projectId: null,
    });
    expect(data.id).not.toBe(row.id);
    await reader.cancel();
    // The listener and the shell are gone with the stream: the next delivery goes to the OS.
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.events.listenerCount("notification")).toBe(0);
    expect(rt.shells.count()).toBe(0);
  });

  it("a UI-style /events stream (token in the query, nothing declared) is no shell: the OS notifier still runs; `client=shell` declares one and `X-Forerunner-Client: ui` opts out", async () => {
    const open = async (path: string, headers: Record<string, string> = {}) => {
      const res = await app.request(path, { headers: { accept: "text/event-stream", ...headers } });
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no body");
      await reader.read(); // the first frame: the handler has registered the stream
      return reader;
    };
    // The React UI's own EventSource (inbox counts), the phone's web view, a browser tab.
    const ui = await open(`/events?token=${token}`);
    expect(rt.events.listenerCount("notification")).toBe(1);
    expect(rt.shells.count()).toBe(0);
    const osRunsBefore = runs.length;
    const pending = nextRecord("request_blocking");
    await insertRequest({ blocking: true, why: "Only a browser tab is open", kind: "approval" });
    const record = await pending;
    expect(record).toMatchObject({ urgency: "urgent", outcome: "delivered" });
    expect(record.deliveries[0]).toMatchObject({
      channel: "desktop",
      status: "delivered",
      reason: "notify-send",
    });
    expect(runs.length).toBe(osRunsBefore + 1);
    expect(runs.at(-1)?.[2]).toBe("--urgency=critical");

    // A native client that says it shows no toasts, although it sends the header.
    const native = await open("/events", {
      authorization: `Bearer ${token}`,
      "x-forerunner-client": "ui",
    });
    expect(rt.shells.count()).toBe(0);
    // A declared shell counts whatever carried the token.
    const shell = await open(`/events?token=${token}&client=shell`);
    expect(rt.shells.count()).toBe(1);
    const viaShell = nextRecord("request_opened");
    await insertRequest({ blocking: false, why: "A declared shell is attached" });
    expect((await viaShell).deliveries[0]?.reason).toBe("shell");
    expect(runs.length).toBe(osRunsBefore + 1);

    await Promise.all([ui.cancel(), native.cancel(), shell.cancel()]);
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.shells.count()).toBe(0);
    expect(rt.events.listenerCount("notification")).toBe(0);
  });

  it("a finished session notifies the human with the outcome, links to the session and logs the delivery on the session", async () => {
    const pending = nextRecord("session_ended");
    const started = await post("/sessions", {
      agentId: rt.agent.id,
      projectId,
      budgetUsdMicro: 1_000_000,
    });
    expect(started.status).toBe(202);
    const record = await pending;
    expect(record).toMatchObject({ urgency: "normal", outcome: "delivered" });
    const sessionId = record.notification.sessionId;
    expect(sessionId).toBeTruthy();
    expect(record.notification.title).toMatch(/^Alice's session \w+: \d+ done, \d+ needs? you$/);
    expect(record.notification.link).toBe(`/sessions/${sessionId}`);
    expect(record.notification.projectId).toBe(projectId);
    const events = (await (await req(`/sessions/${sessionId}/events`)).json()) as Json[];
    const logged = events.find((e) => e.type === "notification");
    expect(logged).toBeDefined();
    expect(str((logged as Json).text)).toContain("session");
  });

  it("a critic escalation on the bus is a critic_verdict raised to normal; one that filed a request is left to the request path", async () => {
    const pending = nextRecord("critic_verdict");
    rt.events.emit("session", {
      type: "critic.verdict",
      payload: {
        taskId: "task-1",
        reviewId: "review-1",
        verdict: "escalate",
        grade: 40,
        escalation: true,
        summary: "The tests do not cover the new branch.",
      },
      agentId: rt.agent.id,
      projectId,
    });
    const record = await pending;
    expect(record).toMatchObject({ urgency: "normal", outcome: "delivered" });
    expect(record.notification).toMatchObject({
      kind: "critic_verdict",
      title: "Critic: escalate (grade 40)",
      link: `/projects/${projectId}/reviews`,
      dedupeKey: "review:review-1",
    });

    const before = rt.notifier.recent({ humanId: rt.human.id, limit: 200 }).length;
    rt.events.emit("session", {
      type: "critic.verdict",
      payload: {
        reviewId: "review-2",
        verdict: "human",
        grade: 10,
        escalation: true,
        humanRequestId: "req-filed-elsewhere",
      },
      agentId: rt.agent.id,
      projectId,
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(rt.notifier.recent({ humanId: rt.human.id, limit: 200 }).length).toBe(before);

    // The bus event names no session, the review row does: the escalation is logged on the
    // session it came from, like the session-end notification.
    const session = await rt.store.session.latestForAgent(rt.agent.id);
    if (!session) throw new Error("the earlier test left no session");
    const review = await rt.store.review.insert({
      task_id: null,
      session_id: session.id,
      critic_model: "fake-critic",
      tier: 1,
      grade: 35,
      confidence: 0.8,
      verdict: "escalate",
      evidence: [],
      summary: "The session review needs the human.",
      author_agent: rt.criticAgent.id,
    });
    const onSession = nextRecord("critic_verdict");
    rt.events.emit("session", {
      type: "critic.session_review",
      payload: {
        reviewId: review.id,
        verdict: "escalate",
        grade: 35,
        escalation: true,
        summary: "The session review needs the human.",
      },
      agentId: rt.agent.id,
      projectId,
    });
    const logged = await onSession;
    expect(logged).toMatchObject({ urgency: "normal", outcome: "delivered" });
    expect(logged.notification.sessionId).toBe(session.id);
    const events = (await (await req(`/sessions/${session.id}/events`)).json()) as Json[];
    const entry = events.find((e) => e.type === "notification" && str(e.text).includes(logged.id));
    expect(entry).toBeDefined();
    expect(str((entry as Json).text)).toContain("critic_verdict");
  });

  it("the kill switch is urgent, names what stopped and why, and links home", async () => {
    const pending = nextRecord("kill_switch");
    const killed = await post("/kill", { scope: "all", reason: "pull the plug" });
    expect(killed.status).toBe(200);
    const record = await pending;
    expect(record).toMatchObject({ urgency: "urgent", outcome: "delivered" });
    expect(record.notification).toMatchObject({
      title: "Kill switch: everything stopped",
      link: "/",
      dedupeKey: "kill:all",
    });
    expect(record.notification.body).toContain("Reason: pull the plug");
    expect(runs.at(-1)?.[2]).toBe("--urgency=critical");
    expect((await post("/kill/resume")).status).toBe(200);
  });

  it("an applied update and a rollback notify the human before the daemon restarts", async () => {
    const rollback = nextRecord("update_applied");
    await rt.restarter.restart({
      reason: "rollback",
      targetVersion: "0.1.0-test",
      fromVersion: "0.2.0",
    });
    expect(exits).toContain(RESTART_EXIT_CODE);
    const r1 = await rollback;
    expect(r1).toMatchObject({ urgency: "normal", outcome: "delivered" });
    expect(r1.notification.title).toBe("Rolled back to 0.1.0-test (from 0.2.0)");
    expect(r1.notification.link).toBe("/settings");

    const update = nextRecord("update_applied");
    await rt.restarter.restart({
      reason: "update",
      targetVersion: "0.3.0",
      fromVersion: "0.1.0-test",
    });
    const r2 = await update;
    expect(r2.notification.title).toBe("Update 0.3.0 applied (from 0.1.0-test); restarting");
    expect(r2.notification.dedupeKey).not.toBe(r1.notification.dedupeKey);
  });

  it("quiet hours from the prefs route hold a normal notification, never an urgent one; the tick flushes it once the window is cleared", async () => {
    expect(
      (await put("/notifications/prefs", { quiet_hours: { start: "08:00", end: "10:00" } })).status,
    ).toBe(200);
    const held = nextRecord("request_opened", { held: true });
    await insertRequest({ blocking: false, why: "Can wait until morning" });
    const record = await held;
    expect(record).toMatchObject({ outcome: "held", heldFor: "quiet_hours", urgency: "normal" });
    const pending = await json(await req("/notifications/pending"));
    expect((pending.held as Json[]).map((r) => r.id)).toContain(record.id);

    const urgent = nextRecord("request_blocking");
    await insertRequest({ blocking: true, why: "Cannot wait", kind: "approval" });
    expect((await urgent).outcome).toBe("delivered");

    expect((await put("/notifications/prefs", { quiet_hours: null })).status).toBe(200);
    await rt.notifier.tick();
    expect(record).toMatchObject({ outcome: "delivered", heldFor: null });
    const recent = await json(await req("/notifications/recent?limit=50"));
    expect((recent.notifications as Json[]).find((r) => r.id === record.id)?.outcome).toBe(
      "delivered",
    );
  });

  it("Telegram: the bot token is resolved by reference at send time and never reaches the record, the audit rows or the logs", async () => {
    expect(
      (
        await put("/notifications/prefs", {
          telegram_chat_id: "4242",
          channels: { kill_switch: ["telegram"] },
        })
      ).status,
    ).toBe(200);
    const pending = nextRecord("kill_switch");
    await rt.kill.stop({ agentId: rt.agent.id }, "telegram test");
    const record = await pending;
    rt.kill.resume();
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0]).toContain(`/bot${BOT_TOKEN}/sendMessage`);
    expect(record.outcome).toBe("failed");
    expect(record.deliveries).toHaveLength(1);
    expect(record.deliveries[0]).toMatchObject({
      channel: "telegram",
      status: "unavailable",
      attempts: 1,
    });
    expect(record.deliveries[0]?.reason).toContain("telegram api 400");
    expect(JSON.stringify(record)).not.toContain(BOT_TOKEN);
    const rows = await rt.store.auditLog.list({ tool: "notify.telegram" } as never, { limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowed).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(logs)).not.toContain(BOT_TOKEN);
    const open = await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 100 });
    expect(JSON.stringify(open)).not.toContain(BOT_TOKEN);
    expect(
      (
        await put("/notifications/prefs", {
          telegram_chat_id: null,
          channels: { kill_switch: ["desktop", "telegram", "signal", "email"] },
        })
      ).status,
    ).toBe(200);
  });

  it("Telegram with a chat id but no bot token in the vault is 'not configured' and skipped, never a failed send", async () => {
    const telegramFirst = { request_opened: ["telegram", "desktop"] };
    expect(
      (await put("/notifications/prefs", { telegram_chat_id: "4242", channels: telegramFirst }))
        .status,
    ).toBe(200);
    expect(await vault.delete("telegram_bot_token")).toBe(true);
    const missing = { configured: false, reason: "bot token not set (secret telegram_bot_token)" };
    const telegramOf = (view: Json) => (view.channels as Json[]).find((c) => c.name === "telegram");
    expect(telegramOf(await json(await req("/notifications/prefs")))).toMatchObject(missing);

    const calls = telegramCalls.length;
    const pending = nextRecord("request_opened");
    await insertRequest({ blocking: false, why: "Where is the bot token?" });
    const record = await pending;
    expect(record.outcome).toBe("delivered");
    expect(record.deliveries.map((d) => [d.channel, d.status, d.reason])).toEqual([
      ["telegram", "skipped", missing.reason],
      ["desktop", "delivered", "notify-send"],
    ]);
    expect(telegramCalls).toHaveLength(calls);
    const test = await json(await post("/notifications/test"));
    expect((test.deliveries as Json[]).find((d) => d.channel === "telegram")).toMatchObject({
      status: "skipped",
      reason: missing.reason,
    });
    expect(JSON.stringify(logs)).not.toContain(BOT_TOKEN);

    // The token stored again (the setup wizard, the settings screen): configured at once.
    await vault.set("telegram_bot_token", BOT_TOKEN);
    expect(telegramOf(await json(await req("/notifications/prefs")))).toMatchObject({
      configured: true,
      reason: null,
    });
    expect(
      (
        await put("/notifications/prefs", {
          telegram_chat_id: null,
          channels: { request_opened: ["desktop", "telegram", "signal", "email"] },
        })
      ).status,
    ).toBe(200);
  });

  it("a test send reports every channel and never enters the recent list", async () => {
    const before = rt.notifier.recent({ humanId: rt.human.id, limit: 200 }).length;
    const r = await json(await post("/notifications/test"));
    const deliveries = r.deliveries as Json[];
    expect(deliveries.map((d) => [d.channel, d.status])).toEqual([
      ["desktop", "delivered"],
      ["telegram", "skipped"],
      ["signal", "skipped"],
      ["email", "skipped"],
      ["voice", "skipped"],
    ]);
    expect(rt.notifier.recent({ humanId: rt.human.id, limit: 200 }).length).toBe(before);
  });
});

/** A mailbox that records what the policy hands it; nothing is sent anywhere. */
class RecordingMailbox implements agentEmail.Mailbox {
  readonly sent: agentEmail.OutboundMessage[] = [];
  constructor(readonly address: string) {}
  async listUnseen(): Promise<agentEmail.InboundEmail[]> {
    return [];
  }
  async fetch(): Promise<agentEmail.InboundEmail | undefined> {
    return undefined;
  }
  async watch(): Promise<agentEmail.MailboxWatch> {
    return { pushActive: false, stop: async () => undefined };
  }
  async send(message: agentEmail.OutboundMessage): Promise<agentEmail.SendReceipt> {
    this.sent.push(message);
    return { messageId: `${this.sent.length}@example.test`, raw: "" };
  }
  async saveDraft(): Promise<agentEmail.DraftReceipt> {
    return { draftId: "draft-1", raw: "" };
  }
  async markSeen(): Promise<void> {
    return undefined;
  }
}

describe("the email channel over the agent email capability", () => {
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  let home = "";
  let stateUrl = "";
  const compose = (mailbox?: RecordingMailbox) =>
    composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl,
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", email: "j@example.test", timezone: "UTC", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
      notifications: mailbox ? { mailboxFactory: async () => mailbox } : {},
    });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "fr-notify-email-"));
    stateUrl = `sqlite:${join(home, "state.sqlite")}`;
  });

  it("is not configured without an agent mailbox; with one, a notification to the human goes through the email policy as the agent", async () => {
    const first = await compose();
    try {
      const view = await first.notifier.getPrefs(first.human.id);
      expect(view.channels.find((c) => c.name === "email")).toMatchObject({
        available: true,
        configured: false,
        reason: "no email sender: enable the agent email capability",
      });
      // The human configures the agent's mailbox (the settings screen writes the same row).
      await new agentEmail.EmailSettingsStore(first.store.extension, first.clock).update(
        first.agent.id,
        {
          settings: {
            mode: "allowlist",
            mailbox: { address: "alice@example.test", imap: null, smtp: null },
          },
        },
      );
    } finally {
      await first.close();
    }

    const mailbox = new RecordingMailbox("alice@example.test");
    const rt = await compose(mailbox);
    try {
      const view = await rt.notifier.getPrefs(rt.human.id);
      expect(view.channels.find((c) => c.name === "email")).toMatchObject({
        available: true,
        configured: true,
        reason: null,
      });
      const deliveries = await rt.notifier.sendTest(rt.human.id);
      expect(deliveries.find((d) => d.channel === "email")).toMatchObject({
        status: "delivered",
        reason: "j@example.test",
      });
      expect(mailbox.sent).toHaveLength(1);
      expect(mailbox.sent[0]).toMatchObject({
        to: ["j@example.test"],
        subject: "[Forerunner] Test notification from Forerunner",
      });
      expect(mailbox.sent[0]?.text).toContain("Open: fr://settings");
      // The policy's sent log recorded the send under the agent (S.21: one log per email).
      const rows = await rt.store.auditLog.list({ agent_id: rt.agent.id } as never, { limit: 50 });
      expect(rows.some((r) => r.tool.startsWith("email") && r.allowed)).toBe(true);
    } finally {
      await rt.close();
    }
  });
});
