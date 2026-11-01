import type { HumanRequestRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { personQuestionsKey } from "../src/session/person-questions.ts";
import {
  DecisionLog,
  decisionPairs,
  NO_ANSWER_CHOSEN,
  plainRows,
} from "../src/wiring/state-ports.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

const CARD_WHY =
  '"Decide where the page is published" needs your answers. No specialist works on it: answer the questions below. Your answers are written to the project\'s decision record (docs/decisions/0001-…). The task is then done.';
const QUESTIONS = [
  "Where should the page be published: GitHub Pages, Netlify, or only as a local file?",
  "Should the quotes be in English only?",
];
const FORM = {
  answers: [
    { question: QUESTIONS[0], answer: "Only as a local file for now; maybe GitHub Pages later." },
    { question: QUESTIONS[1], answer: "Yes, English only." },
  ],
};

function questionsCard(answer: unknown, over: Partial<HumanRequestRow> = {}) {
  return {
    why: CARD_WHY,
    steps: [...QUESTIONS],
    options: ["Cancel the task"],
    answer: answer as never,
    change_card: { key: personQuestionsKey("task-1") } as never,
    ...over,
  };
}

/**
 * The decision log in the person's words (design §3.4, §5 "Decision"). Before, an answered
 * questions card was one row whose question was the card's instructions and whose answer was
 * the form's JSON; Overview showed it with "(not: Cancel the task)" and the person's id, and
 * the memory lesson made from it was pasted into every specialist's brief.
 */
describe("decisions as plain question and answer pairs", () => {
  it("one pair per question, the answer in the person's words; go ahead without and cancel", () => {
    expect(decisionPairs(questionsCard(FORM))).toEqual([
      { question: QUESTIONS[0], chosen: FORM.answers[0]?.answer, options: [] },
      { question: QUESTIONS[1], chosen: "Yes, English only.", options: [] },
    ]);
    // One text from the chat or the phone answers the first question asked.
    expect(decisionPairs(questionsCard("Only locally."))).toEqual([
      { question: QUESTIONS[0], chosen: "Only locally.", options: [] },
    ]);
    expect(decisionPairs(questionsCard({ choice: "Go ahead without" }))).toEqual(
      QUESTIONS.map((question) => ({ question, chosen: NO_ANSWER_CHOSEN, options: [] })),
    );
    expect(decisionPairs(questionsCard("Cancel the task"))).toEqual([]);
    // Another decision card: its first sentence and the option's label, never JSON or an id.
    expect(
      decisionPairs({
        why: 'Merge the reviewed pull request of "Add login"? It passed review (run 01a196fe-2aa9-7114-a15e-2024baa5e65e).',
        steps: [],
        options: ["Merge", "Leave open"],
        answer: { choice: "Merge" } as never,
        change_card: { key: "merge:x" } as never,
      }),
    ).toEqual([
      {
        question: 'Merge the reviewed pull request of "Add login"?',
        chosen: "Merge",
        options: ["Merge", "Leave open"],
      },
    ]);
  });

  it("an old row holding the form's JSON reads as its pairs", () => {
    expect(plainRows({ question: CARD_WHY, chosen: JSON.stringify(FORM) })).toEqual([
      { question: QUESTIONS[0], chosen: FORM.answers[0]?.answer },
      { question: QUESTIONS[1], chosen: "Yes, English only." },
    ]);
    expect(plainRows({ question: "Which stack?", chosen: "TypeScript" })).toEqual([
      { question: "Which stack?", chosen: "TypeScript" },
    ]);
  });

  it("recordAnswer writes a row per question; a new answer supersedes it; and the next session's lesson is the sentence", async () => {
    const w = await loopWorld({
      replies: [submitReply({ grade: 90, verdict: "accept" }), closingReply()],
    });
    try {
      const log = new DecisionLog(w.store);
      const card = await w.store.humanRequest.insert({
        human_id: w.human,
        project_id: w.project,
        kind: "decision",
        why: CARD_WHY,
        steps: [...QUESTIONS],
        options: ["Cancel the task"],
        blocking: true,
        risk: "low",
        change_card: { key: personQuestionsKey("task-1") },
      } as never);
      const answered = await w.store.humanRequest.answer(
        card.id,
        card.version,
        FORM as never,
        w.human,
      );
      await log.recordAnswer(answered, w.human);
      const rows = await log.current(w.project);
      expect(rows.map((r) => [r.question, r.chosen, r.decided_by])).toEqual(
        expect.arrayContaining([
          [QUESTIONS[0], FORM.answers[0]?.answer, w.human],
          [QUESTIONS[1], "Yes, English only.", w.human],
        ]),
      );
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.chosen).not.toMatch(/[{}]/);

      // The next session turns the decisions into lessons a specialist can use.
      await w.addTask("Write the README");
      await w.start(w.runner(doneExecutor(w)));
      const lessons = (
        await w.store.lesson.search({ scope: "agent_private", ownerAgentId: w.alice })
      ).map((l) => l.text);
      const decisionLessons = lessons.filter((t) => t.startsWith("Decision for"));
      expect(decisionLessons).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            `${QUESTIONS[0]} Only as a local file for now; maybe GitHub Pages later.`,
          ),
        ]),
      );
      for (const t of decisionLessons) {
        expect(t).not.toMatch(/[{}]|->|answer the questions below|needs your answers/);
      }
    } finally {
      await w.close();
    }
  });
});
