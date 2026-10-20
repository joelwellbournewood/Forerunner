import { expect, test } from "@playwright/test";
import { recordedCalls, resetDaemon } from "./helpers.ts";

test.beforeEach(async ({ request }) => resetDaemon(request));

test("summary: the next-session queue, the peers feed and the decision log", async ({
  page,
  request,
}) => {
  await page.goto("/projects/proj_atlas/summary");
  await expect(page.getByTestId("queue-item")).toHaveCount(2);
  await page.getByTestId("queue-kind").selectOption("idea");
  await page.getByTestId("queue-text").fill("Add a sitemap");
  await page.getByTestId("queue-add").click();
  await expect(page.getByTestId("queue-item")).toHaveCount(3);
  await page.getByTestId("queue-item").last().getByTestId("queue-dismiss").click();
  await expect(page.getByTestId("queue-item")).toHaveCount(2);
  await expect(page.getByTestId("peer")).toHaveAttribute("data-online", "true");
  await expect(page.getByTestId("peer-claim")).toContainText("Add the search box to the header");
  await expect(page.getByTestId("peer-handoff")).toContainText("PR #12 waits for review");
  await expect(page.getByTestId("decision-chosen")).toHaveText("Static index built at deploy time");
  const calls = await recordedCalls(request);
  expect(calls.find((c) => c.path === "/projects/proj_atlas/queue")?.body).toEqual({
    kind: "idea",
    text: "Add a sitemap",
    priority: 5,
  });
});

test("plan: the milestone timeline and the dependency graph render", async ({ page }) => {
  await page.goto("/projects/proj_atlas/plan");
  await expect(
    page.getByTestId("milestone-timeline").locator("[data-testid=timeline-milestone]"),
  ).toHaveCount(3);
  await expect(page.getByTestId("milestone")).toHaveCount(4);
  await expect(page.getByTestId("milestone-list")).toContainText("Search works");
  const graph = page.getByTestId("dependency-graph");
  await expect(graph.locator("[data-testid=graph-node]")).toHaveCount(3);
  await expect(graph.locator("[data-testid=graph-edge]")).toHaveCount(1);
  await expect(graph.locator("[data-testid=graph-edge]")).toHaveAttribute("data-to", "task_2");
});

test("data: register a dataset by path and queue an import", async ({ page, request }) => {
  await page.goto("/projects/proj_atlas/data");
  await expect(page.getByTestId("data-row")).toHaveCount(1);
  await page.getByTestId("data-locator").fill("s3://example-bucket/atlas/pages.csv");
  await page.getByTestId("data-kind").selectOption("csv");
  await page.getByTestId("data-register").click();
  await expect(page.getByTestId("data-row")).toHaveCount(2);
  await page.getByTestId("import-source").selectOption("folder");
  await page.getByTestId("import-locator").fill("/home/alice/old-site");
  await page.getByTestId("import-run").click();
  await expect(page.getByTestId("import-result")).toHaveAttribute("data-status", "queued");
  const calls = await recordedCalls(request);
  expect(calls.find((c) => c.path === "/projects/proj_atlas/data")?.body).toEqual({
    locator: "s3://example-bucket/atlas/pages.csv",
    kind: "csv",
  });
  expect(calls.find((c) => c.path === "/projects/proj_atlas/import")?.body).toEqual({
    source: "folder",
    locator: "/home/alice/old-site",
  });
});

test("docs: the standard set with drift, and a document opens", async ({ page }) => {
  await page.goto("/projects/proj_atlas/docs");
  await expect(page.getByTestId("docs-present")).toHaveText("7 of 8 present");
  await expect(page.getByTestId("docs-drift")).toHaveText("1 drifted");
  await page
    .getByTestId("doc-row")
    .filter({ hasText: "Architecture" })
    .getByTestId("doc-open")
    .click();
  await expect(page.getByTestId("doc-content")).toContainText("search index built at deploy time");
});

test("costs: savings apart from spend and the cost per accepted task", async ({ page }) => {
  await page.goto("/projects/proj_atlas/costs");
  await expect(page.getByTestId("cost-total")).toHaveText("CHF 25.00");
  await expect(page.getByTestId("cost-savings")).toContainText("Savings (not spend)");
  await expect(page.getByTestId("cost-savings")).toContainText("CHF 2.30");
  await expect(page.getByTestId("cost-by-model")).toContainText("7 / 9 (78%)");
});
