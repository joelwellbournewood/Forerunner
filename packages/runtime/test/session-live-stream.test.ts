import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";

/**
 * The session page's steps and spend move while a task runs (design §3.7, §4.14). Before, the
 * runner wrote steps and spend only at the session's end and the stream of
 * `GET /sessions/:id/events` carried session events only, so the page read "Steps 0 / 200" and
 * "CHF 0.00" for the whole run. Now each step updates the row and the stream sends the row as a
 * `session.changed` frame when its steps, spend or status change.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

describe("the session stream carries the row's steps and spend as they change", () => {
  let rt: RuntimeApp;
  afterAll(async () => {
    await rt?.close();
  });

  it("a step recorded on the row reaches an open stream as session.changed", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-live-stream-"));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock: new SimulatedClock("2026-11-01T12:00:00Z"),
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
    let session = await rt.store.session.insert({
      agent_id: rt.agent.id,
      project_id: null,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 5_000_000,
      step_cap: 200,
      spent_usd_micro: 0,
      steps: 0,
      status: "planned",
      summary: "",
      handoff: {},
      runner: "pc",
    });
    session = await rt.store.session.start(session.id, session.version);
    const { app, token } = createDaemonApp(rt);
    const ac = new AbortController();
    const res = await app.request(`/sessions/${session.id}/events?token=${token}`, {
      headers: { accept: "text/event-stream" },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no stream");
    const decoder = new TextDecoder();
    let text = "";
    // A model call and a tool step land on the row while the stream is open.
    await rt.store.session.recordSpend(session.id, 1_500, 1);
    await rt.store.session.recordSpend(session.id, 0, 1);
    const deadline = Date.now() + 5_000;
    while (!text.includes("event: session.changed") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: undefined }>((r) => setTimeout(() => r({}), 1_500)),
      ]);
      if (chunk.value) text += decoder.decode(chunk.value);
    }
    ac.abort();
    const frame = text
      .split("\n\n")
      .find((f) => f.includes("event: session.changed"))
      ?.split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("");
    expect(frame).toBeDefined();
    const view = JSON.parse(frame ?? "{}") as {
      id: string;
      steps: number;
      spent: { usdMicro: number };
    };
    expect(view.id).toBe(session.id);
    expect(view.steps).toBe(2);
    expect(view.spent.usdMicro).toBe(1_500);
  }, 60_000);
});
