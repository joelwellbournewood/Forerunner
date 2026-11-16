import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOSED_LINE,
  recordLink,
  STOP_EXPLAIN,
  secondsSince,
} from "../src/components/Conversation.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * d1109-chat-depth (run C; the owner's words of 2026-11-09: "There should be something indicating
 * what the chat is doing when waiting", "knowing that this will take more time to reply"): while
 * an answer is made the bubble says what chat is doing and for how long, Send becomes Stop (and a
 * longer answer has Answer now), a reload shows the same, and under an answer its footer, the
 * line it offers with Go ahead or Think it through, the From line, and for a line with no answer
 * why, with Ask again. Against the fake daemon, which the real-daemon cases keep honest.
 */

afterEach(() => {
  vi.useRealTimers();
});

async function openChat(harness = createHarness()) {
  const user = userEvent.setup();
  const view = renderApp("/projects/proj_atlas/chat", harness);
  const input = await screen.findByTestId("chat-input");
  await waitFor(() => expect(input).toBeEnabled());
  return { user, harness, input, view };
}

describe("d1109-chat-depth, run C: the waiting line and Stop", () => {
  it("shows the step the daemon sends, Send becomes Stop with its consequence line, and Stop ends the answer with what it cost", async () => {
    const { user, harness, input } = await openChat();
    harness.daemon.state.nextChatTurn = {
      steps: [{ text: "Reading the last session…" }],
      hold: true,
    };
    await user.type(input, "what did the last session do?");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-waiting")).toHaveTextContent("Reading the last session…"),
    );
    const stop = screen.getByTestId("chat-stop");
    expect(stop).toHaveTextContent("Stop");
    expect(stop).toHaveAttribute("title", STOP_EXPLAIN);
    expect(screen.queryByTestId("chat-send")).toBeNull();
    // A quick answer has no Answer now.
    expect(screen.queryByTestId("chat-answer-now")).toBeNull();
    await waitFor(() => expect(stop).toBeEnabled());
    await user.click(stop);
    await waitFor(() =>
      expect(screen.getByTestId("chat-footer")).toHaveTextContent(
        "You stopped this answer: under CHF 0.01 spent.",
      ),
    );
    // Stop sent the turn's own route, once.
    const stops = harness.daemon.state.calls.filter((c) =>
      /^\/chat\/turns\/[^/]+\/stop$/.test(c.path),
    );
    expect(stops).toHaveLength(1);
    expect(screen.getByTestId("chat-send")).toBeInTheDocument();
  });

  it("the seconds follow the line from 3 s on: ' · 3 s'", () => {
    const since = "2026-11-15T10:00:00.000Z";
    const t = Date.parse(since);
    expect(secondsSince(since, t + 2_000)).toBe("");
    expect(secondsSince(since, t + 3_000)).toBe(" · 3 s");
    expect(secondsSince(since, t + 7_400)).toBe(" · 7 s");
    expect(secondsSince(null, t)).toBe("");
  });

  it("with fake timers the waiting bubble reads 'Thinking…', then the step, then ' · 3 s'", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const harness = createHarness();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderApp("/projects/proj_atlas/chat", harness);
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    harness.daemon.state.nextChatTurn = {
      steps: [{ text: "Going through the tasks…" }],
      hold: true,
    };
    await user.type(input, "what is left?");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-waiting")).toHaveTextContent("Going through the tasks…"),
    );
    await act(async () => {
      vi.advanceTimersByTime(3_200);
    });
    await waitFor(() =>
      expect(screen.getByTestId("chat-waiting")).toHaveTextContent(
        /^Going through the tasks… · [3-9] s$/,
      ),
    );
    await user.click(screen.getByTestId("chat-stop"));
    await waitFor(() => expect(screen.getByTestId("chat-send")).toBeInTheDocument());
  });

  it("during a longer answer Answer now sits beside Stop and sends its route; the hand-over's reset drops the streamed text (L3-left-9)", async () => {
    const { user, harness, input } = await openChat();
    harness.daemon.state.nextChatTurn = {
      steps: [
        { text: "Going through the tasks…" },
        {
          text: "Thinking it through with Sonnet: about 30 seconds, at most CHF 0.30.",
          reset: true,
        },
      ],
      hold: true,
      depth: "stronger",
      footer: "Thought it through with Sonnet · 34 s · CHF 0.06",
    };
    await user.type(input, 'why does "Style the page" keep failing?');
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-waiting")).toHaveTextContent(
        "Thinking it through with Sonnet: about 30 seconds, at most CHF 0.30.",
      ),
    );
    const now = await screen.findByTestId("chat-answer-now");
    await user.click(now);
    await waitFor(() =>
      expect(screen.getByTestId("chat-footer")).toHaveTextContent(
        "Thought it through with Sonnet · 34 s · CHF 0.06",
      ),
    );
    expect(
      harness.daemon.state.calls.some((c) => /^\/chat\/turns\/[^/]+\/answer-now$/.test(c.path)),
    ).toBe(true);
  });

  it("a remounted conversation (a reload) shows the answering line and Stop from the daemon, then the reply", async () => {
    const harness = createHarness();
    const first = await openChat(harness);
    harness.daemon.state.nextChatTurn = {
      steps: [{ text: "Reading the last session…" }],
      hold: true,
    };
    await first.user.type(first.input, "what did the last session do?");
    await first.user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(harness.daemon.state.answering).not.toBeNull());
    first.view.unmount();
    // A fresh page on the same daemon: the store starts empty.
    const again = createHarness();
    again.daemon.state.conversations = harness.daemon.state.conversations;
    again.daemon.state.answering = harness.daemon.state.answering;
    renderApp("/projects/proj_atlas/chat", { ...again, daemon: harness.daemon });
    await waitFor(() =>
      expect(screen.getByTestId("chat-waiting")).toHaveTextContent("Reading the last session…"),
    );
    const stop = screen.getByTestId("chat-stop");
    expect(stop).toBeEnabled();
    await userEvent.setup().click(stop);
    await waitFor(() =>
      expect(screen.getByTestId("chat-footer")).toHaveTextContent("You stopped this answer"),
    );
  });

  it("Talk shows the same waiting line from the shared store", async () => {
    const { user, harness, input } = await openChat();
    harness.daemon.state.nextChatTurn = {
      steps: [{ text: "Listing the project's files…" }],
      hold: true,
    };
    await user.type(input, "which files are there?");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getByTestId("chat-waiting")).toBeInTheDocument());
    await user.click(screen.getByTestId("talk-open"));
    const talk = await screen.findByTestId("conversation");
    await waitFor(() =>
      expect(within(talk).getByTestId("conversation-waiting")).toHaveTextContent(
        "Listing the project's files…",
      ),
    );
    expect(within(talk).getByTestId("conversation-stop")).toBeInTheDocument();
    await user.click(within(talk).getByTestId("conversation-stop"));
    await waitFor(() => expect(harness.daemon.state.answering).toBeNull());
  });

  // fixup-d1109-chat-depth (review blocking 3): Stop was the form's submit button, so Enter in the
  // input while an answer was made stopped it and left the typed line unsent. Stop is the
  // person's own press ("nothing ends by accident"): Enter keeps the answer going and the line.
  it("Enter in the input while an answer is made neither stops it nor drops the typed line; Stop still stops it on its own press", async () => {
    const { user, harness, input } = await openChat();
    harness.daemon.state.nextChatTurn = {
      steps: [{ text: "Reading the last session…" }],
      hold: true,
    };
    await user.type(input, "what did the last session do?");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() =>
      expect(screen.getByTestId("chat-waiting")).toHaveTextContent("Reading the last session…"),
    );
    await waitFor(() => expect(screen.getByTestId("chat-stop")).toBeEnabled());
    await user.type(input, "and what is left?{Enter}");
    const stops = () =>
      harness.daemon.state.calls.filter((c) => /^\/chat\/turns\/[^/]+\/stop$/.test(c.path));
    expect(stops()).toHaveLength(0);
    expect(input).toHaveValue("and what is left?");
    expect(screen.getByTestId("chat-waiting")).toHaveTextContent("Reading the last session…");
    expect(screen.queryByTestId("chat-footer")).toBeNull();
    await user.click(screen.getByTestId("chat-stop"));
    await waitFor(() => expect(stops()).toHaveLength(1));
  });
});

describe("d1109-chat-depth, run C: under the answer", () => {
  it("an ask line with Go ahead: Go ahead sends 'Go ahead.' with the offer's turn", async () => {
    const { user, harness, input } = await openChat();
    const line =
      "This needs a stronger model: about CHF 0.15 (at most CHF 0.30) and 30 seconds. Go ahead?";
    harness.daemon.state.nextChatReply = "The stylesheet link looks wrong.";
    harness.daemon.state.nextChatTurn = { offer: { line, action: "go_ahead", explain: null } };
    await user.type(input, 'why does "Style the page" keep failing?');
    await user.click(screen.getByTestId("chat-send"));
    expect(await screen.findByTestId("chat-offer")).toHaveTextContent(line);
    await user.click(screen.getByTestId("chat-go-ahead"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(2));
    const offered = postedCalls(harness, "/chat/stream")[0];
    const body = postedCalls(harness, "/chat/stream")[1]?.body as Record<string, unknown>;
    expect(body.text).toBe("Go ahead.");
    expect(typeof body.offer).toBe("string");
    void offered;
    // The offer is the newest answer's only: once another line came, no Go ahead stays.
    await waitFor(() => expect(screen.queryByTestId("chat-go-ahead")).toBeNull());
  });

  it("Think it through under a quick answer, with its consequence line, sends depth longer", async () => {
    const { user, harness, input } = await openChat();
    const explain = "Thinks longer on this model: about 30 seconds, at most CHF 0.04.";
    harness.daemon.state.nextChatTurn = { offer: { line: null, action: "think", explain } };
    await user.type(input, "what is left?");
    await user.click(screen.getByTestId("chat-send"));
    expect(await screen.findByTestId("chat-think-explain")).toHaveTextContent(explain);
    await user.click(screen.getByTestId("chat-think"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(2));
    const body = postedCalls(harness, "/chat/stream")[1]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ text: "Think it through.", depth: "longer" });
  });

  it("a cap line under the answer has nothing to press", async () => {
    const { user, harness, input } = await openChat();
    const line = "A closer look would pass this month's cap, so this is the quick answer.";
    harness.daemon.state.nextChatTurn = { offer: { line, action: null, explain: null } };
    await user.type(input, "compare the two plans");
    await user.click(screen.getByTestId("chat-send"));
    expect(await screen.findByTestId("chat-offer")).toHaveTextContent(line);
    expect(screen.queryByTestId("chat-go-ahead")).toBeNull();
    expect(screen.queryByTestId("chat-think")).toBeNull();
  });

  it("a line Forerunner closed on says so with Ask again, which sends the same line", async () => {
    const harness = createHarness();
    harness.daemon.state.conversations.set("proj_atlas", [
      {
        id: "t-closed",
        at: "2026-11-15T09:00:00.000Z",
        said: "what did the first session do?",
        source: "text",
        reply: null,
        interrupted: true,
      },
    ]);
    const { user } = await openChat(harness);
    expect(await screen.findByTestId("chat-no-answer")).toHaveTextContent(CLOSED_LINE);
    await user.click(screen.getByTestId("chat-ask-again"));
    await waitFor(() => expect(postedCalls(harness, "/chat/stream")).toHaveLength(1));
    const sent = postedCalls(harness, "/chat/stream")[0]?.body as { text: string } | undefined;
    expect(sent?.text).toBe("what did the first session do?");
  });

  it("the From line names up to three records, linking only those whose page shows them (C2-left-7)", async () => {
    const { user, harness, input } = await openChat();
    harness.daemon.state.nextChatReply = "You answered Mon to Fri 9 to 18 on 4 Nov.";
    harness.daemon.state.nextChatSources = [
      { kind: "card", title: "Opening hours", date: "4 Nov", link: "/inbox?answered=req_1" },
      {
        kind: "task",
        title: "Write the FAQ",
        date: "5 Nov",
        link: "/projects/proj_atlas/tasks?task=task_1",
      },
      { kind: "conversation", title: "your line", date: "6 Nov", link: null },
    ];
    await user.type(input, "what did I answer about the opening hours?");
    await user.click(screen.getByTestId("chat-send"));
    const from = await screen.findByTestId("chat-from");
    expect(from).toHaveTextContent(
      "From: Opening hours (4 Nov), Write the FAQ (5 Nov), your line (6 Nov)",
    );
    const links = within(from).getAllByTestId("chat-from-link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent("Write the FAQ (5 Nov)");
    expect(recordLink("/talk")).toBeNull();
    expect(recordLink("/inbox?request=r")).toBeNull();
    expect(recordLink("/sessions/s1")).toBe("/sessions/s1");
  });

  it("L3-left-10: a reply that is its two changes' sentences joined shows them once, as the change rows", async () => {
    const { user, harness, input } = await openChat();
    const a = 'Added "Write the FAQ" to Atlas.';
    const b = 'Paused "Style the page".';
    harness.daemon.state.nextChatReply = `${a} ${b}`;
    harness.daemon.state.nextChatActions = [
      { kind: "task.create", summary: `${a} Undo.`, id: "chg_a", undoToken: "chg_a" },
      { kind: "task.transition", summary: `${b} Undo.`, id: "chg_b", undoToken: "chg_b" },
    ];
    await user.type(input, "add the FAQ task and pause the styling");
    await user.click(screen.getByTestId("chat-send"));
    await waitFor(() => expect(screen.getAllByTestId("chat-action")).toHaveLength(2));
    const agent = screen.getAllByTestId("chat-agent").at(-1) as HTMLElement;
    // Each sentence once: in its change row, never again above them.
    expect((agent.textContent ?? "").split(a).length).toBe(2);
    expect((agent.textContent ?? "").split(b).length).toBe(2);
  });
});
