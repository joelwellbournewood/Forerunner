import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createClient } from "../src/api/client.ts";
import { reviewLevelChoices, specialistName } from "../src/lib/task-actions.ts";
import { TASKS } from "./fixtures.ts";
import {
  createHarness,
  fetchFromApp,
  type Harness,
  postedCalls,
  renderApp,
  testConfig,
} from "./helpers.tsx";

/**
 * polish-words (wave 13): what the screens say, read where the person reads it, with the fake
 * daemon wording the rows through the daemon's own `task-words` (design §5: one sentence read
 * at a glance, true when read, names not ids). Each case clicks what the person clicks.
 */

const rowOf = async (id: string) =>
  (await screen.findAllByTestId("task-row")).find(
    (r) => r.getAttribute("data-task-id") === id,
  ) as HTMLElement;
const actionsOf = (row: HTMLElement) =>
  within(row)
    .queryAllByTestId(/^action-/)
    .map((b) => b.textContent);

function addTask(
  harness: Harness,
  id: string,
  title: string,
  extra: Partial<(typeof TASKS)[number]> = {},
) {
  harness.daemon.state.tasks.push({
    ...(TASKS[2] as (typeof TASKS)[number]),
    id,
    title,
    riskTier: 1,
    prUrl: null,
    ...extra,
  });
}

function addCard(harness: Harness, id: string, taskId: string, changeCard: object) {
  harness.daemon.state.requests.push({
    ...(harness.daemon.state.requests[0] as (typeof harness.daemon.state.requests)[number]),
    id,
    taskId,
    projectId: "proj_atlas",
    status: "open",
    why: "seed",
    changeCard: changeCard as never,
  });
}

describe("polish-words, wave 13: the Tasks screen", () => {
  it("a task waiting on its sign-off reads 'Needs your sign-off' and offers Answer and Cancel, row and drawer (C-21, L-9)", async () => {
    const harness = createHarness();
    addTask(harness, "t_deploy", "Deploy the page", {
      status: "needs_human",
      specialist: "ops-deploy",
      riskTier: 3,
    });
    addCard(harness, "req_signoff", "t_deploy", {
      key: "critic:signoff",
      task_id: "t_deploy",
      reason: "verdict",
    });
    renderApp("/projects/proj_atlas/tasks?task=t_deploy", harness);
    const row = await rowOf("t_deploy");
    expect(within(row).getByTestId("task-status")).toHaveTextContent("Needs your sign-off");
    expect(row).not.toHaveTextContent(/decision|try again/i);
    expect(actionsOf(row)).toEqual(["Answer", "Cancel"]);
    const drawer = await screen.findByTestId("task-drawer");
    expect(drawer).toHaveTextContent(
      "Its card is in the Inbox: accept the work, send it back, or cancel it.",
    );
    expect(within(drawer).queryByTestId("drawer-action-try_again")).toBeNull();
    expect(within(drawer).getByTestId("drawer-action-answer")).toBeInTheDocument();
    expect(within(drawer).getByTestId("drawer-action-cancel")).toBeInTheDocument();
  });

  it("Answer on the row and the drawer's Open go to the task's own card in the Inbox, as Home's Answer does (later #55 sibling)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_deploy", "Deploy the page", {
      status: "needs_human",
      specialist: "ops-deploy",
      riskTier: 3,
    });
    addCard(harness, "req_signoff", "t_deploy", {
      key: "critic:signoff",
      task_id: "t_deploy",
      reason: "verdict",
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    const row = await rowOf("t_deploy");
    await user.click(within(row).getByTestId("action-answer"));
    // The Inbox opens at that card (`useScrollToHash` marks it), not at the top of the list.
    await waitFor(() =>
      expect(document.getElementById("card-req_signoff")).toHaveAttribute("data-targeted", "true"),
    );
  });

  it("the drawer's Open beside a card links to that card", async () => {
    const harness = createHarness();
    addTask(harness, "t_deploy", "Deploy the page", {
      status: "needs_human",
      specialist: "ops-deploy",
      riskTier: 3,
    });
    addCard(harness, "req_signoff", "t_deploy", {
      key: "critic:signoff",
      task_id: "t_deploy",
      reason: "verdict",
    });
    renderApp("/projects/proj_atlas/tasks?task=t_deploy", harness);
    const cards = await screen.findByTestId("drawer-cards");
    expect(within(cards).getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/inbox#card-req_signoff",
    );
  });

  it("Cancel on a paused task says its work is set aside in the drawer as in the dialog (P7-21)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_paused", "Write the long guide", { status: "needs_human" });
    // W15-56: its run wrote part of the guide before the pause (the daemon reads the run).
    harness.daemon.state.taskMeta.heldWork?.add("t_paused");
    addCard(harness, "req_budget", "t_paused", {
      key: "task:budget_stop",
      task_id: "t_paused",
      source: "task",
    });
    renderApp("/projects/proj_atlas/tasks?task=t_paused", harness);
    const drawer = await screen.findByTestId("task-drawer");
    const line =
      "Drops it. Its work so far is set aside unless a later task built on it; Undo brings it back.";
    expect(within(drawer).getByTestId("drawer-explain-cancel")).toHaveTextContent(line);
    // The row's button says the same, and the dialog.
    const row = await rowOf("t_paused");
    expect(within(row).getByTestId("action-cancel")).toHaveAttribute("title", line);
    await user.click(within(row).getByTestId("action-cancel"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("action-explain")).toHaveTextContent(line);
  });

  it("Cancel on a ready task holding work in progress says it is set aside (row, dialog and drawer), and the line after says so (P7-20)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    addTask(harness, "t_held", "Write the guide in guide.md", { status: "ready" });
    harness.daemon.state.taskMeta.heldWork?.add("t_held");
    addTask(harness, "t_plain", "Write the notes", { status: "ready" });
    renderApp("/projects/proj_atlas/tasks?task=t_held", harness);
    const line =
      "Drops it. Its work so far is set aside unless a later task built on it; Undo brings it back.";
    const drawer = await screen.findByTestId("task-drawer");
    expect(within(drawer).getByTestId("drawer-explain-cancel")).toHaveTextContent(line);
    // A ready task with no work in progress: Drops it, and nothing else.
    expect(within(await rowOf("t_plain")).getByTestId("action-cancel")).toHaveAttribute(
      "title",
      "Drops it.",
    );
    const row = await rowOf("t_held");
    expect(within(row).getByTestId("action-cancel")).toHaveAttribute("title", line);
    await user.click(within(row).getByTestId("action-cancel"));
    const dialog = await screen.findByTestId("action-dialog");
    expect(within(dialog).getByTestId("action-explain")).toHaveTextContent(line);
    await user.click(within(dialog).getByTestId("confirm-action"));
    expect(await screen.findByTestId("task-moved-sentence")).toHaveTextContent(
      'Cancelled "Write the guide in guide.md": its work so far is set aside; Undo brings it back.',
    );
    expect(postedCalls(harness, "/tasks/t_held/action").map((c) => c.body)).toEqual([
      { version: 1, action: "cancel" },
    ]);
  });

  it("the cap line names the specialist as the log does, and none for Agent's choice (later #74)", async () => {
    const harness = createHarness();
    addTask(harness, "t_writer", "Write the launch post", {
      status: "ready",
      specialist: "writer-marketing",
    });
    renderApp("/projects/proj_atlas/tasks", harness);
    const row = await rowOf("t_writer");
    const cap = within(row).getByTestId("task-cap");
    expect(cap).toHaveTextContent("(the writer's limit)");
    expect(cap).not.toHaveTextContent("writer-marketing");
    // The UI's names are the critic's (the session log's and the cards'): real-daemon.test.ts's
    // polish-words block holds them equal to `saidByName`.
    expect(specialistName("writer-marketing")).toBe("writer");
    expect(specialistName(null)).toBeNull();
  });

  it("a pull request that conflicts reads 'Accepted · conflicts with main' on its row and says what to do in the drawer; the mergeable one waits for the Merge (W14-5)", async () => {
    const harness = createHarness();
    addTask(harness, "t_conflict", "Write the notes", {
      status: "done",
      prUrl: "https://github.com/o/r/pull/3",
    });
    addTask(harness, "t_mergeable", "Write the guide", {
      status: "done",
      prUrl: "https://github.com/o/r/pull/2",
    });
    // As the daemon's merge records (`TaskDisplayContext.merges`): the conflict notice's.
    harness.daemon.state.taskMeta.merges?.set("t_conflict", {
      state: "left_to_you",
      approval: "none",
      pr_number: 3,
      sentence:
        "#3 conflicts with main in README.md: resolve the conflict on GitHub, or redo the task.",
      last_outcome: "conflict",
    });
    harness.daemon.state.taskMeta.merges?.set("t_mergeable", {
      state: "left_to_you",
      approval: "none",
      pr_number: 2,
      sentence: "#2 waits for you: press Merge on the Overview.",
    });
    renderApp("/projects/proj_atlas/tasks?task=t_conflict", harness);
    const row = await rowOf("t_conflict");
    expect(within(row).getByTestId("task-status")).toHaveTextContent(
      "Accepted · conflicts with main",
    );
    expect(row).not.toHaveTextContent(/waiting for you to merge|fr\//);
    expect(within(await rowOf("t_mergeable")).getByTestId("task-status")).toHaveTextContent(
      "Accepted · waiting for you to merge",
    );
    const drawer = await screen.findByTestId("task-drawer");
    expect(within(drawer).getByTestId("drawer-status")).toHaveTextContent(
      "Accepted · conflicts with main",
    );
    expect(drawer).toHaveTextContent(
      "#3 conflicts with main in README.md: resolve the conflict on GitHub, or redo the task.",
    );
  });

  it("New task's light review says what is true now, with no tier or checks words (C-23)", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/tasks");
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    const level = within(dialog).getByTestId("task-risk-tier") as HTMLSelectElement;
    const labels = [...level.options].map((o) => o.textContent ?? "");
    expect(labels).toContain(
      "Light review: the critic reads the work and tries it here; nothing runs in Docker",
    );
    for (const l of reviewLevelChoices(null).map((c) => c.label)) {
      expect(l).not.toMatch(/tier|checks|isolation/i);
      expect(l.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("polish-words, wave 13: the Inbox plan card", () => {
  /** A harness whose answers wait until `release()`: what the card shows while one works. */
  function heldAnswers() {
    const harness = createHarness();
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const fetchApp = fetchFromApp(harness.daemon.app);
    harness.client = createClient(testConfig(), async (input, init) => {
      const url = input;
      if (init?.method === "POST" && /\/requests\/[^/]+\/answer$/.test(url)) await held;
      return fetchApp(input, init);
    });
    return { harness, release: () => release() };
  }

  const planCard = (harness: Harness, repos: string[]) => {
    {
      const p = harness.daemon.state.projects.find((x) => x.id === "proj_atlas");
      if (p) p.repos = repos;
    }
    harness.daemon.state.requests.unshift({
      ...(harness.daemon.state.requests[0] as (typeof harness.daemon.state.requests)[number]),
      id: "req_plan",
      projectId: "proj_atlas",
      projectName: "Atlas",
      taskId: null,
      taskTitle: null,
      kind: "approval",
      why: 'Intake for "Atlas".',
      steps: [],
      options: ["Approve and start", "Change the plan", "Reject"],
      blocking: true,
      changeCard: {
        key: "intake:proj_atlas",
        docs_target: "workspace",
        applied_at: null,
        proposal: {
          plan: { tasks: [{ key: "notes", title: "Write the notes", specialist: "coder" }] },
          docs: { "README.md": "# Atlas" },
        },
      } as never,
      status: "open",
      answer: null,
    });
  };

  it("a one-task plan starts working on 'it', and the card says what it does while Approve works (L-20)", async () => {
    const user = userEvent.setup();
    const { harness, release } = heldAnswers();
    planCard(harness, []); // a folder project: no repository
    renderApp("/inbox", harness);
    const card = (await screen.findAllByTestId("request")).find(
      (c) => c.getAttribute("data-request-id") === "req_plan",
    ) as HTMLElement;
    expect(card).toHaveTextContent("Writes this task and starts working on it now.");
    expect(card).not.toHaveTextContent("working on them now");
    await user.click(within(card).getByRole("button", { name: "Approve and start" }));
    expect(await within(card).findByTestId("choice-working")).toHaveTextContent(
      "Writing the plan…",
    );
    release();
    await waitFor(() => expect(postedCalls(harness, "/requests/req_plan/answer")).toHaveLength(1));
  });

  it("on a repository the line names the docs pull request (L-20)", async () => {
    const user = userEvent.setup();
    const { harness, release } = heldAnswers();
    planCard(harness, ["o/atlas"]);
    renderApp("/inbox", harness);
    const card = (await screen.findAllByTestId("request")).find(
      (c) => c.getAttribute("data-request-id") === "req_plan",
    ) as HTMLElement;
    await user.click(within(card).getByRole("button", { name: "Approve and start" }));
    expect(await within(card).findByTestId("choice-working")).toHaveTextContent(
      "Writing the plan and its docs pull request…",
    );
    release();
  });
});

describe("polish-words, wave 13: same-titled tasks on the Overview (W14-7)", () => {
  it("two tasks titled alike render two Next lines with no duplicate-key error", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    try {
      const harness = createHarness();
      // Running ranks first in Next (at most three lines).
      addTask(harness, "t_guide_1", "Write the guide", {
        status: "in_progress",
        claimedBy: "agent_1",
      });
      addTask(harness, "t_guide_2", "Write the guide", {
        status: "in_progress",
        claimedBy: "agent_1",
      });
      renderApp("/projects/proj_atlas", harness);
      const next = await screen.findByTestId("next");
      await waitFor(() =>
        expect(
          within(next)
            .getAllByRole("listitem")
            .filter((li) => li.textContent?.startsWith('"Write the guide"')),
        ).toHaveLength(2),
      );
      expect(errors.filter((e) => /same key|two children with the same key/i.test(e))).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

// Keep `render` imported for later cases of this file.
void render;
