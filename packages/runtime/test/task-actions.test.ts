import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { taskNoteText, WITHOUT_ANSWERS_NOTE } from "@forerunner/commands";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CommandResultViewSchema,
  ProjectCard,
  TaskTransitionView,
  TaskView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { plainReason, runOrder } from "../src/daemon/task-words.ts";
import { notesForTask } from "../src/session/next-session.ts";

/**
 * The Tasks tab's actions over the daemon (design §3.5, ADR 0102), composed on a file store so
 * a restart reads what the first daemon wrote: a person's pause is still "Paused by you" after
 * a restart and its Undo still works, and the note an action leaves reaches that task's brief.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

describe("task actions over the daemon, across a restart (design §3.5)", () => {
  const clock = new SimulatedClock("2026-11-01T10:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-task-actions-"));
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

  beforeAll(async () => {
    await compose();
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("a paused task is still Paused by you after a restart, never 'needs you', and its Undo works after it", async () => {
    const project = ProjectCard.parse(await post("/projects", { name: "Notes", goal: "Notes" }));
    const created = TaskTransitionView.parse(
      await post(`/projects/${project.id}/tasks`, {
        title: "Create notes/todo.md",
        outcome: "notes/todo.md lists the next steps",
      }),
    );
    expect(created.status).toBe("ready");
    const paused = TaskTransitionView.parse(
      await post(`/tasks/${created.id}/action`, { version: created.version, action: "pause" }),
    );
    expect(paused.display?.label).toBe("Paused by you");
    // No Inbox card was filed for it.
    expect(
      (await rt.store.humanRequest.open({ projectId: project.id })).filter(
        (r) => r.task_id === created.id,
      ),
    ).toEqual([]);

    await rt.close();
    await compose();

    const row = TaskView.array()
      .parse(await get(`/projects/${project.id}/tasks`))
      .find((t) => t.id === created.id);
    expect(row?.display?.label).toBe("Paused by you");
    expect(ProjectCard.parse(await get(`/projects/${project.id}`)).needsYou).toBeNull();
    const undone = CommandResultViewSchema.parse(
      await post(`/changes/${paused.change?.undoToken}/undo`),
    );
    expect(undone).toMatchObject({
      status: "done",
      sentence: 'Undone: the task "Create notes/todo.md" is ready again.',
    });
    expect((await rt.store.task.mustGet(created.id)).status).toBe("ready");
  });

  it("Stop on a task that is not running is refused in words; nothing changes", async () => {
    const project = ProjectCard.parse(await post("/projects", { name: "Stop", goal: "Stop" }));
    const created = TaskTransitionView.parse(
      await post(`/projects/${project.id}/tasks`, { title: "Ready one", outcome: "it is done" }),
    );
    const res = await req(`/tasks/${created.id}/action`, {
      method: "POST",
      body: JSON.stringify({ version: created.version, action: "stop" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as Json).message).toBe(
      '"Ready one" is Ready: Stop is not offered for it.',
    );
    expect((await rt.store.task.mustGet(created.id)).version).toBe(created.version);
  });
});

describe("the note a task action leaves (design §3.5, §4.6)", () => {
  it("names its task, so the next session gives it to that task's brief only", () => {
    const task = { id: "t1", title: "Write a README" };
    const other = { id: "t2", title: "Style the page" };
    const item = {
      id: "q1",
      kind: "note",
      text: taskNoteText(task, "Say how to open index.html."),
      priority: 0,
    };
    expect(item.text).toBe('About "Write a README": Say how to open index.html.');
    expect(notesForTask([item], task, [task, other]).map((n) => n.id)).toEqual(["q1"]);
    expect(notesForTask([item], other, [task, other])).toEqual([]);
    // A title too short to be matched by name is named by its id.
    expect(taskNoteText({ id: "t3", title: "FAQ" }, WITHOUT_ANSWERS_NOTE)).toContain("task t3");
  });
});

describe("the words of a task's status (design §2, §5)", () => {
  it("a stored reason reads as one plain line: no ids, no ladder words", () => {
    expect(
      plainReason(
        "retry ladder exhausted after 4 failed attempt(s) at opus (ceiling opus): human decides",
      ),
    ).toBe("tried 4 times");
    expect(
      plainReason(
        "you answered its questions in the Inbox (request 01a196fe-c00e-7150-a586-7e366743c5ff)",
      ),
    ).toBe("you answered its questions in the Inbox");
    expect(plainReason("x ".repeat(80)).length).toBeLessThanOrEqual(100);
  });

  it("the run order puts a task after what it waits for, then priority, then age; stable", () => {
    const t = (id: string, priority: number, created: string, depends_on: string[] = []) => ({
      id,
      priority,
      created_at: created,
      depends_on,
    });
    const order = runOrder([
      t("notes", 10, "2026-11-01T10:03:00Z", ["readme"]),
      t("readme", 5, "2026-11-01T10:01:00Z"),
      t("license", 5, "2026-11-01T10:02:00Z"),
      t("urgent", 10, "2026-11-01T10:04:00Z"),
    ]).map((x) => x.id);
    expect(order).toEqual(["urgent", "readme", "notes", "license"]);
  });
});
