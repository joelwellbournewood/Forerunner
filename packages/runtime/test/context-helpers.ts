import type { Clock } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import { z } from "zod";
import type { ToolSpec } from "../src/agent/tools.ts";
import type { HeadroomPort, HeadroomProbe, HeadroomStatus } from "../src/context/headroom.ts";
import type { ModelProvider } from "../src/provider/types.ts";
import { ScriptedProvider, type ScriptReply } from "./helpers.ts";

/** In-memory Headroom port: status and per-project counters set by the test. */
export class FakeHeadroom implements HeadroomPort {
  readonly url = "http://127.0.0.1:8787";
  probes = 0;
  statsCalls = 0;
  constructor(
    public status: HeadroomStatus = "healthy",
    public saved: Record<string, number> = {},
  ) {}
  async probe(): Promise<HeadroomProbe> {
    this.probes++;
    return {
      status: this.status,
      available: this.status === "healthy",
      url: this.url,
      ...(this.status === "healthy" ? {} : { detail: "fake" }),
    };
  }
  async tokensSaved(projectId: string): Promise<number | null> {
    this.statsCalls++;
    if (this.status !== "healthy") return null;
    return this.saved[projectId] ?? 0;
  }
}

/** A scripted provider that can be routed through a proxy, like the Anthropic adapter. */
export class ProxyableScriptedProvider extends ScriptedProvider {
  proxied: { baseURL: string; headers: Record<string, string> } | null = null;
  readonly children: ProxyableScriptedProvider[] = [];
  constructor(
    private readonly script: ScriptReply[],
    private readonly clk: Clock,
  ) {
    super(script, clk);
  }
  viaProxy(baseURL: string, headers: Record<string, string>): ModelProvider {
    const child = new ProxyableScriptedProvider(this.script, this.clk);
    child.proxied = { baseURL, headers };
    this.children.push(child);
    return child;
  }
}

/** A tool result that every baseline transform bites on, under the loop's 60k hard cap. */
export const NOISY_OUTPUT = [
  ...Array.from({ length: 60 }, () => "same line of build output"),
  "Z".repeat(3000),
  ...Array.from({ length: 700 }, (_, i) => `row ${i} ${"y".repeat(30)}`),
  "FATAL: database connection refused",
  ...Array.from({ length: 300 }, (_, i) => `tail ${i} ${"t".repeat(30)}`),
].join("\n");

export const noisyTool: ToolSpec<{ what?: string }> = {
  name: "noisy",
  description: "returns a large noisy output",
  schema: z.object({ what: z.string().optional() }),
  actionClass: "read",
  risk: "low",
  async execute() {
    return { content: NOISY_OUTPUT };
  },
};

export interface SeededWorld {
  human: string;
  agent: string;
  project: string;
  /** Empty when the world was seeded without a running session (the runner starts its own). */
  session: string;
}

/** A human, an agent, a project (with the given settings) and, by default, a running session. */
export async function seedWorld(
  store: StateStore,
  settings: Record<string, unknown> = {},
  opts: { session?: boolean } = {},
): Promise<SeededWorld> {
  const human = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 150_000_000,
      locale: "en",
    })
  ).id;
  const agent = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
    await store.project.insert({
      name: "P",
      goal: "g",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: settings as never,
      small_project_mode: false,
      active: true,
    })
  ).id;
  if (opts.session === false) return { human, agent, project, session: "" };
  const session = (
    await store.session.insert({
      agent_id: agent,
      project_id: project,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 5_000_000,
      step_cap: 100,
      spent_usd_micro: 0,
      steps: 0,
      status: "running",
      summary: "",
      handoff: {},
      runner: "pc",
    })
  ).id;
  return { human, agent, project, session };
}
