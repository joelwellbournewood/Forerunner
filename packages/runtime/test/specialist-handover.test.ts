import { fileURLToPath } from "node:url";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { specialistSpecFrom } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { alternateSpecialist, type SpecialistProfile } from "../src/registry/alternates.ts";
import { loadRegistry } from "../src/registry/loader.ts";
import type { SpecialistDriver } from "../src/registry/tools.ts";
import { LoopTaskExecutor, type SpecialistSpec } from "../src/session/executor.ts";
import { flatPricing, harness, issue, registry, ScriptedProvider } from "./helpers.ts";

/**
 * U-044: retries that could change nothing. (1) The retry ladder's second rung says "split or
 * change specialist", and the executor ran the same specialist again with a line in the brief.
 * (2) The researcher and the science-evaluator name WebFetch and WebSearch, which the loop
 * driver (every run billed to an API key) drops, and they were still given research tasks:
 * each run could only fail and be retried. Now the second rung hands the task to a specialist
 * that can do what the first one does, and web work goes to a specialist that reaches the web
 * on the run's driver; with none, the task waits for the person and nothing is spent.
 */
const REGISTRY = fileURLToPath(new URL("../../../evals/registry", import.meta.url));
const shipped = loadRegistry(REGISTRY);
/** The registry's specialists as a loop-driver composition maps them over the test tools. */
const loopSpecs = specialistSpecFrom(shipped, {
  driver: "loop",
  tools: () => registry().names(),
});

function profile(name: string, driver: SpecialistDriver = "loop"): SpecialistProfile {
  const s = loopSpecs(name, driver);
  if (!s) throw new Error(`no specialist ${name}`);
  return {
    name: s.name,
    description: s.description ?? "",
    registryTools: s.registryTools ?? s.allowedTools,
    driverTools: s.allowedTools,
  };
}

const allProfiles = (driver: SpecialistDriver) =>
  shipped.runnableSpecialists().map((d) => profile(d.name, driver));

const stores: StateStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function world(opts: {
  specialists: (n: string, d?: SpecialistDriver) => SpecialistSpec | undefined;
  names: () => string[];
  attempt: number;
  specialist: string;
  /** Specialists that already ran the task (one Run row each). */
  ranBy?: string[];
}) {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  stores.push(store);
  const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const project = (await store.project.insert({ name: "P" })).id;
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    status: "running",
    runner: "pc",
  });
  const task = await store.task.insert({
    project_id: project,
    title: "Compare the three hosting offers",
    outcome: "A table of prices and limits",
    status: "in_progress",
    attempt: opts.attempt,
    specialist: opts.specialist,
    budget_usd_micro: 2_000_000,
  });
  for (const s of opts.ranBy ?? [])
    await store.run.insert({
      task_id: task.id,
      session_id: session.id,
      specialist: s,
      model: "fake-sonnet",
      provider: "fake",
      outcome: "completed",
      author_agent: agent,
    } as never);
  const prior = new Set((await store.run.forTask(task.id)).map((r) => r.id));
  const provider = new ScriptedProvider([{ text: "Done." }], h.clock);
  const events: string[] = [];
  const exec = new LoopTaskExecutor({
    store,
    clock: h.clock,
    tokens: h.tokens,
    driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
    provider,
    pricing: flatPricing,
    tools: registry(),
    billingSourceId: "bs",
    specialists: opts.specialists,
    specialistNames: opts.names,
    onEvent: (_t, ev) => {
      if (ev.type === "warning") events.push(ev.message);
    },
  });
  const result = await exec.execute({
    task,
    session,
    token: issue(h, {
      agentId: agent,
      ownerHumanId: human,
      projectId: project,
      sessionId: session.id,
      allowedTools: registry().names(),
      budgetUsdMicro: 5_000_000,
    }),
    budget: new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: h.clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    item: { taskId: task.id, title: task.title, specialist: opts.specialist, estimateUsdMicro: 1 },
    signal: new AbortController().signal,
  });
  // The runs this execution wrote, not the ones the world seeded.
  const runs = (await store.run.forTask(task.id)).filter((r) => !prior.has(r.id));
  return { result, provider, events, store, task, runs };
}

const names = () => shipped.runnableSpecialists().map((d) => d.name);

describe("the stand-in for a specialist (U-044)", () => {
  it("picks one that can do what the other does, closest in kind, from the shipped registry", () => {
    const loop = allProfiles("loop");
    const sdk = allProfiles("sdk");
    const pick = (from: string, d: SpecialistDriver) =>
      alternateSpecialist(profile(from, d), d === "loop" ? loop : sdk)?.name ?? null;
    for (const d of ["loop", "sdk"] as const) {
      expect(pick("coder", d)).toBe("migration-specialist");
      expect(pick("migration-specialist", d)).toBe("coder");
      expect(pick("tester", d)).toBe("coder");
      expect(pick("designer", d)).toBe("writer-marketing");
      expect(pick("writer-marketing", d)).toBe("designer");
      expect(pick("data-analyst", d)).toBe("science-evaluator");
      // Nobody else names the web tools the researcher works with.
      expect(pick("researcher", d)).toBeNull();
    }
    // The ones that already ran the task are left out.
    expect(
      alternateSpecialist(profile("coder"), loop, { exclude: new Set(["migration-specialist"]) }),
    ).toBeNull();
  });
});

describe("the retry ladder's second rung changes the specialist (U-044)", () => {
  it("after two failed attempts by the coder, the next run is the migration-specialist's", async () => {
    const w = await world({
      specialists: loopSpecs,
      names,
      attempt: 2,
      specialist: "coder",
      ranBy: ["coder", "coder"],
    });
    expect(w.result.outcome).toBe("done");
    expect(w.runs.map((r) => r.specialist)).toEqual(["migration-specialist"]);
    // The task now names its new specialist, so a later rung keeps it.
    expect((await w.store.task.mustGet(w.task.id)).specialist).toBe("migration-specialist");
    expect(w.events.join("\n")).toContain(
      "after 2 failed attempts by the coder, the retry ladder hands this task to the migration-specialist",
    );
    // The brief tells the new specialist where it stands.
    expect(w.provider.calls[0]?.messages[0]?.content as string).toContain(
      "two attempts by another specialist failed and the task was handed to you",
    );
  });

  it("with no stand-in the task waits for the person, and nothing runs", async () => {
    const coder = loopSpecs("coder") as SpecialistSpec;
    const w = await world({
      specialists: (n) => (n === "coder" ? coder : undefined),
      names: () => ["coder"],
      attempt: 2,
      specialist: "coder",
      ranBy: ["coder", "coder"],
    });
    expect(w.provider.calls).toHaveLength(0);
    expect(w.result).toEqual({
      outcome: "needs_human",
      summary:
        "2 attempts by the coder failed, and the retry ladder now hands the task to another specialist, but none can do what the coder does, so nothing ran. Split the task into smaller tasks (New task on the Tasks tab) and cancel this one, or cancel it.",
      costUsdMicro: 0,
    });
  });

  it("a specialist the person gave the task to after the failures keeps it", async () => {
    const w = await world({
      specialists: loopSpecs,
      names,
      attempt: 2,
      specialist: "tester",
      ranBy: ["coder", "coder"],
    });
    expect(w.result.outcome).toBe("done");
    expect((await w.store.task.mustGet(w.task.id)).specialist).toBe("tester");
  });
});

describe("web work goes where the web is (U-044)", () => {
  it("a researcher's task on the loop driver (an API key) waits for the person; nothing runs", async () => {
    const w = await world({
      specialists: loopSpecs,
      names,
      attempt: 0,
      specialist: "researcher",
    });
    expect(w.provider.calls).toHaveLength(0);
    expect(w.result.outcome).toBe("needs_human");
    expect(w.result.summary).toBe(
      "The researcher works from the web (cc:WebFetch, cc:WebSearch), but runs billed to an API key get no web tools, and no other specialist has them there, so nothing ran. Add a Claude subscription in the setup assistant (its runs have web tools) and set the task back to ready, or cancel it.",
    );
    expect(w.runs).toEqual([]);
  });

  it("a specialist that reaches the web on this driver takes the researcher's task", async () => {
    const reader: SpecialistSpec = {
      name: "web-reader",
      description: "Answers a question from web pages it opens, citing every page.",
      prompt: "You read the web.",
      promptVersion: "web-reader@1.0.0+abc12345",
      defaultTier: "sonnet",
      defaultEffort: "medium",
      registryTools: ["cc:Read", "cc:Grep", "cc:Glob", "cc:Write", "browser_navigate"],
      allowedTools: ["read_file", "write_file", "browser_navigate"],
      allowedDomains: [],
      maxBudgetUsdMicro: 1_000_000,
      maxTurns: 10,
      timeoutMs: 60_000,
    };
    const w = await world({
      specialists: (n, d) => (n === "web-reader" ? reader : loopSpecs(n, d)),
      names: () => [...names(), "web-reader"],
      attempt: 0,
      specialist: "researcher",
    });
    expect(w.result.outcome).toBe("done");
    expect(w.runs.map((r) => r.specialist)).toEqual(["web-reader"]);
    expect(w.events.join("\n")).toContain(
      "the researcher gets no web tools on this run (cc:WebFetch, cc:WebSearch); the web-reader, which has them, takes the task",
    );
  });

  it("on the Agent SDK driver the researcher keeps its web tools and runs", () => {
    const sdk = loopSpecs("researcher", "sdk");
    expect(sdk?.allowedTools).toEqual(expect.arrayContaining(["cc:WebFetch", "cc:WebSearch"]));
  });
});
