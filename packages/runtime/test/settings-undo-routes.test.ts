import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { BUILTIN_PRICING } from "@forerunner/billing";
import { desktop } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChangeLogView,
  ChatReplyView,
  CommandResultViewSchema,
  DESKTOP_ALLOWLIST_CONTROL,
  ModelSettingsView,
  ProjectCard,
  SettingView,
  TaskTransitionView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { settingsView } from "../src/daemon/settings-view.ts";
import { EVALS_DEFERRED_REASON } from "../src/models/watch.ts";

/**
 * Settings, undo and the change log over the daemon, as the screens send them (U-056 to U-061):
 * one active project for every channel, an undo confirmed like the change it makes, new
 * projects at the person's default autonomy, every setting listed, and task moves logged.
 * The runtime is composed on a file store so a restart reads what the first daemon wrote.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

describe("settings, undo and the change log over the daemon (U-056 to U-061)", () => {
  const clock = new SimulatedClock("2026-10-20T18:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-settings-undo-"));
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;

  const compose = async () => {
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault(),
      provider: new FakeProvider({
        replies: [textReply("Noted.", { times: Number.POSITIVE_INFINITY })],
        clock,
        latency: "none",
      }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    ({ app, token } = createDaemonApp(rt));
  };
  const restart = async () => {
    await rt.close();
    await compose();
  };
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const post = async (path: string, body: unknown = {}) =>
    (await (await req(path, { method: "POST", body: JSON.stringify(body) })).json()) as Json;
  const get = async (path: string) => (await (await req(path)).json()) as unknown;
  const execute = async (commands: unknown[], extra: Json = {}) =>
    CommandResultViewSchema.parse(
      await post("/commands/execute", { commands, source: "ui", ...extra }),
    );
  const chat = async (body: Json) =>
    ChatReplyView.parse(
      await post("/chat", { humanId: rt.human.id, agentId: rt.agent.id, ...body }),
    );
  const createProject = async (name: string) =>
    ProjectCard.parse(await post("/projects", { name, goal: `${name} goal` }));
  const taskTitles = async (projectId: string) =>
    ((await get(`/projects/${projectId}/tasks`)) as { title: string }[]).map((t) => t.title);
  const activeProjectId = async () => ((await get("/me")) as Json).activeProjectId;

  beforeAll(async () => {
    await compose();
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("U-056: the header's switch is the one active project; a project's Chat tab wins for its turn only", async () => {
    const alpha = await createProject("Alpha");
    const beta = await createProject("Beta");
    // Switched by chat to Alpha: Chat, voice and the phone use Alpha.
    const switched = await chat({ text: "switch to Alpha" });
    expect(switched.activeProjectId).toBe(alpha.id);
    expect(await activeProjectId()).toBe(alpha.id);

    // Beta's own Chat tab: "add a task" lands in Beta; the active project stays Alpha.
    const inTab = await chat({
      projectId: beta.id,
      projectTab: true,
      text: "add a task: write the Beta README",
    });
    expect(inTab.actions.map((a) => a.kind)).toEqual(["task.create"]);
    expect(await taskTitles(beta.id)).toContain("write the Beta README");
    expect(await taskTitles(alpha.id)).not.toContain("write the Beta README");
    expect(inTab.activeProjectId).toBe(alpha.id);
    expect(await activeProjectId()).toBe(alpha.id);

    // The conversation panel (no tab) follows the active project, whatever it names.
    await chat({ projectId: beta.id, text: "add a task: write the Alpha changelog" });
    expect(await taskTitles(alpha.id)).toContain("write the Alpha changelog");

    // The header's switcher and the palette run project.switch: the daemon records it, logged as ui.
    const header = await execute([{ name: "project.switch", params: { project: beta.id } }], {
      wordsUsed: "Switch project: Beta",
    });
    expect(header.status).toBe("done");
    expect(await activeProjectId()).toBe(beta.id);
    const row = await rt.store.changeLog.mustGet(header.changeLogId ?? "");
    expect(row.source).toBe("ui");
    // Chat now uses Beta too, and so does the next daemon after a restart.
    await chat({ text: "add a task: plan the Beta launch" });
    expect(await taskTitles(beta.id)).toContain("plan the Beta launch");
    await restart();
    expect(await activeProjectId()).toBe(beta.id);
  });

  it("U-058: a project created in the app starts at the person's default autonomy, also after a restart", async () => {
    const set = await execute(
      [{ name: "settings.set", params: { key: "default_autonomy", value: 3 } }],
      { confirm: "tap", wordsUsed: "Settings: default autonomy to 3" },
    );
    expect(set.status).toBe("done");
    expect((await createProject("Gamma")).autonomyLevel).toBe(3);
    await restart();
    expect((await createProject("Delta")).autonomyLevel).toBe(3);
  });

  it("U-057: undoing a lowered monthly cap waits for this PC's confirmation; a tap is refused", async () => {
    const capNow = async () => (await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro;
    const originalCap = await capNow();
    const lowered = await execute(
      [{ name: "budget.set", params: { scope: "month", amountChf: 100 } }],
      { confirm: "tap" },
    );
    expect(lowered.status).toBe("done");
    const undo = CommandResultViewSchema.parse(await post(`/changes/${lowered.changeLogId}/undo`));
    expect(undo.status).toBe("pending");
    expect(undo.decision).toBe("needs_device");
    // The Inbox shows it with the device's options.
    const inbox = (await get(`/inbox?humanId=${rt.human.id}`)) as {
      requests: { id: string; options: unknown[]; risk: string }[];
    };
    expect(inbox.requests.find((r) => r.id === undo.pendingId)).toMatchObject({
      options: ["approve on device", "reject"],
      risk: "high",
    });
    const lowCap = await capNow();
    expect(lowCap).toBeLessThan(originalCap);
    const tap = CommandResultViewSchema.parse(
      await post(`/commands/${undo.pendingId}/confirm`, { answer: "tap" }),
    );
    expect(tap.status).toBe("refused");
    expect(await capNow()).toBe(lowCap);
    const device = CommandResultViewSchema.parse(
      await post(`/commands/${undo.pendingId}/confirm`, { answer: "device" }),
    );
    expect(device.status).toBe("done");
    expect(device.sentence).toMatch(/^Undone: the monthly cap is back to CHF 150(\.\d\d)?\.$/);
    expect(await capNow()).toBe(originalCap);
    // Logged with its real source: the Changes screen is `ui`.
    expect((await rt.store.changeLog.mustGet(device.changeLogId ?? "")).source).toBe("ui");
  });

  it("U-061: a move in the Tasks tab is in the change log with Undo; a cancel is reopened", async () => {
    const project = await createProject("Epsilon");
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Draft the onboarding mail",
      status: "ready",
    });
    const moved = TaskTransitionView.parse(
      await post(`/tasks/${task.id}/transition`, {
        version: task.version,
        to: "cancelled",
        reason: "not needed any more",
      }),
    );
    expect(moved.status).toBe("cancelled");
    expect(moved.change?.sentence).toBe(
      'Moved the task "Draft the onboarding mail" from ready to cancelled. Undo.',
    );
    const changes = ChangeLogView.array().parse(await get(`/changes?projectId=${project.id}`));
    const row = changes.find((c) => c.id === moved.change?.changeLogId);
    expect(row).toMatchObject({
      source: "ui",
      wordsUsed: "not needed any more",
      undoable: true,
    });
    const undone = CommandResultViewSchema.parse(
      await post(`/changes/${moved.change?.changeLogId}/undo`),
    );
    expect(undone.status).toBe("done");
    expect(undone.sentence).toBe(
      'Undone: reopened the task "Draft the onboarding mail"; it is ready again.',
    );
    expect((await rt.store.task.mustGet(task.id)).status).toBe("ready");
    // A stale dialog (an old version) is refused like the store refuses it, nothing logged.
    const stale = await req(`/tasks/${task.id}/transition`, {
      method: "POST",
      body: JSON.stringify({ version: task.version, to: "needs_human", reason: "stale" }),
    });
    expect(stale.status).toBe(409);
  });

  it("U-061: an undo that cannot work is not offered, and says why when asked", async () => {
    const project = await createProject("Zeta");
    const created = await execute(
      [{ name: "task.create", params: { title: "Ship the beta", project: project.id } }],
      { wordsUsed: "add a task: ship the beta" },
    );
    const taskId = ((await rt.store.changeLog.mustGet(created.changeLogId ?? "")).after as Json)
      .task_id as string;
    for (const to of ["ready", "claimed", "in_progress", "in_review", "done"] as const) {
      const t = await rt.store.task.mustGet(taskId);
      await rt.store.task.transition(t.id, t.version, to, "work", { agentId: rt.agent.id });
    }
    const why =
      'the task "Ship the beta" is done; a done task cannot be cancelled, so its creation cannot be undone';
    const rows = ChangeLogView.array().parse(await get(`/changes?projectId=${project.id}`));
    expect(rows.find((c) => c.id === created.changeLogId)).toMatchObject({
      undoState: "undoable",
      undoable: false,
      undoBlockedReason: why,
    });
    const onlyUndoable = ChangeLogView.array().parse(
      await get(`/changes?projectId=${project.id}&undoable=true`),
    );
    expect(onlyUndoable.map((c) => c.id)).not.toContain(created.changeLogId);
    const refused = CommandResultViewSchema.parse(
      await post(`/changes/${created.changeLogId}/undo`),
    );
    expect(refused).toMatchObject({ status: "refused", reason: why });
    expect((await rt.store.task.mustGet(taskId)).status).toBe("done");
  });

  it("U-060: Settings lists every setting with a plain label", async () => {
    const rows = SettingView.array().parse(await get("/settings"));
    const human = rows.filter((r) => r.scope === "human").map((r) => [r.key, r.label]);
    expect(human).toEqual(
      expect.arrayContaining([
        ["human.quiet_hours", "Quiet hours"],
        ["human.notify_channel", "Where notifications go"],
        ["human.voice_alerts", "Read urgent notifications aloud"],
        ["human.language", "Language"],
        ["human.model_watch", "Model watch evaluations"],
      ]),
    );
    const project = rows.filter((r) => r.scope === "project").map((r) => r.key);
    expect(project).toEqual(
      expect.arrayContaining([
        "project.session_cap",
        "project.critic_ceiling",
        "project.small_project_mode",
      ]),
    );
    expect(rows.every((r) => typeof r.label === "string" && r.label.length > 0)).toBe(true);
  });

  it("U-059: model rows say which speed applies and the highest model they run at", async () => {
    const view = ModelSettingsView.parse(await get("/settings/models"));
    const modes = view.agents[0]?.modes ?? [];
    const chatRow = modes.find((m) => m.mode === "text_chat");
    const planning = modes.find((m) => m.mode === "planning");
    expect(chatRow?.speedModeApplies).toBe(false);
    expect(planning?.speedModeApplies).toBe(false);
    expect(chatRow?.ceiling).toMatchObject({ tier: "opus", raisable: false });
    expect(planning?.ceiling).toMatchObject({ tier: "opus", raisable: true });
    const specialist = view.specialists[0]?.settings;
    expect(specialist?.speedModeApplies).toBe(true);
    expect(specialist?.ceiling?.note).toContain("Highest model");
  });
});

describe("texts that point to Settings name a control that exists (U-060)", () => {
  it("the desktop approval card names the Settings section that edits the allowlist", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const port = new desktop.HumanRequestDesktopApprovals({
      list: async () => [],
      insert: async (row) => {
        inserted.push(row);
        return row as never;
      },
    });
    await port.ask({
      sessionId: "s1",
      runId: "r1",
      agentId: "alice",
      humanId: "h1",
      tool: "desktop_type",
      actionClass: "permission_change",
      risk: "high",
      why: "the agent wants to type in firefox",
      input: { action: "type" },
      reason: "app_not_allowed",
      app: { exe: "firefox", windowClass: "Navigator.firefox", title: "Mozilla Firefox" },
    });
    const steps = inserted[0]?.steps as string[];
    expect(steps).toContain(
      `To allow it permanently, add it in Settings under ${DESKTOP_ALLOWLIST_CONTROL}.`,
    );
  });

  it("the model watch's deferred evals name the Settings control that runs them", () => {
    expect(EVALS_DEFERRED_REASON).toContain("Run the paid evaluations every week without asking");
    expect(EVALS_DEFERRED_REASON).toContain("Model watch evaluations");
  });
});

describe("settingsView (U-060)", () => {
  it("shows an unset monthly and session cap as the defaults in force, not CHF 0", async () => {
    const clock = new SimulatedClock("2026-10-20T18:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const human = await store.human.insert({ name: "J", email: "j@example.test" });
    const project = await store.project.insert({ name: "Eta" });
    const rows = settingsView({
      human,
      projects: [project],
      chfPerUsd: 0.8,
      providerName: "fake",
      registryDir: "registry",
      pricing: BUILTIN_PRICING,
    });
    const value = (key: string) => rows.find((r) => r.key === key)?.value;
    expect(value("human.monthly_cap")).toEqual({ usdMicro: 187_500_000, chfMicro: 150_000_000 });
    expect(value("project.session_cap")).toEqual({ usdMicro: 6_250_000, chfMicro: 5_000_000 });
    expect(value("human.notify_channel")).toBe("desktop");
    expect(value("human.voice_alerts")).toBe(false);
    expect(value("project.critic_ceiling")).toBeNull();
    await store.close();
  });
});
