import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { EventSourceLike } from "../src/api/sse.ts";
import { AppRoutes } from "../src/routes.tsx";
import { AppProvider } from "../src/store/context.tsx";
import { createHarness, type Harness } from "./helpers.tsx";

/**
 * l4-selftasks-carried, run L4. The owner, 2026-11-17: every chat read-back "stays open in chat
 * and the Inbox until the person presses Yes or No" (design section 3.9). A card that closes, by
 * whatever route, leaves no stale "Waiting for you" in the header or the Inbox badge (L4f-left-1),
 * and an open chat is read again only when its card closed, not on every count (L4f-left-6).
 */

/** The daemon's /events stream from the fake daemon's listeners, open at once. */
function liveStream(harness: Harness) {
  return (_url: string): EventSourceLike => {
    const listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
    const fromDaemon = (event: string, data: unknown) => {
      for (const l of listeners.get(event) ?? []) l({ data: JSON.stringify(data) } as MessageEvent);
    };
    const es: EventSourceLike & { readyState: number } = {
      readyState: 0,
      onerror: null,
      onopen: null,
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      close() {
        es.readyState = 2;
        harness.daemon.state.listeners.delete(fromDaemon);
      },
    };
    harness.daemon.state.listeners.add(fromDaemon);
    queueMicrotask(() => {
      es.readyState = 1;
      es.onopen?.(new Event("open"));
    });
    return es;
  };
}

function renderLive(harness: Harness, route: string) {
  return render(
    <AppProvider
      client={harness.client}
      store={harness.store}
      streamOptions={{ eventSource: liveStream(harness), setTimer: () => 0, clearTimer: () => {} }}
    >
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProvider>,
  );
}

/** The chat read-back's card as the daemon files it: an Inbox request with the same id. */
function fileReadBack(harness: Harness, projectId: string) {
  const pending = harness.daemon.state.pendingConfirmation;
  if (!pending) throw new Error("no read-back waits");
  harness.daemon.state.requests.push({
    ...structuredClone(harness.daemon.state.requests[0]),
    id: pending.id,
    projectId,
    taskId: null,
    status: "open",
    blocking: false,
    title: pending.readback,
    options: ["yes", "no"],
    choices: [],
    answer: null,
    version: 1,
    changeCard: { command: "session.start", what: "a session", decision: "needs_yes" },
  } as never);
  const needsYouCount = harness.daemon.state.requests.filter((r) => r.status === "open").length;
  for (const l of harness.daemon.state.listeners) {
    l("inbox.changed", { blockingCount: 0, needsYouCount });
    l("project.changed", { id: projectId });
  }
}

const conversationReads = (harness: Harness, projectId: string) =>
  harness.daemon.state.gets.filter((p) => p === `/projects/${projectId}/conversation`).length;

describe("l4-selftasks-carried, run L4: a closed chat card leaves no stale waiting header (L4f-left-1)", () => {
  for (const answer of ["no", "yes"] as const) {
    it(`after ${answer === "no" ? "No" : "Yes"} on the chat's card the header and the Inbox badge change at once, without a reload`, async () => {
      const user = userEvent.setup();
      const harness = createHarness();
      for (const r of harness.daemon.state.requests) r.status = "answered";
      renderLive(harness, "/projects/proj_atlas/chat");
      const input = await screen.findByTestId("chat-input");
      await waitFor(() => expect(input).toBeEnabled());
      await user.type(input, "please start a session");
      await user.click(screen.getByTestId("chat-send"));
      const card = await screen.findByTestId("pending-confirmation");
      fileReadBack(harness, "proj_atlas");
      await waitFor(() =>
        expect(screen.getByTestId("project-status")).toHaveTextContent(
          "Waiting for you: 1 change to confirm",
        ),
      );
      await waitFor(() => expect(screen.getByTestId("inbox-badge")).toHaveTextContent("1"));
      await user.click(within(card).getByTestId(answer === "no" ? "confirm-no" : "confirm-yes"));
      await waitFor(() =>
        expect(screen.getByTestId("project-status")).not.toHaveTextContent(/Waiting for you/),
      );
      await waitFor(() => expect(screen.queryByTestId("inbox-badge")).toBeNull());
      expect(screen.queryByTestId("confirm-yes")).toBeNull();
    });
  }

  it("after the card is answered in the Inbox (another window) the open chat's Yes and No go and its header follows", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    for (const r of harness.daemon.state.requests) r.status = "answered";
    renderLive(harness, "/projects/proj_atlas/chat");
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "please start a session");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByTestId("pending-confirmation");
    fileReadBack(harness, "proj_atlas");
    await waitFor(() =>
      expect(screen.getByTestId("project-status")).toHaveTextContent(
        "Waiting for you: 1 change to confirm",
      ),
    );
    const id = harness.daemon.state.pendingConfirmation?.id ?? "";
    // The other window's Inbox answers No, as the Inbox page sends it.
    await harness.client.answerRequest(id, { version: 1, answer: "no" });
    await waitFor(() => expect(screen.queryByTestId("confirm-yes")).toBeNull());
    await waitFor(() =>
      expect(screen.getByTestId("project-status")).not.toHaveTextContent(/Waiting for you/),
    );
    await waitFor(() => expect(screen.queryByTestId("inbox-badge")).toBeNull());
  });
});

describe("l4-selftasks-carried, run L4: an open chat is read again only when its card closed (L4f-left-6)", () => {
  it("on the live stream, an inbox.changed alone reads no conversation again; the conversation.changed the daemon sends for a closed card reads that one", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderLive(harness, "/projects/proj_atlas/chat");
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "please start a session");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByTestId("pending-confirmation");
    await waitFor(() => expect(screen.getByTestId("confirm-yes")).toBeEnabled());
    const before = conversationReads(harness, "proj_atlas");
    // Another card came or went (a question from a session): nothing about this conversation.
    for (const l of harness.daemon.state.listeners) l("inbox.changed", { blockingCount: 3 });
    for (const l of harness.daemon.state.listeners) l("inbox.changed", { blockingCount: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(conversationReads(harness, "proj_atlas")).toBe(before);
    // This conversation's card closed elsewhere: the daemon names it.
    harness.daemon.state.pendingConfirmation = null;
    for (const l of harness.daemon.state.listeners)
      l("conversation.changed", { projectId: "proj_atlas" });
    await waitFor(() => expect(screen.queryByTestId("confirm-yes")).toBeNull());
    expect(conversationReads(harness, "proj_atlas")).toBe(before + 1);
  });

  it("while polling, the periodic count reads no conversation again; a count that moved reads the one that shows a waiting card", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    for (const r of harness.daemon.state.requests) r.status = "answered";
    const timers: Array<() => void> = [];
    render(
      <AppProvider
        client={harness.client}
        store={harness.store}
        streamOptions={{
          pollIntervalMs: 10,
          setTimer: (fn) => {
            timers.push(fn);
            return timers.length;
          },
          clearTimer: () => {},
        }}
      >
        <MemoryRouter initialEntries={["/projects/proj_atlas/chat"]}>
          <AppRoutes />
        </MemoryRouter>
      </AppProvider>,
    );
    const input = await screen.findByTestId("chat-input");
    await waitFor(() => expect(input).toBeEnabled());
    await user.type(input, "please start a session");
    await user.click(screen.getByTestId("chat-send"));
    await screen.findByTestId("pending-confirmation");
    fileReadBack(harness, "proj_atlas");
    const tick = async () => {
      const due = timers.splice(0);
      for (const fn of due) fn();
      await new Promise((r) => setTimeout(r, 30));
    };
    await tick();
    await tick();
    const before = conversationReads(harness, "proj_atlas");
    // Three polls with the same count: the chat is not read again.
    await tick();
    await tick();
    await tick();
    expect(conversationReads(harness, "proj_atlas")).toBe(before);
    // The card is answered in the Inbox: the next poll's count moved, so the chat is read again.
    await harness.client.answerRequest(harness.daemon.state.pendingConfirmation?.id ?? "", {
      version: 1,
      answer: "no",
    });
    await tick();
    await waitFor(() => expect(screen.queryByTestId("confirm-yes")).toBeNull());
    expect(conversationReads(harness, "proj_atlas")).toBeGreaterThan(before);
  });
});
