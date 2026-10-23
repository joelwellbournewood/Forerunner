import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { costOf } from "@forerunner/billing";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { FAST_MODE_AUDIT_TOOL } from "../src/models/fast-mode.ts";
import type {
  ModelProvider,
  ModelRef,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from "../src/provider/types.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * Opus fast mode through the composed daemon (spec D.20, ADR 0057): `composeRuntime` wires the
 * executor, the critic and the command loop to the price table in force, so a project with
 * `fast_mode` on runs its Opus rung (the coder at risk tier 3, the tier-3 review) with
 * `speed: "fast"` and both Run rows name and price the variant from `<config>/pricing.json`.
 * The change card the human confirms and the Settings row quote that same corrected price.
 * A stub provider named `anthropic` that offers fast mode, `sqlite::memory:`, an empty vault
 * (the `fake` billing source, which bills like the API), SimulatedClock; no network.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const str = (v: unknown): string => String(v);

const USAGE = { input_tokens: 10_000, output_tokens: 2_000 };
/** The corrected research-preview row a human or the model watch adopted. */
const CORRECTED = { input_per_mtok_usd: 30, output_per_mtok_usd: 150 };

/** The Anthropic adapter's shape (name and `fastMode`) over scripted replies. */
class FastAnthropicStub implements ModelProvider {
  readonly name = "anthropic";
  readonly fastMode = true;
  constructor(private readonly inner: ScriptedProvider) {}
  get calls(): ModelRequest[] {
    return this.inner.calls;
  }
  listModels(): Promise<ModelRef[]> {
    return this.inner.listModels();
  }
  stream(req: ModelRequest): AsyncIterable<StreamEvent> {
    return this.inner.stream(req);
  }
  complete(req: ModelRequest): Promise<ModelResponse> {
    return this.inner.complete(req);
  }
  countTokens(text: string): number {
    return this.inner.countTokens(text);
  }
}

const ENDED = new Set(["completed", "stopped", "failed", "killed"]);

describe("Opus fast mode wired into the daemon (D.20)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let provider: FastAnthropicStub;
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const post = (path: string, body: unknown) =>
    req(path, { method: "POST", body: JSON.stringify(body) });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-fast-mode-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    writeFileSync(
      join(dirs.config, "pricing.json"),
      JSON.stringify({ "claude-opus-5-5-fast": CORRECTED }),
    );
    provider = new FastAnthropicStub(
      new ScriptedProvider([{ text: "Done. Nothing to report.", usage: USAGE }], clock),
    );
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
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

  it("the change card and the Settings row quote the corrected fast row from the table in force", async () => {
    const card = await json(await post("/projects", { name: "Quote", goal: "Quote the price" }));
    const project = str(card.id);
    expect(rt.pricingTable()["claude-opus-5-5-fast"]).toMatchObject(CORRECTED);
    const settings = (await (await req("/settings")).json()) as Json[];
    const row = settings.find((s) => s.key === "project.fast_mode" && s.scopeId === project);
    expect(str(row?.description)).toContain("USD 30 / 150");
    const ctx = await rt.commands.contextFor({
      humanId: rt.human.id,
      agentId: rt.agent.id,
      activeProjectId: project,
      sessionId: "settings-screen",
      source: "ui",
      wordsUsed: "Settings: project.fast_mode to true",
    });
    const planned = await rt.commands.executor.plan(
      { name: "settings.set", params: { key: "fast_mode", value: true, project } },
      ctx,
    );
    expect(planned.newValue).toContain("USD 30 / 150");
    expect(planned.newValue).toContain("7.5x");
  });

  it("a fast-mode project's coder run and tier-3 review on Opus go fast and are priced from the corrected row", async () => {
    const card = await json(await post("/projects", { name: "Urgent", goal: "Fix the outage" }));
    const project = str(card.id);
    const row = await rt.store.project.mustGet(project);
    await rt.store.project.update(project, row.version, {
      settings: { ...row.settings, fast_mode: true },
    });
    const task = await json(
      await post(`/projects/${project}/tasks`, {
        title: "Hotfix",
        outcome: "the outage is fixed",
        acceptanceCriteria: ["the note is written"],
        riskTier: 3,
      }),
    );
    const before = provider.calls.length;
    const started = await post("/sessions", {
      agentId: rt.agent.id,
      projectId: project,
      budgetUsdMicro: 20_000_000,
    });
    expect(started.status).toBe(202);
    for (let i = 0; i < 500; i++) {
      const rows = (await rt.store.session.list({ project_id: project } as never)).filter(
        (s) => s.summary !== "conversation",
      );
      if (rows.length > 0 && rows.every((s) => ENDED.has(s.status))) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const runs = await rt.store.run.forTask(str(task.id));
    const coder = runs.filter((r) => r.specialist === "coder");
    const critic = runs.filter((r) => r.specialist === "critic");
    expect(coder.length).toBeGreaterThanOrEqual(1);
    expect(critic.length).toBeGreaterThanOrEqual(1);
    const perCall = costOf(
      { tokens_in: USAGE.input_tokens, tokens_out: USAGE.output_tokens },
      "x",
      {
        x: {
          ...CORRECTED,
          cache_read_per_mtok_usd: 0,
          cache_write_per_mtok_usd: 0,
          as_of: "2026-10-23",
          source: "override",
        },
      },
    );
    for (const run of [...coder, ...critic]) {
      expect(run.model).toBe("claude-opus-5-5-fast");
      expect(run.tokens_in % USAGE.input_tokens).toBe(0);
      const calls = run.tokens_in / USAGE.input_tokens;
      expect(run.cost_usd_micro).toBe(calls * perCall);
    }
    const opusCalls = provider.calls.slice(before).filter((c) => c.model === "claude-opus-5-5");
    expect(opusCalls.length).toBeGreaterThanOrEqual(2);
    for (const c of opusCalls) expect(c.speed).toBe("fast");
    const audit = await rt.store.auditLog.list({ tool: FAST_MODE_AUDIT_TOOL } as never, {
      limit: 20,
    });
    const applied = audit.filter((a) => a.result_summary.startsWith("applied:"));
    const specialists = applied.map((a) => JSON.parse(a.input_summary).specialist ?? "coder");
    expect(specialists).toEqual(expect.arrayContaining(["coder", "critic"]));
    // Both decisions read the source the run is billed to: the empty vault's `fake` row.
    for (const a of applied) expect(JSON.parse(a.input_summary).kind).toBe("fake");
  }, 60_000);
});
