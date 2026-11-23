import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { InboxView, StartCheckView } from "../src/daemon/api-types.ts";
import { credWorld, seedProject, setPolicy, startSession } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * d1109-cred-screens (CS-8, CS-10's walk; design §5 rule 7, "about" for estimates): on the bench
 * the ask card the person answers read "about CHF 0.00" for a project with one task: the task
 * whose run met the subscription's limit is claimed while the card is filed, so the ready tasks
 * alone priced nothing. Composed with no injected provider (cred-world: the routed provider over
 * the Messages API stand-in and a scripted Claude Code), so the card is filed by the real router.
 */
const RESET = Date.parse("2026-10-31T14:00:00Z");
const homes: string[] = [];

afterAll(() => removeHomes(homes));

describe("d1109-cred-screens, run C: the ask card's figure counts the task that met the stop (CS-8)", () => {
  it("one task, claimed when the card is filed: the card prices its estimate, never CHF 0.00", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-figure-" });
    homes.push(world.home);
    world.limitSubscription(RESET);
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    // seedProject gives each task an estimate of USD 0.10.
    const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
    await startSession(rt, project.id);
    await settleSessions(rt);
    const inbox = (await req<InboxView>("/inbox")).body;
    const card = inbox.requests.find((r) => (r.title ?? "").startsWith("Use your API key"));
    expect(card?.title).toBe("Use your API key until 15:00?");
    // The task's own estimate (USD 0.10, about CHF 0.08 to 0.10 at the stand-in's rate).
    expect(card?.body).toMatch(
      /^Your Claude subscription is at its limit until 15:00\. Your API key can do the waiting work now: about CHF 0\.(0[5-9]|1\d)\.$/,
    );
    expect(card?.choices?.[0]?.explain).toMatch(
      /^Your work and chat use your API key until 15:00: about CHF 0\.(0[5-9]|1\d) for what waits now\.$/,
    );
    for (const s of [card?.body ?? "", ...(card?.choices ?? []).map((c) => c.explain ?? "")]) {
      expect(s).not.toContain("CHF 0.00");
      expect(s).not.toContain("a cost per use");
    }
    // Nothing ran on the key while the card waits.
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});

/**
 * l4-cred-screens, run L4 (L4-creds-15; live check 4's LC-C24: the ask card said "about CHF 0.10"
 * for work that then cost CHF 0.24 on the key, and the Start dialog said CHF 0.15 and the plan
 * card CHF 0.37 for the same work; ADR 0120 amended 2026-11-22). The waiting work has one figure:
 * the session's promise (the runnable task and its follower, each with its review part, the
 * owner's answer of 2026-11-16: "yes it should count critics reviews, and fixes") plus what is
 * left of a task a session holds, within the work budget. The ask card in GET /inbox and the
 * Start dialog's "Use API key" in GET /projects/:id/start-check say it alike. Before, the card
 * priced the held task at its raw estimate and left out its follower; the dialog priced the
 * runnable task alone.
 */
describe("l4-cred-screens, run L4: one figure for the waiting work (L4-creds-15)", () => {
  it("A and its follower B, priced with their review parts: the ask card and the Start dialog say the same figure, more than A's raw estimate", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-figure-l4-" });
    homes.push(world.home);
    world.limitSubscription(RESET);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "subscription_then_ask");
      const project = await rt.store.project.insert({
        name: "Quote page",
        goal: "A quote page",
        autonomy_level: 2,
      });
      const seed = { outcome: "the page is styled", acceptance_criteria: ["it is done"] };
      const a = await rt.store.task.insert({
        project_id: project.id,
        title: "Style the page",
        ...seed,
        risk_tier: 0,
        status: "ready",
        priority: 5,
        est_cost_usd_micro: 100_000,
        reason: "seed",
      });
      await rt.store.task.insert({
        project_id: project.id,
        title: "Write the copy",
        ...seed,
        risk_tier: 0,
        status: "ready",
        priority: 4,
        est_cost_usd_micro: 100_000,
        depends_on: [a.id],
        reason: "seed",
      });
      // The planner's figures: each task's work plus its review part.
      const planned = rt.estimates.estimate({
        specialist: a.specialist,
        risk_tier: a.risk_tier,
        est_cost_usd_micro: a.est_cost_usd_micro,
        budget_usd_micro: a.budget_usd_micro,
        outcome: a.outcome,
        acceptance_criteria: a.acceptance_criteria,
      });
      expect(planned.reviewUsdMicro ?? 0).toBeGreaterThan(0);
      await startSession(rt, project.id);
      await settleSessions(rt);
      const inbox = (await req<InboxView>("/inbox")).body;
      const card = inbox.requests.find((r) => (r.title ?? "").startsWith("Use your API key"));
      const chfOf = (s: string | null | undefined) => /about (CHF \d+\.\d\d)/.exec(s ?? "")?.[1];
      const onCard = chfOf(card?.body);
      expect(onCard, card?.body ?? "no ask card").toBeDefined();
      expect(chfOf(card?.choices?.[0]?.explain)).toBe(onCard);
      // The Start dialog's "Use API key" says the same figure, and its plan names both tasks.
      const check = (
        await req<StartCheckView>(`/projects/${encodeURIComponent(project.id)}/start-check`)
      ).body;
      expect(check.runnable.map((t) => t.title)).toEqual(["Style the page"]);
      expect(check.later.map((t) => t.title)).toEqual(["Write the copy"]);
      expect(chfOf(check.credential?.runOut?.use.explain)).toBe(onCard);
      // It is the promise of A and B with their review parts: their two figures as the dialog
      // prices them, more than A's raw estimate (USD 0.10) alone.
      const both = [...check.runnable, ...check.later].reduce(
        (sum, t) => sum + t.estimate.chfMicro,
        0,
      );
      const figure = Number((onCard ?? "CHF 0").slice(4));
      expect(Math.abs(figure - both / 1_000_000)).toBeLessThanOrEqual(0.011);
      const rawA = check.runnable[0]?.estimate;
      const rawAChf = rawA ? (100_000 * rawA.chfMicro) / rawA.usdMicro / 1_000_000 : 0;
      expect(figure).toBeGreaterThan(rawAChf + 0.01);
      // Nothing ran on the key while the card waits.
      expect(world.keyCalls()).toHaveLength(0);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 90_000);
});
