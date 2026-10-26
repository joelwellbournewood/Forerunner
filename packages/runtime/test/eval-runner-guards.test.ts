import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { BUILTIN_PRICING, mergePricing, type PricingTable } from "@forerunner/billing";
import { join, resolve } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { fileTools } from "../src/daemon/tools.ts";
import type { RunBilling } from "../src/enforcement/hooks.ts";
import type { CapDecision, CapScope, CapsBilling, CapsPort } from "../src/enforcement/ports.ts";
import { LoopEvalRunner, PROCESS_SANDBOX_REFUSED } from "../src/models/eval-runner.ts";
import { ProviderRegistry } from "../src/provider/registry.ts";
import { loadRegistry } from "../src/registry/loader.ts";
import { FakeSandbox } from "../src/sandbox/fake.ts";
import type { RunSandboxPort } from "../src/session/executor.ts";
import { harness, ScriptedProvider } from "./helpers.ts";

/**
 * The eval runner's guards (ADR 0089): the human's outer caps before every task, with the
 * plan level of a subscription; a task over its own budget fails that task, not the set; the
 * refusal of the process stand-in in plain eval wording.
 */
const REGISTRY = join(resolve(import.meta.dirname, "..", "..", ".."), "evals", "registry");

const PRICE = (input: number) =>
  mergePricing(BUILTIN_PRICING, {
    "fake-haiku": {
      input_per_mtok_usd: input,
      output_per_mtok_usd: input * 5,
      cache_read_per_mtok_usd: input / 10,
      cache_write_per_mtok_usd: input * 1.25,
      as_of: "2026-10-01",
    },
  });

class RecordingCaps implements CapsPort {
  readonly seen: { scope: CapScope; estimate: number; billing?: CapsBilling }[] = [];
  constructor(private readonly decide: (billing?: CapsBilling) => CapDecision) {}
  check(
    scope: CapScope,
    estimate: number,
    opts: { phase: "work" | "review"; billing?: CapsBilling },
  ): CapDecision {
    this.seen.push({ scope, estimate, ...(opts.billing ? { billing: opts.billing } : {}) });
    return this.decide(opts.billing);
  }
}

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runner(opts: {
  provider: ScriptedProvider;
  caps?: CapsPort;
  billing?: () => Promise<RunBilling | undefined>;
  sandbox?: RunSandboxPort;
}) {
  const h = harness();
  const workRoot = mkdtempSync(join(os.tmpdir(), "fr-eval-guards-"));
  temps.push(workRoot);
  return new LoopEvalRunner({
    registry: loadRegistry(REGISTRY),
    driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
    providers: new ProviderRegistry().register(opts.provider),
    tokens: h.tokens,
    clock: h.clock,
    humanId: "human-1",
    agentId: "agent-1",
    billingSourceId: "bs-sub",
    workRoot,
    tools: () => fileTools(),
    maxTasks: 2,
    ...(opts.caps ? { caps: opts.caps } : {}),
    ...(opts.billing ? { billing: opts.billing } : {}),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
  });
}

const input = (pricing: PricingTable, specialist = "researcher") => ({
  specialist,
  provider: "fake",
  model: "fake-haiku",
  effort: "low" as const,
  pricing,
});

describe("eval runner guards", () => {
  it("checks the plan level of a subscription before every task: a plan share past its 80% line starts no task", async () => {
    const provider = new ScriptedProvider([{ text: "done" }], harness().clock);
    const caps = new RecordingCaps((b) =>
      (b?.planUsageShare ?? 0) >= 0.8 * (b?.planShareCap ?? 1)
        ? { decision: "finish_current", level: "plan", message: "plan share at 85%" }
        : { decision: "allow" },
    );
    const r = runner({
      provider,
      caps,
      billing: async () => ({
        kind: "subscription",
        planShareCap: 0.9,
        planUsageShare: () => 0.85,
      }),
    });
    await expect(r.run(input(PRICE(1)))).rejects.toMatchObject({
      code: "budget_exceeded",
      details: { level: "plan" },
    });
    expect(provider.calls).toHaveLength(0);
    expect(caps.seen[0]?.billing).toMatchObject({
      sourceId: "bs-sub",
      kind: "subscription",
      planUsageShare: 0.85,
      planShareCap: 0.9,
    });
    expect(caps.seen[0]?.scope).toEqual({ humanId: "human-1" });
  });

  it("an API source passes its kind to the caps and runs while they allow", async () => {
    const provider = new ScriptedProvider([{ text: "done" }], harness().clock);
    const caps = new RecordingCaps(() => ({ decision: "allow" }));
    const r = runner({ provider, caps, billing: async () => ({ kind: "api" }) });
    const out = await r.run(input(PRICE(1)));
    expect(out.total).toBe(2);
    expect(caps.seen).toHaveLength(2);
    expect(caps.seen[0]?.billing).toMatchObject({ sourceId: "bs-sub", kind: "api" });
  });

  it("a task that hits its own run budget fails that task only; the set goes on while the outer caps allow", async () => {
    const provider = new ScriptedProvider([{ text: "done" }], harness().clock);
    const caps = new RecordingCaps(() => ({ decision: "allow" }));
    // A price so high that the first call's estimate is past every task's budget.
    const out = await runner({ provider, caps }).run(input(PRICE(1_000_000)));
    expect(out).toMatchObject({ total: 2, failed: 2, passed: 0 });
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses the process stand-in in eval wording that says what to do, before any model call", async () => {
    const provider = new ScriptedProvider([{ text: "done" }], harness().clock);
    const port: RunSandboxPort = {
      open: async (req) => ({
        sandbox: new FakeSandbox({ worktree: req.worktree }),
        engine: "process",
        warnings: [],
      }),
    };
    const err = await runner({ provider, sandbox: port })
      .run(input(PRICE(1), "coder"))
      .then(
        () => null,
        (e: unknown) => e as { code: string; message: string; details: Record<string, unknown> },
      );
    expect(err?.code).toBe("not_supported");
    expect(err?.details.reason).toBe(PROCESS_SANDBOX_REFUSED);
    expect(err?.message).toMatch(/install Docker or Podman, or allow the process sandbox/);
    expect(err?.message).not.toMatch(/model watch/i);
    expect(provider.calls).toHaveLength(0);
  });
});
