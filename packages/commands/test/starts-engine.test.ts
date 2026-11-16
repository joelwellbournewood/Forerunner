import { describe, expect, it } from "vitest";
import { sessionStart } from "../src/commands/session.ts";
import { START_BY_ITSELF_SETTING, settingSpec } from "../src/commands/settings.ts";
import { taskCreate, taskReopen, taskResume, taskTransition } from "../src/commands/task.ts";
import { defaultRegistry, type ExecuteResult, IntentParser } from "../src/index.ts";
import { START, TZ, world } from "./helpers.ts";

/**
 * d1109-starts-engine (run C, ADR 0118), in the commands: only the person starts a session. The
 * project's "When work is ready" key (S-5) is the person's alone, asks a yes to turn on and acts
 * at once to turn off; a start said in chat is read back at any budget (S-11), "run it now" and
 * its German are a start; the definitions the chat model reads say which actions start nothing
 * (S-11, S-12), asserted word for word.
 */
function status(r: ExecuteResult) {
  return r.status;
}

describe("d1109-starts-engine S-5: 'When work is ready' (start_by_itself)", () => {
  it("is the person's alone: the chat's agent is refused in one sentence, nothing changes", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "settings.set",
      params: { key: START_BY_ITSELF_SETTING, value: true, project: "Game" },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id } }),
    });
    expect(r.status).toBe("refused");
    expect(r.status === "refused" ? r.reason : "").toBe(
      "Only you can change when work is ready for Game.",
    );
    expect((await w.store.project.mustGet(w.game.id)).settings).not.toHaveProperty(
      START_BY_ITSELF_SETTING,
    );
  });

  it("turning it on asks the person's yes with what it does; turning it off acts at once", async () => {
    const w = await world();
    const on = await w.executor.execute({
      name: "settings.set",
      params: { key: START_BY_ITSELF_SETTING, value: true, project: "Game" },
      ctx: w.ctx({ source: "ui" }),
    });
    expect(status(on)).toBe("pending");
    expect(JSON.stringify(on)).toContain(
      "sessions of Game will start by themselves when work you made ready can run, up to CHF",
    );
    const spec = settingSpec(START_BY_ITSELF_SETTING);
    expect([spec.display?.(true), spec.display?.(false)]).toEqual([
      "Start a session by itself",
      "Wait for my Start",
    ]);
    expect(spec.narrows?.(false, true)).toBe(true);
    expect(spec.narrows?.(true, false)).toBe(false);
    const off = await w.executor.execute({
      name: "settings.set",
      params: { key: START_BY_ITSELF_SETTING, value: false, project: "Game" },
      ctx: w.ctx({ source: "ui" }),
    });
    expect(status(off)).toBe("done");
  });
});

describe("d1109-starts-engine S-11: a start in chat is the person's, read back", () => {
  it("'run it now' and the German are a start; a task change is not", async () => {
    const parser = new IntentParser(defaultRegistry());
    const ctx = {
      source: "chat" as const,
      timezone: TZ,
      now: Date.parse(START),
      activeProjectId: "p-game",
      projects: [{ id: "p-game", name: "Game" }],
    };
    for (const words of [
      "run it now",
      "start it",
      "run the tasks",
      "let's run it",
      "please run it",
      "starte es",
      "jetzt ausführen",
    ])
      expect(
        (await parser.parse(words, ctx)).commands.map((c) => c.name),
        words,
      ).toEqual(["session.start"]);
    expect((await parser.parse("make the FAQ wait for the README", ctx)).commands[0]?.name).toBe(
      "task.dependencies",
    );
  });

  it("session.start is read back from chat at any budget, and its definition says so word for word", () => {
    expect(sessionStart.askFromChat).toBe(true);
    expect(sessionStart.description).toBe(
      "Start a work session now on the person's say-so, on a project, on the PC or the cloud runner, with an optional budget in CHF; read back for their yes. Answers and task changes never start one.",
    );
  });

  it("the task moves the chat model reads start nothing, word for word", () => {
    expect(taskCreate.description).toBe(
      "Add a task to a project, ready unless a draft is asked for (it joins the running session if it fits, else waits for the person's next Start): title, outcome, acceptance criteria, priority (low, medium or high; medium when not said), the tasks it waits for (titles), its review level (1 light review, the default; 2 full review: needs Docker; 3 full review and the person's sign-off) and who does it (a specialist, or 'person' for a question only the person can answer).",
    );
    expect(taskTransition.description).toBe(
      "Move a task along its workflow: ready (make ready, try again; it joins the running session if it fits, else waits for the person's next Start), needs_human (pause), cancelled; agents also use in_progress, in_review, done and failed. Prefer task.pause, task.resume and task.reopen for those moves.",
    );
    expect(taskResume.description).toBe(
      "Resume a paused task, or let a task that waits for the person's answers go ahead without them: it is ready again and joins the running session if it fits, else waits for the person's next Start. Its open Inbox cards are withdrawn.",
    );
    expect(taskReopen.description).toBe(
      "Reopen a cancelled task (Reopen), or a done task to redo it (Redo): it is ready again and joins the running session if it fits, else waits for the person's next Start; the person's note says what to fix and goes into its brief.",
    );
  });
});
