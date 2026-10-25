import { MemoryGitHost } from "@forerunner/capabilities";
import { isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { startCloudRunner } from "../src/runner.ts";
import { seedWorld, tempHome, testConfig } from "./helpers.ts";

/**
 * The runner's identity on a shared store (ADR 0082, the daemon's rule): a store holding two
 * humans refuses a runner that names none, and a runner naming one by email serves that human
 * and their own principal agent, the composed runtime bound to the same rows.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

describe("runner identity on a shared store", () => {
  it("refuses two humans without a selector; serves the human named by email", async () => {
    const home = tempHome("fr-runner-identity-");
    const clock = new SimulatedClock("2026-10-23T08:00:00Z");
    const stateUrl = `sqlite:${join(home, "shared.sqlite")}`;
    const store = await openStore({ url: stateUrl, clock });
    const seed = await seedWorld(store);
    const m = await store.human.insert({
      name: "M",
      email: "m@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 0,
      locale: "en",
    });
    const bob = await store.agent.insert({
      name: "Bob",
      owner_human_id: m.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    for (const human of [seed.human, m]) {
      await store.billingSource.insert({
        human_id: human.id,
        kind: "api_key",
        label: "Console key",
        credential_ref: "anthropic_api_key",
        limits: {},
        enabled: true,
        priority: 2,
      });
    }
    const vault = new MemoryVault();
    await vault.set("anthropic_api_key", ["api", "key", "value"].join("-")); // not-a-secret
    const provider = new FakeProvider({ clock, latency: "none", replies: [], onNoMatch: "echo" });
    const deps = (over: NodeJS.ProcessEnv) => {
      const { env, config } = testConfig(home, stateUrl, over);
      return {
        config,
        env,
        clock,
        vault,
        provider,
        gitHost: new MemoryGitHost("alice"),
        registryDir: REGISTRY,
        sandboxDetection: { engine: "none" as const, reason: "test", checkedAt: clock.nowIso() },
      };
    };
    try {
      await expect(startCloudRunner(deps({}))).rejects.toSatisfy(
        (e: unknown) => isForerunnerError(e) && e.code === "identity_ambiguous",
      );
      expect(await store.human.count()).toBe(2);
      expect(await store.agent.count()).toBe(2);

      await expect(
        startCloudRunner(deps({ FORERUNNER_RUNNER_HUMAN: "nobody@example.test" })),
      ).rejects.toSatisfy((e: unknown) => isForerunnerError(e) && e.code === "not_found");

      const runner = await startCloudRunner(deps({ FORERUNNER_RUNNER_HUMAN: "M@Example.test" }));
      try {
        expect(runner.human.id).toBe(m.id);
        expect(runner.agent.id).toBe(bob.id);
        expect(runner.rt.human.id).toBe(m.id);
        expect(runner.rt.agent.id).toBe(bob.id);
        expect(runner.rt.identity).toEqual({ humanId: m.id, source: "option", selector: m.id });
        expect((await runner.status()).human).toEqual({ id: m.id, name: "M" });
      } finally {
        await runner.stop();
      }
      // Nothing was created on the way: J's rows and M's are what they were.
      expect(await store.human.count()).toBe(2);
      expect((await store.agent.principals(m.id)).map((a) => a.id)).toEqual([bob.id]);
    } finally {
      await store.close();
    }
  });

  it("the composed runtime is the runner's agent, not the human's first principal", async () => {
    // Review finding 2: J has two principals and the runner serves the second
    // (FORERUNNER_RUNNER_AGENT); the runtime it composes must run as that same agent, or its
    // memory loop, context layer, tokens and approval syncs belong to the first one.
    const home = tempHome("fr-runner-agent-");
    const clock = new SimulatedClock("2026-10-23T08:00:00Z");
    const stateUrl = `sqlite:${join(home, "shared.sqlite")}`;
    const store = await openStore({ url: stateUrl, clock });
    const seed = await seedWorld(store);
    const second = await store.agent.insert({
      name: "Alice2",
      owner_human_id: seed.human.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    await store.billingSource.insert({
      human_id: seed.human.id,
      kind: "api_key",
      label: "Console key",
      credential_ref: "anthropic_api_key",
      limits: {},
      enabled: true,
      priority: 2,
    });
    const vault = new MemoryVault();
    await vault.set("anthropic_api_key", ["api", "key", "value"].join("-")); // not-a-secret
    const provider = new FakeProvider({ clock, latency: "none", replies: [], onNoMatch: "echo" });
    const { env, config } = testConfig(home, stateUrl, {
      FORERUNNER_RUNNER_HUMAN: seed.human.id,
      FORERUNNER_RUNNER_AGENT: second.id,
    });
    try {
      const runner = await startCloudRunner({
        config,
        env,
        clock,
        vault,
        provider,
        gitHost: new MemoryGitHost("alice"),
        registryDir: REGISTRY,
        sandboxDetection: { engine: "none" as const, reason: "test", checkedAt: clock.nowIso() },
      });
      try {
        expect(runner.agent.id).toBe(second.id);
        expect(runner.rt.agent.id).toBe(second.id);
        expect(runner.rt.human.id).toBe(seed.human.id);
      } finally {
        await runner.stop();
      }
      expect((await store.agent.principals(seed.human.id)).map((a) => a.id).sort()).toEqual(
        [seed.agent.id, second.id].sort(),
      );
    } finally {
      await store.close();
    }
  });
});
