/**
 * Critic reproduction (tier 2 review of the email security fixes): the routes' owner check was
 * skipped, not refused, when the mount identified the human (`humanFor`) but passed no
 * `identity` port. routes.ts logged a warning and let any signed-in human read and write any
 * agent's email settings, which is the cross-human attack the owner check exists to close.
 * Fixed: such a mount refuses (403, `tool_not_allowed`, `reason: identity_port_missing`) every
 * request under `/agents/:agentId`, and every owner-check refusal is an `email.settings` audit
 * row with `allowed = false`, like the policy's blocked sends; the refusal stands when that
 * row cannot be written.
 */
import type { AuditLogRepo } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmailRoutes,
  EMAIL_SETTINGS_TOOL,
  type EmailRouteApp,
  type EmailRouteContext,
  type EmailRouteDeps,
  type EmailRouteHandler,
} from "../src/email/index.ts";
import { addAgentForHuman, captureLogs, emailWorld, type World } from "./helpers/email-world.ts";

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
    opts: { params?: Record<string, string>; body?: unknown; human?: string } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const handler = this.routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`no route ${method} ${path}`);
    const c: EmailRouteContext = {
      req: {
        param: (name) => opts.params?.[name],
        query: () => undefined,
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

const SEVEN_ROUTES: [method: string, path: string][] = [
  ["GET", "/agents/:agentId/email/settings"],
  ["PUT", "/agents/:agentId/email/settings"],
  ["GET", "/agents/:agentId/email/sent"],
  ["POST", "/agents/:agentId/email/pause"],
  ["POST", "/agents/:agentId/email/resume"],
  ["POST", "/agents/:agentId/email/rotate-marker"],
  ["GET", "/agents/:agentId/email/commands"],
];

let world: World;
afterEach(async () => {
  await world?.stop();
});

async function otherHumansAgent(w: World) {
  return addAgentForHuman(w, {
    humanName: "K",
    humanEmail: "k@example.test",
    agentName: "Bob",
    password: ["other", "pass", "4"].join("-"), // not-a-secret
  });
}

function mount(w: World, extra: Partial<EmailRouteDeps> = {}) {
  return createEmailRoutes(
    {
      settings: w.settings,
      sentLog: w.sentLog,
      clock: w.clock,
      audit: w.store.auditLog,
      humanFor: (c) => c.req.header?.("x-human"),
      ...extra,
    },
    new FakeApp(),
  );
}

async function refusals(w: World, agentId: string) {
  const rows = await w.store.auditLog.list({ agentId, tool: EMAIL_SETTINGS_TOOL });
  return rows.filter((r) => !r.allowed);
}

describe("email routes: the owner check without an identity port", () => {
  // security finding (medium, fixed): `emailRouteTable` applied `assertOwner` only when both
  // `humanFor` and `identity` were set; with `humanFor` alone it warned and proceeded, so a
  // daemon that identifies humans but forgets the identity port reopened the cross-human
  // settings write. The mount now refuses the request (403) and audits the refusal.
  it("security finding: a signed-in human is refused on another human's agent even when the mount passes no identity port", async () => {
    world = await emailWorld();
    const other = await otherHumansAgent(world);
    const { result: app, lines } = await captureLogs(async () => mount(world));
    expect(lines.some((l) => l.startsWith("error") && l.includes("identity port"))).toBe(true);
    const res = await app.call("PUT", "/agents/:agentId/email/settings", {
      params: { agentId: other.agentId },
      human: world.human.id,
      body: { commands: { enabled: true, registeredHumanAddress: "owner@example.test" } },
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: "tool_not_allowed",
      details: { agentId: other.agentId, reason: "identity_port_missing" },
    });
    const after = await world.settings.get(other.agentId);
    expect(after.commands.registeredHumanAddress).toBe("k@example.test");
    expect(after.commands.enabled).toBe(true);
    // The owner of the agent can see the attempt: one refused `email.settings` row, naming the
    // signed-in human and the action, never an allowed row.
    const rows = await world.store.auditLog.list({
      agentId: other.agentId,
      tool: EMAIL_SETTINGS_TOOL,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      allowed: false,
      denied_reason: "identity_port_missing",
      human_id: world.human.id,
      author_human: world.human.id,
      cost_usd_micro: 0,
    });
    expect(JSON.parse(rows[0]?.input_summary ?? "{}")).toEqual({
      action: "update",
      refused: "identity_port_missing",
    });
    // The result is JSON like every other email row's (`{ status: "blocked", reason }` of a
    // blocked send), so a reader that parses `result_summary` never throws on a refusal.
    expect(JSON.parse(rows[0]?.result_summary ?? "")).toEqual({
      status: "refused",
      reason: "identity_port_missing",
    });
  });

  it("every route under /agents/:agentId is refused on such a mount, the human's own agent included; nothing changes", async () => {
    world = await emailWorld();
    const app = mount(world);
    const before = await world.settings.get(world.agentId);
    for (const [method, path] of SEVEN_ROUTES) {
      const res = await app.call(method, path, {
        params: { agentId: world.agentId },
        human: world.human.id,
        body: { settings: { paused: true } },
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((res.body.error as { code: string }).code).toBe("tool_not_allowed");
    }
    // Nobody signed in on an identifying mount is refused too, not let through.
    const anonymous = await app.call("POST", "/agents/:agentId/email/pause", {
      params: { agentId: world.agentId },
    });
    expect(anonymous.status).toBe(403);
    expect(await world.settings.get(world.agentId)).toEqual(before);
    expect(await refusals(world, world.agentId)).toHaveLength(SEVEN_ROUTES.length + 1);
    // A request that never names an agent is a validation error, not an owner refusal.
    const noAgent = await app.call("GET", "/agents/:agentId/email/settings", {
      human: world.human.id,
    });
    expect(noAgent.status).toBe(400);
  });

  it("with the identity port the owner is served, the other human is refused and the refusal is audited", async () => {
    world = await emailWorld();
    const other = await otherHumansAgent(world);
    const { result: app, lines } = await captureLogs(async () =>
      mount(world, { identity: world.identity }),
    );
    expect(lines.some((l) => l.includes("identity port"))).toBe(false);
    const own = await app.call("POST", "/agents/:agentId/email/pause", {
      params: { agentId: world.agentId },
      human: world.human.id,
    });
    expect(own.status).toBe(200);
    for (const [method, path] of SEVEN_ROUTES) {
      const res = await app.call(method, path, {
        params: { agentId: other.agentId },
        human: world.human.id,
        body: { settings: { paused: true } },
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error).toMatchObject({
        code: "tool_not_allowed",
        details: { agentId: other.agentId, reason: "not_owner" },
      });
    }
    const unknownAgent = await app.call("GET", "/agents/:agentId/email/settings", {
      params: { agentId: "no-such-agent" },
      human: world.human.id,
    });
    expect(unknownAgent.status).toBe(403);
    expect((await world.settings.get(other.agentId)).settings.paused).toBe(false);
    const refused = await refusals(world, other.agentId);
    expect(refused).toHaveLength(SEVEN_ROUTES.length);
    expect(refused.map((r) => r.denied_reason)).toEqual(SEVEN_ROUTES.map(() => "not_owner"));
    expect(refused.map((r) => JSON.parse(r.input_summary).action)).toEqual([
      "read_settings",
      "update",
      "read_sent",
      "pause",
      "resume",
      "rotate_marker",
      "read_commands",
    ]);
    for (const r of refused) {
      expect(r.human_id).toBe(world.human.id);
      expect(JSON.parse(r.result_summary)).toEqual({ status: "refused", reason: "not_owner" });
    }
    // The owner's own successful change is the only allowed row on their agent.
    const ownRows = await world.store.auditLog.list({
      agentId: world.agentId,
      tool: EMAIL_SETTINGS_TOOL,
    });
    expect(ownRows.map((r) => r.allowed)).toEqual([true]);
  });

  it("a mount that identifies nobody (no humanFor) applies no owner check and refuses nothing", async () => {
    world = await emailWorld();
    const other = await otherHumansAgent(world);
    const app = mount(world, { humanFor: undefined });
    const res = await app.call("POST", "/agents/:agentId/email/pause", {
      params: { agentId: other.agentId },
    });
    expect(res.status).toBe(200);
    expect(await refusals(world, other.agentId)).toHaveLength(0);
  });

  // The audit row is written before the 403 is thrown; an audit store that fails must not turn
  // the refusal into a 500 `internal` with the store's message as the UI's error text. The
  // request stays refused with its own code and reason, and the missing row is a warn line.
  it("a refusal stays a 403 tool_not_allowed when the audit store cannot record it; the gap is logged", async () => {
    world = await emailWorld();
    const other = await otherHumansAgent(world);
    // The real repo with `append` failing: `list` still reads what is there (nothing).
    const failing: AuditLogRepo = Object.create(world.store.auditLog, {
      append: {
        value: async () => {
          throw new Error("audit store unavailable");
        },
      },
    });
    const cases: [identity: EmailRouteDeps["identity"], reason: string][] = [
      [world.identity, "not_owner"],
      [undefined, "identity_port_missing"],
    ];
    for (const [identity, reason] of cases) {
      const app = mount(world, { audit: failing, identity });
      const { result: res, lines } = await captureLogs(() =>
        app.call("PUT", "/agents/:agentId/email/settings", {
          params: { agentId: other.agentId },
          human: world.human.id,
          body: { commands: { registeredHumanAddress: "owner@example.test" } },
        }),
      );
      expect(res.status, reason).toBe(403);
      expect(res.body.error).toMatchObject({
        code: "tool_not_allowed",
        details: { agentId: other.agentId, reason },
      });
      expect(
        lines.some((l) => l.startsWith("warn") && l.includes("not audited") && l.includes(reason)),
        reason,
      ).toBe(true);
    }
    expect((await world.settings.get(other.agentId)).commands.registeredHumanAddress).toBe(
      "k@example.test",
    );
    expect(await refusals(world, other.agentId)).toHaveLength(0);
  });
});
