import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { seedFromMessage } from "../src/pages/project/NewTaskDialog.tsx";
import { createStore } from "../src/store/store.ts";
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

  it("without a Claude key, a command still runs and any other line says where to add one (U-047)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ noModel: true });
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "add a task: write the README");
    await user.click(screen.getByTestId("chat-send"));
    const added = await screen.findByTestId("chat-agent");
    await waitFor(() => expect(added).toHaveAttribute("data-streaming", "false"));
    expect(added).toHaveTextContent('Created the ready task "write the README".');
    expect(added).not.toHaveTextContent(/fr setup/);
    expect(harness.daemon.state.tasks.find((t) => t.title === "write the README")?.status).toBe(
      "ready",
    );

    await user.type(input, "What should we do first?");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getAllByTestId("chat-agent")).toHaveLength(2));
    const told = screen.getAllByTestId("chat-agent")[1] as HTMLElement;
    await waitFor(() => expect(told).toHaveAttribute("data-streaming", "false"));
    expect(told).toHaveTextContent("No Claude key or subscription is set up yet");
    expect(told).toHaveTextContent("Settings → Accounts and keys → Open the setup assistant");
    expect(told).not.toHaveTextContent(/fr setup/);
    // No error: the line was answered, not refused.
    expect(within(told).queryByText(/HTTP 503|provider_auth/)).toBeNull();
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

  it("keeps the conversation and an unanswered Yes/No card across a tab switch and a reload (U-071)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const first = renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "please start a session");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByTestId("pending-confirmation");

    // Another tab and back: the conversation and the card are still there.
    await user.click(screen.getByTestId("tab-tasks"));
    await screen.findAllByTestId("task-row");
    expect(screen.queryByTestId("chat-human")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("tab-chat"));
    expect(await screen.findByTestId("chat-human")).toHaveTextContent("please start a session");
    expect(screen.getByTestId("pending-confirmation")).toHaveTextContent(
      "You want to start a session with a budget of CHF 4.00.",
    );

    // A reload: a new store over the same browser storage.
    first.unmount();
    const reloaded = {
      ...harness,
      store: createStore(harness.store.getState().config, harness.storage),
    };
    renderApp("/projects/proj_atlas/chat", reloaded);
    expect(await screen.findByTestId("chat-human")).toHaveTextContent("please start a session");
    const card = await screen.findByTestId("pending-confirmation");
    await waitFor(() => expect(screen.getByTestId("chat-input")).toBeEnabled());
    await user.click(within(card).getByTestId("confirm-yes"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(2));
    const answer = postedCalls(harness, "/chat/stream")[1]?.body as { text?: string } | undefined;
    expect(answer?.text).toBe("yes");
    await waitFor(() =>
      expect(screen.queryByTestId("pending-confirmation")).not.toBeInTheDocument(),
    );
  });

  it("keeps each project's conversation apart (U-071)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "what happened last session?");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByTestId("chat-human");
    await waitFor(() =>
      expect(screen.getByTestId("chat-agent")).toHaveAttribute("data-streaming", "false"),
    );
    await user.click(screen.getByTestId("active-project"));
    await user.click(within(screen.getByTestId("project-switcher")).getByText("Beacon"));
    await user.click(await screen.findByTestId("tab-chat"));
    await screen.findByTestId("chat-input");
    expect(screen.queryByTestId("chat-human")).not.toBeInTheDocument();
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
