import { describe, expect, it } from "vitest";
import { type ExecuteResult, MODEL_SETTING_LABELS } from "../src/index.ts";
import { world } from "./helpers.ts";

/** model.settings.set (spec D.4, ADR 0072): one field of the agent's model_config per change. */

function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}
function refused(r: ExecuteResult): Extract<ExecuteResult, { status: "refused" }> {
  if (r.status !== "refused") throw new Error(`expected refused, got ${r.status}`);
  return r;
}
const tap = (humanId: string) => ({
  kind: "tap" as const,
  by: { kind: "human" as const, id: humanId },
});

const withPorts = (acceptsTemperature: boolean) => ({
  specialists: () => ["coder", "researcher"],
  capabilities: () => ({ acceptsTemperature, fastMode: false }),
});

describe("model.settings.set", () => {
  it("sets and clears one field of a specialist override, with a sentence and an undo", async () => {
    const w = await world();
    w.ports.modelSettings = withPorts(false);
    const set = done(
      await w.executor.execute({
        name: "model.settings.set",
        params: { specialist: "coder", field: "max_tokens", value: 8000 },
        ctx: w.ctx({ source: "ui" }),
      }),
    );
    expect(set.sentence).toBe(
      "Set the max tokens per call of the coder specialist for Alice from the default to 8000. Undo.",
    );
    const timeout = done(
      await w.executor.execute({
        name: "model.settings.set",
        params: { specialist: "coder", field: "timeout_minutes", value: 30 },
        ctx: w.ctx(),
      }),
    );
    expect((await w.store.agent.mustGet(w.agent.id)).model_config).toEqual({
      specialists: { coder: { max_tokens: 8000, timeout_minutes: 30 } },
    });
    done(await w.executor.undo(timeout.changeLogId, w.ctx()));
    expect((await w.store.agent.mustGet(w.agent.id)).model_config).toEqual({
      specialists: { coder: { max_tokens: 8000 } },
    });
    // null goes back to the default: the key is removed, and an emptied group with it.
    const reset = done(
      await w.executor.execute({
        name: "model.settings.set",
        params: { specialist: "coder", field: "max_tokens", value: null },
        ctx: w.ctx(),
      }),
    );
    expect(reset.sentence).toBe(
      "Set the max tokens per call of the coder specialist for Alice from 8000 to the default. Undo.",
    );
    expect((await w.store.agent.mustGet(w.agent.id)).model_config).toEqual({});
    await w.store.close();
  });

  it("changes the agent's own planning and chat modes; a costlier rung or fast mode needs a yes", async () => {
    const w = await world();
    w.ports.modelSettings = withPorts(false);
    const plan = await w.executor.plan(
      { name: "model.settings.set", params: { mode: "planning", field: "tier", value: "opus" } },
      w.ctx(),
    );
    expect(plan.impact.risk).toBe("medium");
    expect(plan.what).toBe("the model of Alice's planning");
    expect(
      (
        await w.executor.plan(
          {
            name: "model.settings.set",
            params: { specialist: "coder", field: "speed_mode", value: "fast" },
          },
          w.ctx(),
        )
      ).impact.risk,
    ).toBe("medium");
    expect(
      (
        await w.executor.plan(
          {
            name: "model.settings.set",
            params: { mode: "text_chat", field: "max_tokens", value: 600 },
          },
          w.ctx(),
        )
      ).impact.risk,
    ).toBe("low");
    done(
      await w.executor.execute({
        name: "model.settings.set",
        params: { mode: "planning", field: "tier", value: "opus" },
        ctx: w.ctx(),
        confirmation: tap(w.human.id),
      }),
    );
    expect((await w.store.agent.mustGet(w.agent.id)).model_config).toEqual({
      modes: { planning: { tier: "opus" } },
    });
    await w.store.close();
  });

  it("refuses bad values, unknown specialists, both or neither targets, and other people's agents", async () => {
    const w = await world();
    w.ports.modelSettings = withPorts(false);
    const run = (params: Record<string, unknown>) =>
      w.executor.execute({ name: "model.settings.set", params, ctx: w.ctx() });
    expect(refused(await run({ specialist: "coder", field: "max_tokens", value: 0 })).code).toBe(
      "validation",
    );
    expect(
      refused(await run({ specialist: "coder", field: "speed_mode", value: "warp" })).reason,
    ).toMatch(/"standard" or "fast"/);
    expect(refused(await run({ specialist: "ghost", field: "max_tokens", value: 10 })).code).toBe(
      "not_found",
    );
    expect(refused(await run({ field: "max_tokens", value: 10 })).code).toBe("validation");
    expect(
      refused(await run({ mode: "planning", specialist: "coder", field: "max_tokens", value: 10 }))
        .code,
    ).toBe("validation");
    const theirs = await w.store.agent.insert({
      name: "Bob",
      owner_human_id: w.other.id,
      kind: "principal",
      memory_location: "",
    });
    expect(
      refused(await run({ agent: theirs.id, mode: "planning", field: "max_tokens", value: 10 }))
        .code,
    ).toBe("not_found");
    const critic = await w.store.agent.insert({
      name: "Critic",
      owner_human_id: w.human.id,
      kind: "critic",
      memory_location: "",
    });
    expect(
      refused(await run({ agent: critic.id, mode: "planning", field: "max_tokens", value: 10 }))
        .reason,
    ).toMatch(/critic/);
    expect((await w.store.agent.mustGet(w.agent.id)).model_config).toEqual({});
    await w.store.close();
  });

  it("stores a temperature only where the provider in use accepts one", async () => {
    const w = await world();
    const run = () =>
      w.executor.execute({
        name: "model.settings.set",
        params: { specialist: "coder", field: "temperature", value: 0.3 },
        ctx: w.ctx(),
      });
    // No port: nothing is known to accept a temperature.
    expect(refused(await run()).reason).toMatch(/does not accept a temperature/);
    w.ports.modelSettings = withPorts(false);
    expect(refused(await run()).reason).toMatch(/does not accept a temperature/);
    w.ports.modelSettings = withPorts(true);
    done(await run());
    expect((await w.store.agent.mustGet(w.agent.id)).model_config).toEqual({
      specialists: { coder: { temperature: 0.3 } },
    });
    expect(MODEL_SETTING_LABELS.temperature).toBe("the temperature");
    await w.store.close();
  });
});
