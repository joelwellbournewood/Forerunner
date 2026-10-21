/**
 * Critic reproduction (tier 2 review of the email security fixes): the routes' owner check is
 * skipped, not refused, when the mount identifies the human (`humanFor`) but passes no
 * `identity` port. routes.ts logs a warning and lets any signed-in human read and write any
 * agent's email settings, which is the cross-human attack the owner check exists to close.
 * Expected: 403 (`tool_not_allowed`), or a construction-time error, never 200.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createEmailRoutes,
  type EmailRouteApp,
  type EmailRouteContext,
  type EmailRouteHandler,
} from "../src/email/index.ts";
import { addAgentForHuman, emailWorld, type World } from "./helpers/email-world.ts";

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
  ): Promise<{ status: number }> {
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
    return { status: res.status };
  }
}

let world: World;
afterEach(async () => {
  await world?.stop();
});

describe("email routes: the owner check without an identity port", () => {
  // security finding (medium): `emailRouteTable` applies `assertOwner` only when both
  // `humanFor` and `identity` are set; with `humanFor` alone it warns and proceeds, so a daemon
  // that identifies humans but forgets the identity port reopens the cross-human settings
  // write. Fix: refuse the request (403) or fail at construction when `humanFor` is set
  // without `identity`.
  it.fails("security finding: a signed-in human is refused on another human's agent even when the mount passes no identity port", async () => {
    world = await emailWorld();
    const other = await addAgentForHuman(world, {
      humanName: "K",
      humanEmail: "k@example.test",
      agentName: "Bob",
      password: ["other", "pass", "4"].join("-"), // not-a-secret
    });
    const app = createEmailRoutes(
      {
        settings: world.settings,
        sentLog: world.sentLog,
        clock: world.clock,
        audit: world.store.auditLog,
        humanFor: (c) => c.req.header?.("x-human"),
      },
      new FakeApp(),
    );
    const res = await app.call("PUT", "/agents/:agentId/email/settings", {
      params: { agentId: other.agentId },
      human: world.human.id,
      body: { commands: { enabled: true, registeredHumanAddress: "owner@example.test" } },
    });
    expect(res.status).toBe(403);
    const after = await world.settings.get(other.agentId);
    expect(after.commands.registeredHumanAddress).toBe("k@example.test");
  });
});
