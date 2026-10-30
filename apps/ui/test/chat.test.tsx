import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { seedFromMessage } from "../src/pages/project/NewTaskDialog.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Quick chat", () => {
  it("streams the reply and shows first-token time and cost", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "what happened last session?");
    await user.click(screen.getByTestId("chat-send"));
    expect(await screen.findByTestId("chat-human")).toHaveTextContent(
      "what happened last session?",
    );
    const agent = await screen.findByTestId("chat-agent");
    await waitFor(() => expect(agent).toHaveAttribute("data-streaming", "false"));
    expect(agent).toHaveTextContent(/Atlas: you asked "what happened last session\?"/);
    expect(agent).toHaveTextContent("first token 420 ms");
    expect(agent).toHaveTextContent("CHF 0.01");
    const call = postedCalls(harness, "/chat/stream")[0]?.body as Record<string, unknown>;
    expect(call).toMatchObject({
      humanId: "human_alice",
      agentId: "agent_alice",
      projectId: "proj_atlas",
      text: "what happened last session?",
      source: "text",
    });
  });

  it("shows a pending confirmation with Yes/No and sends the word yes", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "please start a session");
    await user.click(screen.getByTestId("chat-send"));
    const confirmation = await screen.findByTestId("pending-confirmation");
    expect(confirmation).toHaveTextContent(
      "You want to start a session with a budget of CHF 4.00.",
    );
    expect(confirmation).toHaveTextContent("Estimated CHF 4.00");
    await user.click(within(confirmation).getByTestId("confirm-yes"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(2));
    const second = postedCalls(harness, "/chat/stream")[1]?.body as { text?: string } | undefined;
    expect(second?.text).toBe("yes");
    await waitFor(() =>
      expect(screen.queryByTestId("pending-confirmation")).not.toBeInTheDocument(),
    );
    const agents = await screen.findAllByTestId("chat-agent");
    await waitFor(() =>
      expect(agents[1]).toHaveTextContent("Confirmed. Starting the session now."),
    );
    expect(agents[1]).toHaveTextContent("session_start");
  });

  it("sends no when declined", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "start a session now");
    await user.click(screen.getByTestId("chat-send"));
    const confirmation = await screen.findByTestId("pending-confirmation");
    await user.click(within(confirmation).getByTestId("confirm-no"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(2));
    const second = postedCalls(harness, "/chat/stream")[1]?.body as { text?: string } | undefined;
    expect(second?.text).toBe("no");
  });

  it("turns a message into a ready task through the prefilled dialog (U-016)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "Add a dark mode toggle to the docs site");
    await user.click(screen.getByTestId("chat-send"));
    const human = await screen.findByTestId("chat-human");
    await user.click(within(human).getByTestId("make-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    expect(within(dialog).getByTestId("task-title")).toHaveValue(
      "Add a dark mode toggle to the docs site",
    );
    expect(within(dialog).getByTestId("task-outcome")).toHaveValue(
      "Add a dark mode toggle to the docs site",
    );
    expect(within(dialog).getByTestId("task-status")).toHaveValue("ready");
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body).toMatchObject({
      title: "Add a dark mode toggle to the docs site",
      status: "ready",
    });
    expect(await screen.findByTestId("task-created")).toHaveTextContent("Task created");
  });

  it("derives a short title from the first line", () => {
    const seed = seedFromMessage(`${"x".repeat(100)}\nsecond line`);
    expect(seed.title).toHaveLength(80);
    expect(seed.title.endsWith("…")).toBe(true);
    expect(seed.status).toBe("ready");
    expect(seedFromMessage("ok").title).toBe("ok (from chat)");
  });
});
