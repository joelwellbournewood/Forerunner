import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ProjectCard } from "../src/api/client.ts";
import { PlanTab } from "../src/pages/project/PlanTab.tsx";
import { PROJECTS } from "./fixtures.ts";
import { createHarness, type Harness, postedCalls, renderApp, renderWith } from "./helpers.tsx";

const atlas = PROJECTS[0] as ProjectCard;

/** The fake daemon's Atlas switched to small-project mode, as the daemon's card would say. */
function smallAtlas(harness: Harness): ProjectCard {
  const card = harness.daemon.state.projects.find((p) => p.id === "proj_atlas") as ProjectCard;
  card.smallProjectMode = true;
  card.defaultRiskTier = 0;
  return card;
}

describe("small-project mode (B.6)", () => {
  it("Plan tab: the flat task list without milestone grouping or timeline, the one milestone named", async () => {
    const harness = createHarness();
    smallAtlas(harness);
    renderApp("/projects/proj_atlas/plan", harness);
    const flat = await screen.findByTestId("flat-task-list");
    await waitFor(() => expect(within(flat).getAllByTestId("flat-task")).toHaveLength(3));
    expect(
      within(flat)
        .getAllByTestId("flat-task")
        .map((li) => li.getAttribute("data-task-id")),
    ).toEqual(["task_1", "task_2", "task_3"]);
    expect(flat).toHaveTextContent("Index the documentation pages");
    expect(flat).toHaveTextContent("tier 1");
    expect(screen.getByTestId("small-project-notice")).toHaveTextContent(/one milestone/i);
    expect(screen.getByTestId("small-project-notice")).toHaveTextContent(/tier 0/);
    const milestone = screen.getByTestId("small-project-milestone");
    expect(milestone).toHaveTextContent("Search works");
    expect(milestone).toHaveTextContent("Header search returns results under 200 ms");
    expect(milestone).toHaveTextContent("1 / 3 tasks done");
    // Neutral wording: a milestone listed here may predate the mode or be one the mode closed.
    expect(screen.getByTestId("small-project-other-milestones")).toHaveTextContent(
      "Other milestones on file: Docs indexed (done), Launch (planned)",
    );
    expect(screen.queryByTestId("milestone-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("milestone-timeline")).not.toBeInTheDocument();
    expect(screen.queryByTestId("milestone")).not.toBeInTheDocument();
    expect(await screen.findByTestId("dependency-graph")).toBeInTheDocument();
  });

  it("Plan tab: without the milestones route the one milestone comes from the card", async () => {
    const harness = createHarness({ missingRoutes: ["/projects/proj_atlas/milestones"] });
    const card = smallAtlas(harness);
    renderWith(<PlanTab projectId="proj_atlas" project={card} />, harness);
    const milestone = await screen.findByTestId("small-project-milestone");
    expect(milestone).toHaveTextContent("Search works");
    expect(milestone).toHaveTextContent("target 2026-11-05");
    expect(await screen.findByTestId("flat-task-list")).toBeInTheDocument();
    expect(screen.queryByTestId("small-project-other-milestones")).not.toBeInTheDocument();
    expect(screen.queryByTestId("milestone-list")).not.toBeInTheDocument();
  });

  it("Plan tab: a small project without a milestone yet says so and still lists the tasks flat", async () => {
    const harness = createHarness({ missingRoutes: ["/projects/proj_beacon/milestones"] });
    const beacon = {
      ...(PROJECTS[1] as ProjectCard),
      smallProjectMode: true,
      defaultRiskTier: 0,
    };
    renderWith(<PlanTab projectId="proj_beacon" project={beacon} />, harness);
    const flat = await screen.findByTestId("flat-task-list");
    await waitFor(() => expect(within(flat).getAllByTestId("flat-task")).toHaveLength(1));
    expect(screen.getByTestId("small-project-milestone")).toHaveTextContent(/No milestone yet/);
  });

  it("Plan tab: with the flag off the milestones stay grouped (unchanged)", async () => {
    renderApp("/projects/proj_atlas/plan");
    const list = await screen.findByTestId("milestone-list");
    await waitFor(() => expect(within(list).getAllByTestId("milestone")).toHaveLength(4));
    expect(await screen.findByTestId("milestone-timeline")).toBeInTheDocument();
    expect(screen.queryByTestId("flat-task-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("small-project-notice")).not.toBeInTheDocument();
  });

  it("New task dialog: the tier is left to the project unless one is picked; the default is named", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    smallAtlas(harness);
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    const tier = within(dialog).getByTestId("task-risk-tier");
    expect(tier).toHaveValue("");
    expect(
      within(dialog).getByRole("option", { name: "project default (tier 0)" }),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByTestId("task-title"), "Fix the typo on the home page");
    await user.type(within(dialog).getByTestId("task-outcome"), "The home page reads right");
    await user.click(within(dialog).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(1));
    const body = postedCalls(harness, "/projects/proj_atlas/tasks")[0]?.body as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("riskTier");
    expect(body).toMatchObject({ title: "Fix the typo on the home page", status: "ready" });
    // The fake daemon applies the project's default like the real one: the row shows tier 0.
    await waitFor(() => expect(screen.getAllByTestId("task-row")).toHaveLength(4));
    const created = screen
      .getAllByTestId("task-row")
      .find((row) => row.textContent?.includes("Fix the typo on the home page"));
    expect(created).toHaveTextContent("tier 0");

    await user.click(screen.getByTestId("new-task"));
    const second = await screen.findByTestId("new-task-dialog");
    await user.type(within(second).getByTestId("task-title"), "Rotate the deploy key");
    await user.type(within(second).getByTestId("task-outcome"), "A new key is in the vault");
    await user.selectOptions(within(second).getByTestId("task-risk-tier"), "2");
    await user.click(within(second).getByTestId("create-task"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/tasks")).toHaveLength(2));
    expect(postedCalls(harness, "/projects/proj_atlas/tasks")[1]?.body).toMatchObject({
      title: "Rotate the deploy key",
      riskTier: 2,
    });
  });

  it("New task dialog: with the flag off the project default is tier 1", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/tasks", harness);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const dialog = await screen.findByTestId("new-task-dialog");
    expect(
      within(dialog).getByRole("option", { name: "project default (tier 1)" }),
    ).toBeInTheDocument();
  });

  it("New task dialog: a card without the field (an older daemon or the state service) names no number", async () => {
    const user = userEvent.setup();
    const older = createHarness();
    const card = older.daemon.state.projects.find((p) => p.id === atlas.id) as ProjectCard;
    delete (card as { defaultRiskTier?: number }).defaultRiskTier;
    delete (card as { smallProjectMode?: boolean }).smallProjectMode;
    renderApp("/projects/proj_atlas/tasks", older);
    await screen.findAllByTestId("task-row");
    await user.click(screen.getByTestId("new-task"));
    const plain = await screen.findByTestId("new-task-dialog");
    expect(within(plain).getByRole("option", { name: "project default" })).toBeInTheDocument();
  });
});
