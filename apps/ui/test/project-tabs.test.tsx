import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { costPerAccepted } from "../src/pages/project/CostsTab.tsx";
import {
  layoutGraph,
  milestoneRows,
  PlanTab,
  timelineLayout,
} from "../src/pages/project/PlanTab.tsx";
import { MILESTONES, PROJECTS, TASKS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp, renderWith } from "./helpers.tsx";

/** The x of an SVG element's attribute, as the timeline wrote it. */
function svgNumber(element: Element | null | undefined, attribute: string): number {
  const value = element?.getAttribute(attribute);
  if (value === null || value === undefined)
    throw new Error(`no ${attribute} on ${element?.tagName}`);
  return Number.parseFloat(value);
}

describe("Plan tab: timeline and dependency graph", () => {
  it("lays tasks out in dependency layers and drops edges to unknown tasks", () => {
    const { nodes, edges } = layoutGraph(TASKS.slice(0, 3));
    expect(nodes.map((n) => [n.id, n.layer, n.row])).toEqual([
      ["task_1", 0, 0],
      ["task_2", 1, 0],
      ["task_3", 0, 1],
    ]);
    expect(edges).toEqual([{ from: "task_1", to: "task_2" }]);
    const cyclic = layoutGraph([
      { ...(TASKS[0] as (typeof TASKS)[number]), id: "a", dependsOn: ["b"] },
      { ...(TASKS[0] as (typeof TASKS)[number]), id: "b", dependsOn: ["a", "zzz"] },
    ]);
    // The cycle a -> b -> a is cut where a repeats: b sits after a, a after b.
    expect(cyclic.nodes.map((n) => n.layer)).toEqual([2, 1]);
    expect(cyclic.edges).toHaveLength(2);
  });

  it("places milestones on the time axis in date order, undated ones after", () => {
    const rows = milestoneRows(MILESTONES, TASKS);
    expect(rows.map((r) => [r.id, r.tasks.length, r.done])).toEqual([
      ["ms_index", 0, 0],
      ["ms_search", 2, 1],
      ["ms_launch", 0, 0],
      ["__none", 2, 0],
    ]);
    const points = timelineLayout(rows, "2026-10-20T00:00:00.000Z");
    expect(points.map((p) => p.id)).toEqual(["ms_index", "ms_search", "ms_launch"]);
    const xs = points.map((p) => p.x);
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(1);
    expect(xs[1]).toBeGreaterThan(0);
    expect(xs[1]).toBeLessThan(1);
    const undated = timelineLayout(
      [{ ...rows[2], targetDate: null } as (typeof rows)[number]],
      "2026-10-20T00:00:00.000Z",
    );
    expect(undated[0]?.x).toBeGreaterThan(0);
  });

  it("renders the timeline, the milestones with criteria and the dependency graph", async () => {
    renderApp("/projects/proj_atlas/plan");
    const timeline = await screen.findByTestId("milestone-timeline");
    expect(within(timeline).getAllByTestId("timeline-milestone")).toHaveLength(3);
    expect(within(timeline).getByTestId("timeline-today")).toBeInTheDocument();
    const list = screen.getByTestId("milestone-list");
    await waitFor(() => expect(within(list).getAllByTestId("milestone")).toHaveLength(4));
    expect(within(list).getByText("Search works")).toBeInTheDocument();
    expect(list).toHaveTextContent("Header search returns results under 200 ms");
    expect(list).toHaveTextContent("1 / 2 tasks done");
    const graph = await screen.findByTestId("dependency-graph");
    expect(within(graph).getAllByTestId("graph-node")).toHaveLength(3);
    const edge = within(graph).getByTestId("graph-edge");
    expect(edge).toHaveAttribute("data-from", "task_1");
    expect(edge).toHaveAttribute("data-to", "task_2");
    expect(screen.queryByTestId("route-missing")).not.toBeInTheDocument();
  });

  it("edits a milestone with a required reason: posts the version and the reason, shows the change (B.5)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/plan", harness);
    const list = await screen.findByTestId("milestone-list");
    await waitFor(() => expect(within(list).getAllByTestId("milestone")).toHaveLength(4));
    const rowOf = (id: string) =>
      within(list)
        .getAllByTestId("milestone")
        .find((m) => m.dataset.milestoneId === id) as HTMLElement;
    // The reason of the last change is on the row; a row never changed shows none.
    expect(within(rowOf("ms_index")).getByTestId("milestone-reason")).toHaveTextContent(
      "every page indexed, closed after the review",
    );
    expect(within(rowOf("ms_search")).queryByTestId("milestone-reason")).not.toBeInTheDocument();
    // The unassigned group is derived, not a row: nothing to edit there.
    expect(within(rowOf("__none")).queryByTestId("edit-milestone")).not.toBeInTheDocument();

    await user.click(within(rowOf("ms_search")).getByTestId("edit-milestone"));
    const dialog = await screen.findByTestId("milestone-dialog");
    expect(within(dialog).getByTestId("milestone-name")).toHaveValue("Search works");
    expect(within(dialog).getByTestId("milestone-target-date")).toHaveValue("2026-11-05");
    expect(within(dialog).getByTestId("milestone-status")).toHaveValue("active");
    // No reason, no save.
    expect(within(dialog).getByTestId("confirm-milestone")).toBeDisabled();
    await user.selectOptions(within(dialog).getByTestId("milestone-status"), "done");
    await user.clear(within(dialog).getByTestId("milestone-target-date"));
    await user.type(within(dialog).getByTestId("milestone-target-date"), "2026-10-28");
    await user.type(
      within(dialog).getByTestId("milestone-criteria"),
      "{enter}Search results carry the page title",
    );
    await user.type(within(dialog).getByTestId("milestone-reason"), "search shipped a week early");
    await user.click(within(dialog).getByTestId("confirm-milestone"));
    await waitFor(() => expect(postedCalls(harness, "/milestones/ms_search")).toHaveLength(1));
    expect(postedCalls(harness, "/milestones/ms_search")[0]?.body).toEqual({
      version: 1,
      reason: "search shipped a week early",
      name: "Search works",
      successCriteria: [
        "Header search returns results under 200 ms",
        "Search results carry the page title",
      ],
      targetDate: "2026-10-28",
      status: "done",
    });
    await waitFor(() => expect(screen.queryByTestId("milestone-dialog")).not.toBeInTheDocument());
    const row = rowOf("ms_search");
    await waitFor(() => expect(within(row).getByTestId("milestone-reason")).toBeInTheDocument());
    expect(within(row).getByTestId("milestone-reason")).toHaveTextContent(
      "search shipped a week early",
    );
    expect(row).toHaveTextContent("done");
    expect(row).toHaveTextContent("target 2026-10-28");
    expect(row).toHaveTextContent("Search results carry the page title");
    // The timeline moved with the date.
    const timeline = screen.getByTestId("milestone-timeline");
    expect(
      within(timeline)
        .getAllByTestId("timeline-milestone")
        .find((m) => m.dataset.milestoneId === "ms_search"),
    ).toHaveAttribute("data-status", "done");
  });

  it("a milestone edit the daemon refuses keeps the dialog open with the reason", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/plan", harness);
    const list = await screen.findByTestId("milestone-list");
    await waitFor(() => expect(within(list).getAllByTestId("milestone")).toHaveLength(4));
    // Another device moved the row: the version the page holds is stale.
    const row = harness.daemon.state.milestones.find((m) => m.id === "ms_launch");
    if (!row) throw new Error("fixture");
    row.version += 1;
    const launch = within(list)
      .getAllByTestId("milestone")
      .find((m) => m.dataset.milestoneId === "ms_launch") as HTMLElement;
    await user.click(within(launch).getByTestId("edit-milestone"));
    const dialog = await screen.findByTestId("milestone-dialog");
    await user.type(within(dialog).getByTestId("milestone-reason"), "pulling the date in");
    await user.click(within(dialog).getByTestId("confirm-milestone"));
    await waitFor(() => expect(postedCalls(harness, "/milestones/ms_launch")).toHaveLength(1));
    expect(await within(dialog).findByText(/changed since you loaded it/)).toBeInTheDocument();
    expect(screen.getByTestId("milestone-dialog")).toBeInTheDocument();
  });

  it("derives milestones from the tasks when the daemon has no milestones route", async () => {
    renderApp(
      "/projects/proj_atlas/plan",
      createHarness({ missingRoutes: ["/projects/proj_atlas/milestones"] }),
    );
    expect(await screen.findByTestId("route-missing")).toHaveAttribute("data-route", "milestones");
    const list = screen.getByTestId("milestone-list");
    await waitFor(() => expect(within(list).getByText("Search works")).toBeInTheDocument());
    // The timeline stays: the dated next milestone from the card on the axis, the milestone
    // ids the tasks reference after it, and today's tick.
    const timeline = await screen.findByTestId("milestone-timeline");
    await waitFor(() =>
      expect(
        within(timeline)
          .getAllByTestId("timeline-milestone")
          .map((m) => m.dataset.milestoneId),
      ).toContain("ms_search"),
    );
    expect(within(timeline).getByTestId("timeline-today")).toBeInTheDocument();
    expect(await screen.findByTestId("dependency-graph")).toBeInTheDocument();
  });

  it("places today's tick from the clock it is given, not the wall clock", async () => {
    const atlas = PROJECTS.find((p) => p.id === "proj_atlas");
    if (!atlas) throw new Error("no proj_atlas fixture");
    // Milestones span 2026-10-15 to 2026-12-01 (47 days); 2026-11-20 is day 36 of that span.
    renderWith(<PlanTab projectId="proj_atlas" project={atlas} now={Date.UTC(2026, 10, 20)} />);
    const timeline = await screen.findByTestId("milestone-timeline");
    await waitFor(() =>
      expect(within(timeline).getAllByTestId("timeline-milestone")).toHaveLength(3),
    );
    const todayX = svgNumber(
      within(timeline).getByTestId("timeline-today").querySelector("line"),
      "x1",
    );
    const cx = Object.fromEntries(
      within(timeline)
        .getAllByTestId("timeline-milestone")
        .map((m) => [m.dataset.milestoneId, svgNumber(m.querySelector("circle"), "cx")]),
    );
    expect(todayX).toBeGreaterThan(cx.ms_search ?? Number.NaN);
    expect(todayX).toBeLessThan(cx.ms_launch ?? Number.NaN);
    // The axis is 640 wide with 16 px margins and 1.3 units long (undated milestones sit
    // in the last 0.3); today is 36/47 of the dated span.
    expect(todayX).toBeCloseTo(16 + (36 / 47) * ((640 - 32) / 1.3), 1);
  });
});

describe("Docs tab", () => {
  it("lists the standard doc set with drift and missing states and opens a document", async () => {
    const user = userEvent.setup();
    renderApp("/projects/proj_atlas/docs");
    const docs = await screen.findByTestId("docs");
    expect(within(docs).getByTestId("docs-present")).toHaveTextContent("7 of 8 present");
    expect(within(docs).getByTestId("docs-drift")).toHaveTextContent("1 drifted");
    const rows = within(docs).getAllByTestId("doc-row");
    expect(rows).toHaveLength(8);
    const arch = rows.find((r) => r.dataset.path === "docs/architecture.md");
    if (!arch) throw new Error("no architecture row");
    expect(arch).toHaveAttribute("data-drift", "true");
    expect(arch).toHaveTextContent("src/search changed after this doc");
    const runbook = rows.find((r) => r.dataset.path === "docs/runbook.md");
    expect(runbook).toHaveTextContent("missing");
    await user.click(within(arch).getByTestId("doc-open"));
    const content = await screen.findByTestId("doc-content");
    await waitFor(() => expect(content).toHaveTextContent("search index built at deploy time"));
  });

  it("degrades when the docs route is missing", async () => {
    renderApp(
      "/projects/proj_atlas/docs",
      createHarness({ missingRoutes: ["/projects/proj_atlas/docs"] }),
    );
    expect(await screen.findByTestId("route-missing")).toHaveAttribute("data-route", "docs");
  });
});

describe("Data tab", () => {
  it("lists registered data with samples, registers a new locator and removes one", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/data", harness);
    const rows = await screen.findAllByTestId("data-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("crawl-2026-10.parquet");
    expect(rows[0]).toHaveTextContent("2.2 GB");
    expect(rows[0]).toHaveTextContent("s3://example-bucket/atlas/crawl-2026-10.parquet");
    await user.type(screen.getByTestId("data-locator"), "C:\\data\\exports\\sales.csv");
    await user.selectOptions(screen.getByTestId("data-kind"), "csv");
    await user.click(screen.getByTestId("data-register"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/data")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/data")[0]?.body).toEqual({
      locator: "C:\\data\\exports\\sales.csv",
      kind: "csv",
    });
    await waitFor(() => expect(screen.getAllByTestId("data-row")).toHaveLength(2));
    expect(screen.getAllByTestId("data-row")[0]).toHaveTextContent("sales.csv");
    await user.click(
      within(screen.getAllByTestId("data-row")[1] as HTMLElement).getByTestId("data-remove"),
    );
    await user.click(screen.getByTestId("data-remove-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("data-row")).toHaveLength(1));
    expect(postedCalls(harness, "/data/da_1")[0]?.method).toBe("DELETE");
  });

  it("queues an import from a repository and reports the task", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/data", harness);
    await screen.findAllByTestId("data-row");
    await user.selectOptions(screen.getByTestId("import-source"), "repo");
    await user.type(screen.getByTestId("import-locator"), "https://example.test/org/legacy");
    await user.click(screen.getByTestId("import-run"));
    await waitFor(() =>
      expect(postedCalls(harness, "/projects/proj_atlas/import")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/projects/proj_atlas/import")[0]?.body).toEqual({
      source: "repo",
      locator: "https://example.test/org/legacy",
    });
    const result = await screen.findByTestId("import-result");
    expect(result).toHaveAttribute("data-status", "queued");
    expect(result).toHaveTextContent("migration specialist runs it on a branch");
    expect(harness.daemon.state.tasks[0]?.title).toContain("Import repo");
  });

  it("degrades when the data route is missing", async () => {
    renderApp(
      "/projects/proj_atlas/data",
      createHarness({ missingRoutes: ["/projects/proj_atlas/data"] }),
    );
    expect(await screen.findByTestId("route-missing")).toHaveAttribute("data-route", "dataAssets");
  });
});

describe("Summary tab: queue, peers, decisions", () => {
  it("shows the next-session queue by priority, adds an item and dismisses one", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/summary", harness);
    const queue = await screen.findByTestId("queue");
    const items = await within(queue).findAllByTestId("queue-item");
    expect(items.map((i) => i.dataset.kind)).toEqual(["correction", "idea"]);
    expect(within(queue).getByTestId("queue-past")).toHaveTextContent("consumed");
    await user.selectOptions(within(queue).getByTestId("queue-kind"), "task");
    await user.type(within(queue).getByTestId("queue-text"), "Add a sitemap");
    await user.clear(within(queue).getByTestId("queue-priority"));
    await user.type(within(queue).getByTestId("queue-priority"), "8");
    await user.click(within(queue).getByTestId("queue-add"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/queue")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/queue")[0]?.body).toEqual({
      kind: "task",
      text: "Add a sitemap",
      priority: 8,
    });
    await waitFor(() => expect(within(queue).getAllByTestId("queue-item")).toHaveLength(3));
    expect(within(queue).getAllByTestId("queue-item")[0]).toHaveTextContent("Add a sitemap");
    await user.click(
      within(within(queue).getAllByTestId("queue-item")[2] as HTMLElement).getByTestId(
        "queue-dismiss",
      ),
    );
    await waitFor(() => expect(postedCalls(harness, "/queue/q_2/dismiss")).toHaveLength(1));
    await waitFor(() => expect(within(queue).getAllByTestId("queue-item")).toHaveLength(2));
  });

  it("shows the peers feed and the decision log", async () => {
    renderApp("/projects/proj_atlas/summary");
    const peer = await screen.findByTestId("peer");
    expect(peer).toHaveAttribute("data-agent-id", "agent_bob");
    expect(peer).toHaveAttribute("data-online", "true");
    expect(within(peer).getByTestId("peer-claim")).toHaveTextContent(
      "Add the search box to the header",
    );
    expect(within(peer).getByTestId("peer-pr")).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/12",
    );
    expect(within(peer).getByTestId("peer-handoff")).toHaveTextContent("PR #12 waits for review");
    expect(within(peer).getByTestId("peer-files")).toHaveTextContent("src/header.tsx");
    const decision = await screen.findByTestId("decision");
    expect(decision).toHaveTextContent("Which search backend should the docs site use?");
    expect(within(decision).getByTestId("decision-chosen")).toHaveTextContent(
      "Static index built at deploy time",
    );
    expect(decision).toHaveTextContent("not: Hosted search service");
    expect(decision).toHaveTextContent("by human_alice");
  });

  it("shows empty peers and decisions for a solo project, and a missing queue route", async () => {
    renderApp(
      "/projects/proj_beacon/summary",
      createHarness({ missingRoutes: ["/projects/proj_beacon/queue"] }),
    );
    expect(await screen.findByTestId("peers-empty")).toHaveTextContent("solo mode");
    expect(await screen.findByTestId("decisions-empty")).toBeInTheDocument();
    expect(await screen.findByTestId("route-missing")).toHaveAttribute("data-route", "queue");
  });
});

describe("Costs tab", () => {
  it("shows the cost per accepted task next to the success rate", async () => {
    expect(
      costPerAccepted({
        key: "k",
        label: "l",
        cost: { usdMicro: 1000, chfMicro: 800 },
        runs: 3,
        accepted: 2,
      }),
    ).toEqual({ usdMicro: 500, chfMicro: 400 });
    expect(
      costPerAccepted({
        key: "k",
        label: "l",
        cost: { usdMicro: 1000, chfMicro: 800 },
        runs: 3,
        accepted: null,
      }),
    ).toBeNull();
    renderApp("/projects/proj_atlas/costs");
    const model = await screen.findByTestId("cost-by-model");
    expect(model).toHaveTextContent("7 / 9 (78%)");
    expect(within(model).getAllByTestId("cost-per-accepted")[0]).toHaveTextContent("CHF 3.20");
    expect(within(model).getAllByTestId("cost-per-accepted")[1]).toHaveTextContent("—");
  });
});
