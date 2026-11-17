import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { credWorld, seedProject } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * d1109-selftasks-chat, run C (C5-left-7; review of d1109-selftasks-chat): the task check's
 * model is chosen as the intake's is: the planning mode's row, the principal's own planning
 * override (Settings > Models), under the project's highest model (`critic_ceiling`). Before,
 * compose took the planning row's tier alone, so an override or a project's ceiling never
 * reached the check. Composed with no injected provider (cred-world.ts, API key only): the
 * request the Messages API stand-in receives names the model, as Anthropic would see it.
 */
describe("d1109-selftasks-chat, run C: the task check runs on the planning model the person set (C5-left-7)", () => {
  const homes: string[] = [];
  afterAll(() => removeHomes(homes));

  /** "fix the tasks" in a project; the models of the calls it made. */
  async function checkModels(opts: { override?: string; ceiling?: string }) {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, subscription: false, prefix: "fr-check-model-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      if (opts.override) {
        const agent = await rt.store.agent.mustGet(rt.agent.id);
        await rt.store.agent.update(rt.agent.id, agent.version, {
          model_config: { modes: { planning: { tier: opts.override } } },
        });
      }
      const { project } = await seedProject(rt, "Quote page", ["Style the page", "Publish"]);
      if (opts.ceiling)
        await rt.store.project.update(project.id, project.version, {
          settings: { ...project.settings, critic_ceiling: opts.ceiling },
        });
      const before = world.keyCalls().length;
      const res = await req<{ reply: string }>("/chat", {
        humanId: rt.human.id,
        agentId: rt.agent.id,
        projectId: project.id,
        projectTab: true,
        text: "fix the tasks",
      });
      expect(res.status).toBe(200);
      const calls = world.keyCalls().slice(before);
      // "fix the tasks" makes no chat-model call first: every call of the turn is the check's.
      expect(calls.length).toBeGreaterThan(0);
      return [...new Set(calls.map((c) => c.model))];
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }

  it("with nothing set it is the planning row's model", async () => {
    expect(await checkModels({})).toEqual(["claude-sonnet-5-5"]);
  }, 60_000);

  it("the principal's planning override is the check's model", async () => {
    expect(await checkModels({ override: "opus" })).toEqual(["claude-opus-5-5"]);
  }, 60_000);

  it("the project's highest model caps the override, and lifts it only by its own setting", async () => {
    // The default ceiling is Opus: the top rung only by an explicit project setting.
    expect(await checkModels({ override: "fable" })).toEqual(["claude-opus-5-5"]);
    expect(await checkModels({ override: "fable", ceiling: "fable" })).toEqual([
      "claude-fable-5-1",
    ]);
  }, 60_000);

  it("a project whose highest model is below the planning row runs the check on that model", async () => {
    expect(await checkModels({ ceiling: "haiku" })).toEqual(["claude-haiku-5-5"]);
  }, 60_000);
});
