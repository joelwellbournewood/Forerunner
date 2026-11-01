import { describe, expect, it } from "vitest";
import { eventAudience } from "../src/daemon/event-lines.ts";
import { describeEvent, eventView } from "../src/daemon/views.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/**
 * The session page's log in person-level lines (design §3.7, §5; the walks' "developer event
 * log"): every event has an audience; a person reads at most about eight lines per task run,
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

  it("a real session's person lines: at most eight per run, names, no type names, markdown, ids or cut words", async () => {
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
      // Per run of the task, at most about eight lines.
      const runs = rows.filter((e) => e.type === "task.started").length;
      expect(runs).toBe(2);
      const ofTask = person.filter(
        (v) => (v.payload as Record<string, unknown> | null)?.taskId === task.id,
      );
      expect(ofTask.length).toBeLessThanOrEqual(8 * runs);
      for (const l of lines) {
        expect(l, l).not.toMatch(
          /\b(?:session|task|critic|memory|queue|peers|docs|inbox)\.[a-z_]+/,
        );
        expect(l, l).not.toMatch(/\*\*|[{}]|\(s\)|\bUSD\b|\$/);
        expect(l, l).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
        expect(l, l).not.toMatch(/telegram|skipped \(|signal|desktop unavailable/i);
        expect(l.split("\n").length, l).toBe(1);
      }
      expect(lines).toContain(
        'The coder could not do "Style the page in styles.css": "The work needs something I do not have here, so I stopped without changing any file".',
      );
      expect(
        lines.some((l) => /^The critic sent "Style the page in styles\.css" back/.test(l)),
      ).toBe(true);
      expect(lines).toContain('The critic accepted "Style the page in styles.css".');
      expect(lines).toContain("Changed src/x.ts.");
      expect(lines.at(-1)).toMatch(/^Session over: 1 done\. CHF \d+\.\d{2}\.$/);
    } finally {
      await w.close();
    }
  });
});
