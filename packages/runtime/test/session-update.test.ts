import { describe, expect, it } from "vitest";
import { isNewsLine, sessionResultLines, sessionUpdateLine } from "../src/session/result.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/**
 * The Inbox Update of a session (design §3.8, §5.10, §5.11): one line of news. Before, it
 * repeated the card beside it ('"X" needs your decision (Inbox).', stale once answered) and,
 * after the person stopped the only task, read just "<Project>: CHF 0.00." (waves 1 and 2).
 */
describe("a session's Update", () => {
  it("leaves what a card says to the card and says what was done", () => {
    expect(
      sessionUpdateLine(
        "Quote page",
        [
          '"Style the page" needs your decision (Inbox).',
          'Did 2 tasks: "Create index.html" and "Write script.js".',
          "1 task waits on it. CHF 0.06.",
        ],
        ["Style the page"],
      ),
    ).toBe('Quote page: did 2 tasks: "Create index.html" and "Write script.js".');
    expect(
      sessionUpdateLine(
        "Quote page",
        ['"A" failed: Claude did not answer. "B" needs your decision (Inbox).', "CHF 0.02."],
        ["B"],
      ),
    ).toBe('Quote page: "A" failed: Claude did not answer.');
  });

  it("a cost under a centime is money, not news: no Update says only that (the review of polish-words)", () => {
    // polish-words' moneyWordsFirst starts a line "Less than CHF 0.01."; the bench's Update read
    // "Guides: Less than CHF 0.01." and nothing else, where "CHF 0.00." gave none.
    expect(isNewsLine("Less than CHF 0.01.")).toBe(false);
    expect(isNewsLine("Stopped by you. Less than CHF 0.01.")).toBe(false);
    expect(sessionUpdateLine("Guides", ["Less than CHF 0.01."], [])).toBeNull();
    expect(
      sessionUpdateLine("Guides", ['Did 1 task: "Write the guide".', "Less than CHF 0.01."], []),
    ).toBe('Guides: did 1 task: "Write the guide".');
  });

  it("removes the card's sentence by its names: a title with a dot, a quote or a second name leaves the rest whole", () => {
    // The walk's titles carry file names: the sentence used to be cut at the dot in
    // "styles.css", and the Update read 'Quote page: "Style the page in styles.' (review of
    // fix/system-text, blocking 1).
    const lines = sessionResultLines({
      outcome: {
        done: [
          { id: "a", title: "Create the page skeleton in index.html" },
          { id: "b", title: "Show a random quote on every load in script.js" },
        ],
        failed: [],
        needsYou: [{ id: "c", title: "Style the page in styles.css" }],
        leftOver: [],
        waiting: [
          { id: "d", title: "Check every file loads", waitsOn: ['"Style the page in styles.css"'] },
        ],
        waitingForDocker: [],
        stopReason: "completed",
        spentChfMicro: 60_000,
      },
      inReview: [],
      leftOutForBudget: [],
      sessionCapChfMicro: 5_000_000,
      openTasks: 2,
    });
    expect(lines[0]).toBe('"Style the page in styles.css" needs your decision (Inbox).');
    expect(sessionUpdateLine("Quote page", lines, ["Style the page in styles.css"])).toBe(
      'Quote page: did 2 tasks: "Create the page skeleton in index.html" and "Show a random quote on every load in script.js".',
    );
    // On one line with a failed task after it, the failed task's sentence is the news.
    expect(
      sessionUpdateLine(
        "Quote page",
        [
          '"Style the page in styles.css" needs your decision (Inbox). "Check every file loads in index.html" failed: Claude did not answer.',
          "CHF 0.02.",
        ],
        ["Style the page in styles.css"],
      ),
    ).toBe('Quote page: "Check every file loads in index.html" failed: Claude did not answer.');
    // Two cards, dots and a quote in a title.
    expect(
      sessionUpdateLine(
        "Quote page",
        [
          '"Write notes/todo.md" and "Add a "Quote of the day" header to index.html" need your decision (Inbox).',
          'Did 1 task: "Create styles.css".',
          "CHF 0.03.",
        ],
        ["Write notes/todo.md", 'Add a "Quote of the day" header to index.html'],
      ),
    ).toBe('Quote page: did 1 task: "Create styles.css".');
    // Only a card: no Update, never the card's sentence cut short (the card is the news).
    expect(
      sessionUpdateLine(
        "Quote page",
        ['"Style the page in styles.css" needs your decision (Inbox).', "CHF 0.01."],
        ["Style the page in styles.css"],
      ),
    ).toBeNull();
  });

  it("a long gist is cut at a word and its quotes stay closed", () => {
    const titles = [
      "Create the page skeleton in index.html with a header and a footer",
      "Show a random quote on every load in script.js from quotes.json",
      "Style the page in styles.css with the colours of the brand guide",
    ];
    const line =
      sessionUpdateLine(
        "Quote page",
        [`Did 3 tasks: ${titles.map((t) => `"${t}"`).join(", ")}.`, "Nothing left. CHF 0.40."],
        [],
      ) ?? "";
    expect(line.startsWith('Quote page: did 3 tasks: "Create the page skeleton')).toBe(true);
    expect((line.match(/"/g) ?? []).length % 2, line).toBe(0);
    expect(line, line).toMatch(/…"?$/);
    expect(line, line).not.toMatch(/\s…/);
  });

  it("a session whose only news is a card posts no Update: the card in Needs you says it; the person's own stop posts nothing", () => {
    // Phase E, C-32: "Quote page: the session ended without finishing a task." stood right
    // under the card it did not name (design §5.10: one place per fact).
    expect(
      sessionUpdateLine(
        "Quote page",
        ['"Style the page" needs your decision (Inbox).', "CHF 0.01."],
        ["Style the page"],
      ),
    ).toBeNull();
    expect(sessionUpdateLine("Quote page", ["CHF 0.00."], [])).toBeNull();
    expect(sessionUpdateLine("Quote page", ["Stopped by you. CHF 0.00."], [])).toBeNull();
  });

  it("in the Inbox: a task that waits on the person with a file name in its title leaves the Update whole", async () => {
    const w = await loopWorld({
      replies: [submitReply({ grade: 90, verdict: "accept" }), closingReply()],
    });
    try {
      await w.addTask("Create the page skeleton in index.html");
      await w.addTask("Style the page in styles.css");
      const done = doneExecutor(w);
      await w.start(
        w.runner({
          async execute(ctx) {
            if (ctx.task.title.startsWith("Style"))
              return {
                outcome: "needs_human",
                summary: "Which colours should the page use?",
                costUsdMicro: 0,
              };
            return done.execute(ctx);
          },
        }),
      );
      const updates = (await w.store.message.inbox({ humanId: w.human }, { limit: 50 }))
        .filter((m) => m.type === "info")
        .map((m) => m.body);
      expect(updates).toEqual([
        expect.stringMatching(/: did 1 task: "Create the page skeleton in index\.html"\.$/),
      ]);
    } finally {
      await w.close();
    }
  });

  it("in the Inbox: a session that did its task says so once; one whose only task was stopped by the person says nothing", async () => {
    const w = await loopWorld({
      replies: [submitReply({ grade: 90, verdict: "accept" }), closingReply()],
    });
    try {
      await w.addTask("Write the README");
      const result = await w.start(w.runner(doneExecutor(w)));
      expect(result.completed).toHaveLength(1);
      const updates = async () =>
        (await w.store.message.inbox({ humanId: w.human }, { limit: 50 })).filter(
          (m) => m.type === "info",
        );
      expect((await updates()).map((m) => m.body)).toEqual([
        expect.stringMatching(/: did 1 task: "Write the README"\./),
      ]);
      // A second session whose only task the person stops while it runs (the Tasks tab's
      // Stop pauses it; the session goes on and finds nothing else): no "<Project>: CHF 0.00."
      const second = await w.addTask("Write the FAQ");
      await w.start(
        w.runner({
          async execute() {
            const now = await w.store.task.mustGet(second.id);
            await w.store.task.transition(now.id, now.version, "needs_human", "Stopped by you", {
              humanId: w.human,
            });
            return { outcome: "killed", summary: "stopped", costUsdMicro: 0 };
          },
        }),
      );
      expect(await updates()).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});
