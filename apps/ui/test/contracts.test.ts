import { DAEMON_ROUTES } from "@forerunner/runtime/daemon/api-types";
import { EstimateAccuracyViewSchema } from "@forerunner/runtime/estimates/view";
import { ExtensionView as RuntimeExtensionView } from "@forerunner/runtime/extensions/types";
import { UpdatesView as RuntimeUpdatesView } from "@forerunner/runtime/update/screen";
import { describe, expect, it } from "vitest";
import {
  CatalogView,
  EstimateAccuracyView,
  ExtensionView,
  ModelWatchReportSummary,
  PROPOSED_ROUTES,
  parseChangeCard,
  pathFromSpec,
  routeSpec,
  UpdatesView,
  verbFromSpec,
} from "../src/api/contracts.ts";
import {
  CATALOG,
  ESTIMATES,
  EXTENSIONS,
  MODEL_WATCH_REPORTS,
  UPDATES_FEED,
  UPDATES_STATUS,
} from "./fixtures.ts";

/**
 * Drift guard (ADR 0032): the UI mirrors schemas from runtime modules the browser cannot
 * import. Every fixture must satisfy both the runtime's schema and the mirror, so a field
 * added on one side fails here before it fails on a screen.
 */
describe("contract mirrors", () => {
  it("extensions: the fixtures satisfy the runtime schema and the mirror", () => {
    for (const e of EXTENSIONS) {
      expect(RuntimeExtensionView.safeParse(e).success).toBe(true);
      expect(ExtensionView.safeParse(e).success).toBe(true);
    }
    expect(CatalogView.safeParse(CATALOG).success).toBe(true);
    const mirrorKeys = Object.keys(ExtensionView.shape).sort();
    const runtimeKeys = Object.keys(RuntimeExtensionView.shape).sort();
    expect(mirrorKeys).toEqual(runtimeKeys);
  });

  it("updates: the fixtures satisfy the runtime schema and the mirror", () => {
    for (const v of [UPDATES_STATUS, UPDATES_FEED]) {
      expect(RuntimeUpdatesView.safeParse(v).success).toBe(true);
      expect(UpdatesView.safeParse(v).success).toBe(true);
    }
    expect(Object.keys(UpdatesView.shape).sort()).toEqual(
      Object.keys(RuntimeUpdatesView.shape).sort(),
    );
  });

  it("estimates: the fixture satisfies the runtime schema and the mirror", () => {
    expect(EstimateAccuracyViewSchema.safeParse(ESTIMATES).success).toBe(true);
    expect(EstimateAccuracyView.safeParse(ESTIMATES).success).toBe(true);
    const bad = { ...ESTIMATES, overall: { ...ESTIMATES.overall, within_25_pct_share: 2 } };
    expect(EstimateAccuracyView.safeParse(bad).success).toBe(false);
  });

  it("model watch summaries parse and reject a negative count", () => {
    for (const r of MODEL_WATCH_REPORTS)
      expect(ModelWatchReportSummary.safeParse(r).success).toBe(true);
    expect(
      ModelWatchReportSummary.safeParse({ ...MODEL_WATCH_REPORTS[0], recommendations: -1 }).success,
    ).toBe(false);
  });
});

describe("proposed routes", () => {
  it("are only the routes the daemon does not list, and follow the daemon's path once it does", () => {
    for (const name of Object.keys(PROPOSED_ROUTES)) {
      expect(name in DAEMON_ROUTES).toBe(false);
    }
    // Names the daemon serves now are no longer proposed here: the pages read `DAEMON_ROUTES`.
    for (const served of [
      "reviews",
      "memory",
      "updateLesson",
      "deleteLesson",
      "changes",
      "undoChange",
      "dataAssets",
      "registerDataAsset",
      "removeDataAsset",
      "milestones",
      "changeMilestone",
      "performance",
      // Served since U-004 to U-006 (docs/status/UPDATE-LOG.md).
      "queue",
      "enqueue",
      "dismissQueueItem",
      "docs",
      "doc",
      "importData",
    ]) {
      expect(served in DAEMON_ROUTES).toBe(true);
      expect(served in PROPOSED_ROUTES).toBe(false);
    }
    expect(routeSpec("reviews")).toBe(DAEMON_ROUTES.reviews);
    expect(routeSpec("queue")).toBe(DAEMON_ROUTES.queue);
  });

  it("fills params and drops the query hints", () => {
    expect(pathFromSpec(routeSpec("queue"), { id: "p 1" })).toBe("/projects/p%201/queue");
    expect(pathFromSpec(routeSpec("doc"), { id: "p", path: "docs/overview.md" })).toBe(
      "/projects/p/docs/docs%2Foverview.md",
    );
    expect(pathFromSpec("GET /performance?projectId= (PerformanceView)")).toBe("/performance");
    expect(verbFromSpec(DAEMON_ROUTES.removeDataAsset)).toBe("DELETE");
    expect(() => pathFromSpec(routeSpec("docs"), {})).toThrow(/missing param id/);
  });
});

describe("change cards", () => {
  it("parses the daemon's card leniently and rejects non-objects", () => {
    expect(parseChangeCard(null)).toBeNull();
    expect(parseChangeCard("x")).toBeNull();
    const card = parseChangeCard({
      command: "budget.set",
      what: "the session budget",
      oldValue: "CHF 5",
      newValue: "CHF 20",
      scope: "session",
      impact: { risk: "medium", costChfMicro: 15_000_000 },
      sentence: "Raised the session budget. Undo.",
      extra: "ignored but kept",
    });
    expect(card?.scopeLabel).toBe("");
    expect(card?.duration).toBe("permanent");
    expect(card?.impact.risk).toBe("medium");
    expect(card?.reversible).toBe(true);
    expect(parseChangeCard({ impact: { risk: "extreme" } })).toBeNull();
  });
});

/**
 * Source discovery (spec A.4): the UI reads the daemon's own schemas from `daemon/api-types`
 * (no mirror); the fixtures the fake daemon serves must satisfy them, and the route table
 * names every route the client calls.
 */
describe("source discovery contract", () => {
  it("the fixtures satisfy the daemon's schemas and the routes exist", async () => {
    const { SourceView, SourceCandidateView, SOURCES_ROUTES } = await import(
      "@forerunner/runtime/daemon/api-types"
    );
    const { SOURCES, SOURCE_CANDIDATES } = await import("./fixtures.ts");
    for (const s of SOURCES) expect(SourceView.safeParse(s).success).toBe(true);
    for (const c of SOURCE_CANDIDATES) expect(SourceCandidateView.safeParse(c).success).toBe(true);
    for (const name of [
      "sources",
      "addSource",
      "source",
      "scanSource",
      "sourceCandidates",
      "acceptCandidate",
      "removeSource",
    ] as const) {
      const spec = DAEMON_ROUTES[name];
      const verb = spec.slice(0, spec.indexOf(" "));
      const path = spec.slice(spec.indexOf(" ") + 1).split(/[ ?]/)[0];
      expect(SOURCES_ROUTES).toContain(`${verb} ${path}`);
    }
  });
});
