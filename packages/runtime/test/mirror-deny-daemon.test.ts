import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryGitHost, MIRROR_DENY_OPTION, MIRROR_SETTINGS_KEY } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { HumanRequestRow, ProjectRow } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { requestView } from "../src/daemon/views.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-031: answering "Do not mirror this project" to the GitHub Projects mirror saved nothing,
 * and the mirror's 15-minute schedule filed the same card again at its next run. A no now turns
 * the mirror off for the project (the setting `fr mirror disable` and the settings panel write)
 * and drops its schedule, so later runs ask nothing; turning it on again asks again.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const MIN = 60_000;

describe("a no to the GitHub mirror is kept (U-031)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  const gitHost = new MemoryGitHost("alice");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-mirror-deny-"));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      gitHost,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /** The mirror switched on or off as the project settings panel does it. */
  const setMirror = async (project: ProjectRow, enabled: boolean) => {
    const current = await rt.store.project.mustGet(project.id);
    const res = await req(`/projects/${project.id}/settings`, {
      method: "PUT",
      body: JSON.stringify({
        version: current.version,
        settings: { [MIRROR_SETTINGS_KEY]: { enabled, owner: "acme" } },
      }),
    });
    expect(res.status).toBe(200);
  };
  const scheduled = (project: ProjectRow) =>
    rt.scheduler.list().some((s) => s.id === `mirror:${project.id}`);
  const cards = (project: ProjectRow) => rt.store.humanRequest.list({ project_id: project.id });
  /** Real time for the background run; the simulated clock only moves when told. */
  const until = async <T>(read: () => Promise<T | undefined>): Promise<T> => {
    for (let i = 0; i < 500; i++) {
      const v = await read();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("timed out");
  };

  it("deny with the option shown, two more scheduled runs: one card in all, the mirror off and unscheduled; enabling it asks again", async () => {
    const project = await rt.store.project.insert({
      name: "Mirrored",
      goal: "Mirror the tasks",
      repos: ["acme/sample"],
    });
    await rt.store.task.insert({ project_id: project.id, title: "A task", status: "ready" });
    await setMirror(project, true);
    expect(scheduled(project)).toBe(true);

    // The schedule's run asks the person in the Inbox.
    await rt.scheduler.tick(clock.now() + 16 * MIN);
    const asked = await until(async () =>
      (await cards(project)).find((r: HumanRequestRow) => r.status === "open"),
    );
    // The person clicks the option the Inbox shows for no.
    const no = requestView(asked, null).options[1];
    expect(no).toBe(MIRROR_DENY_OPTION);
    const answered = await req(`/requests/${asked.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: asked.version, answer: no }),
    });
    expect(answered.status).toBe(200);

    // The no is kept: the mirror is off for the project and its schedule is gone.
    const off = await until(async () => {
      const p = await rt.store.project.mustGet(project.id);
      const s = p.settings[MIRROR_SETTINGS_KEY] as { enabled?: boolean } | undefined;
      return s?.enabled === false ? p : undefined;
    });
    expect(off.settings[MIRROR_SETTINGS_KEY]).toMatchObject({ enabled: false, owner: "acme" });
    await until(async () => (scheduled(project) ? undefined : true));

    // Two more runs of the schedule's time: nothing is asked again, nothing is created.
    await rt.scheduler.tick(clock.now() + 32 * MIN);
    await rt.scheduler.tick(clock.now() + 48 * MIN);
    await new Promise((r) => setTimeout(r, 50));
    expect(await cards(project)).toHaveLength(1);
    expect(gitHost.projectCalls).toEqual([]);

    // Turned on again in the settings, the next run asks again.
    await setMirror(project, true);
    expect(scheduled(project)).toBe(true);
    await rt.scheduler.tick(clock.now() + 70 * MIN);
    const again = await until(async () =>
      (await cards(project)).find((r) => r.status === "open" && r.id !== asked.id),
    );
    expect(again.options).toEqual(asked.options);
  });
});
