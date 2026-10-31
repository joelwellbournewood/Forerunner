// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { composeRuntime, type RuntimeApp } from "@forerunner/runtime/daemon/compose";
import { createDaemonApp } from "@forerunner/runtime/daemon/server";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedProvider } from "../../../packages/runtime/test/helpers.ts";
import { ApiError, createClient, type DaemonClient, isRouteMissing } from "../src/api/client.ts";

/**
 * The UI's own client against the real daemon (U-008 in docs/status/UPDATE-LOG.md). The screen
 * tests run against `fake-daemon.ts`, which answered routes the daemon never had (the
 * next-session queue, the docs, the import) and a session from `POST /sessions` where the daemon
 * answers the scheduler's outcome; the screens passed their tests and failed in the app
 * (U-003 to U-006). Here the whole runtime is composed as `fr daemon` composes it, the client
 * the screens use calls it through `app.request`, and every answer is parsed with the UI's
 * schemas: a route the daemon lacks or an answer of another shape fails this file.
 */

const REGISTRY = fileURLToPath(new URL("../../../evals/registry", import.meta.url));

/** What a call came back with, when it is a mismatch between the screens and the daemon. */
function mismatch(error: unknown): string | null {
  if (!(error instanceof ApiError)) return `threw ${String(error)}`;
  if (error.code === "ui.invalid_response") return error.message;
  if (isRouteMissing(error)) return `route missing: ${error.message}`;
  return null;
}

describe("the UI client against the real daemon", () => {
  let rt: RuntimeApp;
  let client: DaemonClient;
  let projectId = "";
  let agentId = "";
  let humanId = "";
  let dataDir = "";

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ui-real-"));
    dataDir = join(home, "incoming");
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Done for today." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.0.0-ui-contract",
    });
    const { app, token } = createDaemonApp(rt);
    client = createClient(
      {
        baseUrl: "http://daemon.test",
        token,
        source: "env",
        installId: null,
        platform: null,
        shellVersion: null,
      },
      (input, init) => Promise.resolve(app.request(input, init)),
    );
    const me = await client.me();
    humanId = me.id;
    agentId = (await client.agents())[0]?.id ?? "";
    const project = await client.createProject({ name: "Contract", goal: "Screens match" });
    projectId = project.id;
    // Composing the whole runtime on a cold Windows runner has exceeded the default hook timeout.
  }, 120_000);

  afterAll(async () => {
    await rt?.close();
  });

  it("answers every screen's read call in the shape the screen parses", async () => {
    const reads: Array<[string, () => Promise<unknown>]> = [
      ["health", () => client.health()],
      ["me", () => client.me()],
      ["agents", () => client.agents()],
      ["projects", () => client.projects()],
      ["project", () => client.project(projectId)],
      ["projectSummary", () => client.projectSummary(projectId)],
      ["tasks", () => client.tasks(projectId)],
      ["runs", () => client.runs(projectId)],
      ["decisions", () => client.decisions(projectId)],
      ["peers", () => client.peers(projectId)],
      ["sessions", () => client.sessions({ projectId })],
      ["desktopStatus", () => client.desktopStatus()],
      ["inbox", () => client.inbox(humanId)],
      ["costs", () => client.costs({ projectId })],
      ["costEstimates", () => client.costEstimates()],
      ["settings", () => client.settings()],
      ["modelSettings", () => client.modelSettings()],
      ["extensions", () => client.extensions()],
      ["extensionCatalog", () => client.extensionCatalog()],
      ["voiceStatus", () => client.voiceStatus()],
      ["updates", () => client.updates()],
      ["updatesStatus", () => client.updatesStatus()],
      ["modelWatchReports", () => client.modelWatchReports()],
      ["reviews", () => client.reviews(projectId)],
      ["memoryScopes", () => client.memoryScopes()],
      ["memory", () => client.memory({ scope: "shared" })],
      ["consolidation", () => client.consolidation()],
      ["memoryPromotions", () => client.memoryPromotions()],
      ["memoryOffers", () => client.memoryOffers()],
      ["commandDefs", () => client.commandDefs()],
      ["pendingCommands", () => client.pendingCommands()],
      ["changes", () => client.changes({ projectId })],
      ["emailSettings", () => client.emailSettings(agentId)],
      ["emailSent", () => client.emailSent(agentId)],
      ["emailCommands", () => client.emailCommands(agentId)],
      ["queue", () => client.queue(projectId)],
      ["milestones", () => client.milestones(projectId)],
      ["dataAssets", () => client.dataAssets(projectId)],
      ["docs", () => client.docs(projectId)],
      ["performance", () => client.performance({ projectId })],
      ["sources", () => client.sources()],
      ["devices", () => client.devices()],
      ["setupStatus", () => client.setupStatus()],
    ];
    const failures: string[] = [];
    for (const [name, call] of reads) {
      try {
        await call();
      } catch (error) {
        const why = mismatch(error);
        if (why) failures.push(`${name}: ${why}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("start session: answers with the session it started, which the dialog opens (U-003)", async () => {
    const started = await client.startSession({ agentId, projectId, trigger: "manual" });
    expect(started.result).toBe("started");
    expect(started.startId).toEqual(expect.any(String));
    const session = started.session;
    expect(session).not.toBeNull();
    expect(session?.agentId).toBe(agentId);
    expect(session?.projectId).toBe(projectId);
    // The dialog navigates to the session page, which reads it by id.
    expect((await client.session(session?.id ?? "")).id).toBe(session?.id);
  });

  it("next-session queue: add, list and dismiss (U-004)", async () => {
    const added = await client.enqueue(projectId, {
      kind: "correction",
      text: "Use the staging database",
      priority: 7,
    });
    expect(added).toMatchObject({
      projectId,
      humanId,
      kind: "correction",
      text: "Use the staging database",
      priority: 7,
      status: "queued",
    });
    const queued = await client.queue(projectId, { status: "queued" });
    expect(queued.map((q) => q.id)).toContain(added.id);
    const dismissed = await client.dismissQueueItem(added.id);
    expect(dismissed).toMatchObject({ id: added.id, status: "dismissed" });
    expect((await client.queue(projectId, { status: "queued" })).map((q) => q.id)).not.toContain(
      added.id,
    );
    expect((await client.queue(projectId)).find((q) => q.id === added.id)?.status).toBe(
      "dismissed",
    );
  });

  it("docs: lists the standard doc set and reads one (U-005)", async () => {
    const docs = await client.docs(projectId);
    const readme = docs.find((d) => d.path === "README.md");
    expect(readme).toMatchObject({ exists: true });
    expect(docs.map((d) => d.path)).toContain("docs/status.md");
    const content = await client.doc(projectId, "README.md");
    expect(content.path).toBe("README.md");
    expect(content.content).toContain("Contract");
  });

  it("rename the agent: Settings' call renames the principal and /me and /agents follow (U-025)", async () => {
    const renamed = await client.renameAgent(agentId, "  Robin  ");
    expect(renamed).toMatchObject({ id: agentId, name: "Robin", ownerHumanId: humanId });
    expect((await client.agents()).find((a) => a.id === agentId)?.name).toBe("Robin");
    expect(rt.agent.name).toBe("Robin");
    // The daemon's refusal reaches the field as an ApiError with its own words.
    const refused = await client.renameAgent(agentId, "critic").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ApiError);
    expect((refused as ApiError).status).toBe(409);
    expect((refused as ApiError).message).toContain("already have an agent named Critic");
  });

  it("data import: imports a folder through the daemon's import (U-006)", async () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "notes.csv"), "a,b\n1,2\n");
    const result = await client.importProject(projectId, { source: "folder", locator: dataDir });
    expect(result.projectId).toBe(projectId);
    expect(result.entryCount).toBeGreaterThanOrEqual(1);
  });
});
