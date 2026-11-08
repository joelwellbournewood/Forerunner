import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryGitHost } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { projectWorkspaceDir } from "../src/loop/docs.ts";
import { BILLING_PICK_AUDIT_TOOL, CODE_COMMANDS_SETTING } from "../src/session/billing.ts";
import { abilityTable, credentialChoiceFor } from "../src/session/credential-choice.ts";
import { NO_WEB_ACCESS_LINE, NO_WEB_SEARCH_LINE, planItemFor } from "../src/session/executor.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import {
  type ChooserFacts,
  capabilitiesOf,
  DEFAULT_CHOOSER_FACTS,
} from "../src/wiring/billing-pick.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * The credential chooser (U-078, the owner's decision of 2026-11-02: "the person's order decides;
 * another credential only when the first cannot do the task properly; the plan card says why";
 * ADR 0100 amended, ADR 0107 points 7 to 9 amended). One composition with both credentials (the
 * subscription first, as with no order chosen), a fake Agent SDK for the subscription and a
 * scripted provider for the API key: what each task needs against what each credential can do
 * here decides where it runs, and `rt.chooser` gives the plan card's and New task's sentence.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const OAUTH = ["sk-ant-oat01-", "chooser", "0".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "chooser", "0".repeat(40)].join(""); // not-a-secret

function fakeSdk() {
  const calls: { prompt: string; options: Record<string, unknown> }[] = [];
  const q: QueryLike = ({ prompt, options }) => {
    calls.push({ prompt, options: options ?? {} });
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-1" };
      yield {
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Done on the subscription. Lesson: none." }],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done on the subscription. Lesson: none.",
        total_cost_usd: 0.001,
      };
    })();
  };
  return { q, calls };
}

async function compose(
  vault: Record<string, string>,
  facts: Partial<ChooserFacts>,
  sdk: ReturnType<typeof fakeSdk>,
  provider: ScriptedProvider,
  clock: SimulatedClock,
) {
  const home = mkdtempSync(join(tmpdir(), "fr-chooser-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  mkdirSync(dirs.config, { recursive: true });
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home, FORERUNNER_PLAN_USD_MONTHLY: "100" },
    dirs,
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(vault),
    provider,
    gitHost: new MemoryGitHost("alice"),
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "1.0.0",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    startServices: false,
    sdkQuery: sdk.q,
    // A live object: the test turns search on the key and pages on the subscription on and off.
    billing: { facts: facts as ChooserFacts },
  });
  const projectId = (await rt.store.project.insert({ name: "Club site", goal: "g", repos: [] })).id;
  return { rt, home, projectId };
}

async function seedTask(
  rt: RuntimeApp,
  clock: SimulatedClock,
  projectId: string,
  t: { title: string; outcome?: string; criteria?: string[] },
) {
  const task = await rt.store.task.insert({
    project_id: projectId,
    title: t.title,
    outcome: t.outcome ?? "the change is in",
    acceptance_criteria: t.criteria ?? ["the change is in and tested"],
    risk_tier: 1,
    status: "in_progress",
    priority: 5,
    depends_on: [],
    budget_usd_micro: 500_000,
    est_cost_usd_micro: 0,
    actual_cost_usd_micro: 0,
    attempt: 0,
    reason: "seed",
  });
  const session = await rt.store.session.insert({
    agent_id: rt.agent.id,
    project_id: projectId,
    trigger: "manual",
    plan: {},
    status: "running",
    started_at: clock.nowIso(),
    summary: "chooser",
    runner: "pc",
    author_agent: rt.agent.id,
  });
  const token = rt.tokens.issue({
    runId: `run-session-${task.id}`,
    sessionId: session.id,
    agentId: rt.agent.id,
    ownerHumanId: rt.human.id,
    projectId,
    allowedTools: [...rt.toolsForRun().names(), ...claudeCodeToolNames()],
    allowedPaths: (await rt.sessionGrant(projectId))?.allowedPaths ?? [],
    allowedDomains: [],
    grantedSecrets: [],
    budgetUsdMicro: 2_000_000,
    depth: 0,
    maxDepth: 2,
    autonomy: 3,
    planApproved: true,
    expiresAt: new Date(clock.now() + 60_000).toISOString(),
  });
  const budget = new SessionBudget({
    sessionId: session.id,
    budgetUsdMicro: 2_000_000,
    stepCap: 50,
    deadlineMs: clock.now() + 60_000,
    reserveShare: 0,
  });
  return { task, session, token, budget };
}

describe("the credential chooser with both credentials, the subscription first (U-078)", () => {
  const clock = new SimulatedClock("2026-11-03T09:00:00Z");
  const sdk = fakeSdk();
  const provider = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
  // Since 'sites' the composition reads pages and searches on both credentials; a case turns the
  // subscription's page reader off through this seam to see the chooser send research to the key.
  const facts: Partial<ChooserFacts> = {};
  let rt: RuntimeApp;
  let home: string;
  let projectId: string;

  beforeAll(async () => {
    ({ rt, home, projectId } = await compose(
      { [SECRET_NAMES.anthropicOauth]: OAUTH, [SECRET_NAMES.anthropic]: API_KEY },
      facts,
      sdk,
      provider,
      clock,
    ));
  });
  afterAll(async () => {
    await rt.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function run(
    specialist: string,
    t: { title: string; outcome?: string; criteria?: string[] },
  ) {
    const w = await seedTask(rt, clock, projectId, t);
    const sdkBefore = sdk.calls.length;
    const loopBefore = provider.calls.length;
    const res = await rt.executor.execute({
      ...w,
      item: planItemFor(w.task, specialist),
      signal: new AbortController().signal,
    });
    const run = (await rt.store.run.forTask(w.task.id))[0];
    const sources = await rt.billing.sources();
    const kind = sources.find((s) => s.id === run?.billing_source_id)?.kind;
    const pick = (await rt.store.auditLog.list({ runId: res.runId })).find(
      (r) => r.tool === BILLING_PICK_AUDIT_TOOL,
    );
    return {
      res,
      kind,
      onSdk: sdk.calls.length > sdkBefore,
      onLoop: provider.calls.length > loopBefore,
      sdkPrompt: sdk.calls[sdk.calls.length - 1]?.prompt ?? "",
      loopBrief: JSON.stringify(provider.calls[provider.calls.length - 1]?.messages ?? []),
      reason: pick?.result_summary ?? "",
    };
  }

  it("a researcher runs on the API key when only it reads pages and searches (the subscription's reader off), and the plan card says so", async () => {
    facts.subscriptionPages = false;
    const r = await run("researcher", { title: "Compare two static site generators" }).finally(
      () => {
        delete facts.subscriptionPages;
      },
    );
    expect(r.res.outcome).toBe("done");
    expect(r.kind).toBe("api_key");
    expect(r.onLoop).toBe(true);
    expect(r.onSdk).toBe(false);
    // This composition's API key runs on a scripted provider, which runs no server tool: the run
    // is not offered web search, and its brief says so ('web-search').
    expect(r.loopBrief).toContain(NO_WEB_SEARCH_LINE.slice(0, 40));
    // The pick says why, in its audit row: only the key reads pages, and it meets every need.
    expect(r.reason).toContain(
      "chooser: only api_key meets webRead, webSearch (first choice subscription)",
    );
    expect(r.reason).not.toContain("lacks webSearch");
    // The plan card's and New task's sentence (the same words).
    facts.subscriptionPages = false;
    try {
      expect(await rt.chooser.forTask({ specialist: "researcher", projectId })).toEqual({
        kind: "api_key",
        line: "Runs on your API key: only it can read web pages and search the web here.",
      });
    } finally {
      delete facts.subscriptionPages;
    }
  });

  it("with search and page reading on both credentials (the default since 'sites'), the person's order decides: the subscription", async () => {
    try {
      const r = await run("researcher", { title: "Compare two hosting offers" });
      expect(r.res.outcome).toBe("done");
      expect(r.kind).toBe("subscription");
      expect(r.onSdk).toBe(true);
      // Before (C-64): research went to the API key whenever one was saved, ahead of the order.
      expect(r.reason).not.toContain("API key first");
      expect(await rt.chooser.forTask({ specialist: "researcher", projectId })).toEqual({
        kind: "subscription",
        line: null,
      });
    } finally {
      delete facts.subscriptionPages;
    }
  });

  it("a task whose words need the person's answers runs on the API key, the one that can ask, and says why", async () => {
    const task = {
      title: "Set up the hosting",
      outcome: "The site is hosted; this needs the owner's decision on the hosting provider.",
      criteria: ["The site is reachable on the chosen host"],
    };
    const r = await run("coder", task);
    expect(r.kind).toBe("api_key");
    expect(r.onLoop).toBe(true);
    expect(r.reason).toContain("only api_key meets askPerson (first choice subscription)");
    expect(
      await rt.chooser.forTask({
        specialist: "coder",
        projectId,
        task: { ...task, acceptance_criteria: task.criteria },
      }),
    ).toEqual({
      kind: "api_key",
      line: "Runs on your API key: only it can ask you questions while it works here.",
    });
  });

  it("a coder on a project with dependencies stays on the subscription by default, and the plan card says its tests will not run there; 'the API key' moves it", async () => {
    const folder = projectWorkspaceDir(rt.data.assets.projectsRoot, projectId);
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ scripts: { test: "vitest run" }, devDependencies: { vitest: "^3.0.0" } }),
    );
    const r = await run("coder", { title: "Add a footer" });
    expect(r.res.outcome).toBe("done");
    expect(r.kind).toBe("subscription");
    expect(r.onSdk).toBe(true);
    expect(r.reason).toContain("subscription lacks commands, which only makes the work better");
    expect(await rt.chooser.forTask({ specialist: "coder", projectId })).toEqual({
      kind: "subscription",
      line: "On your subscription its tests will not run: it cannot run commands there.",
    });
    // "Code tasks that need commands: the API key".
    const prefs = (await rt.store.human.get(rt.human.id))?.notify_prefs ?? {};
    await rt.store.human.patch(rt.human.id, {
      notify_prefs: { ...prefs, [CODE_COMMANDS_SETTING]: "api_key" },
    });
    try {
      const k = await run("coder", { title: "Add a header" });
      expect(k.kind).toBe("api_key");
      expect(k.onLoop).toBe(true);
      expect(await rt.chooser.forTask({ specialist: "coder", projectId })).toEqual({
        kind: "api_key",
        line: "Runs on your API key: only it can run commands here.",
      });
    } finally {
      await rt.store.human.patch(rt.human.id, { notify_prefs: prefs });
    }
  });

  it("Settings' table is the capability function's output for each credential", async () => {
    const table = await rt.chooser.table();
    expect(table.columns).toEqual([
      { kind: "api_key", name: "API key", saved: true },
      { kind: "subscription", name: "Claude subscription", saved: true },
    ]);
    const f = rt.chooser.facts();
    for (const row of table.rows) {
      if (row.need === "cost") continue;
      expect(row.cells.map((c) => c.can)).toEqual([
        capabilitiesOf("api_key", f)[row.need],
        capabilitiesOf("subscription", f)[row.need],
      ]);
    }
    expect(table.rows.map((r) => [r.label, ...r.cells.map((c) => c.words)])).toEqual([
      // 'sites': Forerunner's page reader on the subscription too (before: "Not yet").
      ["Read web pages", "Yes", "Yes"],
      ["Search the web", "Yes", "Yes"],
      [
        "Run commands (its tests)",
        "Yes, in a separate folder; a full review waits for Docker",
        "No",
      ],
      ["Ask you while it works", "Yes", "No: it lists its questions in its report"],
      ["What it costs", "Money per use", "Your plan's limits, no money per use"],
    ]);
  });
});

// Review of 'web-search': with the account's search switched off, Settings said "Not yet" under
// the API key and the plan card "but not search yet", a promise the code does not keep (§5.9).
describe("an API key whose web search is off ('web-search')", () => {
  const facts = (over: Partial<ChooserFacts>): ChooserFacts => ({
    ...DEFAULT_CHOOSER_FACTS,
    ...over,
  });
  const searchCell = (f: ChooserFacts) =>
    abilityTable(f, ["api_key", "subscription"]).rows.find((r) => r.need === "webSearch")?.cells[0]
      ?.words;

  it("Settings says why the key does not search, never 'Not yet'", () => {
    expect(searchCell(facts({}))).toBe("Yes");
    expect(searchCell(facts({ keySearch: false, keySearchOff: true }))).toBe(
      "No: switched off for this API key",
    );
    expect(searchCell(facts({ keySearch: false }))).toBe("No: search is off here");
    expect(searchCell(facts({ webFetch: false }))).toBe("No: the page reader is off here");
  });

  it("the plan card says research reads pages by address on the key, without 'yet'", () => {
    // Only the key saved: since 'sites' a subscription would read and search itself.
    const choice = credentialChoiceFor({
      kindsInOrder: ["api_key"],
      needs: { hard: ["webRead", "webSearch"], better: [] },
      facts: facts({ keySearch: false, keySearchOff: true }),
      specialist: "researcher",
      dependencies: false,
    });
    expect(choice).toEqual({
      kind: "api_key",
      line: "Runs on your API key: it can read web pages here but not search, so the researcher reads pages whose address it knows.",
    });
  });
});

describe("the science-evaluator on a Claude subscription alone (U-078)", () => {
  const clock = new SimulatedClock("2026-11-03T09:00:00Z");
  const sdk = fakeSdk();
  const provider = new ScriptedProvider([{ text: "unused" }], clock);
  let rt: RuntimeApp;
  let home: string;
  let projectId: string;

  beforeAll(async () => {
    ({ rt, home, projectId } = await compose(
      { [SECRET_NAMES.anthropicOauth]: OAUTH },
      {},
      sdk,
      provider,
      clock,
    ));
  });
  afterAll(async () => {
    await rt.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("reads pages there through Forerunner's reader ('sites'), and is never told that it searches (it has no web search)", async () => {
    const w = await seedTask(rt, clock, projectId, {
      title: "Check the survey's response rate",
      outcome: "evaluation.md says whether the 64% response rate holds",
    });
    const res = await rt.executor.execute({
      ...w,
      item: planItemFor(w.task, "science-evaluator"),
      signal: new AbortController().signal,
    });
    expect(res.outcome).toBe("done");
    const prompt = sdk.calls[sdk.calls.length - 1]?.prompt ?? "";
    // Before: "Web pages cannot be opened on this run (a Claude subscription): use web search, …".
    expect(prompt).not.toContain("Web pages cannot be opened on this run");
    expect(prompt).not.toContain("use web search");
    expect(prompt).not.toContain("WebSearch");
    // Before 'sites': NO_WEB_ACCESS_LINE, and the plan card "where it cannot read web pages".
    expect(prompt).not.toContain(NO_WEB_ACCESS_LINE);
    const options = sdk.calls[sdk.calls.length - 1]?.options ?? {};
    expect(options.allowedTools).toContain("mcp__forerunner__web_fetch");
    expect(options.allowedTools).not.toContain("WebSearch");
    // The plan card and New task: nothing it cannot do about the web there.
    expect(
      (await rt.chooser.forTask({ specialist: "science-evaluator", projectId }))?.line ?? "",
    ).not.toContain("web pages");
  });
});
