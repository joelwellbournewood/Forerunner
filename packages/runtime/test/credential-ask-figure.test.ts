import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { InboxView } from "../src/daemon/api-types.ts";
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
