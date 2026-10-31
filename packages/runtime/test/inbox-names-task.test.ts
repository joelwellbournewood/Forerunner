import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { signoffCard } from "@forerunner/critic";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { approvalKeyFor } from "../src/enforcement/hooks.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-073: Inbox cards did not say what they were about. A critic sign-off ("Critic sign-off
 * needed (tier 1, grade 30 …)") and a hooks approval ("autonomy level 2 requires approval for
 * destructive") named no task, so the person could not tell which work they were asked about.
 * `GET /inbox` now carries the task's title beside the project's name on every card that names
 * a task, and the Inbox shows both.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

describe("every Inbox card names its task and project (U-073)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const clock = new SimulatedClock("2026-10-31T08:00:00Z");

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-inbox-names-"));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("GET /inbox names the task beside the project on every card that has one", async () => {
    const project = await rt.store.project.insert({ name: "Club site", goal: "A site" });
    const task = await rt.store.task.insert({
      project_id: project.id,
      title: "Set up the contact form",
      outcome: "mail arrives",
      status: "needs_human",
      reason: "seed",
    });
    const base = {
      human_id: rt.human.id,
      project_id: project.id,
      task_id: task.id,
      blocking: true,
      risk: "medium" as const,
    };
    await rt.store.humanRequest.insert({
      ...base,
      kind: "approval",
      why: "Critic sign-off needed (tier 1, grade 30, confidence 0.80): nothing was done.",
      steps: [],
      options: ["accept", "revise", "cancel"],
      change_card: signoffCard({
        taskId: task.id,
        reviewId: null,
        runId: null,
        findingIds: [],
        reason: "verdict",
      }),
    });
    await rt.store.humanRequest.insert({
      ...base,
      kind: "approval",
      why: "autonomy level 2 requires approval for destructive",
      steps: ["Tool: delete_repo", "Action class: destructive"],
      options: ["yes", "no"],
      change_card: {
        key: approvalKeyFor("delete_repo", { repo: "org/old" }),
        tool: "delete_repo",
        actionClass: "destructive",
        input: { repo: "org/old" },
      },
    });
    // A card about no task names none.
    await rt.store.humanRequest.insert({
      human_id: rt.human.id,
      project_id: project.id,
      kind: "decision",
      why: "Which versioning scheme should the docs use?",
      steps: [],
      options: [],
      blocking: false,
      risk: "low",
    });
    const res = await app.request("/inbox", { headers: { authorization: `Bearer ${token}` } });
    const inbox = (await res.json()) as { requests: Json[] };
    const withTask = inbox.requests.filter((r) => r.taskId === task.id);
    expect(withTask).toHaveLength(2);
    for (const r of withTask)
      expect(r).toMatchObject({ projectName: "Club site", taskTitle: "Set up the contact form" });
    expect(inbox.requests.find((r) => r.taskId === null)).toMatchObject({
      projectName: "Club site",
      taskTitle: null,
    });
  });
});
