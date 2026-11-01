import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Home", () => {
  it("one row per project: its status sentence, 'n of m done' and one action; no stage, grade, autonomy or spend (design §3.2)", async () => {
    renderApp("/");
    const cards = await screen.findAllByTestId("project-card");
    expect(cards).toHaveLength(2);
    const atlas = within(cards[0] as HTMLElement);
    expect(atlas.getByText("Atlas")).toBeInTheDocument();
    // Two open cards wait on the person: that comes first (design §2, §5 rule 2).
    expect(atlas.getByTestId("project-status")).toHaveTextContent("Waiting for you: 2 questions");
    expect(atlas.getByTestId("project-status-action")).toHaveTextContent("Answer");
    expect(atlas.getByTestId("project-status-action")).toHaveAttribute("href", "/inbox");
    expect(atlas.getByTestId("progress")).toHaveTextContent("1 of 3 done");
    const beacon = within(cards[1] as HTMLElement);
    expect(beacon.getByTestId("project-status")).toHaveTextContent(
      "0 of 1 done; 1 draft to make ready",
    );
    for (const card of cards) {
      expect(card).not.toHaveTextContent(/Stage|critic grade|Autonomy|Spend|Make active|USD/i);
      expect(within(card).queryByTestId("spend-bar")).toBeNull();
    }
  });

  it("Needs you lists every open card of every project, one line each with Answer (design §3.2)", async () => {
    const user = userEvent.setup();
    renderApp("/");
    const list = await screen.findByTestId("home-needs-you");
    const lines = within(list).getAllByTestId("home-card");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Atlas:");
    const answer = within(lines[0] as HTMLElement).getByTestId("home-card-answer");
    expect(answer.getAttribute("href")).toMatch(/^\/inbox#card-req_/);
    await user.click(answer);
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });

  it("Continue on a project with work that can run opens the Start dialog; Working now while a session runs (design §3.2)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // Beacon gets a ready task and nothing waits on the person there.
    const draft = harness.daemon.state.tasks.find((t) => t.id === "task_4");
    if (!draft) throw new Error("fixture changed");
    draft.status = "ready";
    renderApp("/", harness, { pollIntervalMs: 40 });
    const cards = await screen.findAllByTestId("project-card");
    const beacon = within(cards[1] as HTMLElement);
    expect(beacon.getByTestId("project-status")).toHaveTextContent(
      "Ready to continue: 1 task ready",
    );
    const cont = beacon.getByTestId("project-status-action");
    expect(cont).toHaveTextContent("Continue");
    expect(cont).toHaveAttribute(
      "title",
      "Starts a session that works until nothing more can run.",
    );
    await user.click(cont);
    expect(await screen.findByTestId("start-session-dialog")).toBeInTheDocument();
    await user.click(within(screen.getByTestId("start-session-dialog")).getByText("Cancel"));
    expect(screen.queryByTestId("working-now")).toBeNull();
    harness.daemon.state.sessions.push({
      ...(harness.daemon.state.sessions[0] as (typeof harness.daemon.state.sessions)[0]),
      id: "sess_live",
      projectId: "proj_beacon",
      agentName: "Alice",
      status: "running",
      endedAt: null,
      startedAt: new Date().toISOString(),
      currentTask: { id: "task_4", title: draft.title, specialist: "coder" },
    });
    const working = await screen.findByTestId("working-now");
    expect(working).toHaveTextContent(`Alice is working on "${draft.title}" in Beacon`);
    expect(within(working).getByTestId("working-open")).toHaveAttribute(
      "href",
      "/sessions/sess_live",
    );
    // The project's row says it too, and offers no second Start.
    await waitFor(() =>
      expect(
        within(screen.getAllByTestId("project-card")[1] as HTMLElement).getByTestId(
          "project-status",
        ),
      ).toHaveTextContent(`Working on "${draft.title}" (0 of 1 done)`),
    );
  });

  it("Home follows the Inbox without a reload: a card answered elsewhere changes the project's sentence (design §3.2)", async () => {
    const harness = createHarness();
    renderApp("/", harness, { pollIntervalMs: 40 });
    const cards = await screen.findAllByTestId("project-card");
    expect(within(cards[0] as HTMLElement).getByTestId("project-status")).toHaveTextContent(
      "Waiting for you: 2 questions",
    );
    // Both cards are answered on the phone: the poll sees the count move.
    for (const r of harness.daemon.state.requests) r.status = "answered";
    await waitFor(() =>
      expect(
        within(screen.getAllByTestId("project-card")[0] as HTMLElement).getByTestId(
          "project-status",
        ),
      ).not.toHaveTextContent("Waiting for you"),
    );
    expect(screen.queryByTestId("home-needs-you")).toBeNull();
  });

  it("opens a project through a link, not a button nested in a link", async () => {
    renderApp("/");
    const cards = await screen.findAllByTestId("project-card");
    const open = within(cards[1] as HTMLElement).getByTestId("open-project");
    expect(open.tagName).toBe("A");
    expect(open).toHaveAttribute("href", "/projects/proj_beacon");
    expect(open.querySelector("button")).toBeNull();
    expect(within(cards[1] as HTMLElement).queryByRole("button", { name: "Open" })).toBeNull();
    await userEvent.setup().click(open);
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon"));
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Beacon");
  });

  it("shows the active project in the header and every card that needs you in the inbox badge (design §3.8)", async () => {
    renderApp("/");
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas"));
    // Both open cards wait on the person, the non-blocking one too: the Inbox lists both.
    await waitFor(() => expect(screen.getByTestId("inbox-badge")).toHaveTextContent("2"));
    expect(screen.getByTestId("connection-status")).toHaveTextContent(/connected/);
  });

  it("creates a project from the dialog and opens it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("new-project"));
    const dialog = await screen.findByTestId("new-project-dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Gamma");
    await user.type(within(dialog).getByLabelText(/Goal/), "Ship the thing");
    await user.type(within(dialog).getByLabelText(/Brief/), "A longer brief");
    await user.type(
      within(dialog).getByLabelText(/Repository link/),
      "https://example.test/org/gamma",
    );
    await user.click(within(dialog).getByTestId("create-project"));
    await waitFor(() => expect(postedCalls(harness, "/projects")).toHaveLength(1));
    // A brief asks for the PM intake (spec A.2), so the proposal lands in the inbox.
    expect(postedCalls(harness, "/projects")[0]?.body).toEqual({
      name: "Gamma",
      goal: "Ship the thing",
      brief: "A longer brief",
      repos: ["https://example.test/org/gamma"],
      intake: true,
    });
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Gamma"));
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Gamma");
  });

  it("shows the not-connected state when the daemon is unreachable; no Stop all while nothing runs (design §3.1)", async () => {
    const harness = createHarness();
    const broken = {
      ...harness.client,
      health: () => Promise.reject(new TypeError("fetch failed")),
    };
    renderApp("/", { ...harness, client: broken });
    expect(await screen.findByTestId("not-connected")).toHaveTextContent(/Not connected/);
    expect(screen.getByTestId("active-project")).toHaveTextContent("No active project");
    expect(screen.queryByTestId("kill-switch")).toBeNull();
  });
});
