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

  it("edits a milestone with a reason: posts the version and the reason, shows the change (B.5)", async () => {
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
    // The reason is optional (U-010): Save is offered before one is typed.
    expect(within(dialog).getByTestId("confirm-milestone")).toBeEnabled();
    await user.selectOptions(within(dialog).getByTestId("milestone-status"), "done");
    await user.clear(within(dialog).getByTestId("milestone-target-date"));
    await user.type(within(dialog).getByTestId("milestone-target-date"), "2026-10-28");
    await user.type(
      within(dialog).getByTestId("milestone-criteria"),
      "{enter}Search results carry the page title",
    );
    // The input's id differs from the row's reason line, so a plain lookup never sees both.
    expect(screen.getAllByTestId("milestone-reason")).toHaveLength(1);
    await user.type(
      within(dialog).getByTestId("milestone-change-reason"),
      "search shipped a week early",
    );
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

  it("a milestone edit without a reason is sent with the app's own reason (U-010)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/plan", harness);
    const list = await screen.findByTestId("milestone-list");
    await waitFor(() => expect(within(list).getAllByTestId("milestone")).toHaveLength(4));
    const row = within(list)
      .getAllByTestId("milestone")
      .find((m) => m.dataset.milestoneId === "ms_search") as HTMLElement;
    await user.click(within(row).getByTestId("edit-milestone"));
    const dialog = await screen.findByTestId("milestone-dialog");
    expect(
      within(dialog).getByText(/Left empty: "Milestone edited in the app"/),
    ).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByTestId("milestone-status"), "done");
    await user.click(within(dialog).getByTestId("confirm-milestone"));
    await waitFor(() => expect(postedCalls(harness, "/milestones/ms_search")).toHaveLength(1));
    expect(postedCalls(harness, "/milestones/ms_search")[0]?.body).toMatchObject({
      reason: "Milestone edited in the app",
      status: "done",
    });
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
    await user.type(within(dialog).getByTestId("milestone-change-reason"), "pulling the date in");
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
    expect(within(docs).getByTestId("docs-present")).toHaveTextContent("9 of 10 present");
    expect(within(docs).getByTestId("docs-drift")).toHaveTextContent("1 drifted");
    const rows = within(docs).getAllByTestId("doc-row");
    expect(rows).toHaveLength(10);
    // W8-guide-1, -2 (ADR 0121): the guide leads the list and the app's status comes last.
    expect(rows.map((r) => r.dataset.path)).toEqual([
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "docs/overview.md",
      "docs/architecture.md",
      "docs/decisions",
      "docs/runbook.md",
      "docs/data.md",
      "docs/testing.md",
      "docs/status.md",
    ]);
    expect(rows[0]).toHaveTextContent("Guide");
    expect(rows[1]).toHaveTextContent("Guide for Claude Code");
    const arch = rows.find((r) => r.dataset.path === "docs/architecture.md");
    if (!arch) throw new Error("no architecture row");
    expect(arch).toHaveAttribute("data-drift", "true");
    expect(arch).toHaveTextContent("src/search changed after this doc");
    const runbook = rows.find((r) => r.dataset.path === "docs/runbook.md");
    expect(runbook).toHaveTextContent("missing");
    // A repository project's status stays in the app unless its status pull request is on
    // (C-57): the row says so, in the daemon's words.
    const status = rows.find((r) => r.dataset.path === "docs/status.md");
    expect(status).toHaveTextContent(
      "kept in the app: no status pull request (Settings turns it on)",
    );
    await user.click(within(arch).getByTestId("doc-open"));
    const content = await screen.findByTestId("doc-content");
    await waitFor(() => expect(content).toHaveTextContent("search index built at deploy time"));
  });

  it("a doc waiting in a docs pull request says so, with the pull request's link (ADR 0106)", async () => {
    // GitHub walk (2026-11-02): the docs read "missing · not written yet" while they waited in
    // the scaffold's pull request #1, which no screen showed.
    const harness = createHarness();
    harness.daemon.state.docs.proj_atlas = (harness.daemon.state.docs.proj_atlas ?? []).map((d) =>
      d.path === "docs/runbook.md"
        ? {
            ...d,
            note: "waiting in pull request #1: merge it to add it",
            pullRequest: { number: 1, url: "https://example.test/org/atlas/pull/1" },
          }
        : d,
    );
    renderApp("/projects/proj_atlas/docs", harness);
    const docs = await screen.findByTestId("docs");
    const runbook = within(docs)
      .getAllByTestId("doc-row")
      .find((r) => r.dataset.path === "docs/runbook.md");
    if (!runbook) throw new Error("no runbook row");
    expect(runbook).toHaveTextContent("in a pull request");
    expect(runbook).not.toHaveTextContent("missing");
    expect(runbook).toHaveTextContent("waiting in pull request #1: merge it to add it");
    expect(within(runbook).getByTestId("doc-pr-link")).toHaveAttribute(
      "href",
      "https://example.test/org/atlas/pull/1",
    );
    expect(within(runbook).getByTestId("doc-pr-link")).toHaveTextContent("Open pull request #1");
  });

  it("a together project's doc it does not have says who writes it, with no missing mark (C2-left-13)", async () => {
    // A together project never writes docs; its rows read "missing · not written yet".
    const harness = createHarness();
    const note =
      'The other Forerunner of "Kite club" writes this doc on GitHub; this project does not write docs.';
    harness.daemon.state.docs.proj_atlas = (harness.daemon.state.docs.proj_atlas ?? []).map((d) =>
      d.path === "docs/runbook.md" ? { ...d, note, notWrittenHere: true } : d,
    );
    renderApp("/projects/proj_atlas/docs", harness);
    const docs = await screen.findByTestId("docs");
    const runbook = within(docs)
      .getAllByTestId("doc-row")
      .find((r) => r.dataset.path === "docs/runbook.md");
    if (!runbook) throw new Error("no runbook row");
    expect(runbook).not.toHaveTextContent("missing");
    expect(runbook).not.toHaveTextContent("not written yet");
    expect(runbook).toHaveTextContent(note);
  });

  it("L4-github-102 (l4-github-link, run L4): after a take-over whose docs pull request could not be opened, Docs says GitHub still names the other project before its count", async () => {
    // Live check 4: Docs read "8 of 8 present" as if the take-over had landed.
    const harness = createHarness();
    const text =
      'Took over org/atlas from "Kite club" here, but the docs pull request that names this project could not be opened, so GitHub still names "Kite club".';
    // l4-github-carried (L4e-left-4): the daemon marks the take-over's outcome line, which is
    // the only repository line Docs shows (with its Try again, L4e-left-1).
    harness.daemon.state.repositoryOverview.proj_atlas = {
      kind: "elsewhere",
      text,
      canTakeOver: false,
      takeOverLine: null,
      details: null,
      outcome: "took_over_no_pull_request",
      tryAgainLine: "Tries again to open the docs pull request that names this project.",
    };
    renderApp("/projects/proj_atlas/docs", harness);
    const docs = await screen.findByTestId("docs");
    expect(within(docs).getByTestId("docs-repository-line")).toHaveTextContent(text);
    expect(docs.textContent?.indexOf(text)).toBeLessThan(
      docs.textContent?.indexOf("present") ?? -1,
    );
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
  // l4-chat-depth (L4-chat-204): a project closed by Make one project takes no new data.
  it("Add on a project that joined another is refused with the joined sentence and adds nothing", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.joined.proj_atlas = {
      projectId: "proj_beacon",
      name: "Beacon",
      at: "2026-11-09T10:00:00.000Z",
      text: 'Joined into "Beacon" on 9 Nov.',
    };
    renderApp("/projects/proj_atlas/data", harness);
    await screen.findAllByTestId("data-row");
    await user.type(screen.getByTestId("data-locator"), "C:\\data\\exports\\sales.csv");
    await user.selectOptions(screen.getByTestId("data-kind"), "csv");
    await user.click(screen.getByTestId("data-register"));
    expect(
      await screen.findByText('"Atlas" joined "Beacon", so its work runs there.', { exact: false }),
    ).toBeTruthy();
    expect(screen.getAllByTestId("data-row")).toHaveLength(1);
  });

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

  it("imports a repository through the daemon's import and says where it went (U-006)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/data", harness);
    await screen.findAllByTestId("data-row");
    await user.selectOptions(screen.getByTestId("import-source"), "github");
    // l4-github-carried (L4e-left-10): a GitHub link; the fake daemon, as the daemon, refuses a
    // link on another host (before: https://example.test/org/legacy "imported").
    await user.type(screen.getByTestId("import-locator"), "https://github.com/org/legacy");
    await user.click(screen.getByTestId("import-run"));
    await waitFor(() =>
      expect(postedCalls(harness, "/projects/proj_atlas/data/import")).toHaveLength(1),
    );
    expect(postedCalls(harness, "/projects/proj_atlas/data/import")[0]?.body).toEqual({
      source: "github",
      locator: "https://github.com/org/legacy",
    });
    const result = await screen.findByTestId("import-result");
    expect(result).toHaveAttribute("data-source", "github");
    expect(result).toHaveTextContent(
      "Imported org/legacy on branch forerunner/migration-2026-10-30. The default branch main is untouched.",
    );
  });

  it("imports a folder and says how much came in", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/data", harness);
    await screen.findAllByTestId("data-row");
    await user.selectOptions(screen.getByTestId("import-source"), "folder");
    await user.type(screen.getByTestId("import-locator"), "/home/me/site");
    await user.click(screen.getByTestId("import-run"));
    const result = await screen.findByTestId("import-result");
    expect(result).toHaveTextContent(
      /Imported 1 file \(.+\) into \/data\/projects\/proj_atlas\/data\./,
    );
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
  it("Note for the next session: one box, no type or priority; what is queued can be dismissed (design §3.4)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_atlas/summary", harness);
    const queue = await screen.findByTestId("queue");
    expect(queue).toHaveTextContent("Note for the next session");
    const items = await within(queue).findAllByTestId("queue-item");
    expect(items.map((i) => i.dataset.kind)).toEqual(["correction", "idea"]);
    // What a note does, as the runtime does it (U-038).
    expect(within(queue).getByTestId("queue-explainer")).toHaveTextContent(
      "Goes into the brief of every task the next session runs, or of the task it names.",
    );
    expect(within(queue).queryByTestId("queue-kind")).toBeNull();
    expect(within(queue).queryByTestId("queue-priority")).toBeNull();
    await user.type(within(queue).getByTestId("queue-text"), "Keep the header under 60 px");
    await user.click(within(queue).getByTestId("queue-add"));
    await waitFor(() => expect(postedCalls(harness, "/projects/proj_atlas/queue")).toHaveLength(1));
    expect(postedCalls(harness, "/projects/proj_atlas/queue")[0]?.body).toEqual({
      kind: "note",
      text: "Keep the header under 60 px",
      priority: 5,
    });
    expect(await within(queue).findByTestId("queue-saved")).toHaveTextContent(
      "Saved. The next session reads it.",
    );
    await waitFor(() => expect(within(queue).getAllByTestId("queue-item")).toHaveLength(3));
    const idea = within(queue)
      .getAllByTestId("queue-item")
      .find((i) => i.dataset.queueId === "q_2") as HTMLElement;
    await user.click(within(idea).getByTestId("queue-dismiss"));
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
    // Design §3.4, §5 "Decision": "Q? A. (Alice, 18 Oct)", no options not chosen, no id.
    const decision = (await screen.findAllByTestId("decision"))[0] as HTMLElement;
    expect(decision).toHaveTextContent(
      /^Which search backend should the docs site use\? Static index built at deploy time\. \(Alice, 1[78] Oct\)$/,
    );
    expect(decision).not.toHaveTextContent("not: Hosted search service");
    expect(decision).not.toHaveTextContent("human_alice");
  });

  it("a solo project shows no Peers (design §3.4), empty decisions, and a missing queue route", async () => {
    renderApp(
      "/projects/proj_beacon/summary",
      createHarness({ missingRoutes: ["/projects/proj_beacon/queue"] }),
    );
    await screen.findByTestId("summary");
    expect(screen.queryByTestId("peers")).toBeNull();
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
