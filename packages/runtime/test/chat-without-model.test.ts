import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";

/**
 * U-047: without a Claude key, Chat refused everything with 503 "no model credential
 * configured; run fr setup", even "add a task: …", which the command parser understands with
 * no model call, and named a command the installed app does not have. The chat routes now run
 * every command that needs no model; a line that needs the model, a session start and voice
 * say that a Claude key is missing and where the setup assistant is, never `fr setup`.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

describe("Chat without a Claude key (U-047)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  let otherId = "";
  const clock = new SimulatedClock("2026-10-31T09:00:00Z");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  /** One chat line, as the Chat tab sends it. */
  const say = async (text: string) => {
    const res = await req("/chat", {
      method: "POST",
      body: JSON.stringify({ humanId: rt.human.id, agentId: rt.agent.id, projectId, text }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-chat-no-model-"));
    // No provider and an empty vault: the install as it is before the setup assistant ran.
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
    projectId = (await rt.store.project.insert({ name: "Club site", goal: "A site" })).id;
    otherId = (await rt.store.project.insert({ name: "Newsletter", goal: "A letter" })).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it('"add a task: …" adds the task', async () => {
    const r = await say("add a task: write the README");
    expect(r.status).toBe(200);
    expect(String(r.body.reply)).not.toMatch(/fr setup/);
    const tasks = await rt.store.task.forProject(projectId);
    expect(tasks.map((t) => [t.title, t.status])).toContainEqual(["write the README", "ready"]);
  });

  it("a line that needs the model says a Claude key is missing and where to add it", async () => {
    const r = await say("What should we do first?");
    expect(r.status).toBe(200);
    expect(String(r.body.reply)).toContain("No Claude key or subscription is set up yet");
    expect(String(r.body.reply)).toContain(
      "Settings → Accounts and keys → Open the setup assistant",
    );
    expect(String(r.body.reply)).not.toMatch(/fr setup/);
    // It says what works without one.
    expect(String(r.body.reply)).toContain("add a task:");
  });

  it('"make this a task" makes the line before it a task', async () => {
    await say("Draft the privacy notice for the sign-up form");
    const r = await say("make this a task");
    expect(r.status).toBe(200);
    const tasks = await rt.store.task.forProject(projectId);
    // The line before it is the person's, not the reply that a Claude key is missing.
    expect(tasks.map((t) => t.title)).toContain("Draft the privacy notice for the sign-up form");
    expect(tasks.some((t) => t.title.startsWith("No Claude key"))).toBe(false);
  });

  it('"switch to …" switches the active project', async () => {
    const r = await say("switch to Newsletter");
    expect(r.status).toBe(200);
    expect(r.body.activeProjectId).toBe(otherId);
    await say("switch to Club site");
  });

  it("the streaming route answers too, with the reply and no error", async () => {
    const res = await req("/chat/stream", {
      method: "POST",
      body: JSON.stringify({
        humanId: rt.human.id,
        agentId: rt.agent.id,
        projectId,
        text: "add a task: pick the colours",
      }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: reply");
    expect(text).not.toContain("event: error");
    const tasks = await rt.store.task.forProject(projectId);
    expect(tasks.some((t) => t.title === "pick the colours")).toBe(true);
  });

  it("starting a session and voice name the setup assistant, never fr setup", async () => {
    const started = await req("/sessions", {
      method: "POST",
      body: JSON.stringify({ agentId: rt.agent.id, projectId }),
    });
    const startBody = (await started.json()) as Json;
    expect(JSON.stringify(startBody)).not.toMatch(/fr setup/);
    expect(JSON.stringify(startBody)).toContain("Open the setup assistant");
    const voice = (await (await req("/voice/status")).json()) as Json;
    expect(voice.available).toBe(false);
    expect(String(voice.reason)).toContain("Open the setup assistant");
    expect(String(voice.reason)).not.toMatch(/fr setup/);
  });
});
