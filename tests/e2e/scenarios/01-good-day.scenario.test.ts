/**
 * Scenario 1, "The good day" (spec, Phase 8): "Notes left at night, a scheduled session runs,
 * the peer's changes are picked up, work is reviewed, PRs open, a summary and questions arrive
 * by morning."
 *
 * Fake provider, no network beyond 127.0.0.1, simulated clock. The night: Bob (M's agent) runs
 * a late session and opens a PR that M merges; J leaves two notes in the next-session queue and
 * adds four tasks to the plan. The morning: Bob's scheduled session (05:45 Zurich) finishes one
 * task and is held mid-task on the next by the scenario (a hold on its model call), so he is
 * online with an active claim and files in flight when Alice's scheduled session (06:00) starts;
 * Alice acts on Bob's handoff, reads the peer feed, warns Bob about the file overlap, does her
 * tasks on top of Bob's merged change, has each reviewed by the critic (tier 1 accepted, tier
 * 3 handed to J for sign-off), opens PRs, and J's inbox holds the summary and the question
 * before 07:00. Every clause is asserted on state rows, audit rows, events and the git host.
 *
 * The notes: the runner consumes exactly the queue items a session's brief carried (spec J.2:
 * `queue.consumed` event and audit row, the rows `consumed` by that session). The checklist
 * reads the queue per project, so today the first scheduled session on the project after the
 * notes takes them (Bob's at 05:45); when the runtime scopes the queue to the agent's owner
 * (a runtime finding, testing.md "Scenarios" > "Known issues") it is Alice's at 06:00. The
 * clause is asserted on the consuming session, whichever it is, and on the queue being
 * consumed exactly once.
 *
 * Windows and Android: the same code runs on both (paths and processes through
 * @forerunner/platform); the final-build runs are recorded in gates.md.
 */
import { SUBMIT_REVIEW_TOOL, VERDICT_ADJUSTED_AUDIT_TOOL } from "@forerunner/critic";
import { QUEUE_CONSUMED_AUDIT_TOOL } from "@forerunner/runtime/session/runner";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coderWrites, criticAccepts } from "../src/scenario-scripts.ts";
import { type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";

/** ISO-8601 UTC with milliseconds, the form every timestamp is stored in. */
const at = (iso: string): string => new Date(iso).toISOString();
const NIGHT_START = at("2026-11-02T23:00:00Z"); // 00:00 Europe/Zurich, 3 November 2026
const BOB_LATE_SESSION = at("2026-11-02T23:05:00Z"); // 00:05 Zurich
const MERGE_AT = at("2026-11-02T23:10:00Z"); // 00:10 Zurich
const NOTES_AT = at("2026-11-02T23:30:00Z"); // 00:30 Zurich
const BOB_SCHEDULED = at("2026-11-03T04:45:00Z"); // 05:45 Zurich
const ALICE_SCHEDULED = at("2026-11-03T05:00:00Z"); // 06:00 Zurich
const MORNING = at("2026-11-03T06:00:00Z"); // 07:00 Zurich

const SKELETON = "export const app = { name: 'service', version: '0.1.0' };\n";
const CONFIG = "export const config = { port: 8080, name: 'service' };\n";
const LOGGER = "export const log = (m: string) => console.log(m);\n";
const HEALTH =
  "import { config } from './shared/config';\nexport const health = () => ({ ok: true, name: config.name });\n";
const EXPORT = "export const exportBilling = () => 'id,amount\\n';\n";

const hourInZurich = (iso: string): number =>
  Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", hour: "2-digit", hour12: false })
      .formatToParts(new Date(iso))
      .find((p) => p.type === "hour")?.value,
  ) % 24;

describe("scenario 1: the good day", () => {
  let w: ScenarioWorld;
  beforeAll(async () => {
    w = await scenarioWorld({ start: NIGHT_START });
  });
  afterAll(async () => {
    await w?.close();
  });

  it("notes at night, a scheduled session, the peer's changes picked up, work reviewed, PRs open, a summary and questions by morning", async () => {
    const T0 = "Repository skeleton";
    const T1 = "Shared config module";
    const T2 = "Logging helper";
    const T3 = "Health endpoint";
    const T4 = "Billing export";
    w.provider.pushReplies(
      ...coderWrites(T0, { "src/app.ts": SKELETON }),
      ...coderWrites(T1, { "src/shared/config.ts": CONFIG }),
      ...coderWrites(T2, { "src/shared/log.ts": LOGGER }),
      ...coderWrites(T3, { "src/health.ts": HEALTH }),
      ...coderWrites(T4, { "src/billing/export.ts": EXPORT }),
      ...criticAccepts(),
    );

    // --- The night -------------------------------------------------------------------------
    // Bob works late on the one ready task and opens a PR; M merges it.
    const t0 = await w.addTask({ title: T0, outcome: "src/app.ts exports the app", priority: 95 });
    await w.advanceTo(BOB_LATE_SESSION);
    const bobLate = await w.runSession(w.bob);
    expect(bobLate.status).toBe("completed");
    expect(bobLate.completed).toEqual([t0.id]);
    const bobPr = (await w.pullRequests({ state: "open" })).find((p) => p.title === T0);
    expect(bobPr).toBeDefined();
    if (!bobPr) throw new Error("no PR for the skeleton");
    await w.advanceTo(MERGE_AT);
    const merged = await w.bob.github.mergePullRequest(w.project.repo, bobPr.number, {
      method: "merge",
    });
    expect(merged.merged).toBe(true);

    // J leaves notes for the morning and adds the day's tasks to the plan.
    await w.advanceTo(NOTES_AT);
    const note = await w.leaveNote(w.j, "Keep the health endpoint tiny; no framework.", {
      kind: "note",
      priority: 2,
    });
    const idea = await w.leaveNote(w.j, "Billing export as CSV first, JSON later.", {
      kind: "idea",
    });
    const t1 = await w.addTask({
      title: T1,
      outcome: "src/shared/config.ts exports the config",
      acceptanceCriteria: ["src/shared/config.ts exists and exports config"],
      priority: 90,
    });
    const t2 = await w.addTask({
      title: T2,
      outcome: "src/shared/log.ts exports a log helper",
      acceptanceCriteria: ["src/shared/log.ts exists"],
      priority: 80,
    });
    const t3 = await w.addTask({
      title: T3,
      outcome: "src/health.ts answers with the service name from src/shared/config.ts",
      acceptanceCriteria: ["src/health.ts reads src/shared/config.ts"],
      priority: 70,
    });
    const t4 = await w.addTask({
      title: T4,
      outcome: "src/billing/export.ts writes the billing CSV (money: tier 3)",
      acceptanceCriteria: ["src/billing/export.ts exists"],
      riskTier: 3,
      priority: 60,
    });
    for (const q of [note, idea]) {
      expect(q.status).toBe("queued");
      expect(q.human_id).toBe(w.j.id);
      expect(hourInZurich(q.created_at)).toBeLessThan(6);
    }

    // --- The morning: two scheduled sessions ------------------------------------------------
    w.schedule(w.bob, { time: "05:45" });
    w.schedule(w.alice, { time: "06:00" });
    // Bob's second task is held at its first model call: he stays online, holding the claim.
    const bobHeld = w.holdModelCalls(
      (req) =>
        (req.tools ?? []).some((t) => t.name === "write_file") &&
        JSON.stringify(req.messages[0]?.content ?? "").includes(T2),
    );
    await w.advanceTo(BOB_SCHEDULED);
    await bobHeld.waiting;
    expect(w.scheduled.filter((s) => s.agentId === w.bob.agent.id)).toHaveLength(1);
    const t2Claimed = await w.store.task.mustGet(t2.id);
    expect(t2Claimed.claimed_by).toBe(w.bob.agent.id);
    expect(t2Claimed.status).toBe("in_progress");

    await w.advanceTo(ALICE_SCHEDULED);
    const alice = await w.scheduledResult(w.alice);
    bobHeld.release();
    const bob = await w.scheduledResult(w.bob);

    // --- Clause: a scheduled session runs ---------------------------------------------------
    const aliceSession = await w.store.session.mustGet(alice.sessionId);
    expect(aliceSession.trigger).toBe("schedule");
    expect(aliceSession.started_at).toBe(ALICE_SCHEDULED);
    expect(aliceSession.status).toBe("completed");
    const bobSession = await w.store.session.mustGet(bob.sessionId);
    expect(bobSession.trigger).toBe("schedule");
    expect(bobSession.started_at).toBe(BOB_SCHEDULED);
    expect(bobSession.status).toBe("completed");
    const aliceLog = w.alice.scheduler.log.filter((l) => l.result === "started");
    expect(aliceLog).toHaveLength(1);
    expect(aliceLog[0]?.req.reason).toBe("daily at 06:00 Europe/Zurich");
    expect(aliceLog[0]?.at).toBe(ALICE_SCHEDULED);
    const aliceEvents = await w.eventsOf(alice.sessionId);
    expect(aliceEvents.find((e) => e.type === "session.started")?.payload).toMatchObject({
      trigger: "schedule",
    });

    // --- Clause: notes left at night reached the morning session ----------------------------
    // Both items were consumed by one scheduled session of the morning (started after the
    // notes, before 07:00), whose brief carried them in priority order; that session wrote the
    // `queue.consumed` event and audit row (ids, never the text). See the header for which
    // session that is today and why the consumer is derived rather than named.
    const noteRows = await Promise.all([note, idea].map((q) => w.store.queue.mustGet(q.id)));
    for (const q of noteRows) expect(q.status).toBe("consumed");
    const consumerId = noteRows[0]?.consumed_by_session;
    if (!consumerId) throw new Error("the note was not consumed by a session");
    expect(noteRows[1]?.consumed_by_session).toBe(consumerId);
    expect([alice.sessionId, bob.sessionId]).toContain(consumerId);
    const consumer = await w.store.session.mustGet(consumerId);
    expect(consumer.trigger).toBe("schedule");
    expect((consumer.started_at ?? "") > NOTES_AT).toBe(true);
    expect((consumer.started_at ?? "z") < MORNING).toBe(true);
    const consumed = consumerId === alice.sessionId ? alice : bob;
    expect(consumed.brief.queue.count).toBe(2);
    expect(consumed.brief.queue.items.map((i) => i.text)).toEqual([note.text, idea.text]);
    expect(consumed.brief.queue.items.map((i) => i.kind)).toEqual(["note", "idea"]);
    const consumerBrief = w.briefs.find((b) => b.sessionId === consumerId);
    expect(consumerBrief?.text).toContain(note.text);
    expect(consumerBrief?.text).toContain(idea.text);
    const consumedEvent = (await w.eventsOf(consumerId)).find((e) => e.type === "queue.consumed");
    expect(consumedEvent?.payload).toMatchObject({
      ids: [note.id, idea.id],
      count: 2,
      skipped: [],
    });
    const consumedAudit = await w.auditRows({
      sessionId: consumerId,
      tool: QUEUE_CONSUMED_AUDIT_TOOL,
    });
    expect(consumedAudit).toHaveLength(1);
    expect(consumedAudit[0]).toMatchObject({ allowed: true, agent_id: consumer.agent_id });
    expect(JSON.parse(consumedAudit[0]?.input_summary ?? "{}")).toMatchObject({
      sessionId: consumerId,
      items: [note.id, idea.id],
    });
    expect(JSON.parse(consumedAudit[0]?.result_summary ?? "{}")).toEqual({
      consumed: [note.id, idea.id],
      skipped: [],
    });
    for (const row of consumedAudit) {
      expect(row.input_summary).not.toContain(note.text);
      expect(row.result_summary).not.toContain(idea.text);
    }
    // Consumed once: the other morning session's brief carried no queue item and nothing is
    // left queued on the project.
    const other = consumerId === alice.sessionId ? bob : alice;
    expect(other.brief.queue.count).toBe(0);
    expect(other.brief.queue.items).toEqual([]);
    expect((await w.eventsOf(other.sessionId)).some((e) => e.type === "queue.consumed")).toBe(
      false,
    );
    expect(await w.store.queue.pending(w.project.id)).toEqual([]);
    const aliceBrief = w.briefs.find((b) => b.sessionId === alice.sessionId);

    // --- Clause: the peer's changes are picked up --------------------------------------------
    // Bob's handoff from the night was delivered, read and acted on at Alice's start.
    const handoffs = (await w.inbox(w.alice)).filter(
      (m) => m.type === "handoff" && m.from_agent_id === w.bob.agent.id,
    );
    const nightHandoff = handoffs.find((m) => m.created_at < BOB_SCHEDULED);
    expect(nightHandoff).toBeDefined();
    expect(nightHandoff?.requires_ack).toBe(true);
    expect(nightHandoff?.delivered_at).toBe(ALICE_SCHEDULED);
    expect(nightHandoff?.read_at).toBe(ALICE_SCHEDULED);
    expect(nightHandoff?.acted_at).toBe(ALICE_SCHEDULED);
    expect(
      aliceEvents.some(
        (e) => e.type === "inbox.acted" && (e.payload as { id?: string }).id === nightHandoff?.id,
      ),
    ).toBe(true);
    // The peer feed showed Bob online with his claim and his files in flight.
    const feed = aliceEvents.find((e) => e.type === "peers.feed")?.payload as {
      peers: { agentId: string; online: boolean; claims: number; filesInFlight: number }[];
    };
    const bobInFeed = feed.peers.find((p) => p.agentId === w.bob.agent.id);
    expect(bobInFeed).toMatchObject({ online: true, claims: 1 });
    expect(bobInFeed?.filesInFlight ?? 0).toBeGreaterThanOrEqual(1);
    expect(aliceBrief?.text).toContain("## Peers: what the others are doing");
    expect(aliceBrief?.text).toContain("src/shared/config.ts");
    // The overlap check: Alice's health endpoint touches the file Bob has in flight; she warned
    // him before starting and went on (a file overlap never blocks).
    const overlap = aliceEvents.find((e) => e.type === "peer.overlap")?.payload as {
      kind: string;
      peerId: string;
      taskId: string;
      files: string[];
      plannedTaskId: string;
    };
    expect(overlap).toMatchObject({ kind: "files", peerId: w.bob.agent.id, plannedTaskId: t3.id });
    expect(overlap.taskId).toBe(t1.id);
    expect(overlap.files).toContain("src/shared/config.ts");
    const warning = (await w.inbox(w.bob)).find(
      (m) => m.type === "warning" && m.from_agent_id === w.alice.agent.id && m.task_id === t3.id,
    );
    expect(warning?.body).toContain("Heads-up");
    expect(warning?.body).toContain("src/shared/config.ts");
    expect(alice.skipped).toEqual([]);
    // Her work sits on top of the merged change: the skeleton Bob merged is on her branch.
    const t3Row = await w.store.task.mustGet(t3.id);
    expect(t3Row.branch).toBeTruthy();
    expect(await w.fileOnHost("src/app.ts", t3Row.branch ?? undefined)).toBe(SKELETON);
    expect(await w.fileOnHost("src/health.ts", t3Row.branch ?? undefined)).toBe(HEALTH);
    expect(await w.fileOnHost("src/app.ts", "main")).toBe(SKELETON);

    // --- Clause: work is reviewed (the critic in the loop) -----------------------------------
    for (const [task, tier, model, verdict, status] of [
      [t3, 1, "fake-sonnet", "accept", "done"],
      [t4, 3, "fake-opus", "human", "needs_human"],
    ] as const) {
      const reviews = await w.store.review.forTask(task.id);
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toMatchObject({
        tier,
        critic_model: model,
        verdict,
        session_id: alice.sessionId,
        author_agent: w.alice.criticAgent.id,
      });
      const row = await w.store.task.mustGet(task.id);
      expect(row.status).toBe(status);
      const verdictEvent = aliceEvents.find(
        (e) => e.type === "critic.verdict" && (e.payload as { taskId?: string }).taskId === task.id,
      );
      expect(verdictEvent?.payload).toMatchObject({ tier, verdict });
    }
    expect(alice.completed).toEqual([t3.id]);
    expect(alice.needsHuman).toEqual([t4.id]);
    expect((await w.store.task.mustGet(t3.id)).reason).toMatch(/^critic accepted/);
    for (const task of [t0, t1, t2]) {
      expect((await w.store.review.forTask(task.id)).map((r) => r.verdict)).toEqual(["accept"]);
      expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    }
    expect(bob.completed).toEqual([t1.id, t2.id]);
    expect(bob.skipped.sort()).toEqual([t3.id, t4.id].sort());

    // --- Clause: PRs open in the git host ---------------------------------------------------
    const prs = await w.pullRequests({ state: "all" });
    for (const task of [t1, t2, t3, t4]) {
      const row = await w.store.task.mustGet(task.id);
      const pr = prs.find((p) => p.htmlUrl === row.pr_url);
      expect(pr, `PR of ${task.title}`).toBeDefined();
      expect(pr?.state).toBe("open");
      expect(pr?.head.ref).toBe(row.branch);
      expect(pr?.base.ref).toBe("main");
    }
    expect(prs.filter((p) => p.state === "open")).toHaveLength(4);
    expect(prs.find((p) => p.number === bobPr.number)?.merged).toBe(true);
    const opened = w.gitHost
      .events()
      .filter((e) => e.event === "pull_request" && e.action === "opened");
    expect(opened).toHaveLength(5);

    // --- Clause: a summary and questions arrive by morning ----------------------------------
    const jInbox = await w.inbox(w.j);
    const summary = jInbox.find(
      (m) =>
        m.type === "info" &&
        m.from_agent_id === w.alice.agent.id &&
        m.created_at >= ALICE_SCHEDULED,
    );
    expect(summary?.body).toMatch(/^Session completed\./);
    expect(summary?.body).toContain("Done: 1. In review: 0. Needs you: 1.");
    expect((summary?.created_at ?? "") < MORNING).toBe(true);
    expect(summary?.body).toBe(aliceSession.summary);
    const questions = await w.humanRequests(w.j, { status: "open" });
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({
      task_id: t4.id,
      session_id: alice.sessionId,
      kind: "approval",
      blocking: true,
      author_agent: w.alice.criticAgent.id,
    });
    expect(questions[0]?.why).toMatch(/^Critic sign-off needed \(tier 3/);
    expect(questions[0]?.options).toEqual(["accept", "revise", "cancel"]);
    expect((questions[0]?.created_at ?? "") < MORNING).toBe(true);
    const mInbox = await w.inbox(w.m);
    expect(
      mInbox.filter((x) => x.type === "info" && x.from_agent_id === w.bob.agent.id),
    ).toHaveLength(2);
    expect(await w.humanRequests(w.m, { status: "open" })).toHaveLength(0);
    // Alice handed off to Bob at her end; Bob's morning handoff waits for Alice's next session.
    expect(
      (await w.inbox(w.bob)).filter((x) => x.type === "handoff" && x.created_at >= ALICE_SCHEDULED),
    ).toHaveLength(1);
    expect(handoffs.filter((x) => x.created_at >= ALICE_SCHEDULED && !x.acted_at)).toHaveLength(1);

    // --- Both sessions ended cleanly: claims released, every tool call audited, none denied ---
    for (const task of [t0, t1, t2, t3, t4])
      expect((await w.store.task.mustGet(task.id)).claimed_by).toBeNull();
    const FILE_TOOLS: string[] = ["write_file", "read_file"];
    for (const [sessionId, writes] of [
      [bobLate.sessionId, 1],
      [bob.sessionId, 2],
      [alice.sessionId, 2],
    ] as const) {
      const rows = await w.auditRows({ sessionId });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.filter((r) => !r.allowed)).toHaveLength(0);
      // Every tool call a specialist made went through the hooks: one allowed row per
      // `tool_call` run event of the session's coder runs, each row on its run. Here that is
      // one coder run and one file write per task the session worked on.
      const coderRuns = (await w.store.run.forSession(sessionId)).filter(
        (r) => r.specialist === "coder",
      );
      expect(coderRuns).toHaveLength(writes);
      const calls = w.runEvents.filter(
        (r) => r.event.type === "tool_call" && coderRuns.some((run) => run.task_id === r.taskId),
      );
      const fileRows = rows.filter((r) => FILE_TOOLS.includes(r.tool));
      expect(fileRows).toHaveLength(calls.length);
      expect(fileRows.filter((r) => r.tool === "write_file")).toHaveLength(writes);
      expect(new Set(fileRows.map((r) => r.run_id))).toEqual(new Set(coderRuns.map((r) => r.id)));
      // The critic's review tool once per task review, behind the same hooks.
      expect(rows.filter((r) => r.tool === SUBMIT_REVIEW_TOOL)).toHaveLength(
        (await w.store.review.forSession(sessionId)).filter((r) => r.task_id).length,
      );
      const ended = (await w.eventsOf(sessionId)).find((e) => e.type === "session.ended");
      expect(ended?.payload).toMatchObject({ status: "completed", stopReason: "completed" });
    }
    // The rules turned the tier 3 accept into a human sign-off: that is an outward action of
    // the critic's code with an audit row of its own (ADR 0042), in Alice's session only.
    const adjusted = await w.auditRows({ tool: VERDICT_ADJUSTED_AUDIT_TOOL });
    expect(adjusted).toHaveLength(1);
    expect(adjusted[0]).toMatchObject({
      session_id: alice.sessionId,
      agent_id: w.alice.criticAgent.id,
      allowed: true,
    });
    expect(JSON.parse(adjusted[0]?.input_summary ?? "{}")).toMatchObject({
      taskId: t4.id,
      tier: 3,
    });
    expect(adjusted[0]?.result_summary).toContain("verdict human");

    // --- Secrets: neither install's git token reached a row, an event or a message ----------
    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.message.list(),
      await w.store.humanRequest.list(),
      await w.store.task.list(),
      await w.store.session.list(),
      await w.store.run.list(),
      aliceEvents,
      await w.eventsOf(bob.sessionId),
      w.briefs.map((b) => b.text),
    ]);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  }, 90_000);
});
