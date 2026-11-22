import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { RunningView } from "../src/daemon/api-types.ts";
import {
  credWorld,
  type SdkMessage,
  SUBSCRIPTION_REPORT,
  seedProject,
  setPolicy,
  startSession,
  until,
} from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-9 (live check 4, LC-C31): two projects' sessions waited for the same
 * stop. At the reset the first went on (one agent), and the second's start was queued behind it,
 * but the running bar did not name it as next ("· then Bird notes") and its own entry still read
 * "waiting until 08:32, then it goes on" after 08:32. Composed as `fr daemon` composes it with
 * the scripted Claude Code; the first continuation's run is held open while the bar is read.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

describe("l4-cred-engine, run L4: a continuation queued behind another project's session", () => {
  it("at the reset the first goes on, the bar names the second as next, and nothing still says it waits until the reset", async () => {
    const clock = new SimulatedClock("2026-11-17T07:00:00Z");
    const world = credWorld({ clock, key: false, prefix: "fr-cont-queue-" });
    homes.push(world.home);
    const reset = Date.parse("2026-11-17T07:32:00Z");
    world.limitSubscription(reset);
    const { rt, req } = await world.compose();
    let releaseRun: () => void = () => undefined;
    try {
      await setPolicy(rt, "subscription_then_wait");
      const map = await seedProject(rt, "Map notes", ["Write notes/map.md"]);
      const bird = await seedProject(rt, "Bird notes", ["Write notes/bird.md"]);
      await startSession(rt, map.project.id);
      await settleSessions(rt);
      await startSession(rt, bird.project.id);
      await settleSessions(rt);
      const waits = (await req<RunningView[]>("/running")).body.filter(
        (v) => v.state === "waiting",
      );
      expect(waits.map((v) => v.projectName).sort()).toEqual(["Bird notes", "Map notes"]);

      // The first continuation's run holds until released.
      let release: () => void = () => undefined;
      const held = new Promise<void>((r) => {
        release = r;
      });
      releaseRun = () => release();
      world.setRunScript(async function* (_o, n): AsyncIterable<SdkMessage> {
        yield { type: "system", subtype: "init", session_id: `held-${n}` };
        await held;
        yield {
          type: "assistant",
          message: {
            id: `m${n}`,
            content: [{ type: "text", text: SUBSCRIPTION_REPORT }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        };
        yield { type: "result", subtype: "success", is_error: false, result: SUBSCRIPTION_REPORT };
      });
      await clock.set(reset + 60_000);
      world.limitSubscription(null);
      await rt.billing.waits.wake();
      await until("one continuation to run and the other to wait in line", async () => {
        const views = (await req<RunningView[]>("/running")).body;
        return views.some((v) => v.state !== "waiting" && v.sessionId)
          ? null
          : JSON.stringify(views);
      });
      const views = (await req<RunningView[]>("/running")).body;
      const running = views.find((v) => v.state !== "waiting");
      const other = running?.projectName === "Map notes" ? "Bird notes" : "Map notes";
      expect(running?.nextProject).toBe(other);
      // Nothing says it waits until 07:32 (08:32 in Zurich) once that time has passed.
      for (const v of views) expect(v.text).not.toMatch(/waiting until 08:32/);
      release();
      await settleSessions(rt);
    } finally {
      releaseRun();
      await settleSessions(rt);
      await rt.close();
    }
  }, 90_000);
});
