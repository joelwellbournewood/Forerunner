import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { MILESTONE_AUDIT_TOOL } from "../src/session/project-plan.ts";
import { ScriptedProvider } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const jsonList = async (r: Response): Promise<Json[]> => (await r.json()) as Json[];
const str = (v: unknown): string => String(v);

/**
 * Spec B.5 on the daemon: every milestone change made from the app carries the human's
 * reason, is versioned, and reads back with its author; a change without a reason or on a
 * stale version is refused and nothing moves.
 */
describe("milestone changes carry author and reason (B.5)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  let milestone: Json = {};
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const change = (id: string, body: Json) =>
    req(`/milestones/${id}`, { method: "POST", body: JSON.stringify(body) });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-reasons-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Hello." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
    const created = await req("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "Atlas", goal: "Ship the docs site" }),
    });
    expect(created.status).toBe(201);
    projectId = str((await json(created)).id);
    const planned = await req(`/projects/${projectId}/plan`, {
      method: "POST",
      body: JSON.stringify({
        reason: "planned from the brief",
        milestones: [
          {
            name: "Docs indexed",
            successCriteria: ["Every page is in the index"],
            targetDate: "2026-11-15",
            tasks: [{ title: "Index the pages", outcome: "The index lists every page" }],
          },
        ],
      }),
    });
    expect(planned.status).toBe(201);
    milestone = ((await json(planned)).milestones as Json[])[0] as Json;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("GET /projects/:id/milestones serves the rows with their reason, author and version", async () => {
    const res = await req(`/projects/${projectId}/milestones`);
    expect(res.status).toBe(200);
    const rows = await jsonList(res);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: milestone.id,
      projectId,
      name: "Docs indexed",
      status: "planned",
      targetDate: "2026-11-15",
      reason: "planned from the brief",
      authorHuman: rt.human.id,
      authorAgent: null,
      version: 1,
    });
    expect(typeof rows[0]?.updatedAt).toBe("string");
    expect((await req("/projects/nope/milestones")).status).toBe(404);
  });

  it("POST /milestones/:id changes the row with the human's reason and bumps the version", async () => {
    await clock.advance(60_000);
    const res = await change(str(milestone.id), {
      version: 1,
      reason: "the index landed early; kickoff of the search phase moved up",
      status: "active",
      targetDate: "2026-11-01",
    });
    expect(res.status).toBe(200);
    const view = await json(res);
    expect(view).toMatchObject({
      id: milestone.id,
      name: "Docs indexed",
      status: "active",
      targetDate: "2026-11-01",
      reason: "the index landed early; kickoff of the search phase moved up",
      authorHuman: rt.human.id,
      authorAgent: null,
      version: 2,
      updatedAt: clock.nowIso(),
    });
    const row = await rt.store.milestone.mustGet(str(milestone.id));
    expect(row).toMatchObject({
      status: "active",
      target_date: "2026-11-01",
      reason: "the index landed early; kickoff of the search phase moved up",
      author_human: rt.human.id,
      version: 2,
    });
    const listed = await jsonList(await req(`/projects/${projectId}/milestones`));
    expect(listed[0]).toEqual(view);
    // The history: one audit row per change with what moved (before -> after) and the reason.
    const history = await rt.store.auditLog.list({ tool: MILESTONE_AUDIT_TOOL });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      allowed: true,
      human_id: rt.human.id,
      agent_id: null,
      occurred_at: clock.nowIso(),
      result_summary: "reason: the index landed early; kickoff of the search phase moved up",
    });
    expect(history[0]?.input_summary).toBe(
      `milestone "Docs indexed" (${str(milestone.id)}) v1 -> v2: target date 2026-11-15 -> 2026-11-01; status planned -> active`,
    );
  });

  it("refuses a change without a reason, with a blank one, or on a stale version, and nothing moves", async () => {
    const before = await rt.store.milestone.mustGet(str(milestone.id));
    const missing = await change(str(milestone.id), { version: before.version, name: "Renamed" });
    expect(missing.status).toBe(409);
    expect(await json(missing)).toMatchObject({
      code: "conflict",
      details: { cause: "validation" },
    });
    const blank = await change(str(milestone.id), {
      version: before.version,
      reason: "   ",
      name: "Renamed",
    });
    expect(blank.status).toBe(409);
    expect(await json(blank)).toMatchObject({ code: "conflict", details: { cause: "validation" } });
    const stale = await change(str(milestone.id), {
      version: before.version - 1,
      reason: "late edit",
      name: "Renamed",
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({
      code: "conflict",
      details: { cause: "version_conflict", expected: before.version - 1, actual: before.version },
    });
    const badDate = await change(str(milestone.id), {
      version: before.version,
      reason: "typo",
      targetDate: "next week",
    });
    expect(badDate.status).toBe(409);
    expect(await json(badDate)).toMatchObject({ details: { cause: "validation" } });
    expect(await rt.store.milestone.mustGet(str(milestone.id))).toEqual(before);
    expect((await change("nope", { version: 1, reason: "x", name: "y" })).status).toBe(404);
    // A refused change leaves no history row behind.
    expect(await rt.store.auditLog.count({ tool: MILESTONE_AUDIT_TOOL })).toBe(1);
  });

  it("every field the app edits is recorded under one reason: name, criteria, date and status", async () => {
    const before = await rt.store.milestone.mustGet(str(milestone.id));
    const res = await change(str(milestone.id), {
      version: before.version,
      reason: "scope agreed with the team: search is part of this milestone",
      name: "Docs indexed and searchable",
      successCriteria: ["Every page is in the index", "Header search answers under 200 ms"],
      targetDate: null,
      status: "planned",
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({
      name: "Docs indexed and searchable",
      successCriteria: ["Every page is in the index", "Header search answers under 200 ms"],
      targetDate: null,
      status: "planned",
      reason: "scope agreed with the team: search is part of this milestone",
      version: before.version + 1,
    });
    const last = (await rt.store.auditLog.list({ tool: MILESTONE_AUDIT_TOOL })).at(-1);
    expect(last?.input_summary).toBe(
      `milestone "Docs indexed" (${str(milestone.id)}) v2 -> v3: name "Docs indexed" -> "Docs indexed and searchable"; success criteria added: "Header search answers under 200 ms"; target date 2026-11-01 -> none; status active -> planned`,
    );
    expect(last?.result_summary).toBe(
      "reason: scope agreed with the team: search is part of this milestone",
    );
  });
});
