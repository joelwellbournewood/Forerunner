import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  credWorld,
  type SdkMessage,
  sdkThrow,
  seedProject,
  setPolicy,
  syntheticError,
  until,
} from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-13 (C5L-4; CE-5's repository case, checked before only by live check
 * 4's LC-C23): the subscription writes part of the task, then meets its usage limit (Agent SDK
 * 0.3.304's shape: the rejected rate-limit event, Claude Code's own error message, the error
 * result, then the throw). Under "then the API key" the work goes on with the key from the kept
 * work: the stopped run's change is kept as a commit of its own, and the key's run is told where
 * the last run stopped, word for word as the model receives it. Composed as `fr daemon` composes
 * it (no injected provider).
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const KEPT_BRIEF =
  "The last run of this task stopped when its Claude credential reached its limit, before its work was done. Its work so far is in the folder you work in (kept as a commit of its own): continue from it, do not start again.";

describe("l4-cred-engine, run L4: work kept when the subscription stops mid-task, then finished on the key", () => {
  it("subscription_then_key: the stopped run's file is a commit of its own and the key's run continues from it", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-kept-work-" });
    homes.push(world.home);
    const reset = Date.parse("2026-11-17T11:00:00Z");
    let folder = "";
    world.setRunScript(async function* (options, n): AsyncIterable<SdkMessage> {
      yield { type: "system", subtype: "init", session_id: `cc-kept-${n}` };
      folder = typeof options.cwd === "string" ? options.cwd : "";
      if (folder) {
        mkdirSync(join(folder, "notes"), { recursive: true });
        writeFileSync(join(folder, "notes", "a.md"), "# A\n\nThe first half of the note.\n");
      }
      yield {
        type: "assistant",
        message: {
          id: `m-kept-${n}`,
          model: "claude-sonnet-5-5",
          content: [{ type: "text", text: "Writing notes/a.md." }],
          usage: { input_tokens: 200, output_tokens: 50 },
        },
      };
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: Math.ceil(reset / 1000),
          rateLimitType: "five_hour",
        },
      };
      yield syntheticError("rate_limit", "You've hit your limit");
      yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" };
      throw sdkThrow("You've hit your limit");
    });
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "subscription_then_key");
      const { project, tasks } = await seedProject(rt, "Field notes", ["Write notes/a.md"]);
      const started = await req("/sessions", {
        agentId: rt.agent.id,
        projectId: project.id,
        trigger: "manual",
      });
      expect(started.status).toBe(202);
      await settleSessions(rt);
      await until("the task to finish on the key", async () => {
        const t = await rt.store.task.mustGet(tasks[0]?.id ?? "");
        return t.status === "done" ? null : t.status;
      });
      // The stopped run was a credential stop, never a failure.
      const runs = await rt.store.run.forTask(tasks[0]?.id ?? "");
      expect(runs.map((r) => r.outcome)).toContain("usage_limit");
      expect(runs.map((r) => r.outcome)).not.toContain("failed");
      // The key's run is told where the last one stopped, as the model receives it.
      const briefs = world.keyModel.calls
        .map((c) => {
          const first = c.messages[0]?.content;
          return typeof first === "string" ? first : JSON.stringify(first ?? "");
        })
        .filter((t) => t.includes("## Where the last run stopped"));
      expect(briefs.length, "the key's run got the stopped run's section").toBeGreaterThan(0);
      expect(briefs[0]).toContain(KEPT_BRIEF);
      // The stopped run's file is kept as a commit of its own in the folder the work happens in.
      expect(folder, "the subscription's run had a folder").not.toBe("");
      if (existsSync(folder)) {
        const log = execFileSync(
          "git",
          ["-C", folder, "log", "--format=%H %s", "--", "notes/a.md"],
          {
            encoding: "utf8",
          },
        ).trim();
        expect(log, "a commit holds notes/a.md").not.toBe("");
      }
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 90_000);
});
