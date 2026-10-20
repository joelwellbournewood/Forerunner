import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Requirements close-out for project creation (spec A.1) and the one-screen summary (A.6)
 * through the composed daemon: a brief of any length and a linked repository are kept whole,
 * a file upload lands in the project's data store, and the summary is readable aloud.
 */

const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

describe("closeout: create a project from the dashboard (A.1) and read its summary aloud (A.6)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  const brief =
    "One line of a very long paste-in brief, with details the agent plans from.\n".repeat(5_000);
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-closeout-projects-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Noted." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("accepts name, goal, a brief of any length and a repository link; the brief is kept whole and queued for the first session", async () => {
    expect(brief.length).toBeGreaterThan(300_000);
    const res = await req("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Gamma",
        goal: "Ship the thing",
        brief,
        repos: ["https://example.test/org/gamma"],
      }),
    });
    expect(res.status).toBe(201);
    const card = await json(res);
    projectId = String(card.id);
    expect(card).toMatchObject({ name: "Gamma", goal: "Ship the thing", stage: "planning" });
    const row = await rt.store.project.mustGet(projectId);
    expect(row.repos).toEqual(["https://example.test/org/gamma"]);
    expect((row.summary_cache as { brief?: string }).brief).toBe(brief);
    const queued = await rt.store.queue.pending(projectId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "note", status: "queued", human_id: rt.human.id });
    expect(queued[0]?.text).toBe(`Project brief:\n${brief}`);
  });

  it("takes a file upload into the project's data store and lists it", async () => {
    const boundary = "----forerunner-closeout-boundary";
    const body = new TextEncoder().encode(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="kind"',
        "",
        "csv",
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="notes.csv"',
        "Content-Type: text/csv",
        "",
        "topic,owner\nonboarding,J\n",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const up = await req(`/projects/${projectId}/data`, {
      method: "POST",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      body,
    });
    expect(up.status).toBe(201);
    const asset = await json(up);
    expect(JSON.stringify(asset)).toContain("notes.csv");
    const list = (await (await req(`/projects/${projectId}/data`)).json()) as Json[];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(asset.id);
  });

  it("the one-screen summary is readable aloud before any session ran", async () => {
    const res = await req(`/projects/${projectId}/summary`);
    expect(res.status).toBe(200);
    const summary = await json(res);
    expect(summary).toMatchObject({
      goal: "Ship the thing",
      stage: "planning",
      lastSession: null,
      nextSteps: [],
      openQuestions: 0,
      spend: { usdMicro: 0, chfMicro: 0 },
    });
    const spoken = String(summary.spoken);
    for (const part of [
      "Gamma.",
      "Goal: Ship the thing.",
      "Stage: planning.",
      "No session yet.",
      "0 open questions.",
      "Spent 0.00 francs.",
    ]) {
      expect(spoken).toContain(part);
    }
    // The brief itself is not read aloud: the summary stays one screen.
    expect(spoken.length).toBeLessThan(500);
  });
});
