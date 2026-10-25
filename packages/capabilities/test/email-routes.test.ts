import { ForerunnerError } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmailRoutes,
  EMAIL_SETTINGS_TOOL,
  type EmailRouteApp,
  type EmailRouteContext,
  type EmailRouteHandler,
  emailRouteTable,
  errorStatus,
} from "../src/email/index.ts";
import {
  emailWorld,
  inboundOf,
  MARKER,
  ownerSends,
  STRANGER,
  type World,
} from "./helpers/email-world.ts";

let world: World | undefined;

afterEach(async () => {
  await world?.stop();
  world = undefined;
});

interface CallOptions {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  human?: string;
}

/** The slice of Hono the routes use, with a direct call helper (no HTTP, no hono dependency). */
class FakeApp implements EmailRouteApp {
  readonly routes = new Map<string, EmailRouteHandler>();
  get(path: string, handler: EmailRouteHandler): void {
    this.routes.set(`GET ${path}`, handler);
  }
  put(path: string, handler: EmailRouteHandler): void {
    this.routes.set(`PUT ${path}`, handler);
  }
  post(path: string, handler: EmailRouteHandler): void {
    this.routes.set(`POST ${path}`, handler);
  }
  async call(
    method: string,
    path: string,
    opts: CallOptions = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const handler = this.routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`no route ${method} ${path}`);
    const c: EmailRouteContext = {
      req: {
        param: (name) => opts.params?.[name],
        query: (name) => opts.query?.[name],
        json: async () => opts.body,
        header: (name) => (name === "x-human" ? opts.human : undefined),
      },
      json: (body, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    };
    const res = await handler(c);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
}

/**
 * The production-shaped mount: the daemon identifies the signed-in human and resolves agent
 * owners, so every call below names the owner (a mount with `humanFor` and no `identity`
 * refuses everything, see security-email-routes-identity.test.ts).
 */
function appOf(w: World) {
  return createEmailRoutes(
    {
      settings: w.settings,
      sentLog: w.sentLog,
      clock: w.clock,
      audit: w.store.auditLog,
      commandAudit: (agentId, opts) => w.handler.commandAudit(agentId, opts),
      humanFor: (c) => c.req.header?.("x-human"),
      identity: w.identity,
    },
    new FakeApp(),
  );
}

describe("createEmailRoutes", () => {
  it("exposes the seven routes of the Settings -> Capabilities -> Email page", async () => {
    world = await emailWorld();
    const table = emailRouteTable({
      settings: world.settings,
      sentLog: world.sentLog,
      clock: world.clock,
    });
    expect(table.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /agents/:agentId/email/settings",
      "PUT /agents/:agentId/email/settings",
      "GET /agents/:agentId/email/sent",
      "POST /agents/:agentId/email/pause",
      "POST /agents/:agentId/email/resume",
      "POST /agents/:agentId/email/rotate-marker",
      "GET /agents/:agentId/email/commands",
    ]);
    expect(errorStatus(new ForerunnerError("validation", "x"))).toBe(400);
    expect(errorStatus(new ForerunnerError("not_found", "x"))).toBe(404);
    expect(errorStatus(new ForerunnerError("tool_not_allowed", "x"))).toBe(403);
    expect(errorStatus(new ForerunnerError("version_conflict", "x"))).toBe(409);
    expect(errorStatus(new ForerunnerError("internal", "x"))).toBe(500);
  });

  it("GET and PUT settings: defaults, merge, validation, audit; credentials stay references", async () => {
    world = await emailWorld();
    const app = appOf(world);
    // A second agent of the same human that no test configured: the defaults.
    const second = await world.store.agent.insert({
      name: "Fresh",
      owner_human_id: world.human.id,
    });
    const fresh = await app.call("GET", "/agents/:agentId/email/settings", {
      params: { agentId: second.id },
      human: world.human.id,
    });
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({
      settings: { mode: "off", dailySendCap: 20, perRecipientDailyCap: 5, paused: false },
      commands: { enabled: false, dailyTaskCap: 10, autonomyLevel: 2 },
    });

    const updated = await app.call("PUT", "/agents/:agentId/email/settings", {
      params: { agentId: world.agentId },
      human: world.human.id,
      body: {
        settings: {
          mode: "allowlist",
          allowlist: { domains: ["partner.test"] },
          mailbox: {
            address: "alice@example.test",
            imap: { host: "imap.example.test", user: "alice", passwordRef: "secret:alice_imap" },
            smtp: null,
          },
        },
        commands: { dailyTaskCap: 3 },
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      settings: { mode: "allowlist", allowlist: { domains: ["partner.test"] } },
      commands: { dailyTaskCap: 3, enabled: true, marker: MARKER },
    });
    expect(JSON.stringify(updated.body)).toContain("secret:alice_imap");
    const rows = await world.store.auditLog.list({
      agentId: world.agentId,
      tool: EMAIL_SETTINGS_TOOL,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.human_id).toBe(world.human.id);
    expect(JSON.parse(rows[0]?.input_summary ?? "{}")).toMatchObject({
      action: "update",
      modeBefore: "full_discretion",
      modeAfter: "allowlist",
    });

    const bad = await app.call("PUT", "/agents/:agentId/email/settings", {
      params: { agentId: world.agentId },
      human: world.human.id,
      body: { settings: { mode: "yolo" } },
    });
    expect(bad.status).toBe(400);
    expect((bad.body.error as { code: string }).code).toBe("validation");
    const value = await app.call("PUT", "/agents/:agentId/email/settings", {
      params: { agentId: world.agentId },
      human: world.human.id,
      body: {
        settings: {
          mailbox: {
            address: "alice@example.test",
            imap: { host: "h", user: "u", passwordRef: "hunter22xyz" },
            smtp: null,
          },
        },
      },
    });
    expect(value.status).toBe(400);
    const notObject = await app.call("PUT", "/agents/:agentId/email/settings", {
      params: { agentId: world.agentId },
      human: world.human.id,
      body: null,
    });
    expect(notObject.status).toBe(400);
    const noAgent = await app.call("GET", "/agents/:agentId/email/settings", {
      human: world.human.id,
    });
    expect(noAgent.status).toBe(400);
  });

  it("pause and resume flip the flag the policy enforces", async () => {
    world = await emailWorld({ mode: "full_discretion" });
    const app = appOf(world);
    const paused = await app.call("POST", "/agents/:agentId/email/pause", {
      params: { agentId: world.agentId },
      human: world.human.id,
    });
    expect(paused.body).toEqual({ paused: true });
    const outcome = await world.policy.send(
      { to: [STRANGER], subject: "x", text: "y" },
      { agentId: world.agentId, humanId: world.human.id },
    );
    expect(outcome.status).toBe("queued");
    const resumed = await app.call("POST", "/agents/:agentId/email/resume", {
      params: { agentId: world.agentId },
      human: world.human.id,
    });
    expect(resumed.body).toEqual({ paused: false });
    expect(
      (
        await world.policy.send(
          { to: [STRANGER], subject: "x", text: "y" },
          { agentId: world.agentId, humanId: world.human.id },
        )
      ).status,
    ).toBe("sent");
    const audits = await world.store.auditLog.list({
      agentId: world.agentId,
      tool: EMAIL_SETTINGS_TOOL,
    });
    expect(audits.map((r) => JSON.parse(r.input_summary).action)).toEqual(["pause", "resume"]);
  });

  it("rotate-marker invalidates the old marker at once", async () => {
    world = await emailWorld();
    const app = appOf(world);
    const rotated = await app.call("POST", "/agents/:agentId/email/rotate-marker", {
      params: { agentId: world.agentId },
      human: world.human.id,
    });
    const marker = rotated.body.marker as string;
    expect(marker).toMatch(/^\[FR-[a-z2-9]{4}\]$/);
    expect(marker).not.toBe(MARKER);
    const old = await ownerSends(world, { subject: "old tag", text: "do x" });
    expect((await world.gate.evaluate(world.agentId, await inboundOf(old))).reason).toBe(
      "no_marker",
    );
    const fresh = await ownerSends(world, {
      subject: `${marker} new tag`,
      text: "do x",
      marker: false,
    });
    expect(await world.gate.evaluate(world.agentId, await inboundOf(fresh))).toMatchObject({
      obey: true,
      via: "marker",
    });
  });

  it("GET sent returns the agent's sent log newest first with a limit, GET commands the audit", async () => {
    world = await emailWorld({ mode: "full_discretion" });
    const app = appOf(world);
    for (const subject of ["one", "two", "three"]) {
      await world.policy.send(
        { to: [STRANGER], subject, text: "body" },
        { agentId: world.agentId, humanId: world.human.id },
      );
      await world.clock.advance(1000);
    }
    const sent = await app.call("GET", "/agents/:agentId/email/sent", {
      params: { agentId: world.agentId },
      human: world.human.id,
      query: { limit: "2" },
    });
    expect(sent.status).toBe(200);
    const rows = sent.body.rows as Array<{ subject: string; text: string }>;
    expect(rows.map((r) => r.subject)).toEqual(["three", "two"]);
    expect(rows[0]?.text).toContain("body");
    // `since` is read as an ISO-8601 instant; anything else is the seven-day default, and the
    // body echoes the instant that was used (a mistyped query never lists every copy ever
    // written, nor nothing with the typo echoed back).
    const sinceOf = async (since: string) => {
      const res = await app.call("GET", "/agents/:agentId/email/sent", {
        params: { agentId: world?.agentId ?? "" },
        human: world?.human.id,
        query: { since },
      });
      return {
        status: res.status,
        since: res.body.since as string,
        subjects: (res.body.rows as Array<{ subject: string }>).map((r) => r.subject),
      };
    };
    const weekAgo = new Date(world.clock.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    expect(await sinceOf("tomorrow")).toEqual({
      status: 200,
      since: weekAgo,
      subjects: ["three", "two", "one"],
    });
    expect(await sinceOf("0")).toEqual({
      status: 200,
      since: weekAgo,
      subjects: ["three", "two", "one"],
    });
    const afterOne = new Date(world.clock.now() - 2 * 1000).toISOString();
    expect(await sinceOf(afterOne)).toEqual({
      status: 200,
      since: afterOne,
      subjects: ["three", "two"],
    });

    const spoof = await ownerSends(world, { subject: "cmd", text: "hello", marker: false });
    await world.handler.handle(world.agentId, await inboundOf(spoof));
    const commands = await app.call("GET", "/agents/:agentId/email/commands", {
      params: { agentId: world.agentId },
      human: world.human.id,
    });
    const audit = commands.body.rows as Array<{ obeyed: boolean; deniedReason: string | null }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ obeyed: false, deniedReason: "ignored: no_marker" });
  });

  it("with modeChangeCommand a PUT that changes the mode is refused (403, the command named, an audited refusal, nothing written); the same mode and the other fields pass", async () => {
    world = await emailWorld({ mode: "draft_only" });
    const app = createEmailRoutes(
      {
        settings: world.settings,
        sentLog: world.sentLog,
        clock: world.clock,
        audit: world.store.auditLog,
        humanFor: (c) => c.req.header?.("x-human"),
        identity: world.identity,
        modeChangeCommand: "email.mode.set",
      },
      new FakeApp(),
    );
    const call = (body: unknown) =>
      app.call("PUT", "/agents/:agentId/email/settings", {
        params: { agentId: world?.agentId ?? "" },
        human: world?.human.id,
        body,
      });
    // The mode is a high-risk change (spec Q, "Confirmation by risk"): the registry's card and
    // device confirmation are the one path; the raw route refuses to apply it.
    const refused = await call({ settings: { mode: "full_discretion", dailySendCap: 3 } });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatchObject({
      code: "tool_not_allowed",
      details: {
        reason: "mode_change_needs_command",
        command: "email.mode.set",
        modeBefore: "draft_only",
        modeRequested: "full_discretion",
      },
    });
    expect((refused.body.error as { message: string }).message).toContain("email.mode.set");
    const after = await world.settings.get(world.agentId);
    expect(after.settings.mode).toBe("draft_only");
    expect(after.settings.dailySendCap).toBe(20);
    const rows = await world.store.auditLog.list({
      agentId: world.agentId,
      tool: EMAIL_SETTINGS_TOOL,
    });
    expect(rows.map((r) => [r.allowed, r.denied_reason, JSON.parse(r.input_summary)])).toEqual([
      [
        false,
        "mode_change_needs_command",
        { action: "update", refused: "mode_change_needs_command" },
      ],
    ]);
    expect(JSON.parse(rows[0]?.result_summary ?? "")).toEqual({
      status: "refused",
      reason: "mode_change_needs_command",
    });
    // The stored mode in the body is no change: the other fields save as before.
    const same = await call({ settings: { mode: "draft_only", dailySendCap: 7 } });
    expect(same.status).toBe(200);
    expect((same.body.settings as { dailySendCap: number }).dailySendCap).toBe(7);
    // Without the option (a host without a registry) the table keeps serving the mode.
    const plain = appOf(world);
    const picked = await plain.call("PUT", "/agents/:agentId/email/settings", {
      params: { agentId: world.agentId },
      human: world.human.id,
      body: { settings: { mode: "allowlist" } },
    });
    expect(picked.status).toBe(200);
    expect((picked.body.settings as { mode: string }).mode).toBe("allowlist");
  });
});
