/**
 * Scenario 8, "Handover" (spec, Phase 8; spec P "Handover test"): "A fresh agent with only
 * the repo and docs fixes a seeded bug."
 *
 * Fake provider, no network beyond 127.0.0.1, simulated clock. The sample repository in the
 * fake git host carries the standard doc set, a seeded defect in `src/clamp.js` and the test
 * that fails because of it; the project's `settings.checks` names that test. A NEW principal
 * agent row for J, with an empty private memory and nothing in its brief but the state and
 * the task, runs one session on its own install (`freshInstall`, composed like the world's):
 * its scripted specialist reads README.md and the docs the README names, then the source and
 * the test, fixes the bound, and reports with "Lesson:" lines. The critic (tier 2) runs the
 * test in the worktree through the project's checks and accepts; a PR opens on the fake
 * host; the handoff goes to the peers and the lessons into the fresh agent's memory.
 * Asserted on the agent and memory rows, the brief, the audit rows (every read and write),
 * the review row with the check evidence, the PR, the messages and the session events; the
 * seeded test is run with node before (fails) and on the fixed file (passes).
 *
 * Windows and Android: the same code runs on both (paths and processes through
 * @forerunner/platform; the test runs with `node` from PATH); the final-build runs are
 * recorded in gates.md.
 */
import { readdirSync } from "node:fs";
import { SUBMIT_REVIEW_TOOL } from "@forerunner/critic";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CLAMP_BUGGY,
  CLAMP_FIXED,
  coderReadsDocsThenWrites,
  type FreshInstall,
  freshInstall,
  runSeededTest,
  SEEDED_CHECKS,
  SEEDED_REPO,
} from "../src/scenario-handover.ts";
import { criticAccepts } from "../src/scenario-scripts.ts";
import { type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";
import { lessonsSection } from "../src/world.ts";

const START = "2026-11-03T08:00:00Z"; // 09:00 Europe/Zurich
const TASK = "Fix the clamp upper bound";
const READS = [
  "README.md",
  "docs/testing.md",
  "docs/overview.md",
  "src/clamp.js",
  "test/clamp.test.js",
];
const LESSON_DOCS =
  "docs/testing.md names the one test command of this repository; read it before touching src/.";
const LESSON_BOUND =
  "clamp's upper edge is inclusive and returns hi; test/clamp.test.js pins both edges of the range.";
const REPORT = [
  "Read README.md, docs/testing.md and docs/overview.md, then src/clamp.js and test/clamp.test.js.",
  "The upper bound returned lo instead of hi; src/clamp.js now returns hi above the range.",
  "node --test test/clamp.test.js passes.",
  `Lesson: ${LESSON_DOCS}`,
  `Lesson: ${LESSON_BOUND}`,
].join("\n");

describe("scenario 8: handover", () => {
  let w: ScenarioWorld;
  let fresh: FreshInstall;
  beforeAll(async () => {
    w = await scenarioWorld({
      start: START,
      project: {
        name: "clamp",
        goal: "A one-function library with its docs",
        repo: "clamp",
        files: SEEDED_REPO,
        settings: SEEDED_CHECKS,
      },
    });
    fresh = await freshInstall(w, { agentName: "Newcomer" });
  });
  afterAll(async () => {
    await w?.close();
  });

  it("a fresh agent with only the repo and docs fixes a seeded bug", async () => {
    // --- The seeded bug and its failing test, as the repository carries them ---------------
    expect(await w.fileOnHost("src/clamp.js", "main")).toBe(CLAMP_BUGGY);
    expect(await w.fileOnHost("docs/testing.md", "main")).toContain(
      "node --test test/clamp.test.js",
    );
    const before = await runSeededTest(w.root, SEEDED_REPO, "before");
    expect(before.code).not.toBe(0);
    expect(`${before.stdout}\n${before.stderr}`).toContain("fail 1");

    // --- A fresh agent: a new row, an empty memory, no lessons anywhere -------------------
    const agentRow = await w.store.agent.mustGet(fresh.agent.id);
    expect(agentRow).toMatchObject({ kind: "principal", owner_human_id: w.j.id, name: "Newcomer" });
    expect(agentRow.created_at >= new Date(START).toISOString()).toBe(true);
    expect((await w.store.session.list({ agent_id: fresh.agent.id } as never)).length).toBe(0);
    expect(
      await fresh.memory.list({ scope: "agent_private", ownerAgentId: fresh.agent.id }),
    ).toEqual([]);
    expect(readdirSync(fresh.memoryRoot)).toEqual([]);

    // --- The task, phrased as the repo's own docs would be handed over ----------------------
    w.provider.pushReplies(
      ...coderReadsDocsThenWrites(TASK, READS, { "src/clamp.js": CLAMP_FIXED }, REPORT),
      ...criticAccepts(
        "The test named in docs/testing.md passes; the fix matches docs/overview.md.",
      ),
    );
    const task = await w.addTask({
      title: TASK,
      outcome:
        "test/clamp.test.js passes: clamp never returns a value above hi. Start from README.md; docs/testing.md says how the tests run.",
      acceptanceCriteria: [
        "node --test test/clamp.test.js exits 0",
        "src/clamp.js returns hi for values above the range",
      ],
      riskTier: 2,
    });
    const result = await fresh.runSession();

    // --- Clause: the session ran on the fresh agent, with no memory loaded ------------------
    expect(result.status).toBe("completed");
    expect(result.completed).toEqual([task.id]);
    const session = await w.store.session.mustGet(result.sessionId);
    expect(session).toMatchObject({ agent_id: fresh.agent.id, project_id: w.project.id });
    expect(result.memory).toMatchObject({ lessons: 0, tokens: 0 });
    const brief = fresh.briefs.find((b) => b.sessionId === result.sessionId);
    expect(brief?.agentId).toBe(fresh.agent.id);
    expect(lessonsSection(brief?.text ?? "")).toBe("");
    expect(brief?.text).toContain(TASK);

    // --- Clause: the specialist read the docs first, then the code, then wrote the fix -----
    const audit = await w.auditRows({ sessionId: result.sessionId });
    expect(audit.filter((r) => !r.allowed)).toHaveLength(0);
    const fileCalls = audit
      .filter((r) => r.tool === "read_file" || r.tool === "write_file")
      .map((r) => [r.tool, (JSON.parse(r.input_summary) as { path?: string }).path]);
    expect(fileCalls).toEqual([
      ...READS.map((p) => ["read_file", p]),
      ["write_file", "src/clamp.js"],
    ]);
    expect(
      audit.every((r) => r.agent_id === fresh.agent.id || r.agent_id === fresh.criticAgent.id),
    ).toBe(true);
    // The docs reached the model as data: the run's tool results carry the untrusted marker.
    const readResults = fresh.runEvents.filter(
      (e) => e.event.type === "tool_result" && e.event.name === "read_file",
    );
    expect(readResults).toHaveLength(READS.length);

    // --- Clause: the critic accepted, with the test run as evidence ------------------------
    const reviews = await w.store.review.forTask(task.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      tier: 2,
      verdict: "accept",
      critic_model: "fake-opus", // tier 2 reviews run on the opus rung (H.2 "full review")
      session_id: result.sessionId,
      author_agent: fresh.criticAgent.id,
    });
    const evidence = JSON.stringify(reviews[0]?.evidence);
    expect(evidence).toContain("ran: tests -> pass");
    expect(evidence).toContain("node --test test/clamp.test.js");
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    expect((await w.store.task.mustGet(task.id)).claimed_by).toBeNull();
    expect(audit.filter((r) => r.tool === SUBMIT_REVIEW_TOOL)).toHaveLength(1);

    // --- Clause: the bug is fixed and a PR is open -------------------------------------------
    const taskRow = await w.store.task.mustGet(task.id);
    expect(taskRow.branch).toBeTruthy();
    expect(await w.fileOnHost("src/clamp.js", taskRow.branch ?? undefined)).toBe(CLAMP_FIXED);
    expect(await w.fileOnHost("src/clamp.js", "main")).toBe(CLAMP_BUGGY);
    const after = await runSeededTest(
      w.root,
      { ...SEEDED_REPO, "src/clamp.js": CLAMP_FIXED },
      "after",
    );
    expect(after.code).toBe(0);
    const prs = await w.pullRequests({ state: "open" });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ title: TASK, state: "open" });
    expect(prs[0]?.head.ref).toBe(taskRow.branch);
    expect(prs[0]?.base.ref).toBe("main");
    expect(prs[0]?.htmlUrl).toBe(taskRow.pr_url);
    expect(
      w.gitHost.events().filter((e) => e.event === "pull_request" && e.action === "opened"),
    ).toHaveLength(1);

    // --- Clause: the handoff names what it learned -----------------------------------------
    expect(result.lessonsRecorded).toBe(2);
    const ended = fresh.events.find((e) => e.type === "session.ended");
    expect(ended?.payload).toMatchObject({ status: "completed", lessonsRecorded: 2, completed: 1 });
    expect(fresh.events.find((e) => e.type === "memory.recorded")?.payload).toMatchObject({
      recorded: 2,
      rejected: 0,
    });
    const lessons = await fresh.memory.list({
      scope: "agent_private",
      ownerAgentId: fresh.agent.id,
    });
    expect(lessons.map((l) => l.text).sort()).toEqual([LESSON_BOUND, LESSON_DOCS].sort());
    for (const l of lessons) {
      expect(l.source).toContain(result.sessionId);
      expect(l.project_id).toBe(w.project.id);
    }
    expect(readdirSync(fresh.memoryRoot).length).toBeGreaterThan(0);
    // The handoff itself: to both peers of the project, with the summary, requiring an ack.
    const handoffs = await Promise.all(
      [w.alice, w.bob].map(async (peer) =>
        (await w.inbox(peer)).find(
          (m) => m.type === "handoff" && m.from_agent_id === fresh.agent.id,
        ),
      ),
    );
    for (const h of handoffs) {
      expect(h).toMatchObject({
        requires_ack: true,
        project_id: w.project.id,
        body: result.summary,
      });
    }
    expect(session.summary).toBe(result.summary);
    expect(result.summary).toMatch(/^Session completed\. Done: 1\./);
    expect(session.handoff).toMatchObject({ done: [task.id], stop_reason: "completed" });
    expect(
      (session.handoff as { reviews?: { task_id: string; verdict: string }[] }).reviews,
    ).toEqual([
      expect.objectContaining({ task_id: task.id, verdict: "accept", decision: "accepted" }),
    ]);
    const summaryToJ = (await w.inbox(w.j)).find(
      (m) => m.type === "info" && m.from_agent_id === fresh.agent.id,
    );
    expect(summaryToJ?.body).toBe(result.summary);
    expect(await w.humanRequests(w.j, { status: "open" })).toHaveLength(0);

    // --- Secrets: the fresh install's git token reached no row, event or brief -------------
    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.message.list(),
      await w.store.task.list(),
      await w.store.session.list(),
      await w.eventsOf(result.sessionId),
      fresh.briefs.map((b) => b.text),
    ]);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  }, 90_000);
});
