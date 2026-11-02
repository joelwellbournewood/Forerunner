import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Home", () => {
  it("renders one card per project with stage, milestone, health, spend, waiting count and grade", async () => {
    renderApp("/");
    const cards = await screen.findAllByTestId("project-card");
    expect(cards).toHaveLength(2);
    const atlas = within(cards[0] as HTMLElement);
    expect(atlas.getByText("Atlas")).toBeInTheDocument();
    expect(atlas.getByTestId("stage")).toHaveTextContent("build");
    expect(atlas.getByTestId("next-milestone")).toHaveTextContent("Search works · 2026-11-05");
    expect(atlas.getByTestId("health-badge")).toHaveTextContent("attention");
    expect(atlas.getByTestId("spend-bar")).toHaveTextContent("CHF 25.00 of CHF 100.00 (25%)");
    expect(atlas.getByTestId("spend-bar")).not.toHaveTextContent("USD");
    expect(atlas.getByTestId("waiting-on-you")).toHaveTextContent("1");
    expect(atlas.getByTestId("critic-grade")).toHaveTextContent("82 / 100");

    const beacon = within(cards[1] as HTMLElement);
    expect(beacon.getByTestId("next-milestone")).toHaveTextContent("none planned");
    expect(beacon.getByTestId("critic-grade")).toHaveTextContent("no review yet");
    expect(beacon.getByTestId("health-badge")).toHaveTextContent("good");
  });

  it("names the task that needs you instead of saying blocked, and links to it (U-071)", async () => {
    const harness = createHarness();
    const beacon = harness.daemon.state.projects[1];
    if (!beacon) throw new Error("fixture changed");
    beacon.health = "attention";
    beacon.needsYou = { taskId: "task_9", title: "Confirm the stack" };
    renderApp("/", harness);
    const cards = await screen.findAllByTestId("project-card");
    const card = within(cards[1] as HTMLElement);
    const needsYou = card.getByTestId("needs-you");
    expect(needsYou).toHaveTextContent("needs you: Confirm the stack");
    expect(needsYou).toHaveAttribute("href", "/projects/proj_beacon/tasks");
    expect(card.queryByText("blocked")).not.toBeInTheDocument();
    expect(card.queryByTestId("health-badge")).not.toBeInTheDocument();
    await userEvent.setup().click(needsYou);
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Beacon");
    expect(screen.getByTestId("project-header")).toHaveTextContent("needs you: Confirm the stack");
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

  it("a one-line brief without a Goal creates the project: the brief's first sentence is the goal, and the dialog says so (live check of 2026-11-01)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("new-project"));
    const dialog = await screen.findByTestId("new-project-dialog");
    // The dialog says what an empty Goal does and what a short brief gets.
    expect(dialog).toHaveTextContent(
      "Optional: left empty, the first sentence you write below is the goal.",
    );
    // Only the Brief is labelled "brief": a hint naming it would label the Goal too (the bench's
    // smoke journey fills the field by its label, case aside).
    expect(within(dialog).getAllByLabelText(/brief/i)).toHaveLength(1);
    // The condition the daemon applies is named (design §5.9): with a repository link the plan
    // is sized from the repository, not the brief.
    expect(dialog).toHaveTextContent(
      "Without a repository, a sentence or two gets a small plan (up to three tasks); a list of features gets a full one.",
    );
    expect(within(dialog).getAllByLabelText(/Repository link/)).toHaveLength(1);
    await user.type(within(dialog).getByLabelText("Name"), "Quote page");
    await user.type(
      within(dialog).getByLabelText(/Brief/),
      "A page that shows a random quote. It should look calm.",
    );
    await user.click(within(dialog).getByTestId("create-project"));
    await waitFor(() => expect(postedCalls(harness, "/projects")).toHaveLength(1));
    expect(postedCalls(harness, "/projects")[0]?.body).toEqual({
      name: "Quote page",
      goal: "A page that shows a random quote",
      brief: "A page that shows a random quote. It should look calm.",
      intake: true,
    });
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Quote page");
  });

  it("New project without a Goal or a Brief says what is missing and sends nothing", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("new-project"));
    const dialog = await screen.findByTestId("new-project-dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Empty");
    await user.click(within(dialog).getByTestId("create-project"));
    expect(
      await within(dialog).findByText("Give a goal or a brief: the agent plans from them."),
    ).toBeVisible();
    expect(postedCalls(harness, "/projects")).toHaveLength(0);
  });

  it("shows the not-connected state when the daemon is unreachable", async () => {
    const harness = createHarness();
    const broken = {
      ...harness.client,
      health: () => Promise.reject(new TypeError("fetch failed")),
    };
    renderApp("/", { ...harness, client: broken });
    expect(await screen.findByTestId("not-connected")).toHaveTextContent(/Not connected/);
    expect(screen.getByTestId("active-project")).toHaveTextContent("No active project");
    expect(screen.getByTestId("kill-switch")).toBeEnabled();
  });
});
