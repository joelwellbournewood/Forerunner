import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { milestonesFromTasks } from "../src/pages/project/PlanTab.tsx";
import { PROJECTS, TASKS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

describe("Project page", () => {
  it("redirects to the summary tab, shows the tabs and the cached summary", async () => {
    renderApp("/projects/proj_atlas");
    const summary = await screen.findByTestId("summary");
    expect(summary).toHaveTextContent("Indexed the docs and opened a PR for the search box.");
    expect(summary).toHaveTextContent("Review PR #12");
    expect(summary).toHaveTextContent("1 open question");
    expect(screen.getByTestId("project-tabs")).toHaveTextContent(
      "SummaryPlanTasksDocsReviewsCostsDataChat",
    );
    expect(screen.getByTestId("read-aloud")).toBeEnabled();
    expect(screen.getByTestId("read-aloud")).toHaveTextContent("Read aloud");
  });

  it("Read aloud asks the daemon to speak the summary, shows the text being read, and Stop cancels it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("read-aloud"));
    // The daemon's voice provider reads it (spec A.6): the button posts to the speak route
    // and the echoed text is shown while it reads.
    const text = await screen.findByTestId("read-aloud-text");
    expect(text).toHaveTextContent("Atlas is in the build stage.");
    expect(text).toHaveTextContent("One question waits for you.");
    expect(postedCalls(harness, "/projects/proj_atlas/speak")).toHaveLength(1);
    expect(screen.getByTestId("read-aloud")).toHaveTextContent("Stop reading");
    expect(screen.getByTestId("read-aloud")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByTestId("read-aloud"));
    await waitFor(() => expect(postedCalls(harness, "/speak/speak_1/cancel")).toHaveLength(1));
    expect(screen.queryByTestId("read-aloud-text")).not.toBeInTheDocument();
    expect(screen.getByTestId("read-aloud")).toHaveTextContent("Read aloud");
  });

  it("leaving the page while it reads stops the daemon too (nobody is left to hear it)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const view = renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("read-aloud"));
    await screen.findByTestId("read-aloud-text");
    expect(postedCalls(harness, "/speak/speak_1/cancel")).toHaveLength(0);
    view.unmount();
    await waitFor(() => expect(postedCalls(harness, "/speak/speak_1/cancel")).toHaveLength(1));
  });

  it("without a voice provider the button says why (jsdom has no browser speech either)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ voiceUnavailable: true });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("read-aloud"));
    const notice = await screen.findByTestId("read-aloud-notice");
    expect(notice).toHaveTextContent("Voice unavailable: no TTS provider available");
    expect(screen.queryByTestId("read-aloud-text")).not.toBeInTheDocument();
    expect(screen.getByTestId("read-aloud")).toHaveTextContent("Read aloud");
  });

  it("derives milestones from the card and the tasks (the fallback without a milestones route)", () => {
    const rows = milestonesFromTasks(PROJECTS[0] as (typeof PROJECTS)[number], TASKS.slice(0, 3));
    expect(rows.map((r) => [r.id, r.tasks.length, r.done])).toEqual([
      ["ms_search", 2, 1],
      ["__none", 1, 0],
    ]);
  });

  it("shows costs by model, specialist and task with savings apart", async () => {
    renderApp("/projects/proj_atlas/costs");
    expect(await screen.findByTestId("cost-total")).toHaveTextContent("CHF 25.00");
    expect(screen.getByTestId("cost-by-model")).toHaveTextContent("Sonnet 5.5");
    expect(screen.getByTestId("cost-by-specialist")).toHaveTextContent("tester");
    expect(screen.getByTestId("cost-by-task")).toHaveTextContent(
      "Add the search box to the header",
    );
    expect(screen.getByTestId("cost-savings")).toHaveTextContent("Savings (not spend)");
    expect(screen.getByTestId("cost-savings")).toHaveTextContent("CHF 2.30");
  });

  it("fills every tab: docs, reviews and data are no longer placeholders", async () => {
    renderApp("/projects/proj_atlas/docs");
    expect(await screen.findByTestId("docs")).toBeInTheDocument();
    renderApp("/projects/proj_atlas/reviews");
    expect(await screen.findByTestId("reviews")).toBeInTheDocument();
    renderApp("/projects/proj_atlas/data");
    expect(await screen.findByTestId("data")).toBeInTheDocument();
    expect(screen.queryByTestId("placeholder")).not.toBeInTheDocument();
  });

  it("warns before a start that no task is ready and says how to give the agent work (U-009)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    // proj_beacon's only task is a draft: a session would plan nothing and end at once.
    renderApp("/projects/proj_beacon", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    const warning = await within(dialog).findByTestId("start-session-no-work");
    expect(warning).toHaveTextContent(/No task in this project is ready/);
    expect(warning).toHaveTextContent(/Tasks tab/);
    expect(warning).toHaveTextContent(/add a task: write the README/);
    expect(warning).toHaveTextContent(/Inbox/);
  });

  it("says a start is queued instead of opening a session that does not exist yet (U-003)", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ startOutcome: "queued" });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    expect(await within(dialog).findByTestId("start-session-notice")).toHaveTextContent(
      /Queued: your agent is in another session/,
    );
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByTestId("session-header")).not.toBeInTheDocument();
  });

  it("starts a session from the dialog and opens the live view", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ eventDelayMs: 10 });
    renderApp("/projects/proj_atlas", harness);
    await screen.findByTestId("summary");
    await user.click(screen.getByTestId("start-session"));
    const dialog = await screen.findByTestId("start-session-dialog");
    await waitFor(() => expect(within(dialog).getByTestId("confirm-start-session")).toBeEnabled());
    // proj_atlas has a ready task: no warning.
    expect(within(dialog).queryByTestId("start-session-no-work")).not.toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Session budget/), "4");
    await user.type(within(dialog).getByLabelText(/Reason/), "try the plan");
    await user.click(within(dialog).getByTestId("confirm-start-session"));
    await waitFor(() => expect(postedCalls(harness, "/sessions")).toHaveLength(1));
    expect(postedCalls(harness, "/sessions")[0]?.body).toEqual({
      agentId: "agent_alice",
      projectId: "proj_atlas",
      trigger: "manual",
      budgetUsdMicro: 5_000_000,
      reason: "try the plan",
    });
    const header = await screen.findByTestId("session-header");
    expect(header).toHaveTextContent(/Session sess_/);
    // The first event arrives over SSE after the session page mounts; CI runners have needed more than 4 s.
    await waitFor(() => expect(screen.getAllByTestId("event-row").length).toBeGreaterThan(0), {
      timeout: 15_000,
    });
  });
});
