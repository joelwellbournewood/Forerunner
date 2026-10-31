import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/daemon/views.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/** Session log lines for the events added with U-013 and U-017. */
describe("session log lines", () => {
  it("says when a session put claimed tasks back to ready (U-013)", () => {
    expect(describeEvent("task.claims_released", { count: 2 })).toBe(
      "Put 2 task(s) back to ready: their claim had lapsed or no agent held it.",
    );
  });

  it("shows the critic's measurements once, apart from the review line (U-017)", () => {
    expect(
      describeEvent("critic.session_review_metrics", {
        metrics: {
          plannedTasks: 1,
          plannedDoneTasks: 0,
          actualUsdMicro: 0,
          estimateUsdMicro: 204_400,
        },
      }),
    ).toBe(
      "Session review measured: 0 of 1 planned task(s) done, CHF 0.00 spent of a CHF 0.16 estimate.",
    );
  });
});

/**
 * Every event type a session writes has a plain sentence (U-074): the live view printed the
 * type and its raw JSON for those `describeEvent` did not know, spoke of tiers, verdicts and
 * "improve_brief", and gave money in USD.
 */
describe("session log lines in plain words (U-074)", () => {
  const JARGON = /[{}]|\bUSD\b|\btier\b|verdict|improve_brief|split_or_change|ladder|ceiling/i;

  const SAMPLES: Array<[string, Record<string, unknown>]> = [
    [
      "session.started",
      { trigger: "manual", budgetCapUsdMicro: 5_000_000, stepCap: 200, autonomy: 2 },
    ],
    ["session.brief", { unread: 1, ready: 2, warnings: [] }],
    ["session.planned", { items: 2, estimateUsdMicro: 1_000_000, summary: "two tasks" }],
    ["session.plan_filed", { requestId: "req_1", items: 2, changed: false }],
    ["session.plan_approved", { planId: "p", approvedSessionId: "sess_1", items: 2 }],
    [
      "task.started",
      { taskId: "t1", title: "Add clamp", specialist: "coder", estimateUsdMicro: 400_000 },
    ],
    [
      "task.finished",
      { taskId: "t1", outcome: "in_review", costUsdMicro: 250_000, summary: "done" },
    ],
    ["task.files", { taskId: "t1", files: ["src/x.ts"] }],
    ["task.heard", { taskId: "t1", ids: ["m1"] }],
    ["task.skipped", { taskId: "t1", reason: "peer_in_flight" }],
    ["task.claims_released", { count: 1 }],
    ["task.blocked_by_findings", { warning: "one finding is open" }],
    ["critic.review_started", { tier: 1, attempt: 0 }],
    [
      "critic.verdict",
      {
        verdict: "revise",
        grade: 40,
        findings: 1,
        openFindings: 1,
        decision: "revise",
        retry: "improve_brief",
        summary: "No test.",
      },
    ],
    [
      "critic.review",
      { subject: "task", tier: 2, verdict: "accept", grade: 91, findings: 0, costUsdMicro: 20_000 },
    ],
    ["critic.review_failed", { warning: "the model did not answer" }],
    ["critic.session_review", { verdict: "accept", grade: 100, findings: 0, summary: "" }],
    ["critic.session_review_failed", { warning: "store busy" }],
    [
      "critic.session_review_metrics",
      {
        metrics: {
          plannedTasks: 1,
          plannedDoneTasks: 1,
          actualUsdMicro: 10_000,
          estimateUsdMicro: 20_000,
        },
      },
    ],
    ["peers.feed", { peers: [{ agentId: "a2", name: "Bob", online: true }] }],
    [
      "peer.overlap",
      {
        kind: "files",
        peerId: "a2",
        peerName: "Bob",
        taskId: "t9",
        files: ["src/x.ts"],
        plannedTaskId: "t1",
      },
    ],
    ["queue.consumed", { ids: ["q1", "q2"], count: 2, skipped: [] }],
    [
      "docs.status_written",
      {
        location: "repo",
        path: "docs/status.md",
        prUrl: "https://example.test/pr/1",
        created: false,
      },
    ],
    ["docs.status_skipped", { reason: "no task changed state" }],
    ["docs.status_failed", { warning: "the branch moved" }],
    ["memory.loaded", { tokens: 120, budget: 2000, lessons: 3 }],
    ["memory.over_budget", { warning: "memory block too large; dropped" }],
    ["memory.load_failed", { warning: "index locked" }],
    ["memory.recorded", { recorded: 1, merged: 0, rejected: 0 }],
    ["memory.record_failed", { warning: "disk full" }],
    ["memory.lessons_rejected", { count: 1, warning: "1 proposed lesson read like instructions" }],
    ["memory.promotion", { verdict: "accept", grade: 80, status: "promoted", offers: 2 }],
    ["memory.promotion_failed", { warning: "review timed out" }],
    [
      "notification",
      {
        id: "n1",
        kind: "session_ended",
        title: "Alice's session completed: 1 done",
        deliveries: [{ channel: "desktop", status: "sent" }],
      },
    ],
    ["inbox.message", { id: "m1", type: "request", from: "agent_bob", fromName: "Bob" }],
    ["inbox.acted", { id: "m1", type: "info" }],
    ["inbox.unacknowledged", { count: 2 }],
    ["inbox.heard", { id: "m2", source: "voice" }],
    ["inbox.recheck_failed", { warning: "store busy" }],
    ["inbox.carry_failed", { warning: "store busy" }],
    ["inbox.carried_forward", { ids: ["m3"] }],
    ["session.end_inbox", { read: ["m4"], interrupt: null, stopped: false }],
    ["session.error", { code: "internal", message: "boom" }],
    [
      "session.ended",
      { status: "completed", stopReason: "completed", spentUsdMicro: 300_000, completed: 1 },
    ],
    ["pr.merged", { taskId: "t1", prUrl: "https://example.test/pr/1", status: "merged" }],
    [
      "pr.left_open",
      { taskId: "t1", prUrl: "https://example.test/pr/1", reason: "autonomy 2 does not merge" },
    ],
    ["pr.merge_failed", { taskId: "t1", warning: "merge step failed, PR left open: conflict" }],
    ["context.headroom_unavailable", { warning: "Headroom is not running" }],
    ["chat.human", { text: "hi" }],
    ["chat.reply", { text: "hello" }],
    ["chat.forwarded", { sessionId: "s", messageId: "m" }],
    ["change", { sentence: "Created the task." }],
    ["voice.turn", { said: "add a task" }],
    ["voice.heard", { heardFirstAudioMs: 420 }],
    ["voice.speak", { subject: "the summary", state: "done" }],
    ["email_sent", { subject: "Status" }],
    ["email_blocked", { reason: "over the cap" }],
    ["email_command", { subject: "add a task", outcome: "done" }],
    ["mirror.sync", { github_project_url: "https://github.com/orgs/o/projects/1", error: null }],
    ["budget.warning", { warning: "Session spend at 80% of the cap" }],
  ];

  it.each(SAMPLES)("%s reads as a sentence: no JSON, no USD, no jargon", (type, payload) => {
    const line = describeEvent(type, payload, 0.8);
    expect(line.trim().length).toBeGreaterThan(5);
    expect(line).not.toMatch(JARGON);
  });

  it("says what the types the log printed as JSON mean, with money in CHF and names, not ids", () => {
    const line = (type: string, p: Record<string, unknown>) => describeEvent(type, p, 0.8);
    expect(
      line("peers.feed", {
        peers: [
          { name: "Bob", online: true },
          { name: "Eve", online: false },
        ],
      }),
    ).toBe("Other agents on this project: Bob, Eve (1 online).");
    expect(line("queue.consumed", { ids: ["q1", "q2"], count: 2, skipped: [] })).toBe(
      "Took 2 items from the next-session queue into this session.",
    );
    expect(
      line("docs.status_written", {
        path: "docs/status.md",
        prUrl: "https://example.test/pr/1",
        created: true,
      }),
    ).toBe("Created the project status in docs/status.md on https://example.test/pr/1.");
    expect(
      line("notification", {
        title: "Alice's session completed: 1 done",
        deliveries: [{ channel: "desktop", status: "sent" }],
      }),
    ).toBe('Notified you: "Alice\'s session completed: 1 done": desktop sent.');
    expect(line("inbox.message", { type: "request", from: "agent_bob", fromName: "Bob" })).toBe(
      "Read a request message from Bob.",
    );
    expect(line("inbox.message", { type: "request", from: "agent_bob" })).toBe(
      "Read a request message from another agent.",
    );
    expect(
      line("session.started", {
        trigger: "manual",
        budgetCapUsdMicro: 5_000_000,
        stepCap: 200,
        autonomy: 2,
      }),
    ).toBe("Session started (manual), budget CHF 4.00, 200 steps, autonomy Standard (level 2).");
    expect(
      line("critic.verdict", {
        verdict: "revise",
        grade: 40,
        findings: 1,
        openFindings: 1,
        decision: "revise",
        retry: "improve_brief",
        summary: "No test.",
      }),
    ).toBe(
      "Critic: sent back for changes (grade 40, 1 finding(s), 1 open): the task goes back for another attempt, again with a clearer brief. No test.",
    );
    expect(line("critic.review_started", { tier: 1, attempt: 0 })).toBe(
      "The critic started a light review (attempt 1).",
    );
    // A type no sentence knows: its words and its warning, never JSON.
    expect(line("tool.something_new", { warning: "it went wrong", detail: { a: 1 } })).toBe(
      "Tool something new: it went wrong",
    );
  });

  it("a real session's log has no JSON, no USD and no jargon, and its summary says CHF", async () => {
    const w = await loopWorld({
      replies: [
        submitReply({
          grade: 40,
          verdict: "revise",
          summary: "The clamp has no test.",
          findings: [
            { severity: "major", what: "No test covers clamp", required_action: "Add a test" },
          ],
        }),
        closingReply(),
      ],
    });
    try {
      await w.addTask("Add clamp");
      const result = await w.start(w.runner(doneExecutor(w)));
      const rows = await w.store.event.list(result.sessionId);
      expect(rows.length).toBeGreaterThan(5);
      for (const e of rows) {
        const line = describeEvent(e.type, (e.payload ?? {}) as Record<string, unknown>, 0.8);
        expect(line, e.type).not.toMatch(JARGON);
      }
      expect(result.summary).toMatch(/Spent CHF \d+\.\d{2}\./);
      expect(result.summary).not.toMatch(/\$|USD/);
    } finally {
      await w.close();
    }
  });
});
