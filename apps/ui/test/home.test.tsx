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

  it("shows the active project in the header and the blocking count in the inbox badge", async () => {
    renderApp("/");
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Atlas"));
    await waitFor(() => expect(screen.getByTestId("inbox-badge")).toHaveTextContent("1"));
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
    expect(postedCalls(harness, "/projects")[0]?.body).toEqual({
      name: "Gamma",
      goal: "Ship the thing",
      brief: "A longer brief",
      repos: ["https://example.test/org/gamma"],
    });
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Gamma"));
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Gamma");
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
