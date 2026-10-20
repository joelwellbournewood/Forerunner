import { SimulatedClock } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { openStore, type StateStore } from "../src/store.ts";

/**
 * Requirements close-out for the Project entity (spec "Data model", U.4): a project carries
 * its name, repositories, stage, status, budget, autonomy level, summary cache and data assets,
 * every one of them written and read back through the store; a data asset names the projects
 * that use it; and Forerunner itself is an ordinary project row (M.1 runs that project end to
 * end in `tests/e2e/scenarios/phase7-gate.integration.test.ts`). In-memory SQLite, simulated
 * clock; the Postgres adapter shares the repositories (`suite.ts`).
 */

let store: StateStore | undefined;

afterEach(async () => {
  await store?.close();
  store = undefined;
});

describe("close-out U.4: the Project entity", () => {
  it("round-trips name, repos, stage, status, budget, autonomy level, summary cache and data assets", async () => {
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    const human = await store.human.insert({ name: "J", email: "j@example.test" });
    const asset = await store.dataAsset.insert({
      project_ids: [],
      locator: "https://data.example.test/sales-2025.parquet",
      size_bytes: 2_500_000_000,
      kind: "parquet",
      sample: { columns: ["day", "chf"], rows: 3 },
      registered_by: human.id,
    });
    const summary = {
      goal: "Ship the sample service",
      stage: "build",
      last_session: "2026-03-01T22:00:00.000Z",
      next_steps: ["wire the login", "write the runbook", "cut 0.1"],
      open_questions: ["which host?"],
      spend_usd_micro: 1_250_000,
    };
    const created = await store.project.insert({
      name: "Sample",
      goal: "Ship a sample service",
      repos: [
        "https://git.example.test/j/sample.git",
        "https://git.example.test/j/sample-docs.git",
      ],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 3,
      summary_cache: summary,
      data_assets: [asset.id],
      author_human: human.id,
    });
    await store.dataAsset.patch(asset.id, { project_ids: [created.id] });

    const read = await store.project.mustGet(created.id);
    expect(read).toMatchObject({
      name: "Sample",
      goal: "Ship a sample service",
      repos: [
        "https://git.example.test/j/sample.git",
        "https://git.example.test/j/sample-docs.git",
      ],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 3,
      summary_cache: summary,
      data_assets: [asset.id],
      author_human: human.id,
      version: 1,
    });
    // The asset side of the link names the project too.
    expect((await store.dataAsset.mustGet(asset.id)).project_ids).toEqual([created.id]);
    // Every column is a filter or a field the UI reads: status and name are indexed.
    expect((await store.project.list({ status: "active" })).map((p) => p.id)).toEqual([created.id]);
    expect(await store.project.list({ status: "archived" })).toEqual([]);
    // The autonomy level is bounded in the schema (0 to 4), not by the caller.
    await expect(store.project.insert({ name: "Loose", autonomy_level: 5 })).rejects.toThrow();
  });

  it("Forerunner itself is a project like any other: its own row, repository, budget and autonomy", async () => {
    const clock = new SimulatedClock("2026-03-02T07:00:00Z");
    store = await openStore({ url: "sqlite::memory:", clock });
    const self = await store.project.insert({
      name: "Forerunner",
      goal: "Forerunner, managed as a Forerunner project",
      repos: ["https://git.example.test/j/forerunner.git"],
      stage: "maintain",
      budget_usd_micro: 20_000_000,
      autonomy_level: 2,
    });
    const other = await store.project.insert({ name: "Sample" });
    const task = await store.task.insert({
      project_id: self.id,
      title: "Add a dark-mode toggle to Settings",
      status: "ready",
    });
    expect((await store.task.forProject(self.id)).map((t) => t.id)).toEqual([task.id]);
    expect(await store.task.forProject(other.id)).toEqual([]);
    // Names are unique: a second "Forerunner" row is refused, so the self project is one row.
    await expect(store.project.insert({ name: "Forerunner" })).rejects.toThrow();
    expect(
      (await store.project.list({}, { orderBy: "name" })).map((p) => [p.name, p.stage]),
    ).toEqual([
      ["Forerunner", "maintain"],
      ["Sample", "idea"],
    ]);
  });
});
