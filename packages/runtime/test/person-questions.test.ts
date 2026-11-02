import { SIGNOFF_KEY } from "@forerunner/critic";
import type { HumanRequestRow, JsonObject } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import {
  isPersonTask,
  PERSON_QUESTIONS_KEY_PREFIX,
  personQuestionsCardOf,
  questionsForTask,
  reportedQuestions,
} from "../src/session/person-questions.ts";
import {
  ANSWER_CARD_KEYS,
  acceptsAnswer,
  CANCEL_TASK_OPTION,
  personQuestionsAnswer,
} from "../src/wiring/request-answers.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/**
 * U-022: a task whose acceptance criteria need the person's answers went to a specialist,
 * which cannot ask: the run did nothing, the critic graded it "human", the retry ladder ran it
 * four times at a cost, and the Inbox then showed a critic sign-off with nothing to answer.
 * Here: which tasks are the person's, what a run's report asks, what the card's reader takes,
 * and the critic path (a report that needs the person's answers files the questions, never a
 * sign-off, and the ladder stops at the first verdict). The daemon journey (planned tasks,
 * the specialist's tool, answers in the Inbox, a restart) is `person-questions-daemon.test.ts`.
 */

describe("which tasks are the person's (U-022)", () => {
  it("the explicit field, and the 1.0.3 plan's title from the owner's data", () => {
    expect(isPersonTask({ title: "Pick the hosting", specialist: "person" })).toBe(true);
    expect(isPersonTask({ title: "Pick the hosting", specialist: "coder" }, "Person")).toBe(true);
    expect(isPersonTask({ title: "Pick the hosting", specialist: "human" })).toBe(true);
    expect(
      isPersonTask({
        title: "Confirm stack, hosting and repository with the human",
        specialist: "ops",
      }),
    ).toBe(true);
    expect(isPersonTask({ title: "Ask the owner which domain to use", specialist: null })).toBe(
      true,
    );
    expect(isPersonTask({ title: "Get the human's decision on pricing", specialist: null })).toBe(
      true,
    );
  });

  it("a title the person wrote in the first person asks them (walk-needs-me: 'Confirm the hosting choice with me' went to a coder)", () => {
    for (const title of [
      "Confirm the hosting choice with me",
      "Check with me which quotes to use",
      "Ask me which colours to use",
      "Decide the domain with me",
    ])
      expect(isPersonTask({ title, specialist: null }), title).toBe(true);
  });

  it("work for a specialist is not mistaken for a question", () => {
    for (const title of [
      "Add a user confirmation dialog",
      "Implement the owner dashboard",
      "Write the README",
      "Confirm the build passes on Windows",
      "Let a person reset their password",
      "Add a 'remember me' checkbox",
      "Write the about me page",
    ])
      expect(isPersonTask({ title, specialist: "coder" }), title).toBe(false);
  });

  it("asks the criteria that are questions, else one question per thing the title names", () => {
    expect(
      questionsForTask({
        title: "Pick the hosting",
        outcome: "",
        acceptance_criteria: ["Which hosting provider?", "Which domain?", "Recorded in 0001"],
      }),
    ).toEqual(["Which hosting provider?", "Which domain?"]);
    expect(
      questionsForTask({
        title: "Confirm stack, hosting and repository with the human",
        outcome: "",
        acceptance_criteria: ["Stack confirmed", "Hosting confirmed"],
      }),
    ).toEqual([
      "Stack: what do you choose?",
      "Hosting: what do you choose?",
      "Repository: what do you choose?",
    ]);
  });

  it("a question over 500 characters is shortened at a word and stays a question (ADR 0103)", () => {
    // The planner may write a long question (the limit is in its prompt, not enforced on it).
    // Before, it was cut mid-word at 500 characters, lost its "?" and stopped being a question.
    const long = `Which hosting do you want for the page, ${"given that the quotes are bundled and nothing runs on a server, ".repeat(9)}or none at all?`;
    expect(long.length).toBeGreaterThan(500);
    const [q, other] = questionsForTask({
      title: "Decide the hosting",
      outcome: "",
      acceptance_criteria: [long, "Which domain?"],
    });
    expect(q?.length).toBeLessThanOrEqual(500);
    expect(q).toMatch(/[a-z]…\?$/);
    expect(long.startsWith((q ?? "").slice(0, -2))).toBe(true);
    // Cut at a word: what follows the kept text in the question is a space or a comma.
    expect(long.charAt((q ?? "").length - 2)).toMatch(/[ ,]/);
    expect(other).toBe("Which domain?");
  });
});

describe("what a run reports (U-022)", () => {
  it("a 'Questions for the person:' list", () => {
    expect(
      reportedQuestions(
        "Nothing deployed.\n\nQuestions for the person:\n- Which hosting provider?\n- Which domain?\n\nLesson: ask first.",
      ),
    ).toEqual({ questions: ["Which hosting provider?", "Which domain?"] });
  });

  it("a sentence that the work needs the person's answers", () => {
    expect(
      reportedQuestions(
        "I cannot confirm the stack, hosting and repository: they need the human's decision. Which stack do you want?",
      ),
    ).toEqual({
      questions: [
        "I cannot confirm the stack, hosting and repository: they need the human's decision. Which stack do you want?",
      ],
    });
    expect(reportedQuestions("The repository is a decision that needs your answers.")).toEqual({
      questions: [],
    });
  });

  it("an ordinary report asks nothing", () => {
    expect(reportedQuestions("Done: the clamp has a test. Tests pass.")).toBeNull();
    expect(reportedQuestions("The form validates the user's input before it posts.")).toBeNull();
  });
});

describe("the card's reader (U-022)", () => {
  const card = {
    kind: "decision",
    options: [CANCEL_TASK_OPTION],
    change_card: { key: `${PERSON_QUESTIONS_KEY_PREFIX}t-1` },
  };

  it("is the reader the answer routes use, under the key the card is filed with", () => {
    expect(ANSWER_CARD_KEYS.personQuestionsPrefix).toBe(PERSON_QUESTIONS_KEY_PREFIX);
  });

  it("takes the Inbox form's answers, one text from anywhere else, and its option", () => {
    const form = {
      answers: [
        { question: "Which hosting provider?", answer: "Cloudflare" },
        { question: "Which domain?", answer: " " },
      ],
    };
    expect(personQuestionsAnswer(form)).toEqual({
      kind: "answers",
      answers: [{ question: "Which hosting provider?", answer: "Cloudflare" }],
    });
    expect(personQuestionsAnswer("TypeScript, Cloudflare, github.com/me/site")).toEqual({
      kind: "answers",
      answers: [{ question: null, answer: "TypeScript, Cloudflare, github.com/me/site" }],
    });
    expect(personQuestionsAnswer(CANCEL_TASK_OPTION)).toEqual({ kind: "cancel" });
    for (const a of [form, "TypeScript", CANCEL_TASK_OPTION])
      expect(acceptsAnswer(card, a)).toEqual({ ok: true });
  });

  it("refuses an answer that says nothing; the card stays open", () => {
    for (const a of ["  ", { answers: [{ question: "Which domain?", answer: "" }] }, {}])
      expect(acceptsAnswer(card, a)).toMatchObject({ ok: false, options: [CANCEL_TASK_OPTION] });
  });
});

describe("the critic path: a run that needs the person's answers (U-022)", () => {
  const report = [
    "Nothing deployed: where it runs is the human's decision, not mine.",
    "",
    "Questions for the person:",
    "- Which hosting provider should the site use?",
    "- Which domain should it live on?",
  ].join("\n");

  for (const verdict of ["human", "revise"] as const) {
    it(`a "${verdict}" verdict files the questions, not a sign-off, and the ladder stops at once`, async () => {
      const w = await loopWorld({
        replies: [
          submitReply(
            {
              grade: 30,
              verdict,
              summary: "Nothing was done: the hosting and the domain are the person's to choose.",
              findings: [
                {
                  severity: "major",
                  what: "Hosting not chosen",
                  required_action: "Get the person's choice",
                },
              ],
            },
            { times: 4 },
          ),
          closingReply(),
        ],
      });
      try {
        const task = await w.addTask("Set up the hosting");
        const executor = doneExecutor(w, { finalReport: report });
        const result = await w.start(w.runner(executor));
        // One attempt, one review: no rung of the ladder ran.
        expect(executor.executed).toEqual([task.id]);
        expect(result.retried).toEqual([]);
        expect(result.reviews).toHaveLength(1);
        expect(result.reviews[0]).toMatchObject({ decision: "human", attempt: 0 });
        const after = await w.store.task.mustGet(task.id);
        expect(after).toMatchObject({ status: "needs_human", attempt: 0 });
        // The Inbox holds the questions, not a sign-off.
        const open = await w.store.humanRequest.open({ humanId: w.human });
        const keys = open.map((r) => (r.change_card as JsonObject | null)?.key);
        expect(keys).not.toContain(SIGNOFF_KEY);
        const questions = open.find((r) => personQuestionsCardOf(r) !== null) as HumanRequestRow;
        expect(questions).toMatchObject({
          kind: "decision",
          task_id: task.id,
          blocking: true,
          options: [CANCEL_TASK_OPTION],
          steps: ["Which hosting provider should the site use?", "Which domain should it live on?"],
        });
        expect(questions.why).toContain('"Set up the hosting"');
        expect(questions.why).toContain("not retried");
        expect(personQuestionsCardOf(questions)).toMatchObject({
          source: "critic",
          on_answer: "ready",
          run_id: `run-${task.id}-0`,
        });
        // A second session does not run it again while it waits for the person.
        const again = await w.start(w.runner(executor));
        expect(executor.executed).toEqual([task.id]);
        expect(again.completed).toEqual([]);
      } finally {
        await w.close();
      }
    });
  }

  it("an accept does not close a run whose report lists questions for the person: they become its card (ADR 0104)", async () => {
    // Before ADR 0104 an accepted run was left alone whatever its report asked; live
    // ("Members chart", 2026-11-01) that left work that waits for the person marked Done.
    const w = await loopWorld({ replies: [submitReply(), closingReply()] });
    try {
      const task = await w.addTask("Write the hosting notes");
      const result = await w.start(w.runner(doneExecutor(w, { finalReport: report })));
      expect(result.completed).toEqual([]);
      expect((await w.store.task.mustGet(task.id)).status).toBe("needs_human");
      const open = await w.store.humanRequest.open({ humanId: w.human });
      const cards = open.filter((r) => personQuestionsCardOf(r) !== null);
      expect(cards.map((r) => r.steps)).toEqual([
        ["Which hosting provider should the site use?", "Which domain should it live on?"],
      ]);
    } finally {
      await w.close();
    }
  });

  it("an accepted run whose report mentions the person only in passing is left alone", async () => {
    const w = await loopWorld({ replies: [submitReply(), closingReply()] });
    try {
      const task = await w.addTask("Write the hosting notes");
      const result = await w.start(
        w.runner(
          doneExecutor(w, {
            finalReport:
              "Wrote docs/hosting.md. The person's earlier answer (Netlify) is used throughout.",
          }),
        ),
      );
      expect(result.completed).toEqual([task.id]);
      const open = await w.store.humanRequest.open({ humanId: w.human });
      expect(open.filter((r) => personQuestionsCardOf(r) !== null)).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
