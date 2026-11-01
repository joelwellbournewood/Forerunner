import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * The Start dialog's note reaches the work (design §4.6, §5.9 "no promises the code does not
 * keep"). Before, the dialog's Reason said "Shown in the session log and the handoff" and was
 * thrown away: `POST /sessions` passed it to the scheduler, and compose never gave it to the
 * runner.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

describe("the note for a session reaches every task's brief (design §4.6)", () => {
  let rt: RuntimeApp;
  afterAll(async () => {
    await rt?.close();
  });

  it("POST /sessions with a note: the specialist's brief carries it and the handoff keeps it", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-session-note-"));
    const clock = new SimulatedClock("2026-11-01T12:00:00Z");
    const provider = new ScriptedProvider([{ text: "Done." }], clock);
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
    const project = await rt.store.project.insert({
      name: "Greeting page",
      goal: "A page that greets",
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
    });
    await rt.store.task.insert({
      project_id: project.id,
      title: "Create index.html",
      outcome: "index.html greets the visitor",
      acceptance_criteria: ["index.html exists"],
      risk_tier: 0,
      status: "ready",
      priority: 5,
    });
    const { app, token } = createDaemonApp(rt);
    const res = await app.request("/sessions", {
      method: "POST",
      body: JSON.stringify({
        agentId: rt.agent.id,
        projectId: project.id,
        trigger: "manual",
        note: "Say good evening after 6 pm.",
      }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { session: { id: string } | null };
    const id = body.session?.id ?? "";
    for (let i = 0; i < 400 && (await rt.store.session.active(rt.agent.id)).length > 0; i++)
      await new Promise((r) => setTimeout(r, 25));
    const session = await rt.store.session.mustGet(id);
    expect((session.handoff as { note?: string }).note).toBe("Say good evening after 6 pm.");
    const specialistCall = provider.calls.find((c) =>
      JSON.stringify(c.messages[0]?.content ?? "").includes("# Task brief"),
    );
    expect(JSON.stringify(specialistCall?.messages[0]?.content)).toContain(
      "Say good evening after 6 pm.",
    );
  }, 120_000);
});
