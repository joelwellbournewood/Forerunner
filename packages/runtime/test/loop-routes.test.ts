import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SESSION_OVERRIDE_KEY } from "@forerunner/commands";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ChangeLogView,
  ChatReplyView,
  CommandDefView,
  CommandResultViewSchema,
  ConsolidationProposalView,
  ConsolidationRunView,
  DAEMON_ROUTES,
  LessonView,
  MemoryScopeView,
  MemoryView,
  PendingChangeView,
  ReviewsView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  CONSOLIDATION_KEY,
  MEMORY_CONSOLIDATION_SCHEDULE_ID,
  MemoryLoop,
} from "../src/loop/memory.ts";
import { fileBlockedByFindingsRequest } from "../src/session/findings.ts";

/**
 * The daemon routes of the core loop (spec K.2 Reviews tab, K.5 memory views, Q commands and
 * the change log) over the composed runtime: the UI, the palette and the phone call the same
 * commands chat does, and each produces the same change log entry.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const jsonList = async (r: Response): Promise<Json[]> => (await r.json()) as Json[];

describe("core loop routes", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  let taskId = "";
  const clock = new SimulatedClock("2026-10-20T18:00:00Z");
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
    const home = mkdtempSync(join(tmpdir(), "fr-loop-routes-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new FakeProvider({
        replies: [textReply("Hello from the fake agent.", { times: Number.POSITIVE_INFINITY })],
        clock,
        latency: "none",
      }),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
    });
    ({ app, token } = createDaemonApp(rt));
    const p = await rt.store.project.insert({
      name: "PharmaWatch",
      goal: "Watch pharma news",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 10_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
    });
    projectId = p.id;
    await rt.store.project.insert({ name: "Game", goal: "Ship the game" });
    const t = await rt.store.task.insert({
      project_id: projectId,
      title: "Add clamp",
      outcome: "clamp exists",
      acceptance_criteria: ["works"],
      risk_tier: 1,
      status: "in_review",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 1,
      reason: "seed",
    });
    taskId = t.id;
  });
  afterAll(async () => {
    await rt.close();
  });

  it("composes the critic, memory and commands and names the routes", () => {
    expect(rt.critic).toBeDefined();
    expect(rt.criticAgent.name).toBe("Critic");
    expect(rt.memory).toBeDefined();
    expect(rt.commands.registry.names()).toContain("budget.set");
    expect(rt.scheduler.list().some((s) => s.id === MEMORY_CONSOLIDATION_SCHEDULE_ID)).toBe(true);
    for (const key of [
      "reviews",
      "taskReviews",
      "memory",
      "memoryScopes",
      "updateLesson",
      "pinLesson",
      "deleteLesson",
      "consolidation",
      "runConsolidation",
      "commands",
      "parseCommand",
      "executeCommands",
      "pendingCommands",
      "confirmCommand",
      "cancelCommand",
      "changes",
      "undoChange",
    ])
      expect(DAEMON_ROUTES).toHaveProperty(key);
  });

  it("serves the Reviews tab: reviews with findings, verdict counts and the grade trend", async () => {
    const r1 = await rt.store.review.insert({
      task_id: taskId,
      critic_model: "fake-sonnet",
      tier: 1,
      grade: 40,
      confidence: 0.9,
      verdict: "revise",
      evidence: ["checked"],
      summary: "no test",
      author_agent: rt.criticAgent.id,
    });
    await rt.store.finding.insert({
      review_id: r1.id,
      task_id: taskId,
      severity: "high",
      description: "No test covers clamp",
      required_action: "Add a test",
      status: "open",
      fingerprint: "fp-1",
      author_agent: rt.criticAgent.id,
    });
    await clock.advance(60_000);
    await rt.store.review.insert({
      task_id: taskId,
      critic_model: "fake-sonnet",
      tier: 1,
      grade: 88,
      confidence: 0.95,
      verdict: "accept",
      evidence: [],
      summary: "fine now",
      author_agent: rt.criticAgent.id,
    });
    const byProject = ReviewsView.parse(await json(await req(`/projects/${projectId}/reviews`)));
    expect(byProject.reviews).toHaveLength(2);
    expect(byProject.reviews[0]?.verdict).toBe("accept");
    expect(byProject.reviews[1]?.findings[0]?.description).toBe("No test covers clamp");
    expect(byProject.reviews[1]?.taskTitle).toBe("Add clamp");
    expect(byProject.openFindings).toBe(1);
    expect(byProject.verdicts).toEqual({ accept: 1, revise: 1 });
    expect(byProject.gradeTrend.map((p) => p.grade)).toEqual([40, 88]);
    expect(byProject.averageGrade).toBe(64);
    const byTask = ReviewsView.parse(await json(await req(`/tasks/${taskId}/reviews`)));
    expect(byTask.taskId).toBe(taskId);
    expect(byTask.reviews).toHaveLength(2);
    expect((await req("/tasks/nope/reviews")).status).toBe(404);
  });

  it("a task blocked by findings is unblocked from the inbox: the answer reworks it through syncApprovals", async () => {
    const blocked = await rt.store.task.insert({
      project_id: projectId,
      title: "Blocked by a finding",
      outcome: "closed",
      acceptance_criteria: ["works"],
      risk_tier: 0,
      status: "in_review",
      priority: 5,
      depends_on: [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 0,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "seed",
    });
    const review = await rt.store.review.insert({
      task_id: blocked.id,
      critic_model: "fake-sonnet",
      tier: 1,
      grade: 30,
      confidence: 0.9,
      verdict: "revise",
      evidence: [],
      summary: "earlier",
      author_agent: rt.criticAgent.id,
    });
    const finding = await rt.store.finding.insert({
      review_id: review.id,
      task_id: blocked.id,
      severity: "medium",
      description: "No Windows run of the script",
      required_action: "Run it on Windows CI",
      status: "open",
      fingerprint: "fp-win",
      author_agent: rt.criticAgent.id,
    });
    const filed = await fileBlockedByFindingsRequest({
      store: rt.store,
      task: blocked,
      session: null,
      humanId: rt.human.id,
      agentId: rt.agent.id,
      runId: null,
      findings: [finding],
      path: "tier0",
    });
    const inbox = await json(await req("/inbox"));
    const request = (inbox.requests as Json[]).find((r) => r.id === filed.request.id);
    if (!request) throw new Error("the blocked-findings request is not in the inbox");
    expect(request.options).toEqual(["rework", "accept", "cancel"]);
    const answered = await req(`/requests/${filed.request.id}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "rework" }),
    });
    expect(answered.status).toBe(200);
    const after = await rt.store.task.mustGet(blocked.id);
    expect(after.status).toBe("ready");
    expect(after.attempt).toBe(1);
    expect((await rt.store.finding.mustGet(finding.id)).status).toBe("open");
    expect((await rt.syncApprovals()).findings).toEqual({
      reworked: 0,
      accepted: 0,
      cancelled: 0,
      skipped: 0,
    });
  });

  it("serves the memory views: scopes, search, edit, pin, delete", async () => {
    await rt.memory.record({
      agentId: rt.agent.id,
      sessionId: "seed",
      projectId,
      lessons: [
        {
          text: "Run the Windows CI job before merging a change that touches paths.",
          tags: ["windows"],
        },
        {
          text: "Keep vault secret names in kebab case and never log their values.",
          tags: ["vault"],
        },
      ],
    });
    const scopes = (await jsonList(await req("/memory/scopes"))).map((s) =>
      MemoryScopeView.parse(s),
    );
    expect(scopes.map((s) => s.scope)).toEqual(["agent_private", "critic", "shared"]);
    expect(scopes[0]).toMatchObject({ label: "Alice", ownerAgentId: rt.agent.id, active: 2 });
    const view = MemoryView.parse(
      await json(await req(`/memory?scope=agent_private&agentId=${rt.agent.id}&q=vault`)),
    );
    expect(view.lessons).toHaveLength(1);
    expect(view.lessons[0]?.tags).toEqual(["vault"]);
    expect((await req("/memory?scope=agent_private")).status).toBe(409);
    expect((await req("/memory?scope=bogus")).status).toBe(409);
    const id = view.lessons[0]?.id ?? "";
    const edited = LessonView.parse(
      await json(
        await req(`/memory/lessons/${id}`, {
          method: "PUT",
          body: JSON.stringify({ tags: ["vault", "logging"], confidence: 0.9 }),
        }),
      ),
    );
    expect(edited.tags).toEqual(["vault", "logging"]);
    expect(edited.confidence).toBe(0.9);
    const bad = await req(`/memory/lessons/${id}`, {
      method: "PUT",
      body: JSON.stringify({ text: "short" }),
    });
    expect(bad.status).toBe(409);
    const pinned = LessonView.parse(
      await json(
        await req(`/memory/lessons/${id}/pin`, {
          method: "POST",
          body: JSON.stringify({ pinned: true }),
        }),
      ),
    );
    expect(pinned.pinned).toBe(true);
    const removed = LessonView.parse(
      await json(await req(`/memory/lessons/${id}`, { method: "DELETE" })),
    );
    expect(removed.status).toBe("retired");
    const after = MemoryView.parse(
      await json(await req(`/memory?scope=agent_private&agentId=${rt.agent.id}`)),
    );
    expect(after.lessons).toHaveLength(1);
  });

  it("the memory routes stop at the human boundary: another human's agent reads as 404", async () => {
    const k = await rt.store.human.insert({
      name: "K",
      email: "k@example.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 1_000_000,
      locale: "en",
    });
    const carol = await rt.store.agent.insert({
      name: "Carol",
      owner_human_id: k.id,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    const theirs = new MemoryLoop({
      store: rt.store,
      clock,
      files: rt.memory.files,
      humanId: k.id,
    });
    await theirs.record({
      agentId: carol.id,
      sessionId: "k-seed",
      projectId: null,
      lessons: [
        { text: "Carol's private note about her own project layout and naming.", tags: ["k"] },
      ],
    });
    const [row] = await theirs.list({ scope: "agent_private", ownerAgentId: carol.id });
    expect((await req(`/memory?scope=agent_private&agentId=${carol.id}`)).status).toBe(404);
    expect(
      (
        await req(`/memory/lessons/${row?.id}`, {
          method: "PUT",
          body: JSON.stringify({ text: "Overwritten by another human through the daemon." }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(`/memory/lessons/${row?.id}/pin`, {
          method: "POST",
          body: JSON.stringify({ pinned: true }),
        })
      ).status,
    ).toBe(404);
    expect((await req(`/memory/lessons/${row?.id}`, { method: "DELETE" })).status).toBe(404);
    expect(await rt.store.lesson.mustGet(row?.id ?? "")).toMatchObject({
      text: "Carol's private note about her own project layout and naming.",
      status: "active",
      pinned: false,
    });
    const scopes = (await jsonList(await req("/memory/scopes"))).map((s) =>
      MemoryScopeView.parse(s),
    );
    expect(scopes.map((s) => s.ownerAgentId)).not.toContain(carol.id);
  });

  it("runs the consolidation report and lists the proposals; the inbox answer applies them", async () => {
    const dup = "Run the Windows CI job before merging a change that touches file paths.";
    await rt.memory.ctx.repo.add({
      scope: "agent_private",
      owner_agent_id: rt.agent.id,
      project_id: projectId,
      text: dup,
      source: "session:seed2",
      tags: ["windows"],
      confidence: 0.5,
      hit_count: 0,
      pinned: false,
      status: "active",
      embedding: [...rt.memory.ctx.embedder.embed(dup)],
      author_agent: rt.agent.id,
    });
    const run = ConsolidationRunView.parse(
      await json(await req("/memory/consolidation/run", { method: "POST" })),
    );
    expect(run.requestId).not.toBeNull();
    expect(run.proposals).toBeGreaterThan(0);
    const listed = (await jsonList(await req("/memory/consolidation"))).map((p) =>
      ConsolidationProposalView.parse(p),
    );
    expect(listed[0]).toMatchObject({ requestId: run.requestId, status: "open", appliedAt: null });
    const inbox = await json(await req("/inbox"));
    const request = (inbox.requests as Json[]).find((r) => r.id === run.requestId);
    if (!request) throw new Error("the consolidation request is not in the inbox");
    expect((request.changeCard as Json).key).toBe(CONSOLIDATION_KEY);
    const answered = await req(`/requests/${run.requestId}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: request.version, answer: "apply" }),
    });
    expect(answered.status).toBe(200);
    const after = (await jsonList(await req("/memory/consolidation"))).map((p) =>
      ConsolidationProposalView.parse(p),
    );
    expect(after[0]?.appliedAt).not.toBeNull();
    const active = MemoryView.parse(
      await json(await req(`/memory?scope=agent_private&agentId=${rt.agent.id}`)),
    );
    expect(active.lessons).toHaveLength(1);
  });

  it("lists the registry and parses a sentence without running anything", async () => {
    const defs = (await jsonList(await req("/commands"))).map((d) => CommandDefView.parse(d));
    expect(defs.map((d) => d.name)).toContain("budget.set");
    expect(defs.find((d) => d.name === "budget.set")?.limit).toBe(true);
    const parsed = await json(
      await req("/commands/parse", {
        method: "POST",
        body: JSON.stringify({ text: "switch to pharmawatch and give it 20 francs tonight" }),
      }),
    );
    expect((parsed.commands as Json[]).map((c) => c.name)).toEqual([
      "project.switch",
      "budget.set",
    ]);
    expect(parsed.matched).toBe("pattern");
    expect(await rt.store.changeLog.list()).toHaveLength(0);
  });

  it("executes commands from the UI: low risk acts, medium waits for a yes, the change log and undo follow", async () => {
    const low = CommandResultViewSchema.parse(
      await json(
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [{ name: "project.switch", params: { project: "PharmaWatch" } }],
            wordsUsed: "click: switch to PharmaWatch",
          }),
        }),
      ),
    );
    expect(low.status).toBe("done");
    expect(low.sentence).toBe("Switched the active project to PharmaWatch. Undo.");
    expect(low.undoToken).toBeTruthy();
    expect((await json(await req("/me"))).activeProjectId).toBe(projectId);

    const medium = CommandResultViewSchema.parse(
      await json(
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [{ name: "budget.set", params: { scope: "session", amountChf: 20 } }],
            wordsUsed: "slider: session budget 20",
          }),
        }),
      ),
    );
    expect(medium.status).toBe("pending");
    expect(medium.decision).toBe("needs_yes");
    const pending = (await jsonList(await req("/commands/pending"))).map((p) =>
      PendingChangeView.parse(p),
    );
    expect(pending.map((p) => p.id)).toContain(medium.pendingId);
    const confirmed = CommandResultViewSchema.parse(
      await json(
        await req(`/commands/${medium.pendingId}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "tap" }),
        }),
      ),
    );
    expect(confirmed.status).toBe("done");
    expect(confirmed.sentence).toContain("CHF 20");
    expect((await rt.store.project.mustGet(projectId)).settings.session_cap_usd_micro).toBe(
      25_000_000,
    );
    // The settings screen path: the card was shown and tapped; no pending card.
    const tapped = CommandResultViewSchema.parse(
      await json(
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [{ name: "budget.set", params: { scope: "session", amountChf: 25 } }],
            wordsUsed: "slider: session budget 25",
            confirm: "tap",
          }),
        }),
      ),
    );
    expect(tapped.status).toBe("done");

    const changes = (await jsonList(await req(`/changes?projectId=${projectId}`))).map((c) =>
      ChangeLogView.parse(c),
    );
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes[0]?.undoable).toBe(true);
    expect(changes[0]?.wordsUsed).toBe("slider: session budget 25");
    const undone = CommandResultViewSchema.parse(
      await json(await req(`/changes/${changes[0]?.id}/undo`, { method: "POST" })),
    );
    expect(undone.status).toBe("done");
    expect(undone.sentence).toContain("Undone");
    expect((await rt.store.project.mustGet(projectId)).settings.session_cap_usd_micro).toBe(
      25_000_000,
    );
    const undoable = (await jsonList(await req("/changes?undoable=true"))).map((c) =>
      ChangeLogView.parse(c),
    );
    expect(undoable.every((c) => c.undoState === "undoable")).toBe(true);
    expect(undoable.map((c) => c.id)).not.toContain(changes[0]?.id);
  });

  it("high risk needs the paired device: a yes on the route is refused, the device confirms", async () => {
    const high = CommandResultViewSchema.parse(
      await json(
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [{ name: "budget.set", params: { scope: "month", amountChf: 500 } }],
            wordsUsed: "raise the monthly cap",
          }),
        }),
      ),
    );
    expect(high.decision).toBe("needs_device");
    const yes = CommandResultViewSchema.parse(
      await json(
        await req(`/commands/${high.pendingId}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "yes" }),
        }),
      ),
    );
    expect(yes.status).toBe("refused");
    expect(yes.code).toBe("approval_required");
    const phone = await rt.store.device.register({
      owner_human_id: rt.human.id,
      name: "Pixel",
      platform: "android",
      public_key: ["pk", "phone", "fixture"].join("-"), // not-a-secret
      kind: "phone",
    });
    const noBiometric = CommandResultViewSchema.parse(
      await json(
        await req(`/commands/${high.pendingId}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "device", deviceId: phone.id, biometric: false }),
        }),
      ),
    );
    expect(noBiometric.status).toBe("refused");
    const ok = CommandResultViewSchema.parse(
      await json(
        await req(`/commands/${high.pendingId}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "device", deviceId: phone.id, biometric: true }),
        }),
      ),
    );
    expect(ok.status).toBe("done");
    expect((await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro).toBe(625_000_000);
    const cancelled = CommandResultViewSchema.parse(
      await json(await req("/commands/none/cancel", { method: "POST" })),
    );
    expect(cancelled.status).toBe("refused");
  });

  it("chat, voice and the UI produce the same change log entry for the same change", async () => {
    const before = (await rt.store.changeLog.list()).length;
    const ui = CommandResultViewSchema.parse(
      await json(
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [
              {
                name: "budget.set",
                params: { scope: "session", amountChf: 30, project: projectId },
              },
            ],
            wordsUsed: "slider",
            confirm: "tap",
          }),
        }),
      ),
    );
    await req(`/changes/${ui.changeLogId}/undo`, { method: "POST" });
    const chat = ChatReplyView.parse(
      await json(
        await req("/chat", {
          method: "POST",
          body: JSON.stringify({
            humanId: rt.human.id,
            agentId: rt.agent.id,
            text: "set the session budget for pharmawatch to 30 francs",
          }),
        }),
      ),
    );
    expect(chat.pendingConfirmation?.commands).toEqual(["budget.set"]);
    expect(chat.pendingConfirmation?.decision).toBe("needs_yes");
    const chatDone = ChatReplyView.parse(
      await json(
        await req("/chat", {
          method: "POST",
          body: JSON.stringify({ humanId: rt.human.id, agentId: rt.agent.id, text: "yes" }),
        }),
      ),
    );
    expect(chatDone.actions[0]?.kind).toBe("budget.set");
    await req(`/changes/${chatDone.actions[0]?.id}/undo`, { method: "POST" });
    const voice = ChatReplyView.parse(
      await json(
        await req("/chat", {
          method: "POST",
          body: JSON.stringify({
            humanId: rt.human.id,
            agentId: rt.agent.id,
            text: "set the session budget for pharmawatch to 30 francs",
            source: "voice",
          }),
        }),
      ),
    );
    const voiceDone = ChatReplyView.parse(
      await json(
        await req("/chat", {
          method: "POST",
          body: JSON.stringify({
            humanId: rt.human.id,
            agentId: rt.agent.id,
            text: "ja",
            source: "voice",
          }),
        }),
      ),
    );
    expect(voice.pendingConfirmation).not.toBeNull();
    const rows = await Promise.all(
      [ui.changeLogId, chatDone.actions[0]?.id, voiceDone.actions[0]?.id].map((id) =>
        rt.store.changeLog.mustGet(id ?? ""),
      ),
    );
    const shape = (r: (typeof rows)[number]) => ({
      commands: r.commands,
      after: r.after,
      scope: r.scope,
      project_id: r.project_id,
      sentence: r.sentence,
    });
    expect(shape(rows[1] as (typeof rows)[number])).toEqual(
      shape(rows[0] as (typeof rows)[number]),
    );
    expect(shape(rows[2] as (typeof rows)[number])).toEqual(
      shape(rows[0] as (typeof rows)[number]),
    );
    expect(rows.map((r) => r.source)).toEqual(["chat", "chat", "voice"]);
    expect((await rt.store.changeLog.list()).length).toBeGreaterThan(before);
    // The scheduler-started session reads the registry's cap (spec Q.12: same enforcement).
    const project = await rt.store.project.mustGet(projectId);
    expect(project.settings[SESSION_OVERRIDE_KEY]).toBeUndefined();
  });

  it("the settings screen's change is logged with source ui: the route takes it and the change log row shows it (RT-P5-4)", async () => {
    const asked = CommandResultViewSchema.parse(
      await json(
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [{ name: "autonomy.set", params: { level: 3, project: projectId } }],
            wordsUsed: "Settings: project.autonomy to 3",
            source: "ui",
            projectId,
          }),
        }),
      ),
    );
    expect(asked.status).toBe("pending");
    expect(asked.decision).toBe("needs_yes");
    const tapped = CommandResultViewSchema.parse(
      await json(
        await req(`/commands/${asked.pendingId}/confirm`, {
          method: "POST",
          body: JSON.stringify({ answer: "tap" }),
        }),
      ),
    );
    expect(tapped.status).toBe("done");
    const row = await rt.store.changeLog.mustGet(tapped.changeLogId ?? "");
    expect(row.source).toBe("ui");
    expect(row.words_used).toBe("Settings: project.autonomy to 3");
    const shown = (await jsonList(await req(`/changes?projectId=${projectId}`)))
      .map((c) => ChangeLogView.parse(c))
      .find((c) => c.id === row.id);
    expect(shown?.source).toBe("ui");
    // The parse route takes the source too (nothing runs).
    const parsed = await req("/commands/parse", {
      method: "POST",
      body: JSON.stringify({ text: "switch to game", source: "ui" }),
    });
    expect(parsed.status).toBe(200);
    // A source the daemon does not know is refused (validation answers 409), nothing runs.
    const changesBefore = (await rt.store.changeLog.list()).length;
    expect(
      (
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [{ name: "project.switch", params: { project: "PharmaWatch" } }],
            source: "palette",
          }),
        })
      ).status,
    ).toBe(409);
    expect((await rt.store.changeLog.list()).length).toBe(changesBefore);
    const undone = CommandResultViewSchema.parse(
      await json(await req(`/changes/${row.id}/undo`, { method: "POST" })),
    );
    expect(undone.status).toBe("done");
    expect((await rt.store.project.mustGet(projectId)).autonomy_level).toBe(2);
  });
});
