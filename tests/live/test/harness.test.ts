import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { closingReply, specialistReportTurn, specialistTurn, submitReview } from "@forerunner/e2e";
import { join, SimulatedClock } from "@forerunner/platform";
import { loadRegistry, SECRET_NAMES, stateSources } from "@forerunner/runtime";
import { FakeProvider, type ScriptedReply, textReply, toolReply } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DRY_RUN_PRICING, dryRunCredentials } from "../src/dry-run.ts";
import { composeLive, type LiveHarness, repositoryRegistryDir } from "../src/harness.ts";
import {
  LIVE_CODER_OVERRIDES,
  patchSpecialistFrontmatter,
  prepareLiveRegistry,
} from "../src/registry.ts";

/**
 * The dry run: the whole harness on a scripted provider. The real runtime is composed
 * (composeRuntime, in-memory store, memory vault with the key by name, fake git host, patched
 * registry), one session runs one task through the PR executor and the critic, and the spend
 * ledger, the audit log and the store's cost ledger agree on what was "spent". No network.
 */
const temps: string[] = [];
afterAll(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

describe("registry copy for the live coder", () => {
  it("replaces the tool list and the caps, keeps every other key and the prompt", () => {
    const original = [
      "---",
      "name: coder",
      'version: "1.0.0"',
      "description: Implements a scoped code change.",
      "default_tier: sonnet",
      "default_effort: medium",
      "max_effort: high",
      "allowed_tools:",
      "  - cc:Read",
      "  - cc:Write",
      "allowed_domains: []",
      "max_budget_usd: 3.0",
      "max_turns: 80",
      "timeout_minutes: 45",
      "risk_tier_floor: 1",
      "eval_set: evals/coder",
      "status: active",
      "requires_sandbox: true",
      "output_contract: A diff limited to the brief.",
      "---",
      "# Coder",
      "",
      "Body stays.",
      "",
    ].join("\n");
    const patched = patchSpecialistFrontmatter(original, LIVE_CODER_OVERRIDES);
    expect(patched).toContain("allowed_tools:\n  - read_file\n  - write_file\n  - list_dir\n");
    expect(patched).toContain(
      "max_budget_usd: 0.5\nmax_turns: 12\ntimeout_minutes: 5\nrequires_sandbox: false\n---",
    );
    expect(patched).not.toContain("cc:Read");
    expect(patched).not.toContain("max_turns: 80");
    expect(patched).toContain("eval_set: evals/coder");
    expect(patched.endsWith("# Coder\n\nBody stays.\n")).toBe(true);
    expect(() => patchSpecialistFrontmatter("no frontmatter", LIVE_CODER_OVERRIDES)).toThrow(
      /frontmatter/,
    );
  });

  it("the copied registry loads with the coder runnable on the built-in tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-live-registry-"));
    temps.push(dir);
    const prepared = prepareLiveRegistry(repositoryRegistryDir(), join(dir, "registry"));
    expect(prepared.patched).toEqual(["coder"]);
    const registry = loadRegistry(prepared.dir, {
      toolNames: ["read_file", "write_file", "list_dir", "run_command"],
    });
    const coder = registry.specialists.get("coder");
    expect(coder?.runnable).toBe(true);
    expect(coder?.allowed_tools).toEqual(["read_file", "write_file", "list_dir"]);
    expect(coder?.max_turns).toBe(12);
    expect(coder?.requires_sandbox).toBe(false);
    expect(coder?.prompt).toContain("You are the coder specialist of Forerunner");
  });
});

describe("live harness dry run (scripted provider, no network)", () => {
  let h: LiveHarness;
  let ledgerDir: string;
  const clock = new SimulatedClock("2026-10-20T14:00:00Z");
  const script = (): ScriptedReply[] => [
    toolReply(
      "write_file",
      {
        path: "src/greet.ts",
        content:
          "export function greet(name: string): string {\n  return `Hello, ` + name + `!`;\n}\n",
      },
      "Writing the file.",
      {
        when: specialistTurn,
        times: Number.POSITIVE_INFINITY,
        usage: { input_tokens: 3000, output_tokens: 120 },
      },
    ),
    textReply(
      "Summary: added greet. Criteria: met (file written).\nLesson: keep greetings short and tested.",
      {
        when: specialistReportTurn,
        times: Number.POSITIVE_INFINITY,
        usage: { input_tokens: 3200, output_tokens: 60 },
      },
    ),
    submitReview({}, { times: Number.POSITIVE_INFINITY }),
    closingReply(),
  ];
  const compose = (runCapUsd: number) =>
    composeLive({
      env: { FORERUNNER_LIVE_RUN: "dry-run" },
      clock,
      inner: new FakeProvider({
        mode: "script",
        clock,
        latency: "none",
        onNoMatch: "throw",
        replies: script(),
      }),
      credentials: dryRunCredentials(),
      ledgerPath: join(ledgerDir, "spend.json"),
      config: { capUsd: 100, runCapUsd, warnShare: 0.8 },
      pricing: DRY_RUN_PRICING,
      onWarn: () => undefined,
    });

  beforeAll(async () => {
    ledgerDir = mkdtempSync(join(tmpdir(), "fr-live-dry-"));
    temps.push(ledgerDir);
    h = await compose(15);
  });
  afterAll(async () => {
    await h?.close();
  });

  it("composes the real runtime on an api_key billing source with the key held by name in the vault", async () => {
    const sources = await stateSources(h.app.store)(h.app.human.id);
    expect(sources.map((s) => s.kind)).toEqual(["api_key"]);
    expect(sources[0]?.credentialRef).toBe(SECRET_NAMES.anthropic);
    expect(await h.app.vault.has(SECRET_NAMES.anthropic)).toBe(true);
    expect(await h.app.vault.has(SECRET_NAMES.github)).toBe(true);
    expect(h.app.provider?.name).toBe("fake");
    expect(h.app.registry.specialists.get("coder")?.allowed_tools).toEqual([
      "read_file",
      "write_file",
      "list_dir",
    ]);
    expect(h.app.conversation).not.toBeNull();
    expect(h.host.repo(h.repo.full)?.defaultBranch).toBe("main");
  });

  it("one session completes a task through a PR on the fake host with every call in the spend ledger, the audit log and the cost ledger", async () => {
    const project = await h.addProject({ name: "Dry run", goal: "Prove the harness" });
    const task = await h.addTask(project, {
      title: "Add greet",
      outcome: "src/greet.ts exports greet(name)",
      acceptanceCriteria: ["src/greet.ts exports greet(name: string): string"],
    });
    const events: string[] = [];
    const res = await h.startSession({
      projectId: project,
      budgetCapUsdMicro: 2_000_000,
      onEvent: (type) => events.push(type),
    });
    expect(res.status).toBe("completed");
    expect(res.failed).toEqual([]);
    expect(res.needsHuman).toEqual([]);
    expect([...res.completed, ...res.inReview]).toEqual([task.id]);
    expect(events).toContain("task.started");
    const prs = await h.app.gitHost.listPullRequests({ owner: h.repo.owner, name: h.repo.name });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.head.ref).toMatch(/^fr\//);

    // Every model call (coder turns, critic turns) is one ledger row of this run, priced.
    const rows = h.ledger.rows();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.run === "dry-run" && r.usd > 0 && r.note === undefined)).toBe(true);
    expect(rows.filter((r) => r.model === "fake-sonnet").length).toBe(rows.length);
    expect(h.provider.calls).toHaveLength(rows.length);
    expect(h.budget.refusals).toEqual([]);
    expect(h.budget.snapshot().inFlightUsd).toBe(0);
    const text = readFileSync(h.ledger.path, "utf8");
    expect(text).not.toContain(dryRunCredentials().apiKey);
    // The store's cost ledger (what the product bills) saw the same tokens as the spend ledger.
    const sum = await h.app.store.costLedger.sum({ sessionId: res.sessionId });
    expect(sum.tokens_in).toBe(rows.reduce((s, r) => s + r.tokensIn, 0));
    expect(sum.tokens_out).toBe(rows.reduce((s, r) => s + r.tokensOut, 0));
    expect(sum.entries).toBeGreaterThan(0);
    // One audit row per live call, none denied; the runs stayed under the task cap.
    const audit = await h.app.store.auditLog.list(undefined, { limit: 10_000 });
    const liveRows = audit.filter((a) => a.tool === "live.model_call");
    expect(liveRows).toHaveLength(rows.length);
    expect(liveRows.every((a) => a.allowed)).toBe(true);
    const runs = await h.app.store.run.forSession(res.sessionId);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.every((r) => r.cost_usd_micro <= 400_000)).toBe(true);
    expect(res.spentUsdMicro).toBeLessThanOrEqual(2_000_000);
  });

  it("a call the run cap cannot cover is refused in code and surfaces as a failed task with the reason", async () => {
    // A second composition on the same ledger and run id, with the per-run cap one micro-USD
    // above what the run has already spent: the next call is refused before it is sent.
    const before = h.ledger.rows().length;
    const tight = await compose(h.ledger.runUsd("dry-run") + 0.000001);
    try {
      const project = await tight.addProject({ name: "Dry run capped", goal: "Refusal path" });
      await tight.addTask(project, {
        title: "Add farewell",
        outcome: "src/farewell.ts exports farewell(name)",
        acceptanceCriteria: ["src/farewell.ts exists"],
      });
      const res = await tight.startSession({ projectId: project, budgetCapUsdMicro: 2_000_000 });
      expect(res.failed.length + res.needsHuman.length).toBe(1);
      expect(tight.budget.refusals.length).toBeGreaterThanOrEqual(1);
      expect(tight.budget.refusals[0]?.reason).toContain("per-run cap");
      expect(tight.ledger.rows()).toHaveLength(before);
      expect(tight.provider.inner).toBeInstanceOf(FakeProvider);
      expect((tight.provider.inner as FakeProvider).calls).toHaveLength(0);
      const audit = await tight.app.store.auditLog.list(undefined, { limit: 10_000 });
      const denied = audit.filter((a) => a.tool === "live.model_call" && !a.allowed);
      expect(denied.length).toBeGreaterThanOrEqual(1);
      expect(denied[0]?.denied_reason).toContain("per-run cap");
    } finally {
      await tight.close();
    }
  });
});
