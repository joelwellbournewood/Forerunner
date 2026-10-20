import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { SessionRunner, StaticPlanner, type TaskExecutor } from "../src/session/runner.ts";

/**
 * Requirements close-out for claims (spec "Data model", U.18): the holder renews the claim
 * every few minutes while working; if renewals stop, the claim expires after 30 minutes by
 * default. The session runner is the holder: its default TTL, its renewal cadence and the
 * lapse are asserted on an in-memory SQLite store under the simulated clock. The TTL and the
 * cadence below are the spec's numbers, written out rather than read from the code.
 */

const MINUTE = 60_000;
const DEFAULT_CLAIM_TTL_MS = 30 * MINUTE;
const RENEW_EVERY_MS = 5 * MINUTE;
const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  bob: string;
  project: string;
}

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-03-02T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      default_autonomy: 2,
    })
  ).id;
  const alice = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  const bob = (await store.agent.insert({ name: "Bob", owner_human_id: human })).id;
  const project = (
    await store.project.insert({
      name: "Sample",
      goal: "Ship a sample service",
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
    })
  ).id;
  await store.project.patch(project, { settings: { members: [alice, bob] } as never });
  return { store, clock, human, alice, bob, project };
}

/** Let the renewal's store write land; the simulated clock does not move. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

const iso = (ms: number) => new Date(ms).toISOString();

describe("close-out U.18: the holder renews its claim; a claim whose renewals stop expires", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("a session's claim lasts 30 minutes by default, is renewed every 5 minutes while the task runs, and lapses once renewals stop", async () => {
    const task = await w.store.task.insert({
      project_id: w.project,
      title: "long task",
      outcome: "long task done",
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 400_000,
      reason: "seed",
      author_agent: w.bob,
    });
    let begun: () => void = () => undefined;
    let release: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      begun = resolve;
    });
    const executor: TaskExecutor = {
      async execute({ task: t }) {
        begun();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          outcome: "done",
          summary: `${t.title}: done`,
          costUsdMicro: 0,
          checksPassed: true,
        };
      },
    };
    // The holder's renewals, and a switch that makes them fail (the holder's machine is gone).
    let offline = false;
    const renewals: string[] = [];
    const original = w.store.task.renewClaim.bind(w.store.task);
    w.store.task.renewClaim = async (...args: Parameters<typeof original>) => {
      if (offline) throw new Error("holder offline");
      renewals.push(w.clock.nowIso());
      return original(...args);
    };
    const runner = new SessionRunner({
      store: w.store,
      clock: w.clock,
      tokens: new TokenIssuer({ now: () => w.clock.now() }),
      kill: new KillSwitch(),
      planner: new StaticPlanner(),
      executor,
    });
    const run = runner.start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 2_000_000,
      grant,
      // no claimTtlMs: the default applies
    });
    await started;

    // The default TTL: the claim is set in one update with its expiry 30 minutes out.
    const claimedAt = w.clock.now();
    let row = await w.store.task.mustGet(task.id);
    expect(row.claimed_by).toBe(w.alice);
    expect(row.status).toBe("in_progress");
    expect(row.claim_expires).toBe(iso(claimedAt + DEFAULT_CLAIM_TTL_MS));

    // Renewed every five minutes while the task runs; each renewal pushes the expiry out again.
    await w.clock.advance(RENEW_EVERY_MS);
    await settle();
    expect(renewals).toEqual([iso(claimedAt + RENEW_EVERY_MS)]);
    row = await w.store.task.mustGet(task.id);
    expect(row.claim_expires).toBe(iso(w.clock.now() + DEFAULT_CLAIM_TTL_MS));
    await w.clock.advance(RENEW_EVERY_MS);
    await settle();
    expect(renewals).toHaveLength(2);
    const lastRenewal = w.clock.now();
    row = await w.store.task.mustGet(task.id);
    expect(row.claimed_by).toBe(w.alice);
    expect(row.claim_expires).toBe(iso(lastRenewal + DEFAULT_CLAIM_TTL_MS));
    // Meanwhile the other agent cannot take the task.
    expect(await w.store.task.claim(task.id, w.bob, DEFAULT_CLAIM_TTL_MS)).toMatchObject({
      ok: false,
      reason: "held_by",
      holder: w.alice,
    });

    // The renewals stop. The claim holds for the rest of its 30 minutes and no longer.
    offline = true;
    await w.clock.advance(DEFAULT_CLAIM_TTL_MS - 1);
    await settle();
    expect(renewals).toHaveLength(2);
    expect(await w.store.task.claim(task.id, w.bob, DEFAULT_CLAIM_TTL_MS)).toMatchObject({
      ok: false,
      reason: "held_by",
      holder: w.alice,
      expires: iso(lastRenewal + DEFAULT_CLAIM_TTL_MS),
    });
    await w.clock.advance(2);
    await settle();
    const expired = await w.store.task.expireClaims();
    expect(expired.map((t) => t.id)).toEqual([task.id]);
    expect(expired[0]).toMatchObject({
      claimed_by: null,
      claim_expires: null,
      status: "ready",
      reason: "claim expired",
    });
    const taken = await w.store.task.claim(task.id, w.bob, DEFAULT_CLAIM_TTL_MS);
    expect(taken.ok).toBe(true);
    expect(await w.store.task.mustGet(task.id)).toMatchObject({
      claimed_by: w.bob,
      claim_expires: iso(w.clock.now() + DEFAULT_CLAIM_TTL_MS),
      status: "claimed",
    });

    // The lapsed holder comes back and finishes: it cannot take the task from the new holder.
    offline = false;
    release();
    const result = await run.catch((e: unknown) => ({ status: `threw: ${String(e)}` }));
    expect(["completed", "failed"]).toContain(result.status);
    expect(await w.store.task.mustGet(task.id)).toMatchObject({
      claimed_by: w.bob,
      status: "claimed",
    });
    await w.clock.advance(DEFAULT_CLAIM_TTL_MS);
    await settle();
    expect(renewals).toHaveLength(2);
  });
});
