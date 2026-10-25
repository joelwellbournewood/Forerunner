import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { email as agentEmail } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DAEMON_ROUTES, EmailSettingsView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";

/**
 * The Settings -> Capabilities -> Email routes on the daemon (spec S.15, S.28, S.29, T.14):
 * `createEmailRoutes` mounted behind the bearer check with the daemon's human as the
 * signed-in human and the capability's identity port as the owner check. The tray's two
 * routes (`POST /agents/:id/email/pause|resume`) flip `settings.paused` and the policy holds
 * the next send while paused; a settings change through `PUT` reaches the policy at once and
 * is one `email.settings` audit row, but the mode is not the route's to change: it is the
 * registry's `email.mode.set` (spec Q "Confirmation by risk": high, a card and a device
 * confirmation, one change log row with undo; ADR 0066 amended 2026-10-25), and a `PUT`
 * that would change it is a 403 naming the command; the command audit and the sent log read
 * newest first; another human's agent is refused on the routes and by the command; email
 * commands cannot be on at sending mode off (ADR 0081): turning them on there is a 400 with
 * the plain message, and switching the mode to off turns them off with an audit row and an
 * `email_commands_off` notification to the owner. Fake provider, a fake mailbox,
 * `sqlite::memory:`, memory vault, SimulatedClock; no network.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const AGENT_ADDRESS = "alice@agent.test";
const STRANGER = "ops@vendor-cloud.test";

/** An in-memory agent mailbox that records sends; nothing inbound. */
class FakeMailbox implements agentEmail.Mailbox {
  readonly sent: agentEmail.OutboundMessage[] = [];
  readonly drafts: agentEmail.OutboundMessage[] = [];
  constructor(readonly address: string) {}
  async listUnseen(): Promise<agentEmail.InboundEmail[]> {
    return [];
  }
  async fetch(): Promise<agentEmail.InboundEmail | undefined> {
    return undefined;
  }
  async watch(): Promise<agentEmail.MailboxWatch> {
    return { stop: async () => undefined, pushActive: false };
  }
  async send(message: agentEmail.OutboundMessage): Promise<agentEmail.SendReceipt> {
    this.sent.push(message);
    return { messageId: `sent-${this.sent.length}@agent.test`, raw: message.text };
  }
  async saveDraft(message: agentEmail.OutboundMessage): Promise<agentEmail.DraftReceipt> {
    this.drafts.push(message);
    return { draftId: `draft-${this.drafts.length}`, raw: message.text };
  }
  async markSeen(): Promise<void> {
    return undefined;
  }
}

describe("the email settings routes on the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home: string;
  let mailbox: FakeMailbox;
  let otherAgentId = "";
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    app.request(path, {
      ...init,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const post = (path: string, body: unknown = {}) =>
    req(path, { method: "POST", body: JSON.stringify(body) });
  const put = (path: string, body: unknown) =>
    req(path, { method: "PUT", body: JSON.stringify(body) });
  const settingsPath = () => `/agents/${rt.agent.id}/email/settings`;
  const sendToStranger = () =>
    rt.capabilities.email.ports.policy.send(
      { to: [STRANGER], subject: "hello", text: "a line" },
      { agentId: rt.agent.id, humanId: rt.human.id },
    );
  const settingsAudit = async () =>
    (
      await rt.store.auditLog.list({
        agentId: rt.agent.id,
        tool: agentEmail.EMAIL_SETTINGS_TOOL,
      })
    ).map((r) => {
      const input = JSON.parse(r.input_summary) as { action: string; refused?: string };
      return {
        action: input.action,
        allowed: r.allowed,
        refused: input.refused ?? null,
        human: r.human_id,
        author: r.author_human,
      };
    });
  /**
   * The mode the way the page, chat and voice change it: `email.mode.set` through the
   * registry, a `needs_device` card answered by this PC's own device row (what the page
   * sends with `/me.desktopDeviceId`), one change log row.
   */
  const setMode = async (mode: string, agentId = rt.agent.id): Promise<Json> => {
    const pending = await json(
      await post("/commands/execute", {
        commands: [{ name: "email.mode.set", params: { mode, agent: agentId } }],
        wordsUsed: `Settings: email mode to ${mode}`,
        source: "ui",
      }),
    );
    if (pending.status !== "pending") return pending;
    expect(pending.decision).toBe("needs_device");
    return json(await post(`/commands/${String(pending.pendingId)}/confirm`, { answer: "device" }));
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-email-routes-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mailbox = new FakeMailbox(AGENT_ADDRESS);
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new FakeProvider({ clock, latency: "none", onNoMatch: "throw" }),
      registryDir: REGISTRY,
      identity: {
        humanName: "J",
        email: "j@example.test",
        timezone: "Europe/Zurich",
        agentName: "Alice",
      },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      browser: { mode: "static" },
      notifications: { platform: "linux", mailboxFactory: async () => mailbox },
    });
    // A second human with an agent of their own on the same state (ADR 0041 item 4).
    const bob = await rt.store.human.insert({ name: "Bob", email: "bob@example.test" });
    otherAgentId = (
      await rt.store.agent.insert({ name: "Bobby", owner_human_id: bob.id, kind: "principal" })
    ).id;
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("lists the seven routes in DAEMON_ROUTES and serves them behind the bearer check", async () => {
    for (const key of [
      "emailSettings",
      "updateEmailSettings",
      "emailSent",
      "pauseEmail",
      "resumeEmail",
      "rotateEmailMarker",
      "emailCommands",
    ] as const) {
      expect(DAEMON_ROUTES).toHaveProperty(key);
      expect(DAEMON_ROUTES[key]).toContain("/email/");
    }
    expect((await req(settingsPath(), {}, false)).status).toBe(401);
    expect((await req(`/agents/${rt.agent.id}/email/commands`, {}, false)).status).toBe(401);
    const fresh = await req(settingsPath());
    expect(fresh.status).toBe(200);
    const body = await json(fresh);
    // The daemon's contract (api-types) and the capability's schema agree on the shape.
    expect(EmailSettingsView.safeParse(body).success).toBe(true);
    expect(agentEmail.AgentEmailConfigSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(EmailSettingsView.shape.settings.shape).sort()).toEqual(
      Object.keys(agentEmail.EmailSettingsSchema.shape).sort(),
    );
    expect(Object.keys(EmailSettingsView.shape.commands.shape).sort()).toEqual(
      Object.keys(agentEmail.EmailCommandSettingsSchema.shape).sort(),
    );
    expect(body).toMatchObject({
      settings: { mode: "off", paused: false, dailySendCap: 20, perRecipientDailyCap: 5 },
      commands: { enabled: false },
    });
  });

  it("PUT refuses a mode change and names email.mode.set; the mailbox saves through PUT as one audit row; the mode set through the command (card, this device, change log) reaches the policy at once", async () => {
    // Mode off: the policy refuses before anything reaches the mailbox.
    await expect(sendToStranger()).rejects.toMatchObject({ code: "tool_not_allowed" });
    // The mode is a high-risk change (spec Q): the raw route applies no card, so it refuses
    // and nothing in the body is written, the mailbox beside it included.
    const viaPut = await put(settingsPath(), {
      settings: {
        mode: "full_discretion",
        mailbox: { address: AGENT_ADDRESS, imap: null, smtp: null },
      },
    });
    expect(viaPut.status).toBe(403);
    const viaPutError = (await json(viaPut)).error as { message: string };
    expect(viaPutError).toMatchObject({
      code: "tool_not_allowed",
      details: { reason: "mode_change_needs_command", command: "email.mode.set" },
    });
    expect(viaPutError.message).toContain("email.mode.set");
    expect((await json(await req(settingsPath()))).settings).toMatchObject({
      mode: "off",
      mailbox: null,
    });
    // The stored mode in the body is no change: the mailbox saves.
    const updated = await put(settingsPath(), {
      settings: {
        mode: "off",
        mailbox: {
          address: AGENT_ADDRESS,
          imap: { host: "imap.agent.test", user: "alice", passwordRef: "secret:alice_imap" },
          smtp: null,
        },
      },
    });
    expect(updated.status).toBe(200);
    expect(await json(updated)).toMatchObject({
      settings: {
        mode: "off",
        mailbox: { address: AGENT_ADDRESS, imap: { passwordRef: "secret:alice_imap" } },
      },
    });
    const bad = await put(settingsPath(), { settings: { mode: "yolo" } });
    expect(bad.status).toBe(400);
    expect(((await json(bad)).error as { code: string }).code).toBe("validation");
    const value = await put(settingsPath(), {
      settings: {
        mailbox: {
          address: AGENT_ADDRESS,
          imap: { host: "imap.agent.test", user: "alice", passwordRef: "hunter22xyz" },
          smtp: null,
        },
      },
    });
    expect(value.status).toBe(400);
    // The refused mode change is an audited refusal the owner sees; the mailbox save a row.
    expect(await settingsAudit()).toEqual([
      {
        action: "update",
        allowed: false,
        refused: "mode_change_needs_command",
        human: rt.human.id,
        author: rt.human.id,
      },
      { action: "update", allowed: true, refused: null, human: rt.human.id, author: rt.human.id },
    ]);
    // The mode: the registry's command, the same one chat and voice run, with its card.
    const r = await setMode("full_discretion");
    expect(r).toMatchObject({
      status: "done",
      sentence: "Changed the email mode of Alice from Off to Full discretion. Undo.",
    });
    expect(typeof r.changeLogId).toBe("string");
    expect((await json(await req(settingsPath()))).settings).toMatchObject({
      mode: "full_discretion",
    });
    const changes = (await (await req("/changes")).json()) as Array<Record<string, unknown>>;
    expect(changes.find((c) => c.id === r.changeLogId)).toMatchObject({
      source: "ui",
      sentence: "Changed the email mode of Alice from Off to Full discretion. Undo.",
      undoable: true,
    });
    await rt.capabilities.refresh();
    expect(rt.capabilities.email.presence.enabled()).toBe(true);
    expect((await sendToStranger()).status).toBe("sent");
    expect(mailbox.sent).toHaveLength(1);
  });

  it("the tray's pause route holds the next send and resume releases it (S.28)", async () => {
    const paused = await post(`/agents/${rt.agent.id}/email/pause`);
    expect(paused.status).toBe(200);
    expect(await json(paused)).toEqual({ paused: true });
    expect((await json(await req(settingsPath()))).settings).toMatchObject({ paused: true });
    const held = await sendToStranger();
    expect(held.status).toBe("queued");
    expect(mailbox.sent).toHaveLength(1);
    const resumed = await post(`/agents/${rt.agent.id}/email/resume`);
    expect(resumed.status).toBe(200);
    expect(await json(resumed)).toEqual({ paused: false });
    expect((await sendToStranger()).status).toBe("sent");
    expect(mailbox.sent).toHaveLength(2);
    expect((await settingsAudit()).filter((r) => r.allowed).map((r) => r.action)).toEqual([
      "update",
      "pause",
      "resume",
    ]);
  });

  it("GET sent lists the agent's copies newest first; GET commands serves the audit rows newest first", async () => {
    await clock.advance(1000);
    await rt.capabilities.email.ports.policy.send(
      { to: [STRANGER], subject: "later", text: "second line" },
      { agentId: rt.agent.id, humanId: rt.human.id },
    );
    const sent = await req(`/agents/${rt.agent.id}/email/sent?limit=2`);
    expect(sent.status).toBe(200);
    const rows = (await json(sent)).rows as Array<{ subject: string; to: string[] }>;
    expect(rows.map((r) => r.subject)).toEqual(["later", "hello"]);
    expect(rows[0]?.to).toEqual([STRANGER]);

    const empty = await req(`/agents/${rt.agent.id}/email/commands`);
    expect(empty.status).toBe(200);
    expect(await json(empty)).toEqual({ rows: [] });
    // Rows the runner's handler writes into the shared state: one per command.
    for (const [i, row] of [
      {
        allowed: false,
        denied_reason: "ignored: no_marker",
        input: { messageId: "<m1@example.test>", from: "j@example.test", subject: "no tag" },
        result: { outcome: "ignored", reason: "no_marker" },
      },
      {
        allowed: true,
        denied_reason: null,
        input: { messageId: "<m2@example.test>", from: "j@example.test", subject: "[FR-x] q" },
        result: {
          outcome: "question",
          interpretation: { kind: "question", summary: "What is due?", title: "" },
        },
      },
    ].entries()) {
      await clock.advance(1000);
      await rt.store.auditLog.append({
        tool: agentEmail.EMAIL_COMMAND_TOOL,
        allowed: row.allowed,
        denied_reason: row.denied_reason,
        agent_id: rt.agent.id,
        human_id: rt.human.id,
        session_id: i === 1 ? "sess_1" : null,
        input_summary: JSON.stringify(row.input),
        result_summary: JSON.stringify(row.result),
        cost_usd_micro: 0,
        occurred_at: clock.nowIso(),
        author_agent: rt.agent.id,
      });
    }
    const commands = await req(`/agents/${rt.agent.id}/email/commands?limit=10`);
    const audit = (await json(commands)).rows as Array<Record<string, unknown>>;
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      obeyed: true,
      deniedReason: null,
      sessionId: "sess_1",
      email: { from: "j@example.test", subject: "[FR-x] q" },
      result: { outcome: "question", interpretation: { kind: "question" } },
    });
    expect(audit[1]).toMatchObject({ obeyed: false, deniedReason: "ignored: no_marker" });
    expect((await json(await req(`/agents/${rt.agent.id}/email/commands?limit=1`))).rows).toEqual([
      audit[0],
    ]);
  });

  it("rotate-marker answers a fresh marker that the settings then carry", async () => {
    const before = (await json(await req(settingsPath()))).commands as { marker: string };
    const rotated = await post(`/agents/${rt.agent.id}/email/rotate-marker`);
    expect(rotated.status).toBe(200);
    const marker = (await json(rotated)).marker as string;
    expect(marker).toMatch(/^\[FR-[a-z2-9]{4}\]$/);
    expect(marker).not.toBe(before.marker);
    expect((await json(await req(settingsPath()))).commands).toMatchObject({ marker });
  });

  it("refuses another human's agent and an unknown agent on every route (403, nothing changed)", async () => {
    for (const [method, path] of [
      ["GET", `/agents/${otherAgentId}/email/settings`],
      ["PUT", `/agents/${otherAgentId}/email/settings`],
      ["GET", `/agents/${otherAgentId}/email/sent`],
      ["POST", `/agents/${otherAgentId}/email/pause`],
      ["POST", `/agents/${otherAgentId}/email/resume`],
      ["POST", `/agents/${otherAgentId}/email/rotate-marker`],
      ["GET", `/agents/${otherAgentId}/email/commands`],
      ["POST", "/agents/nobody/email/pause"],
    ] as const) {
      const res = await req(path, {
        method,
        ...(method === "GET" ? {} : { body: JSON.stringify({ settings: { paused: true } }) }),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(((await json(res)).error as { code: string }).code).toBe("tool_not_allowed");
    }
    // The registry's path refuses Bob's agent too: no card is formed, this human's device
    // confirms nothing for it (S.15; review of w2-email-page, finding 2).
    const viaCommand = await setMode("full_discretion", otherAgentId);
    expect(viaCommand).toMatchObject({ status: "refused", code: "tool_not_allowed" });
    expect(String(viaCommand.reason)).toMatch(/not yours/);
    // Bob's agent has no settings row of its own written by this daemon's human.
    expect(
      await rt.store.extension.byName(
        agentEmail.EMAIL_EXTENSION_KIND,
        agentEmail.emailExtensionName(otherAgentId),
      ),
    ).toBeFalsy();
  });

  it("ADR 0081: switching the mode to off turns email commands off, audits it and notifies the owner; turning them on at off is a 400", async () => {
    expect(await setMode("read_only")).toMatchObject({ status: "done" });
    const on = await put(settingsPath(), {
      commands: { enabled: true, registeredHumanAddress: "j@example.test" },
    });
    expect(on.status).toBe(200);
    expect((await json(on)).commands).toMatchObject({ enabled: true });
    // The page's mode change to off: the registry's card says commands go off with it, and
    // the daemon's settings store turns them off in the same write.
    const off = await setMode("off");
    expect(off).toMatchObject({
      status: "done",
      sentence:
        "Changed the email mode of Alice from Read only to Off; email commands are turned off with it, because at Off the agent could not answer them. Undo.",
    });
    expect(await json(await req(settingsPath()))).toMatchObject({
      settings: { mode: "off" },
      commands: { enabled: false, registeredHumanAddress: "j@example.test" },
    });
    const rows = await rt.store.auditLog.list({
      agentId: rt.agent.id,
      tool: agentEmail.EMAIL_SETTINGS_TOOL,
    });
    const switched = rows
      .map((r) => JSON.parse(r.input_summary) as Record<string, unknown>)
      .filter((i) => i.action === "commands_switched_off");
    expect(switched).toEqual([
      {
        action: "commands_switched_off",
        reason: "mode_off",
        modeBefore: "read_only",
        modeAfter: "off",
      },
    ]);
    await vi.waitFor(() => {
      const told = rt.notifier
        .recent({ humanId: rt.human.id, limit: 200 })
        .filter((r) => r.notification.kind === "email_commands_off");
      expect(told).toHaveLength(1);
      expect(told[0]?.notification).toMatchObject({
        title: "Email commands turned off",
        link: "/settings",
      });
      expect(told[0]?.notification.body).toMatch(/sending mode is now off/);
    });
    const refused = await put(settingsPath(), { commands: { enabled: true } });
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toMatchObject({
      code: "validation",
      message: agentEmail.COMMANDS_NEED_SENDING_MODE,
    });
    expect((await json(await req(settingsPath()))).commands).toMatchObject({ enabled: false });
  });
  it("ADR 0081: email.mode.set (chat, voice, the phone) to off goes through the settings store: commands off, the audit row, the owner told; undo turns them back on", async () => {
    expect(await setMode("allowlist")).toMatchObject({ status: "done" });
    const on = await put(settingsPath(), {
      commands: { enabled: true, registeredHumanAddress: "j@example.test" },
    });
    expect(on.status).toBe(200);
    const switchedRows = async () =>
      (await rt.store.auditLog.list({ agentId: rt.agent.id, tool: agentEmail.EMAIL_SETTINGS_TOOL }))
        .filter((r) => r.input_summary.includes("commands_switched_off"))
        .map((r) => ({
          input: JSON.parse(r.input_summary) as Record<string, unknown>,
          human: r.human_id,
        }));
    const toldBefore = rt.notifier
      .recent({ humanId: rt.human.id, limit: 200 })
      .filter((r) => r.notification.kind === "email_commands_off").length;
    const rowsBefore = (await switchedRows()).length;
    const pending = await json(
      await req("/commands/execute", {
        method: "POST",
        body: JSON.stringify({
          commands: [{ name: "email.mode.set", params: { mode: "off" } }],
          wordsUsed: "turn my agent's email off",
        }),
      }),
    );
    expect(pending.status).toBe("pending");
    expect((pending.card as { sentence: string }).sentence).toBe(
      "Changed the email mode of Alice from Allowlist to Off; email commands are turned off with it, because at Off the agent could not answer them. Undo.",
    );
    const phone = await rt.store.device.register({
      owner_human_id: rt.human.id,
      name: "Pixel",
      platform: "android",
      public_key: ["pk", "phone", "email"].join("-"), // not-a-secret
      kind: "phone",
    });
    const done = await json(
      await req(`/commands/${String(pending.pendingId)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ answer: "device", deviceId: phone.id, biometric: true }),
      }),
    );
    expect(done.status).toBe("done");
    expect(await json(await req(settingsPath()))).toMatchObject({
      settings: { mode: "off" },
      commands: { enabled: false, registeredHumanAddress: "j@example.test" },
    });
    const row = await rt.store.extension.byName(
      agentEmail.EMAIL_EXTENSION_KIND,
      agentEmail.emailExtensionName(rt.agent.id),
    );
    expect(row?.enabled).toBe(false);
    expect(row?.permissions).not.toContain("email-commands");
    const rows = await switchedRows();
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows).toContainEqual({
      input: {
        action: "commands_switched_off",
        reason: "mode_off",
        modeBefore: "allowlist",
        modeAfter: "off",
      },
      human: rt.human.id,
    });
    await vi.waitFor(() => {
      const told = rt.notifier
        .recent({ humanId: rt.human.id, limit: 200 })
        .filter((r) => r.notification.kind === "email_commands_off");
      expect(told).toHaveLength(toldBefore + 1);
    });
    // The undo restores the mode and the commands the change turned off.
    const undone = await json(
      await req(`/changes/${String(done.changeLogId)}/undo`, { method: "POST" }),
    );
    expect(undone.status).toBe("done");
    expect(await json(await req(settingsPath()))).toMatchObject({
      settings: { mode: "allowlist" },
      commands: { enabled: true },
    });
  });
});
