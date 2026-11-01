import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { seedFromMessage } from "../src/pages/project/NewTaskDialog.tsx";
import { createStore } from "../src/store/store.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * The chat (design §3.9): one conversation per project, kept by the daemon and shown the same
 * in the project's Chat tab and in Talk; a reply's changes as plain sentences with one Undo; a
 * Yes/No card that stays until it is answered; "Make this a task" only under the person's own
 * lines; three example phrases under the input.
 */
describe("Quick chat", () => {
  it("streams the reply, with no first-token badge or cost chip on it", async () => {
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
    await waitFor(() =>
      expect(screen.getByTestId("chat-agent")).toHaveTextContent(
        /Atlas: you asked "what happened last session\?"/,
      ),
    );
    const agent = screen.getByTestId("chat-agent");
    expect(agent).toHaveAttribute("data-streaming", "false");
    // Before (the 2026-11-01 walk): "first token 420 ms" and "CHF 0.01" under every reply.
    expect(agent).not.toHaveTextContent(/first token/);
    expect(agent).not.toHaveTextContent("CHF 0.01");
    const call = postedCalls(harness, "/chat/stream")[0]?.body as Record<string, unknown>;
    expect(call).toMatchObject({
      humanId: "human_alice",
      agentId: "agent_alice",
      projectId: "proj_atlas",
      projectTab: true,
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
    await waitFor(() =>
      expect(screen.getByTestId("chat-agent")).toHaveTextContent(
        'Added "write the README" to Atlas.',
      ),
    );
    expect(screen.getByTestId("chat-agent")).not.toHaveTextContent(/fr setup/);
    expect(harness.daemon.state.tasks.find((t) => t.title === "write the README")?.status).toBe(
      "ready",
    );
    // A command that acted is no line to make a task of (design §3.9).
    expect(within(screen.getByTestId("chat-human")).queryByTestId("make-task")).toBeNull();

    await user.type(input, "What should we do first?");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getAllByTestId("chat-agent")).toHaveLength(2));
    const told = screen.getAllByTestId("chat-agent")[1] as HTMLElement;
    await waitFor(() =>
      expect(told).toHaveTextContent("No Claude key or subscription is set up yet"),
    );
    expect(told).toHaveTextContent("Settings → Accounts and keys → Open the setup assistant");
    expect(told).not.toHaveTextContent(/fr setup/);
    // No error: the line was answered, not refused.
    expect(within(told).queryByText(/HTTP 503|provider_auth/)).toBeNull();
  });

  it("shows the read-back once on a Yes/No card and sends the word yes; the change reads as a sentence", async () => {
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
    // Shown once: the reply's own text does not repeat the read-back (the walk saw it twice).
    expect(screen.getAllByText(/You want to start a session/)).toHaveLength(1);
    await user.click(within(confirmation).getByTestId("confirm-yes"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(2));
    const second = postedCalls(harness, "/chat/stream")[1]?.body as { text?: string } | undefined;
    expect(second?.text).toBe("yes");
    await waitFor(() =>
      expect(screen.queryByTestId("pending-confirmation")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getAllByTestId("chat-agent")).toHaveLength(2));
    const agents = screen.getAllByTestId("chat-agent");
    expect(agents[1]).toHaveTextContent("Confirmed. Starting the session now.");
    // No raw command chip ("session_start: ...", "task.create: ...").
    expect(agents[1]).not.toHaveTextContent(/session_start|session\.start:/);
    // The answered read-back says what became of it.
    expect(screen.getByTestId("readback-closed")).toHaveTextContent("(you said yes)");
  });

  it("a question typed while a card waits does not drop the card (design §3.9)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "please start a session");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByTestId("pending-confirmation");
    await user.type(input, "how much will it cost?");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getAllByTestId("chat-agent")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getAllByTestId("chat-agent")[1]).toHaveAttribute("data-streaming", "false"),
    );
    // Before: the card's buttons vanished with no word once another line was typed.
    const card = screen.getByTestId("pending-confirmation");
    expect(within(card).getByTestId("confirm-yes")).toBeEnabled();
  });

  it("keeps the conversation and an unanswered Yes/No card across a tab switch and a reload: the daemon keeps them (U-071)", async () => {
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

    // A reload: a new store over empty browser storage; the daemon has the conversation.
    first.unmount();
    const blank = new Map<string, string>();
    const emptyStorage = {
      get: (k: string) => blank.get(k) ?? null,
      set: (k: string, v: string) => void blank.set(k, v),
      remove: (k: string) => void blank.delete(k),
    };
    const reloaded = {
      ...harness,
      storage: emptyStorage,
      store: createStore(harness.store.getState().config, emptyStorage),
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
    await screen.findByTestId("chat-empty");
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
    // A "yes" after the card was answered here asks what it is for.
    await user.type(input, "yes");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getAllByTestId("chat-agent")).toHaveLength(3));
    expect(screen.getAllByTestId("chat-agent")[2]).toHaveTextContent(
      "Yes to what? Nothing is waiting for your yes.",
    );
  });

  // Review of fix/chat (2026-11-01): after "stop everything" in Chat the header showed no
  // stopped bar until the window was reloaded (it read the kill state at start only).
  it("'stop everything' shows the header's stopped bar at once; 'resume' takes it away", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    expect(screen.queryByTestId("kill-banner")).toBeNull();
    await user.type(input, "stop everything");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-agent")).toHaveTextContent("Stopped every running session."),
    );
    await waitFor(() => expect(screen.getByTestId("kill-banner")).toBeInTheDocument());
    await user.type(input, "resume");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getAllByTestId("chat-agent")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("kill-banner")).toBeNull());
  });

  it("turns your own message into a ready task through the prefilled dialog (U-016); never an agent's reply", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "Add a dark mode toggle to the docs site");
    await user.click(screen.getByTestId("chat-send"));
    const agent = await screen.findByTestId("chat-agent");
    await waitFor(() => expect(agent).toHaveAttribute("data-streaming", "false"));
    // "Make this a task" only under the person's own lines (design §3.9).
    expect(within(agent).queryByTestId("make-task")).toBeNull();
    const human = screen.getByTestId("chat-human");
    await user.click(within(human).getByTestId("make-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    expect(within(dialog).getByTestId("task-title")).toHaveValue(
      "Add a dark mode toggle to the docs site",
    );
    expect(within(dialog).getByTestId("task-outcome")).toHaveValue(
      "Add a dark mode toggle to the docs site",
    );
    // No draft choice in New task (design §3.5): what the person adds is ready for a session.
    expect(within(dialog).queryByTestId("task-status")).toBeNull();
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body).toMatchObject({
      title: "Add a dark mode toggle to the docs site",
      status: "ready",
    });
    expect(await screen.findByTestId("task-created")).toHaveTextContent("Task created");
  });

  it("offers three example phrases under the input; one fills it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const examples = await screen.findByTestId("chat-examples");
    expect(examples).toHaveTextContent("what is left?");
    expect(examples).toHaveTextContent("add a task: …");
    expect(examples).toHaveTextContent("stop after this task");
    await user.click(within(examples).getByText("stop after this task"));
    expect(screen.getByTestId("chat-input")).toHaveValue("stop after this task");
  });

  it("derives a short title from the first line", () => {
    const seed = seedFromMessage(`${"x".repeat(100)}\nsecond line`);
    expect(seed.title).toHaveLength(80);
    expect(seed.title.endsWith("…")).toBe(true);
    expect(seed.status).toBe("ready");
    expect(seedFromMessage("ok").title).toBe("ok (from chat)");
  });
});

describe("Talk shows the conversation of the project on screen (design §3.9)", () => {
  it("on a project page, Talk shows the Chat tab's lines and what is typed there reaches the Chat tab", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "what happened last session?");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-agent")).toHaveAttribute("data-streaming", "false"),
    );

    await user.click(screen.getByTestId("talk-open"));
    const talk = await screen.findByTestId("conversation");
    expect(within(talk).getByTestId("conversation-about")).toHaveTextContent("About Atlas");
    // Before: Talk started empty and kept its own lines, so the two disagreed.
    expect(await within(talk).findByTestId("conversation-human")).toHaveTextContent(
      "what happened last session?",
    );
    await user.type(within(talk).getByTestId("conversation-input"), "add a task: write the FAQ");
    await user.click(within(talk).getByTestId("conversation-send"));
    await waitFor(() => expect(within(talk).getAllByTestId("conversation-agent")).toHaveLength(2));
    // Talk spoke about the project on screen, not a hidden "active" one.
    const sent = postedCalls(harness, "/chat/stream")[1]?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ projectId: "proj_atlas", projectTab: true });
    // The Chat tab behind it shows the same new turn.
    await waitFor(() => expect(screen.getAllByTestId("chat-human")).toHaveLength(2));
    expect(screen.getAllByTestId("chat-human")[1]).toHaveTextContent("add a task: write the FAQ");
  });

  it("on Home, Talk is the conversation outside any project", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await user.click(await screen.findByTestId("talk-open"));
    const talk = await screen.findByTestId("conversation");
    expect(within(talk).getByTestId("conversation-about")).toHaveTextContent(
      "Not about one project",
    );
    const input = within(talk).getByTestId("conversation-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "what needs me?");
    await user.click(within(talk).getByTestId("conversation-send"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(1));
    const sent = postedCalls(harness, "/chat/stream")[0]?.body as Record<string, unknown>;
    expect(sent).not.toHaveProperty("projectId");
    expect(await within(talk).findByTestId("conversation-human")).toHaveTextContent(
      "what needs me?",
    );
  });
});
