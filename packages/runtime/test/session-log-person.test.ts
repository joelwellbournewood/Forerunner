import { describe, expect, it } from "vitest";
import { eventAudience } from "../src/daemon/event-lines.ts";
import { describeEvent, eventView } from "../src/daemon/views.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/**
 * The session page's log in person-level lines (design §3.7, §5; the walks' "developer event
 * log"): every event has an audience; a person reads at most about eight lines per task,
 * with names, no event type names, no markdown, nothing cut mid-word, "could not" for a run
 * that reported it could not do the work, and no notification channels. The rest is Details.
 */
describe("person-level session log (design §3.7)", () => {
  const COULD_NOT_REPORT =
    "**Summary** [stand-in model] I could not complete this task. The work needs something I do not have here, so I stopped without changing any file.\n\n**Files changed**: none.\n\n**Criteria**\n- styles.css exists and styles the page";

  it("a run that reported it could not do the work reads 'could not', never 'done', and quotes it whole", () => {
    const line = describeEvent(
      "task.finished",
      {
        taskId: "t1",
        title: "Style the page in styles.css",
        specialist: "writer-marketing",
        outcome: "done",
        costUsdMicro: 0,
        summary: COULD_NOT_REPORT,
      },
      0.8,
    );
    expect(line).toBe(
      'The writer could not do "Style the page in styles.css": "The work needs something I do not have here, so I stopped without changing any file".',
    );
    expect(eventAudience("task.finished", { outcome: "done" })).toBe("person");
  });

  it("the end, the stop and the delivery of a notification read as a person's lines or Details", () => {
    expect(
      describeEvent(
        "session.ended",
        {
          status: "killed",
          stopReason: "stop_all",
          spentUsdMicro: 0,
          completed: 0,
          failed: 0,
          needsHuman: 0,
          retried: 0,
          inReview: 0,
          skipped: 0,
        },
        0.8,
      ),
    ).toBe("Stopped: Stop all: nothing done. CHF 0.00.");
    expect(
      describeEvent(
        "session.ended",
        {
          status: "completed",
          stopReason: "completed",
          spentUsdMicro: 75_000,
          completed: 2,
          needsHuman: 1,
          retried: 0,
        },
        0.8,
      ),
    ).toBe("Session over: 2 done, 1 needs you. CHF 0.06.");
    expect(eventAudience("notification", {})).toBe("detail");
    expect(eventAudience("task.step", {})).toBe("detail");
    expect(eventAudience("memory.loaded", {})).toBe("detail");
    expect(eventAudience("task.finished", { outcome: "killed" })).toBe("detail");
    // A retry in the same session is told by what came of it: the same specialist starting
    // again, and a reviewed run's own line when the critic's line says it, are details.
    expect(eventAudience("task.started", { again: true })).toBe("detail");
    expect(eventAudience("task.started", { again: true, handedFrom: "designer" })).toBe("person");
    expect(eventAudience("task.finished", { outcome: "done", review: true })).toBe("person");
    expect(eventAudience("task.finished", { outcome: "done", review: true, couldNot: "" })).toBe(
      "detail",
    );
    expect(eventAudience("task.finished", { outcome: "done", review: true, again: true })).toBe(
      "detail",
    );
    // Without the critic after it, the run's line is the only one that says how it ended.
    expect(eventAudience("task.finished", { outcome: "done", couldNot: "x", again: true })).toBe(
      "person",
    );
    expect(
      describeEvent("notification", {
        title: "Quote page: session done",
        deliveries: [
          { channel: "telegram", status: "skipped", reason: "no Telegram chat id" },
          { channel: "email", status: "skipped", reason: "no email sender" },
        ],
      }),
    ).toBe('Notified you: "Quote page: session done".');
    // A step and a replan say their own words, never "Task step: ...".
    expect(describeEvent("task.step", { text: "wrote index.html" })).toBe("wrote index.html");
    expect(describeEvent("session.replanned", { text: 'Continuing with "B".' })).toBe(
      'Continuing with "B".',
    );
  });

  it("a real session's person lines: at most about eight per task, names, no type names, markdown, ids or cut words", async () => {
    const w = await loopWorld({
      replies: [
        submitReply({
          grade: 35,
          verdict: "revise",
          summary:
            "[stand-in model] Sent back for rework: the worker reports it could not do the work.",
          findings: [
            { severity: "major", what: "styles.css is missing", required_action: "Write it" },
          ],
        }),
        submitReply({ grade: 90, verdict: "accept", summary: "The page is styled." }),
        closingReply(),
      ],
    });
    try {
      const task = await w.addTask("Style the page in styles.css");
      const done = doneExecutor(w);
      let attempt = 0;
      const result = await w.start(
        w.runner({
          async execute(ctx) {
            const r = await done.execute(ctx);
            attempt += 1;
            return attempt === 1 ? { ...r, summary: COULD_NOT_REPORT, changedFiles: [] } : r;
          },
        }),
      );
      const rows = await w.store.event.list(result.sessionId);
      const views = rows.map((e) => eventView(e, 0.8));
      const person = views.filter((v) => v.audience === "person");
      const details = views.filter((v) => v.audience === "detail");
      expect(details.length).toBeGreaterThan(0);
      const lines = person.map((v) => v.text);
      expect(rows.filter((e) => e.type === "task.started")).toHaveLength(2);
      // Per task (not per run), at most about eight lines (design §3.7).
      const ofTask = person
        .filter((v) => (v.payload as Record<string, unknown> | null)?.taskId === task.id)
        .map((v) => v.text);
      expect(ofTask.length, ofTask.join("\n")).toBeLessThanOrEqual(8);
      expectPlain(lines);
      // The run that could not do the work and the critic sending it back are one line, the
      // design's own (§5 "Log line"); the second start is the same specialist again: a detail.
      expect(ofTask).toEqual([
        expect.stringMatching(/^The coder started "Style the page in styles\.css"/),
        'The coder could not do "Style the page in styles.css": "The work needs something I do not have here, so I stopped without changing any file". Trying again.',
        "Changed src/x.ts.",
        'The critic accepted "Style the page in styles.css".',
      ]);
      expect(lines.at(-1)).toMatch(/^Session over: 1 done\. CHF \d+\.\d{2}\.$/);
    } finally {
      await w.close();
    }
  });

  it("the walk's journey: a task that could not be done four times, the last by another specialist, reads in at most eight lines", async () => {
    // Bench session 1 of the review of fix/system-text: "Style the page in styles.css" had 12
    // person lines (4 starts, 4 'could not', 3 'The critic sent … back: the worker reports it
    // could not do the work. Trying again.', 1 'needs your decision'), each critic line saying
    // again what the line above it said.
    const sentBack = () =>
      submitReply({
        grade: 35,
        verdict: "escalate",
        summary:
          "[stand-in model] Sent back for rework: the worker reports it could not do the work.",
        findings: [
          { severity: "major", what: "styles.css is missing", required_action: "Write it" },
        ],
      });
    const w = await loopWorld({
      replies: [sentBack(), sentBack(), sentBack(), sentBack(), closingReply()],
    });
    try {
      const task = await w.addTask("Style the page in styles.css", { specialist: "designer" });
      const done = doneExecutor(w);
      let attempt = 0;
      const result = await w.start(
        w.runner({
          async execute(ctx) {
            const r = await done.execute(ctx);
            attempt += 1;
            // The executor hands the task to another specialist on the ladder's second rung
            // and records it on the task; the next attempt is planned with it.
            if (attempt === 3)
              await w.store.task.patch(task.id, { specialist: "writer-marketing" });
            return { ...r, summary: COULD_NOT_REPORT, changedFiles: [] };
          },
        }),
      );
      expect(result.needsHuman).toEqual([task.id]);
      const rows = await w.store.event.list(result.sessionId);
      expect(rows.filter((e) => e.type === "task.started")).toHaveLength(4);
      const views = rows.map((e) => eventView(e, 0.8));
      const person = views.filter((v) => v.audience === "person");
      const ofTask = person
        .filter((v) => (v.payload as Record<string, unknown> | null)?.taskId === task.id)
        .map((v) => v.text);
      expect(ofTask.length, ofTask.join("\n")).toBeLessThanOrEqual(8);
      expectPlain(person.map((v) => v.text));
      const SAID =
        '"The work needs something I do not have here, so I stopped without changing any file"';
      expect(ofTask).toEqual([
        expect.stringMatching(/^The designer started "Style the page in styles\.css"/),
        `The designer could not do "Style the page in styles.css": ${SAID}. Trying again.`,
        `The designer could not do "Style the page in styles.css": ${SAID}. Trying again.`,
        `The designer could not do "Style the page in styles.css": ${SAID}. Trying again.`,
        'The writer takes over "Style the page in styles.css" from the designer.',
        `The writer could not do "Style the page in styles.css": ${SAID}. It needs your decision (Inbox).`,
      ]);
      // Details still hold every start, every run's own line and each verdict as the critic
      // gave it.
      const details = views.filter((v) => v.audience === "detail").map((v) => v.type);
      expect(details.filter((t) => t === "task.started")).toHaveLength(2);
      expect(details.filter((t) => t === "task.finished")).toHaveLength(4);
    } finally {
      await w.close();
    }
  });
});

/** The rules every person line keeps (design §5). */
function expectPlain(lines: readonly string[]): void {
  for (const l of lines) {
    expect(l, l).not.toMatch(/\b(?:session|task|critic|memory|queue|peers|docs|inbox)\.[a-z_]+/);
    expect(l, l).not.toMatch(/\*\*|[{}]|\(s\)|\bUSD\b|\$/);
    expect(l, l).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(l, l).not.toMatch(/telegram|skipped \(|signal|desktop unavailable/i);
    expect(l.split("\n").length, l).toBe(1);
    expect((l.match(/"/g) ?? []).length % 2, l).toBe(0);
  }
}
