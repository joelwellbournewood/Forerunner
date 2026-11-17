import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * d1109-selftasks-run, run C (ST-11; ADR 0119 point 7): the agent's suggested changes to its own
 * task list as the Inbox shows them, against the fake daemon in step with the real one (the
 * same card is answered through the real daemon in `real-daemon.test.ts`, describe
 * "d1109-selftasks-run, run C"). The owner, 2026-11-09: the agent fixes its tasks, "the
 * autonomy level deciding when it asks first"; at Assisted it asks on ONE card.
 */

const SPLIT_LINE =
  'Split "Decide the versioning scheme" into "Decide the versioning scheme: numbers" and "Decide the versioning scheme: tags".';
const ADD_LINE = 'Add "Check that the release notes name each change".';

/** The card as the daemon's `fileTaskProposal` files it for task_3 of Atlas. */
function suggestion() {
  return {
    id: "req_tasks",
    projectId: "proj_atlas",
    projectName: "Atlas",
    taskId: null,
    taskTitle: null,
    sessionId: "sess_1",
    kind: "decision",
    why: `The coder's report on "Index the documentation pages" says: "'Decide the versioning scheme' is two jobs, the numbers and the tags". Nothing changes until you say yes.`,
    steps: [
      SPLIT_LINE,
      ADD_LINE,
      'Asks you first: "Decide the versioning scheme" is a task you added or changed yourself.',
    ],
    options: ["Make these changes", "Keep the tasks"],
    blocking: false,
    risk: "low" as const,
    changeCard: {
      key: "task_proposal",
      project_id: "proj_atlas",
      session_id: "sess_1",
      fingerprint: "0123456789abcdef",
      changes: [
        {
          line: SPLIT_LINE,
          calls: [
            {
              name: "task.split",
              params: {
                task: "task_3",
                parts: [
                  { title: "Decide the versioning scheme: numbers", acceptance_criteria: [] },
                  { title: "Decide the versioning scheme: tags", acceptance_criteria: [] },
                ],
                order: "in_turn",
                why: "The report says it is two jobs.",
              },
            },
          ],
        },
        {
          line: ADD_LINE,
          calls: [
            {
              name: "task.create",
              params: {
                title: "Check that the release notes name each change",
                outcome: "Checked: the release notes name each change",
                acceptance_criteria: ["the release notes name each change"],
                specialist: "coder",
                depends_on: ["task_1"],
                before: [],
                status: "ready",
                risk_tier: 1,
                project: "proj_atlas",
                why: "Nothing checks the release notes.",
              },
            },
          ],
        },
      ],
      quotes: [],
      reasons: ['"Decide the versioning scheme" is a task you added or changed yourself'],
    },
    status: "open",
    answer: null,
    createdAt: "2026-10-31T09:00:00.000Z",
    version: 1,
  };
}

function setUp() {
  const harness = createHarness();
  harness.daemon.state.requests.unshift(suggestion());
  return harness;
}

const cardOf = async () =>
  (await screen.findAllByTestId("request")).find(
    (r) => r.getAttribute("data-request-id") === "req_tasks",
  ) as HTMLElement;

describe("d1109-selftasks-run, run C: the agent's suggested task changes in the Inbox", () => {
  it("names the project and the count, quotes what showed it, lists each change, and says what each answer does", async () => {
    renderApp("/inbox", setUp());
    const card = await cardOf();
    expect(within(card).getByTestId("request-title")).toHaveTextContent(
      "Atlas: the agent suggests 2 changes to the tasks",
    );
    expect(within(card).getByTestId("request-body")).toHaveTextContent(
      `The coder's report on "Index the documentation pages" says: "'Decide the versioning scheme' is two jobs, the numbers and the tags". Nothing changes until you say yes.`,
    );
    expect(
      within(card)
        .getAllByTestId("option")
        .map((b) => b.textContent),
    ).toEqual(["Make these changes", "Keep the tasks"]);
    expect(
      within(card)
        .getAllByTestId("option-explain")
        .map((e) => e.textContent),
    ).toEqual(["Changes the tasks as listed; one Undo takes them back.", "Nothing changes."]);
    // d1109-selftasks-chat (SC-9): the changes show open, never under a collapsed Details.
    const details = within(card).getByTestId("request-details-open");
    expect(details.closest("details")).toBeNull();
    expect(within(card).queryByTestId("request-details")).not.toBeInTheDocument();
    expect(details).toHaveTextContent(SPLIT_LINE);
    expect(details).toHaveTextContent(ADD_LINE);
    expect(details).toHaveTextContent(
      'Asks you first: "Decide the versioning scheme" is a task you added or changed yourself.',
    );
    expect(card).not.toHaveTextContent(/task_proposal|fingerprint|task\.split|plan_fix/);
  });

  it("Make these changes: the Done line, the tasks changed, one Changes row whose Undo takes the set back; no session starts", async () => {
    const user = userEvent.setup();
    const harness = setUp();
    const sessions = harness.daemon.state.sessions.length;
    renderApp("/inbox", harness);
    const card = await cardOf();
    await user.click(within(card).getByRole("button", { name: "Make these changes" }));
    await waitFor(() =>
      expect(postedCalls(harness, "/requests/req_tasks/answer")[0]?.body).toEqual({
        version: 1,
        answer: "Make these changes",
      }),
    );
    expect(await screen.findByTestId("done-line")).toHaveTextContent(
      "Done: Changed 2 tasks; your next Start runs them.",
    );
    const tasks = await harness.client.tasks("proj_atlas");
    const titles = tasks.map((t) => t.title);
    expect(titles).toContain("Decide the versioning scheme: numbers");
    expect(titles).toContain("Decide the versioning scheme: tags");
    expect(titles).toContain("Check that the release notes name each change");
    const rows = (await harness.client.changes({ projectId: "proj_atlas" })).filter(
      (c) => c.wordsUsed === "Make these changes",
    );
    expect(rows.map((r) => [r.source, r.undoable, r.sentence])).toEqual([
      [
        "ui",
        true,
        'Split "Decide the versioning scheme" into "Decide the versioning scheme: numbers" and "Decide the versioning scheme: tags". Added "Check that the release notes name each change" to Atlas, for the coder.',
      ],
    ]);
    expect(harness.daemon.state.sessions.length).toBe(sessions);
    const undone = await harness.client.undoChange(rows[0]?.id ?? "");
    expect(undone.sentence).toBe(
      'Undone: "Decide the versioning scheme" is one task again; cancelled the task "Check that the release notes name each change" you created.',
    );
    const back = await harness.client.tasks("proj_atlas");
    expect(back.find((t) => t.id === "task_3")?.title).toBe("Decide the versioning scheme");
    expect(
      back.filter((t) => t.title.startsWith("Decide the versioning scheme:")).map((t) => t.status),
    ).toEqual(["cancelled"]);
  });

  it("Keep the tasks: the Done line says nothing changed, and nothing did", async () => {
    const user = userEvent.setup();
    const harness = setUp();
    const before = (await harness.client.tasks("proj_atlas")).map((t) => [t.id, t.title]);
    const changes = (await harness.client.changes()).length;
    renderApp("/inbox", harness);
    const card = await cardOf();
    await user.click(within(card).getByRole("button", { name: "Keep the tasks" }));
    expect(await screen.findByTestId("done-line")).toHaveTextContent(
      "Done: Kept the tasks as they are; nothing changed.",
    );
    expect((await harness.client.tasks("proj_atlas")).map((t) => [t.id, t.title])).toEqual(before);
    expect((await harness.client.changes()).length).toBe(changes);
  });
});
