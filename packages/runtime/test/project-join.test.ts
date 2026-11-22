import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { ProjectRow } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryLike } from "../src/agent/sdk.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { TASK_PROPOSAL_KEY, TASK_PROPOSAL_OPTIONS } from "../src/daemon/task-proposal-words.ts";
import { keepNotes, keptNotesOf, type TaskListNote } from "../src/session/task-list-notes.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import {
  AcceptingCriticProvider,
  removeHomes,
  ScriptedProvider,
  settleSessions,
} from "./helpers.ts";

/**
 * d1109-onerepo-join (OJ-02, C3-left-2): Make one project waits for what the person was told will
 * go on. A session of either project that waits to go on after its Claude credential (the person's
 * continuation), or a Start kept for the reset ("Start at 15:00"), holds the join with its time,
 * read through d1109-starts-engine's accessors (`keptContinuationOf`, `keptStartOf`) on the
 * billing source, also after the daemon starts again; after Cancel the join goes through.
 * Composed daemon on a file database, the person's routes, the stand-in Claude Code meeting the
 * subscription's limit; the clock is simulated and waits are on the store with a 20 s deadline.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "joining", "7".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "joining", "8".repeat(40)].join(""); // not-a-secret
/** 09:00Z is 10:00 in Zurich; the subscription's limit resets at 14:00Z, 15:00 in Zurich. */
const START = "2026-10-31T09:00:00Z";
const RESET = "2026-10-31T14:00:00.000Z";

/** The stand-in Claude Code: every call meets the plan's usage limit. */
function claudeCode(calls: string[]): QueryLike {
  return ({ prompt }) => {
    calls.push(prompt);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-joining" };
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: Date.parse(RESET) / 1000,
          rateLimitType: "five_hour",
        },
      };
      yield {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: "You've hit your limit · resets 3pm" }] },
      };
      yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" };
    })();
  };
}

interface World {
  rt: RuntimeApp;
  post: <T>(path: string, body?: unknown) => Promise<{ status: number; json: T }>;
  get: <T>(path: string) => Promise<{ status: number; json: T }>;
  close: () => Promise<void>;
}

const homes: string[] = [];
const open: RuntimeApp[] = [];

async function compose(home: string, clock: SimulatedClock): Promise<World> {
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault: new MemoryVault({
      [SECRET_NAMES.anthropicOauth]: OAUTH,
      [SECRET_NAMES.anthropic]: API_KEY,
    }),
    provider: new AcceptingCriticProvider(new ScriptedProvider([{ text: "Done." }], clock)),
    sdkQuery: claudeCode([]),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    startServices: false,
  });
  open.push(rt);
  const { app, token } = createDaemonApp(rt);
  const post = async <T>(path: string, body?: unknown) => {
    const res = await app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, json: (await res.json()) as T };
  };
  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, json: (await res.json()) as T };
  };
  return {
    rt,
    post,
    get,
    close: async () => {
      await settleSessions(rt);
      await rt.close();
      open.splice(open.indexOf(rt), 1);
    },
  };
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const rt of open.splice(0)) {
    await settleSessions(rt).catch((e: unknown) => failures.push(e));
    await rt.close().catch(() => undefined);
  }
  try {
    removeHomes(homes.splice(0));
  } catch (e) {
    failures.push(e);
  }
  if (failures.length > 0) throw failures[0];
});

/** Waits on the store (never on time): up to 20 s, then fails with what it waited for. */
async function until(what: string, fn: () => Promise<boolean>): Promise<void> {
  const end = Date.now() + 20_000;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`still waiting after 20 s for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** "Site" and "Kite club" in one folder (made before the rule), Kite club with a ready task. */
async function pair(rt: RuntimeApp, home: string): Promise<{ site: ProjectRow; kite: ProjectRow }> {
  const folder = join(home, "kites");
  mkdirSync(folder, { recursive: true });
  const site = await rt.store.project.insert({ name: "Site", goal: "A site", repos: [folder] });
  const kite = await rt.store.project.insert({
    name: "Kite club",
    goal: "Kites",
    repos: [folder],
    autonomy_level: 2,
  });
  await rt.store.task.insert({
    project_id: kite.id,
    title: "Write the club page",
    outcome: "the page is written",
    acceptance_criteria: ["it is written"],
    risk_tier: 0,
    status: "ready",
    priority: 5,
    est_cost_usd_micro: 100_000,
    reason: "seed",
  });
  return { site, kite };
}

const joinCall = (site: ProjectRow, kite: ProjectRow) => ({
  commands: [{ name: "project.join", params: { keep: site.id, close: [kite.id] } }],
  wordsUsed: "Make one project (Overview)",
  source: "ui",
  confirm: "tap",
});

const WAITS =
  'A session of "Kite club" waits to go on at 15:00. Make one project after it ran, or cancel it first.';

describe("d1109-onerepo-join, run C: a join waits for a session that waits to go on (OJ-02, C3-left-2)", () => {
  it("the person's session of Kite club waiting for its credential holds the join with its time, also after the daemon starts again; after Cancel the join goes through", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-join-continues-"));
    homes.push(home);
    const clock = new SimulatedClock(START);
    let w = await compose(home, clock);
    const { site, kite } = await pair(w.rt, home);
    const started = await w.post<{ result: string }>("/sessions", {
      agentId: w.rt.agent.id,
      projectId: kite.id,
      trigger: "manual",
      budgetUsdMicro: 5_000_000,
    });
    expect(started.status, JSON.stringify(started.json)).toBe(202);
    await until("the person's session to end and wait", async () => {
      const all = await w.rt.store.session.forProject(kite.id, { limit: 10 });
      return all.length === 1 && !["running", "planned", "paused"].includes(String(all[0]?.status));
    });
    expect(await w.rt.continuations.waiting(kite.id)).toMatch(/goes on by itself at 15:00\.$/);
    const refused = await w.post<{ status: string; reason?: string }>(
      "/commands/execute",
      joinCall(site, kite),
    );
    expect(refused.json).toMatchObject({ status: "refused", reason: WAITS });
    expect((await w.rt.store.project.mustGet(kite.id)).status).toBe("active");
    // The daemon starts again on the same home: the kept continuation still holds it.
    await w.close();
    w = await compose(home, clock);
    expect(
      (await w.post<{ status: string; reason?: string }>("/commands/execute", joinCall(site, kite)))
        .json,
    ).toMatchObject({ status: "refused", reason: WAITS });
    const cancelled = await w.post<{ cancelled: boolean }>(
      `/projects/${kite.id}/continuation/cancel`,
    );
    expect(cancelled.json.cancelled).toBe(true);
    const done = await w.post<{ status: string; sentence?: string }>(
      "/commands/execute",
      joinCall(site, kite),
    );
    expect(done.json).toMatchObject({
      status: "done",
      sentence: 'Made one project: "Kite club" joined "Site".',
    });
    await w.close();
  }, 60_000);

  it("a Start kept for the reset ('Start at 15:00') holds the join with its time; after Cancel the join goes through", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-join-kept-start-"));
    homes.push(home);
    const clock = new SimulatedClock(START);
    const w = await compose(home, clock);
    const { site, kite } = await pair(w.rt, home);
    const sub = (await w.rt.store.billingSource.list({} as never, { limit: 20 })).find(
      (s) => s.kind === "subscription",
    );
    if (!sub) throw new Error("no subscription source");
    await w.rt.store.billingSource.patch(sub.id, {
      limits: { ...sub.limits, restingUntil: RESET },
    });
    const pressed = await w.post<{ result: string; sentence?: string }>("/sessions", {
      agentId: w.rt.agent.id,
      projectId: kite.id,
      trigger: "manual",
      budgetUsdMicro: 5_000_000,
    });
    expect(pressed.json).toMatchObject({ result: "kept" });
    expect(
      (await w.post<{ status: string; reason?: string }>("/commands/execute", joinCall(site, kite)))
        .json,
    ).toMatchObject({ status: "refused", reason: WAITS });
    expect(
      (await w.post<{ cancelled: boolean }>(`/projects/${kite.id}/continuation/cancel`)).json
        .cancelled,
    ).toBe(true);
    expect(
      (await w.post<{ status: string }>("/commands/execute", joinCall(site, kite))).json.status,
    ).toBe("done");
    await w.close();
  }, 60_000);
});

// l4-selftasks-check, run L4 (L4-selftasks-109; C4L-14, merge-w20; the review of
// fix/l4-selftasks-check, blocking 1): after Make one project the notes a session kept for the
// closing project's task check stayed on it and were never checked, and the kept project could
// show two open "the agent suggests ... changes to the tasks" cards. Both are stored state (the
// project's summary_cache and the cards' status), so the join and its Undo are read back after
// the daemon starts again on the same home, through the routes the Inbox and the Overview read.
describe("l4-selftasks-check, run L4: Make one project moves the agent's task-list notes and keeps one suggestion, also after a restart (L4-selftasks-109)", () => {
  const note = (projectId: string, title: string, text: string): TaskListNote => ({
    source: "report",
    taskId: `task-of-${projectId}`,
    taskTitle: title,
    specialist: "coder",
    lines: [{ text, flagged: false }],
    at: START,
  });
  /** A suggestion card as `fileTaskProposal` stores it (its steps, options and change card). */
  const suggestion = (w: World, projectId: string, step: string) =>
    w.rt.store.humanRequest.insert({
      human_id: w.rt.human.id,
      project_id: projectId,
      kind: "decision",
      why: `A line of the coder's report says: "${step}". Nothing changes until you say yes.`,
      steps: [`Add "${step}".`],
      options: [...TASK_PROPOSAL_OPTIONS],
      blocking: false,
      risk: "low",
      status: "open",
      change_card: {
        key: TASK_PROPOSAL_KEY,
        project_id: projectId,
        changes: [{ line: `Add "${step}".` }],
        quotes: [],
        reasons: [],
      },
    } as never);
  interface InboxCard {
    projectId: string | null;
    status: string;
    steps: string[];
    changeCard: { key?: unknown } | null;
  }
  /** The open suggestion cards GET /inbox shows, by project: each card's first step. */
  const openSuggestions = async (w: World) => {
    const inbox = await w.get<{ requests: InboxCard[] }>("/inbox");
    expect(inbox.status).toBe(200);
    const byProject: Record<string, string[]> = {};
    for (const r of inbox.json.requests) {
      if (r.status !== "open" || r.changeCard?.key !== TASK_PROPOSAL_KEY) continue;
      const key = r.projectId ?? "";
      byProject[key] = [...(byProject[key] ?? []), r.steps[0] ?? ""];
    }
    return byProject;
  };
  /** The notes the project's next task check takes (`takeNotes` reads them so). */
  const notesOf = async (w: World, projectId: string) =>
    keptNotesOf(await w.rt.store.project.mustGet(projectId)).map((n) => n.lines[0]?.text);
  const statusLine = async (w: World, projectId: string) =>
    (await w.get<{ statusLine?: { text?: string } | null }>(`/projects/${projectId}`)).json
      .statusLine?.text;

  it("after the join and a restart the kept project holds both notes and GET /inbox one suggestion; Undo after another restart puts both back as they were", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-join-task-list-"));
    homes.push(home);
    const clock = new SimulatedClock(START);
    let w = await compose(home, clock);
    const { site, kite } = await pair(w.rt, home);
    await keepNotes(w.rt.store, site.id, [
      note(site.id, "Launch page", "the launch page links no contact page"),
    ]);
    await keepNotes(w.rt.store, kite.id, [
      note(kite.id, "Signup form", "nothing checks the signup's email field"),
    ]);
    await suggestion(w, site.id, "Add a contact page");
    await clock.advance(60_000);
    await suggestion(w, kite.id, "Check the email field");
    expect(await openSuggestions(w)).toEqual({
      [site.id]: ['Add "Add a contact page".'],
      [kite.id]: ['Add "Check the email field".'],
    });
    const joined = await w.post<{ status: string; changeLogId?: string; sentence?: string }>(
      "/commands/execute",
      joinCall(site, kite),
    );
    expect(joined.json).toMatchObject({
      status: "done",
      sentence: 'Made one project: "Kite club" joined "Site".',
    });
    const changeId = joined.json.changeLogId ?? "";
    expect(changeId).not.toBe("");
    // The daemon starts again on the same home: what the join moved and closed is stored.
    await w.close();
    w = await compose(home, clock);
    expect(await notesOf(w, site.id)).toEqual([
      "the launch page links no contact page",
      "nothing checks the signup's email field",
    ]);
    expect(await notesOf(w, kite.id)).toEqual([]);
    // One suggestion of the agent per project (ADR 0119 point 7): the newer one stays open.
    expect(await openSuggestions(w)).toEqual({ [site.id]: ['Add "Check the email field".'] });
    expect(await statusLine(w, site.id)).toBe("Waiting for you: 1 suggestion");
    // Undo on Changes, then the daemon starts again: both cards open and the notes back.
    const undone = await w.post<{ status: string; reason?: string }>(`/changes/${changeId}/undo`);
    expect(undone.json.status, JSON.stringify(undone.json)).toBe("done");
    await w.close();
    w = await compose(home, clock);
    expect(await notesOf(w, site.id)).toEqual(["the launch page links no contact page"]);
    expect(await notesOf(w, kite.id)).toEqual(["nothing checks the signup's email field"]);
    expect(await openSuggestions(w)).toEqual({
      [site.id]: ['Add "Add a contact page".'],
      [kite.id]: ['Add "Check the email field".'],
    });
    expect(await statusLine(w, site.id)).toBe("Waiting for you: 1 suggestion");
    expect(await statusLine(w, kite.id)).toBe("Waiting for you: 1 suggestion");
    await w.close();
  }, 60_000);
});
