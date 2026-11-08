import { describe, expect, it } from "vitest";
import { describeEvent } from "../src/daemon/views.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/** Session log lines for the events added with U-013 and U-017. */
describe("session log lines", () => {
  it("a task's changed files name the pull request they went to (GitHub walk, 2026-11-02)", () => {
    // Before: "Changed 1 file: index.html." with no word of the PR or its branch.
    expect(
      describeEvent("task.files", {
        taskId: "t1",
        files: ["index.html"],
        prUrl: "https://github.com/o/sample/pull/2",
        branch: "fr/01a1-create-index",
      }),
    ).toBe("Changed index.html, in pull request #2.");
    expect(describeEvent("task.files", { taskId: "t1", files: ["index.html"] })).toBe(
      "Changed index.html.",
    );
  });

  it("a reviewed pull request left open is named by its number and says why in the setting's name", () => {
    // Bench, 2026-11-02: "Left the pull request http://127.0.0.1:48063/bench/seeded/pull/3 open
    // for you: PR left open for you: autonomy level 2 does not merge (level 3 Trusted does)."
    expect(
      describeEvent("pr.left_open", {
        taskId: "t1",
        prUrl: "https://github.com/o/sample/pull/3",
        reason: "PR left open for you: autonomy level 2 does not merge (level 3 Trusted does)",
      }),
      // merge-in-app: no level merges any more (the owner's decision of 2026-11-02), so an older
      // event says what to do instead (before: "Forerunner merges only at Trusted").
    ).toBe("Pull request #3 waits for you to merge it: press Merge on the Overview.");
    // The merge step's status decides the words (merge-in-app): never the step's own message,
    // and a merge that waits for its checks does not say it waits for the person.
    const left = (status: string, reason: string) =>
      describeEvent("pr.left_open", {
        taskId: "t1",
        prUrl: "https://github.com/o/sample/pull/6",
        status,
        reason: `PR left open for you: ${reason}`,
      });
    expect(left("not_allowed", 'the project\'s merge mode is "You press Merge"')).toBe(
      "Pull request #6 waits for you to merge it: press Merge on the Overview.",
    );
    expect(left("checks_pending", "a check is still running after 0 s: ci/test")).toBe(
      "Pull request #6 merges when its checks pass.",
    );
    expect(left("unreachable", "GitHub did not answer")).toBe(
      "GitHub did not answer about pull request #6: Forerunner tries the merge again.",
    );
    expect(left("head_moved", "the PR head 1a2b3c4d5e6f is not the reviewed commit 0f9e8d7c")).toBe(
      "Pull request #6 changed after the review, so it waits for you (Inbox).",
    );
    expect(
      left(
        "not_allowed",
        "main changed since the review, and the repository has no automatic checks to test the two together",
      ),
    ).toBe(
      "Pull request #6 waits for you: main changed since the review, and nothing tests the two together. Press Merge on the Overview if it should go in.",
    );
    expect(
      describeEvent("pr.left_open", {
        taskId: "t1",
        prUrl: "https://github.com/o/sample/pull/4",
        reason:
          "PR left open for you: the reviewed commit is not known (no task worktree), so https://github.com/o/sample/pull/4 is not merged automatically",
      }),
    ).toBe(
      "Pull request #4 waits for you to merge it: the reviewed commit is not known (no task worktree), so it is not merged automatically.",
    );
    expect(
      describeEvent("pr.merged", { taskId: "t1", prUrl: "https://github.com/o/sample/pull/5" }),
    ).toBe("Merged pull request #5.");
  });

  it("says when a session put claimed tasks back to ready (U-013)", () => {
    expect(describeEvent("task.claims_released", { count: 2 })).toBe(
      "Put 2 tasks back to ready: their claim had lapsed or no agent held it.",
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
      "Session review measured: 0 of 1 planned task done, CHF 0.00 spent of a CHF 0.16 estimate.",
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
      // Which channels sent it is not the session's news (design §5, "Notification").
    ).toBe('Notified you: "Alice\'s session completed: 1 done".');
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
      // A person-level line (design §3.7): the steps and the autonomy level are Details.
    ).toBe("You started the session with a budget of CHF 4.00.");
    expect(
      line("critic.verdict", {
        title: "Add clamp",
        verdict: "revise",
        grade: 40,
        findings: 1,
        openFindings: 1,
        decision: "revise",
        retry: "improve_brief",
        summary: "No test.",
      }),
    ).toBe('The critic sent "Add clamp" back: No test. Trying again.');
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
        // The rework runs in the same session (design §4.3) and is accepted.
        submitReply({ grade: 90, verdict: "accept", summary: "The clamp is tested now." }),
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
      expect(result.summary).toMatch(/CHF \d+\.\d{2}\./);
      expect(result.summary).not.toMatch(/\$|USD/);
    } finally {
      await w.close();
    }
  });
});
