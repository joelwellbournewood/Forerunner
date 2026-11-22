import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { credWorld, seedProject, setPolicy } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-10 (live check 4, L4-creds-16): config.json's `anthropicApiBase` (a
 * gateway or a proxy) reached chat's Claude Code calls but not the subscription's task runs: the
 * proxy logged no request during a task run, and the run's 401 had the real API's wording.
 * Composed as `fr daemon` composes it, with the scripted Claude Code keeping each call's options.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const envOf = (o: Record<string, unknown>) => (o.env ?? {}) as Record<string, string | undefined>;

async function runOnce(apiBase: string | undefined) {
  const clock = new SimulatedClock("2026-11-17T09:00:00Z");
  const world = credWorld({
    clock,
    key: false,
    prefix: "fr-api-base-",
    ...(apiBase ? { apiBase } : {}),
  });
  homes.push(world.home);
  const { rt, req } = await world.compose();
  try {
    await setPolicy(rt, "subscription_then_wait");
    const { project } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
    // Chat on the subscription (Claude Code as the provider).
    await req("/chat", {
      humanId: rt.human.id,
      agentId: rt.agent.id,
      projectId: project.id,
      projectTab: true,
      text: "What is next on this project?",
      source: "text",
    });
    // A task run on the subscription, started as the Start dialog sends it.
    const started = await req("/sessions", {
      agentId: rt.agent.id,
      projectId: project.id,
      trigger: "manual",
    });
    expect(started.status).toBe(202);
    await settleSessions(rt);
    const calls = world.sdkCalls.map((c, i) => ({ c, o: world.sdkOptions[i] ?? {} }));
    const chat = calls.find((x) => x.c.provider && !x.c.review);
    const run = calls.find((x) => !x.c.provider);
    expect(chat, "a chat call on Claude Code").toBeTruthy();
    expect(run, "a task run on Claude Code").toBeTruthy();
    return { chat: envOf(chat?.o ?? {}), run: envOf(run?.o ?? {}) };
  } finally {
    await settleSessions(rt);
    await rt.close();
  }
}

describe("l4-cred-engine, run L4: the configured API address reaches the subscription's task runs", () => {
  it("anthropicApiBase http://gw.test: the task run's Claude Code has ANTHROPIC_BASE_URL as chat's does", async () => {
    const { chat, run } = await runOnce("http://gw.test");
    expect(chat.ANTHROPIC_BASE_URL).toBe("http://gw.test");
    expect(run.ANTHROPIC_BASE_URL).toBe("http://gw.test");
  }, 60_000);

  it("the default address: no ANTHROPIC_BASE_URL on either", async () => {
    const { chat, run } = await runOnce("https://api.anthropic.com");
    expect(chat.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(run.ANTHROPIC_BASE_URL).toBeUndefined();
  }, 60_000);
});
