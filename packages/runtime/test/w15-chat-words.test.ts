import { describe, expect, it } from "vitest";
import { projectStatusLine } from "../src/daemon/project-status.ts";
import { requestWords } from "../src/daemon/request-words.ts";

/**
 * w15-chat (wave 15): the words cards, the project line and notifications are written in, at the
 * function that writes each sentence (design §5). The person meets them on Home, in the Inbox
 * and in the desktop notification; the routes are in `apps/ui/test/real-daemon.test.ts`
 * ("w15-chat, wave 15").
 */
describe("w15-chat, wave 15", () => {
  const approval = (over: Record<string, unknown>) => ({
    kind: "approval" as const,
    why: "",
    steps: [],
    options: ["yes", "no"],
    status: "open" as const,
    answer: null,
    change_card: {},
    ...over,
  });

  // W15-77 (live check 2, research F13): "undo: web pages research may read for Reading rules"
  // was titled "undo": the first sentence ended at the colon after one word.
  it("a one-word lead before a colon is no sentence of its own (W15-77)", () => {
    const words = requestWords(
      approval({
        why: "undo: web pages research may read for Reading rules",
        change_card: {
          command: "undo",
          what: "undo: web pages research may read for Reading rules",
        },
      }) as never,
    );
    expect(words.title).not.toBe("undo");
    expect(words.title).toBe("undo: web pages research may read for Reading rules");
    // A sentence with a colon after several words still ends there (P7-26 unchanged).
    const two = requestWords(
      approval({
        kind: "decision",
        options: ["Merge", "Keep"],
        why: 'Planning failed twice: "Write the README: how to open it" could not be read.',
      }) as never,
    );
    expect(two.title).toBe("Planning failed twice");
  });

  // W15-76 (wave 13 review of polish-screens): a settings.set card's Yes repeated its own body,
  // cut with "…".
  it("an approval card's Yes says what Yes does; the body already says what the change means (W15-76)", () => {
    const ask =
      "Set who merges accepted work for Merging to Merge automatically after review? Forerunner merges each task's pull request once the critic accepts it. Merges show under your GitHub name, a comment on a merged pull request starts nothing, and if this repository's main goes online by itself, every accepted task goes live.";
    const words = requestWords(
      approval({
        why: "who merges accepted work for Merging",
        change_card: { command: "settings.set", what: "who merges accepted work for Merging", ask },
      }) as never,
    );
    expect(words.title).toBe(
      "Set who merges accepted work for Merging to Merge automatically after review?",
    );
    expect(words.body).toMatch(/^Forerunner merges each task's pull request/);
    expect(words.choices.map((c) => [c.label, c.explain])).toEqual([
      ["Yes", "Makes the change now."],
      ["No", "Nothing changes."],
    ]);
    // An undo's question (W15-34) reads the same way.
    const undo = requestWords(
      approval({
        why: "web pages research may read for Reading rules",
        change_card: {
          command: "undo",
          what: "web pages research may read for Reading rules",
          ask: "Put web pages research may read for Reading rules back to any public website? Research reads any public website except the ones listed, on the API key and on the subscription.",
        },
      }) as never,
    );
    expect(undo.title).toBe(
      "Put web pages research may read for Reading rules back to any public website?",
    );
    expect(undo.choices.map((c) => [c.label, c.explain])).toEqual([
      ["Yes", "Makes the change now."],
      ["No", "Nothing changes."],
    ]);
  });

  // W15-77: the project line counted a change waiting for a yes as "1 question".
  it("a change waiting for a yes is a change to confirm in the project line, not a question (W15-77)", () => {
    const line = (cards: { id: string; change_card: unknown }[]) =>
      projectStatusLine({
        projectId: "p1",
        tasks: [],
        displays: new Map(),
        cards: cards.map((c) => ({ ...c, task_id: null })) as never,
        plan: null,
        working: null,
        folder: null,
      }).text;
    const change = (id: string, command: string) => ({
      id,
      change_card: { command, what: "web pages research may read for Reading rules" },
    });
    expect(line([change("r1", "undo")])).toBe("Waiting for you: 1 change to confirm");
    expect(line([change("r1", "undo"), change("r2", "settings.set")])).toBe(
      "Waiting for you: 2 changes to confirm",
    );
    expect(
      line([change("r1", "settings.set"), { id: "r2", change_card: { key: "person:questions" } }]),
    ).toBe("Waiting for you: 1 change to confirm and 1 question");
  });
});
