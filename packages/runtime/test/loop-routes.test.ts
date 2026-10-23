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
  LessonOfferView,
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
      "proposeLesson",
      "memoryPromotions",
      "memoryOffers",
      "answerOffer",
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

  it("cross-project sharing: propose from the view, pending proposals, offers answered and applied", async () => {
    // The human proposes their agent's private lesson for every project (spec G.6).
    const view = MemoryView.parse(
      await json(await req(`/memory?scope=agent_private&agentId=${rt.agent.id}`)),
    );
    const mine = view.lessons[0];
    if (!mine) throw new Error("expected a private lesson");
    const proposed = LessonView.parse(
      await json(await req(`/memory/lessons/${mine.id}/propose`, { method: "POST" })),
    );
    expect(proposed).toMatchObject({ scope: "shared", status: "proposed", projectId: null });
    expect(proposed.tags).toContain("general");
    expect(proposed.text).toBe(mine.text);
    const pending = (await jsonList(await req("/memory/promotions"))).map((l) =>
      LessonView.parse(l),
    );
    expect(pending.map((p) => p.id)).toEqual([proposed.id]);
    // Another human's private row reads as 404 here as well.
    const [carol] = await rt.store.agent.list({ name: "Carol" } as never);
    const [hers] = await rt.store.lesson.search({
      scope: "agent_private",
      ownerAgentId: carol?.id ?? "",
    });
    expect((await req(`/memory/lessons/${hers?.id}/propose`, { method: "POST" })).status).toBe(404);
    expect((await req("/memory/lessons/les_missing/propose", { method: "POST" })).status).toBe(404);
    // The critic decides at a session end (loop-memory-promotion.test.ts); its accepting
    // review row stands in for it here. The Game project shares the lesson's tag.
    const [game] = await rt.store.project.list({ name: "Game" } as never);
    if (!game) throw new Error("expected the Game project");
    await rt.store.project.patch(game.id, { settings: { tags: ["windows"] } });
    const review = await rt.store.review.insert({
      critic_model: "fake",
      verdict: "accept",
      tier: 1,
      author_agent: rt.criticAgent.id,
    });
    const resolved = await rt.memory.resolvePromotion(proposed.id, {
      reviewId: review.id,
      verdict: "accept",
      grade: 90,
      confidence: 0.9,
      summary: "general",
      completed: true,
      costUsdMicro: 0,
    });
    expect(resolved.status).toBe("promoted");
    expect(resolved.offers.map((o) => o.projectId)).toEqual([game.id]);
    expect(await jsonList(await req("/memory/promotions"))).toEqual([]);
    const offers = (await jsonList(await req("/memory/offers"))).map((o) =>
      LessonOfferView.parse(o),
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      lessonId: proposed.id,
      projectId: game.id,
      projectName: "Game",
      sharedTags: ["windows"],
      status: "open",
      appliedAt: null,
      copyId: null,
    });
    const requestId = offers[0]?.requestId ?? "";
    // The offer is a non-blocking approval in the inbox too.
    const inbox = await json(await req("/inbox"));
    expect((inbox.requests as Json[]).some((r) => r.id === requestId)).toBe(true);
    expect(
      (
        await req(`/memory/offers/${requestId}/answer`, {
          method: "POST",
          body: JSON.stringify({ answer: "maybe" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await req("/memory/offers/req_missing/answer", {
          method: "POST",
          body: JSON.stringify({ answer: "accept" }),
        })
      ).status,
    ).toBe(404);
    const answered = LessonOfferView.parse(
      await json(
        await req(`/memory/offers/${requestId}/answer`, {
          method: "POST",
          body: JSON.stringify({ answer: "accept" }),
        }),
      ),
    );
    expect(answered.status).toBe("answered");
    expect(answered.appliedAt).not.toBeNull();
    const copy = MemoryView.parse(
      await json(await req(`/memory?scope=shared&projectId=${game.id}`)),
    ).lessons.find((l) => l.id === answered.copyId);
    expect(copy).toMatchObject({ projectId: game.id, pinned: true, text: mine.text });
    // Answered once: a second answer is refused and nothing is copied twice.
    expect(
      (
        await req(`/memory/offers/${requestId}/answer`, {
          method: "POST",
          body: JSON.stringify({ answer: "dismiss" }),
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await rt.store.auditLog.list({ humanId: rt.human.id })).filter(
        (a) => a.tool === "memory.offer_accepted",
      ),
    ).toHaveLength(1);
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

  it("a one-shot without services or the remote option (the cloud runner's shape) registers no desktop row and /me names none", async () => {
    expect(rt.remote.device).toBeNull();
    expect(
      await rt.store.device.list({ owner_human_id: rt.human.id, kind: "desktop" }),
    ).toHaveLength(0);
    const me = await json(await req("/me"));
    expect(me.desktopDeviceId).toBeNull();
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

describe("a solo daemon's own desktop device", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
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
    const home = mkdtempSync(join(tmpdir(), "fr-loop-solo-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    // The daemon's own shape: services on (the default), a local store, no remote option.
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
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("a solo install's desktop is the paired device: /me names the daemon's own desktop row, its id confirms a high-risk change, a foreign id is refused, and an answer without an id is this PC", async () => {
    // A daemon (services on) on a `sqlite:` store: the remote services stay off (no phone can
    // reach this daemon), yet the daemon's own `desktop` device row exists: it is the paired
    // device the settings screen confirms a high-risk change on (ADR 0030, the P1 of
    // BLOCKERS.md).
    expect(rt.remote.enabled).toBe(false);
    expect(rt.remote.watcher).toBeNull();
    expect(rt.remote.presence).toBeNull();
    const desktop = rt.remote.device;
    expect(desktop).toMatchObject({ kind: "desktop", owner_human_id: rt.human.id, revoked: false });
    const me = await json(await req("/me"));
    expect(me.desktopDeviceId).toBe(desktop?.id);

    const ask = async (amountChf: number) => {
      const r = CommandResultViewSchema.parse(
        await json(
          await req("/commands/execute", {
            method: "POST",
            body: JSON.stringify({
              commands: [{ name: "budget.set", params: { scope: "month", amountChf } }],
              wordsUsed: `Settings: human.monthly_cap to ${amountChf}`,
              source: "ui",
            }),
          }),
        ),
      );
      expect(r.decision).toBe("needs_device");
      return r.pendingId ?? "";
    };
    const confirm = async (pendingId: string, body: Record<string, unknown>) =>
      CommandResultViewSchema.parse(
        await json(
          await req(`/commands/${pendingId}/confirm`, {
            method: "POST",
            body: JSON.stringify(body),
          }),
        ),
      );

    // The shell's install id (what the UI used to send) is not a device row: refused, and the
    // card stays open for a proper answer.
    const first = await ask(600);
    const foreign = await confirm(first, { answer: "device", deviceId: "install-uuid-of-shell" });
    expect(foreign.status).toBe("refused");
    expect(foreign.code).toBe("approval_required");
    expect(foreign.reason).toContain("unknown device");
    expect((await jsonList(await req("/commands/pending"))).map((p) => p.id)).toContain(first);
    // A real foreign id: another human's desktop row on the same store (the shared-store case,
    // where the shell's id never matched either) is refused by the route, the card kept and
    // the cap unchanged.
    const other = await rt.store.human.insert({ name: "Bob", email: "bob@example.test" });
    const othersPc = await rt.store.device.register({
      owner_human_id: other.id,
      name: "Bob's PC",
      platform: "linux",
      public_key: ["pk-", "B".repeat(40)].join(""), // not-a-secret
      kind: "desktop",
    });
    const capBefore = (await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro;
    const theirs = await confirm(first, { answer: "device", deviceId: othersPc.id });
    expect(theirs.status).toBe("refused");
    expect(theirs.code).toBe("approval_required");
    expect(theirs.reason).toBe("the device belongs to someone else");
    expect((await jsonList(await req("/commands/pending"))).map((p) => p.id)).toContain(first);
    expect((await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro).toBe(capBefore);
    expect(capBefore).not.toBe(750_000_000);
    // The id `/me` names performs the change.
    const ok = await confirm(first, { answer: "device", deviceId: me.desktopDeviceId });
    expect(ok.status).toBe("done");
    expect((await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro).toBe(750_000_000);
    // The pending id is the card's `human_request` row: its answer names the device.
    const row = await rt.store.humanRequest.mustGet(first);
    expect(row.status).toBe("answered");
    expect(row.answer).toMatchObject({
      verdict: "confirmed",
      kind: "device",
      device_id: desktop?.id,
      biometric: false,
    });

    // A device answer without an id on the daemon-token route is this PC (an older shell):
    // the daemon substitutes its own row and writes an audit row saying so.
    const second = await ask(700);
    const mapped = await confirm(second, { answer: "device" });
    expect(mapped.status).toBe("done");
    expect((await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro).toBe(875_000_000);
    const audit = (await rt.store.auditLog.list()).filter(
      (r) => r.tool === "daemon.confirm_device",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ allowed: true, human_id: rt.human.id });
    expect(JSON.parse(audit[0]?.input_summary ?? "{}")).toMatchObject({
      pendingId: second,
      deviceId: desktop?.id,
      given: null,
    });

    // The literal `desktop` an older settings screen sent without an install id is the same
    // id-less answer: this PC's row, audited.
    const third = await ask(800);
    const literal = await confirm(third, { answer: "device", deviceId: "desktop" });
    expect(literal.status).toBe("done");
    expect((await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro).toBe(1_000_000_000);
    const audit2 = (await rt.store.auditLog.list()).filter(
      (r) => r.tool === "daemon.confirm_device",
    );
    expect(audit2).toHaveLength(2);
    expect(audit2.map((r) => JSON.parse(r.input_summary ?? "{}"))).toContainEqual({
      pendingId: third,
      deviceId: desktop?.id,
      given: "desktop",
    });

    // The audit row tells what the registry answered: an id-less answer for a card that does
    // not exist is mapped to this PC and logged as not allowed, with the registry's reason.
    const ghost = await confirm("no-such-pending", { answer: "device" });
    expect(ghost.status).toBe("refused");
    const audit3 = (await rt.store.auditLog.list()).filter(
      (r) => r.tool === "daemon.confirm_device",
    );
    expect(audit3).toHaveLength(3);
    const ghostRow = audit3.find(
      (r) => JSON.parse(r.input_summary ?? "{}").pendingId === "no-such-pending",
    );
    expect(ghostRow).toMatchObject({ allowed: false });
    expect(ghostRow?.denied_reason).toContain("no pending");
    expect(audit3.filter((r) => r.allowed)).toHaveLength(2);
    expect(audit3.find((r) => r.allowed)?.result_summary).toContain("done");

    // A phone row of the same human still needs biometric to confirm.
    const phone = await rt.store.device.register({
      owner_human_id: rt.human.id,
      name: "J's phone",
      platform: "android",
      public_key: ["pk-", "Q".repeat(40)].join(""), // not-a-secret
      kind: "phone",
    });
    const fourth = await ask(900);
    const noBio = await confirm(fourth, { answer: "device", deviceId: phone.id });
    expect(noBio.status).toBe("refused");
    expect((await rt.store.human.mustGet(rt.human.id)).monthly_cap_usd_micro).toBe(1_000_000_000);
  });
});
