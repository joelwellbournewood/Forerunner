import { describe, expect, it } from "vitest";
import { type CommandContext, CommandExecutor, defaultRegistry } from "../src/index.ts";
import { type World, world } from "./helpers.ts";

/**
 * d1109-selftasks-chat, run C (SC-12; ADR 0119; the owner's D7: "each change shown with one
 * Undo", confirmed "the agent changes its own tasks"): a change the agent makes says so where it
 * is stored, by who made it, with no id and no channel. The commands through the executor with
 * the bodies a session's task check and chat's "fix the tasks" send (the agent as the actor).
 * Before: task.update stored "Changed by you: …" whoever acted, and an agent's new task or move
 * stored "created by agent <id> via session" / "agent <id> via chat".
 */

const reg = defaultRegistry();

function agentCtx(w: World, source: "session" | "chat", over: Partial<CommandContext> = {}) {
  return w.ctx({
    actor: { kind: "agent", id: w.agent.id },
    source,
    activeProjectId: w.pharma.id,
    planFix: { level: 2 },
    ...over,
  });
}

async function seed(w: World, title: string, extra: Record<string, unknown> = {}) {
  return w.store.task.insert({
    project_id: w.pharma.id,
    title,
    outcome: `${title} is done`,
    acceptance_criteria: ["it works"],
    risk_tier: 1,
    status: "ready",
    priority: 5,
    reason: "planned",
    author_agent: w.agent.id,
    ...extra,
  } as never);
}

const NO_ID = /[0-9a-f]{8}-[0-9a-f]{4}|01[0-9a-z]{20}|via (chat|session)/i;

describe("d1109-selftasks-chat, run C: the agent's change says so where it is stored (SC-12)", () => {
  for (const source of ["session", "chat"] as const)
    it(`${source}: added, changed, split, dropped and moved by the agent read so; never 'by you', an id or the channel`, async () => {
      const w = await world();
      const ex = new CommandExecutor({ registry: reg, store: w.store, clock: w.clock });
      const ctx = agentCtx(w, source);
      const style = await seed(w, "Style the page", {
        acceptance_criteria: ["the layout is a grid", "the colours match the logo"],
      });
      const readme = await seed(w, "Add the README");
      const again = await seed(w, "Write the README file");
      const publish = await seed(w, "Publish the page");

      const add = await ex.compose(
        [
          {
            name: "task.create",
            params: {
              title: "Check the links",
              outcome: "Every link works",
              specialist: "coder",
              status: "ready",
              project: w.pharma.id,
              why: "The coder said nothing checks the links.",
            },
          },
        ],
        ctx,
      );
      expect(add.status).toBe("done");
      const edit = await ex.compose(
        [{ name: "task.update", params: { task: publish.id, priority: "high" } }],
        ctx,
      );
      expect(edit.status).toBe("done");
      const split = await ex.compose(
        [
          {
            name: "task.split",
            params: {
              task: style.id,
              parts: [
                { title: "Style the page: layout", acceptance_criteria: ["the layout is a grid"] },
                {
                  title: "Style the page: colours",
                  acceptance_criteria: ["the colours match the logo"],
                },
              ],
              order: "in_turn",
            },
          },
        ],
        ctx,
      );
      expect(split.status).toBe("done");
      const drop = await ex.compose(
        [
          {
            name: "task.transition",
            params: { task: again.id, to: "cancelled", duplicate_of: readme.id },
          },
        ],
        ctx,
      );
      expect(drop.status).toBe("done");
      const pause = await ex.compose(
        [{ name: "task.transition", params: { task: readme.id, to: "draft" } }],
        ctx,
      );
      const tasks = await w.store.task.forProject(w.pharma.id, {}, { limit: 50 });
      const reason = (title: string) => tasks.find((t) => t.title === title)?.reason ?? "";
      expect(reason("Check the links")).toBe(
        "Added by the agent: the coder said nothing checks the links",
      );
      expect(reason("Publish the page")).toBe("Changed by the agent: priority to High");
      expect(reason("Style the page: colours")).toBe('Split from "Style the page" by the agent');
      expect(reason("Write the README file")).toBe(
        'Dropped by the agent: same as "Add the README"',
      );
      if (pause.status === "done") expect(reason("Add the README")).toMatch(/by the agent$/);
      for (const t of tasks) {
        expect(t.reason, t.title).not.toMatch(NO_ID);
        if (t.title !== "Add the README" || pause.status !== "done")
          expect(t.reason, t.title).not.toMatch(/by you/);
      }
    });

  it("a why that starts with a word in capitals keeps it ('README', 'CSS'); an ordinary first word reads lower case after the colon", async () => {
    const w = await world();
    const ex = new CommandExecutor({ registry: reg, store: w.store, clock: w.clock });
    const ctx = agentCtx(w, "session");
    const add = (title: string, why: string) =>
      ex.compose(
        [{ name: "task.create", params: { title, status: "ready", project: w.pharma.id, why } }],
        ctx,
      );
    expect((await add("Add the README", "README.md is missing.")).status).toBe("done");
    expect((await add("Split the styles", "CSS and layout are mixed.")).status).toBe("done");
    expect((await add("Check the links", "Nothing checks the links.")).status).toBe("done");
    const tasks = await w.store.task.forProject(w.pharma.id, {}, { limit: 50 });
    const reason = (title: string) => tasks.find((t) => t.title === title)?.reason ?? "";
    expect(reason("Add the README")).toBe("Added by the agent: README.md is missing");
    expect(reason("Split the styles")).toBe("Added by the agent: CSS and layout are mixed");
    expect(reason("Check the links")).toBe("Added by the agent: nothing checks the links");
  });

  it("the person's own moves read as before ('Changed by you: …', 'Added by you')", async () => {
    const w = await world();
    const ex = new CommandExecutor({ registry: reg, store: w.store, clock: w.clock });
    const publish = await seed(w, "Publish the page");
    const ctx = w.ctx({ activeProjectId: w.pharma.id });
    const said = async (calls: Parameters<CommandExecutor["compose"]>[0]) => {
      const r = await ex.compose(calls, ctx);
      if (r.status === "pending") await ex.confirm(r.pendingId, { kind: "yes", by: ctx.actor });
    };
    await said([{ name: "task.update", params: { task: publish.id, priority: "high" } }]);
    await said([{ name: "task.create", params: { title: "Write the FAQ", project: w.pharma.id } }]);
    const tasks = await w.store.task.forProject(w.pharma.id, {}, { limit: 50 });
    expect(tasks.find((t) => t.title === "Publish the page")?.reason).toBe(
      "Changed by you: priority to High",
    );
    expect(tasks.find((t) => t.title === "Write the FAQ")?.reason).toBe("Added by you");
  });
});
