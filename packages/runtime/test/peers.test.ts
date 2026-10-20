import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { TokenIssuer } from "../src/enforcement/token.ts";
import {
  buildPeerFeed,
  detectOverlap,
  extractPathHints,
  overlapBlocks,
  type PeerFeed,
  pathsOverlap,
  renderPeerFeed,
  TASK_FILES_EVENT,
} from "../src/session/peers.ts";
import {
  SessionRunner,
  StaticPlanner,
  type TaskExecutionResult,
  type TaskExecutor,
} from "../src/session/runner.ts";

interface World {
  store: StateStore;
  clock: SimulatedClock;
  human: string;
  alice: string;
  bob: string;
  project: string;
}

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-03-02T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "Europe/Zurich",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
      locale: "en",
    })
  ).id;
  const mk = async (name: string) =>
    (
      await store.agent.insert({
        name,
        owner_human_id: human,
        model_config: {},
        memory_location: "local",
        status: "active",
        kind: "principal",
      })
    ).id;
  const alice = await mk("Alice");
  const bob = await mk("Bob");
  const project = (
    await store.project.insert({
      name: "Sample",
      goal: "Ship a sample service",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [alice, bob] },
      small_project_mode: false,
      active: true,
    })
  ).id;
  return { store, clock, human, alice, bob, project };
}

async function addTask(w: World, title: string, over: Record<string, unknown> = {}) {
  return w.store.task.insert({
    project_id: w.project,
    title,
    outcome: `${title} done`,
    acceptance_criteria: ["works"],
    risk_tier: 0,
    status: "ready",
    priority: 5,
    depends_on: [],
    budget_usd_micro: 1_000_000,
    est_cost_usd_micro: 400_000,
    actual_cost_usd_micro: 0,
    attempt: 0,
    reason: "seed",
    author_agent: w.bob,
    ...over,
  });
}

function executor(
  w: World,
  files: Record<string, string[]> = {},
  outcome: TaskExecutionResult["outcome"] = "in_review",
): TaskExecutor & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    async execute({ task, budget }) {
      executed.push(task.id);
      budget.record(`run-${task.id}`, 100_000);
      return {
        outcome,
        summary: `${task.title}: ${outcome}`,
        costUsdMicro: 100_000,
        prUrl: `http://git.test/pr/${task.id.slice(0, 6)}`,
        changedFiles: files[task.title] ?? [],
      };
    },
  };
}

/** A session row for Bob: running, or completed with a handoff. */
async function bobSession(
  w: World,
  state: { ended: true; handoff: Record<string, unknown>; summary?: string } | { ended: false },
) {
  const row = await w.store.session.insert({
    agent_id: w.bob,
    project_id: w.project,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 1_000_000,
    step_cap: 10,
    spent_usd_micro: 0,
    steps: 0,
    started_at: w.clock.nowIso(),
    status: "planned",
    summary: "",
    handoff: {},
    runner: "pc",
    device_id: null,
    author_agent: w.bob,
  });
  const running = await w.store.session.start(row.id, row.version);
  if (!state.ended) return running;
  return w.store.session.setStatus(running.id, running.version, "completed", {
    summary: state.summary ?? "done",
    handoff: state.handoff as never,
  });
}

function runner(w: World, exec: TaskExecutor) {
  return new SessionRunner({
    store: w.store,
    clock: w.clock,
    tokens: new TokenIssuer({ now: () => w.clock.now() }),
    kill: new KillSwitch(),
    planner: new StaticPlanner(),
    executor: exec,
  });
}

const grant = { allowedTools: ["echo"], allowedPaths: [], allowedDomains: [], grantedSecrets: [] };

describe("peers: hints and overlap rules", () => {
  it("extracts explicit file and directory mentions from task text", () => {
    const hints = extractPathHints(
      "Fix the parser in packages/runtime/src/session/peers.ts and tidy docs/maintainers/. Ignore https://example.test/a/b. Also touch README.md.",
    );
    expect(hints).toContain("packages/runtime/src/session/peers.ts");
    expect(hints).toContain("docs/maintainers/");
    expect(hints).toContain("README.md");
    expect(hints.some((h) => h.includes("example.test"))).toBe(false);
  });

  it("matches files exactly or by directory containment on both separators", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/", "src\\a.ts")).toBe(true);
    expect(pathsOverlap("src/a.ts", "src/ab.ts")).toBe(false);
    expect(pathsOverlap("src", "srcx/a.ts")).toBe(false);
  });

  it("ranks task overlaps before file overlaps and says which block", () => {
    const feed: PeerFeed = {
      generatedAt: "2026-03-02T07:00:00Z",
      projectId: "p",
      peers: [
        {
          agentId: "bob",
          agentName: "Bob",
          online: true,
          activeClaims: [],
          openPullRequests: [{ taskId: "t1", title: "T1", url: "http://pr/1" }],
          lastHandoff: { at: "x", summary: "", inFlight: ["t1"], blocked: [], next: [] },
          inFlightFiles: { t9: ["src/shared.ts", "src/other.ts"] },
        },
      ],
    };
    const o = detectOverlap({ taskId: "t1", title: "T1", files: ["src/shared.ts"] }, feed);
    expect(o.map((x) => x.kind)).toEqual(["task_pr_open", "files"]);
    expect(overlapBlocks(o[0] as never)).toBe(true);
    expect(overlapBlocks(o[1] as never)).toBe(false);
    const none = detectOverlap({ taskId: "t2", title: "T2", files: ["src/else.ts"] }, feed);
    expect(none).toEqual([]);
  });
});

describe("peers: feed from the store and the runner", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });
  afterEach(() => w.store.close());

  it("builds the feed: claims, open PRs, last handoff, files in flight, online flag", async () => {
    const claimed = await addTask(w, "Claimed by Bob");
    await w.store.task.claim(claimed.id, w.bob, 60_000, w.clock.now(), { reason: "test" });
    const pr = await addTask(w, "Bob's PR", {
      status: "in_review",
      pr_url: "http://git.test/pr/7",
      owner_agent_id: w.bob,
    });
    await bobSession(w, {
      ended: true,
      summary: "done 1",
      handoff: {
        done: [],
        in_flight: [pr.id],
        in_flight_files: { [pr.id]: ["src/a.ts"] },
        blocked: [],
        next: [],
      },
    });
    const running = await bobSession(w, { ended: false });
    await w.store.event.append(running.id, TASK_FILES_EVENT, {
      taskId: claimed.id,
      files: ["src/b.ts"],
    });

    const feed = await buildPeerFeed({
      store: w.store,
      clock: w.clock,
      agentId: w.alice,
      projectId: w.project,
      peerIds: [w.bob, w.alice],
    });
    expect(feed.peers).toHaveLength(1);
    const bob = feed.peers[0] as PeerFeed["peers"][number];
    expect(bob.agentName).toBe("Bob");
    expect(bob.online).toBe(true);
    expect(bob.activeClaims.map((c) => c.taskId)).toEqual([claimed.id]);
    expect(bob.openPullRequests).toEqual([
      { taskId: pr.id, title: "Bob's PR", url: "http://git.test/pr/7" },
    ]);
    expect(bob.lastHandoff?.inFlight).toEqual([pr.id]);
    expect(bob.inFlightFiles).toEqual({ [pr.id]: ["src/a.ts"], [claimed.id]: ["src/b.ts"] });
    const text = renderPeerFeed(feed);
    expect(text).toContain("Bob: online");
    expect(text).toContain("src/a.ts");
    expect(renderPeerFeed({ ...feed, peers: [] })).toBe("");
  });

  it("messages the peer on a file overlap and still does the work; records files in the handoff", async () => {
    // Bob finished a session with src/shared.ts in flight on his task; Alice plans a task naming that file.
    const bobsTask = await addTask(w, "Bob's refactor", {
      status: "in_review",
      pr_url: "http://git.test/pr/1",
      owner_agent_id: w.bob,
    });
    await bobSession(w, {
      ended: true,
      handoff: {
        done: [],
        in_flight: [bobsTask.id],
        in_flight_files: { [bobsTask.id]: ["src/shared.ts"] },
        blocked: [],
        next: [],
      },
    });
    const mine = await addTask(w, "Alice's feature", {
      outcome: "Extend src/shared.ts with a new export",
    });
    const events: string[] = [];
    const exec = executor(w, { "Alice's feature": ["src/shared.ts", "src/new.ts"] });
    const res = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
      onEvent: (t) => events.push(t),
    });
    expect(exec.executed).toEqual([mine.id]);
    expect(res.inReview).toEqual([mine.id]);
    expect(events).toContain("peers.feed");
    expect(events).toContain("peer.overlap");
    expect(events).toContain(TASK_FILES_EVENT);
    const warnings = await w.store.message.list({ to_agent_id: w.bob, type: "warning" } as never);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain("src/shared.ts");
    expect(warnings[0]?.task_id).toBe(mine.id);
    const session = await w.store.session.mustGet(res.sessionId);
    expect(
      (session.handoff as { in_flight_files: Record<string, string[]> }).in_flight_files,
    ).toEqual({
      [mine.id]: ["src/shared.ts", "src/new.ts"],
    });
    expect((await w.store.task.mustGet(mine.id)).owner_agent_id).toBe(w.alice);
  });

  it("leaves a task alone when the peer has an open PR for it and tells the peer once", async () => {
    const shared = await addTask(w, "Shared task", {
      status: "ready",
      pr_url: "http://git.test/pr/42",
      owner_agent_id: w.bob,
    });
    // An open PR counts only while the task is in review; make Bob's PR task in_review and a
    // second ready task that is the same work re-opened would be a different id, so simulate the
    // in-flight case through Bob's handoff and a running session instead.
    await bobSession(w, {
      ended: true,
      handoff: { done: [], in_flight: [shared.id], blocked: [], next: [] },
    });
    await bobSession(w, { ended: false });
    const other = await addTask(w, "Other task", { priority: 1 });
    const exec = executor(w);
    const res = await runner(w, exec).start({
      agentId: w.alice,
      projectId: w.project,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant,
    });
    expect(exec.executed).toEqual([other.id]);
    expect(res.skipped).toEqual([shared.id]);
    const warnings = await w.store.message.list({ to_agent_id: w.bob, type: "warning" } as never);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.body).toContain("in flight");
    expect((await w.store.task.mustGet(shared.id)).status).toBe("ready");
  });
});
