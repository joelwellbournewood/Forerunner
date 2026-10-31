import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChangeLogView,
  ChatReplyView,
  CommandResultViewSchema,
  ProjectCard,
  TaskTransitionView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";

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
  const _restart = async () => {
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
  const _chat = async (body: Json) =>
    ChatReplyView.parse(
      await post("/chat", { humanId: rt.human.id, agentId: rt.agent.id, ...body }),
    );
  const createProject = async (name: string) =>
    ProjectCard.parse(await post("/projects", { name, goal: `${name} goal` }));
  const _taskTitles = async (projectId: string) =>
    ((await get(`/projects/${projectId}/tasks`)) as { title: string }[]).map((t) => t.title);
  const _activeProjectId = async () => ((await get("/me")) as Json).activeProjectId;

  beforeAll(async () => {
    await compose();
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
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
});
