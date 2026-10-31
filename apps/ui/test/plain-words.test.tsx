import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { inAppText, withoutUndoWord } from "../src/lib/plain-words.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Plain words in the app (U-074): no "reply yes to the email" or "Say undo" on an app card, an
 * "Undo." that is a button (or goes), no ids where a name exists, no jargon without its meaning.
 */
describe("plain words (U-074)", () => {
  it("drops the voice and email hints the app has buttons for", () => {
    expect(
      inAppText(
        "Change: the monthly cap. From CHF 150 to CHF 200. Say yes to confirm, or reply yes to the email.",
      ),
    ).toBe("Change: the monthly cap. From CHF 150 to CHF 200.");
    expect(inAppText("Undo: Say undo or tap Undo in the change log.")).toBe(
      "Undo: Undo it from Changes.",
    );
    expect(withoutUndoWord("Created the task. Undo.")).toEqual({
      text: "Created the task.",
      undo: true,
    });
    expect(withoutUndoWord("Nothing to undo here.")).toEqual({
      text: "Nothing to undo here.",
      undo: false,
    });
  });

  it("Chat: the header promises only what happens, and a reply's Undo is a working button", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.nextChatReply =
      "Raised tonight's session budget for Atlas from CHF 5 to CHF 20, until 06:00. Undo.";
    harness.daemon.state.nextChatActions = [
      {
        kind: "budget.set",
        summary: "Raised tonight's session budget for Atlas from CHF 5 to CHF 20",
        id: "chg_2",
        undoToken: "chg_2",
      },
    ];
    renderApp("/projects/proj_atlas/chat", harness);
    expect(await screen.findByTestId("chat-intro")).toHaveTextContent(
      "A small change you ask for (a task, a note for the next session) is made at once, with Undo; a bigger one is read back first and waits for your Yes.",
    );
    expect(screen.getByTestId("chat-intro")).not.toHaveTextContent("need your confirmation");
    const input = screen.getByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "raise tonight's budget to 20");
    await user.click(screen.getByTestId("chat-send"));
    const agent = await screen.findByTestId("chat-agent");
    await waitFor(() => expect(agent).toHaveAttribute("data-streaming", "false"));
    expect(agent).toHaveTextContent("from CHF 5 to CHF 20, until 06:00.");
    expect(agent).not.toHaveTextContent("Undo.");
    await user.click(within(agent).getByTestId("chat-undo"));
    await waitFor(() => expect(postedCalls(harness, "/changes/chg_2/undo")).toHaveLength(1));
    expect(await within(agent).findByTestId("chat-undo-note")).toHaveTextContent(/^Undone/);
    expect(within(agent).queryByTestId("chat-undo")).not.toBeInTheDocument();
  });

  it("Chat: a read-back waiting for Yes says nothing about saying yes or email", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "please start a session");
    await user.click(screen.getByTestId("chat-send"));
    const card = await screen.findByTestId("pending-confirmation");
    expect(card).not.toHaveTextContent(/say yes|reply yes|email/i);
    expect(within(card).getByTestId("confirm-yes")).toBeInTheDocument();
  });

  it("Inbox: a message's spoken Undo is a link to Changes; an answer is shown as words, not JSON", async () => {
    const harness = createHarness();
    const first = harness.daemon.state.messages[0];
    if (!first) throw new Error("fixture changed");
    first.body = "Switched the active project to Beacon. Undo.";
    const answered = harness.daemon.state.requests[0];
    if (!answered) throw new Error("fixture changed");
    answered.status = "answered";
    answered.answer = { choice: "Semantic versions" };
    renderApp("/inbox", harness);
    const message = (await screen.findAllByTestId("message"))[0] as HTMLElement;
    expect(message).toHaveTextContent("Switched the active project to Beacon.");
    expect(message).not.toHaveTextContent("Undo.");
    expect(within(message).getByTestId("message-undo")).toHaveAttribute("href", "/changes");
    await userEvent.setup().click(screen.getByText(/answered or closed/));
    const closed = screen.getByText(/Which versioning scheme/).closest("li") as HTMLElement;
    expect(closed).toHaveTextContent("→ Semantic versions");
    expect(closed).not.toHaveTextContent("{");
  });

  it("Tasks: a dependency by its title, the review level in words, the critic's call plainly", async () => {
    renderApp("/projects/proj_atlas/tasks");
    const rows = await screen.findAllByTestId("task-row");
    const second = rows[1] as HTMLElement;
    expect(second).toHaveTextContent('after "Index the documentation pages"');
    expect(second).not.toHaveTextContent("task_1");
    expect(second).toHaveTextContent(/(checks only|light review|full review)/);
    expect(second).not.toHaveTextContent(/· tier \d/);
  });

  it("Project: the autonomy level is named and explained, not 'autonomy 2'", async () => {
    renderApp("/projects/proj_atlas/summary");
    const badge = await screen.findByTestId("project-autonomy");
    expect(badge).toHaveTextContent("autonomy: Standard (level 2)");
    expect(badge).toHaveAttribute("title", "routine, reversible actions run; the rest asks you");
  });

  it("Memory: a lesson names its project, not its id", async () => {
    renderApp("/memory");
    const project = (await screen.findAllByTestId("lesson-project"))[0];
    expect(project).toHaveTextContent("project Atlas");
    expect(project).not.toHaveTextContent("proj_");
  });
});
