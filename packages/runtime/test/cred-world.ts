import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, type SimulatedClock } from "@forerunner/platform";
import {
  type KeyAnswer,
  keyIdOf,
  messagesApiStandIn,
  type StandInRequest,
  standInFetch,
} from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { AcceptingCriticProvider, ScriptedProvider } from "./helpers.ts";

/**
 * d1109-cred-engine (ADR 0120): the daemon composed as `fr daemon` composes it, with no injected
 * provider, so every call goes through the person's credential policy: the routed provider for
 * chat, planning and the critic's reviews, and `RouterTaskBilling` for task runs. The API key is
 * the Messages API stand-in (testenv), whose request log names each key by its id; the
 * subscription is a scripted Claude Code (`sdkQuery`), whose calls are kept here. Each test
 * stops the subscription or the key when it says so (a usage limit, a refusal).
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
export const WORLD_OAUTH = ["sk-ant-oat01-", "credworld", "5".repeat(40)].join(""); // not-a-secret
export const WORLD_KEY = ["sk-ant-api03-", "credworld", "6".repeat(40)].join(""); // not-a-secret

/** One Claude Code call as the scripted binary saw it. */
export interface SdkCall {
  prompt: string;
  /** A provider call (chat, planning, a review): one turn, no Claude Code tool. */
  provider: boolean;
  /** A review's call (the critic's system prompt asks for `submit_review`). */
  review: boolean;
  system: string;
}

export type SdkMessage = Record<string, unknown>;
const ev = (event: Record<string, unknown>): SdkMessage => ({ type: "stream_event", event });

/** A provider call's reply as Claude Code streams it (`includePartialMessages`). */
export async function* providerReply(call: SdkCall): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: "cc-world" };
  yield ev({
    type: "message_start",
    message: { model: "claude-sonnet-5-5", usage: { input_tokens: 200, output_tokens: 0 } },
  });
  const answered = call.prompt.includes("[tool result");
  if (call.review && !answered) {
    const input = {
      grade: 90,
      confidence: "high",
      verdict: "accept",
      summary: "The work matches the brief.",
      findings: [],
      criteria: [],
      checks_run: [],
    };
    yield ev({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "tu_cc_review",
        name: "mcp__forerunner__submit_review",
      },
    });
    yield ev({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });
    yield ev({ type: "content_block_stop", index: 0 });
    yield ev({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 20 },
    });
    yield ev({ type: "message_stop" });
    yield { type: "result", subtype: "success", is_error: false, result: "" };
    return;
  }
  const text = call.review ? "Recorded." : "From Claude Code.";
  yield ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  yield ev({ type: "content_block_stop", index: 0 });
  yield ev({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 7 },
  });
  yield ev({ type: "message_stop" });
  yield { type: "result", subtype: "success", is_error: false, result: text };
}

/** The report of a task run on the subscription, unless a test gives its own. */
export const SUBSCRIPTION_REPORT = "Done on the subscription. Lesson: none.";

/** A task run on the subscription (the SDK driver). */
async function* runReply(n: number, text = SUBSCRIPTION_REPORT): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: `sdk-world-${n}` };
  yield {
    type: "assistant",
    message: {
      id: `m${n}`,
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  };
  yield { type: "result", subtype: "success", is_error: false, result: text };
}

/**
 * Claude Code's own error message, as Agent SDK 0.3.304 streams it (l4-cred-engine L4-creds-2,
 * read on LC-C22 with the real SDK against a local 401): an assistant message with `error` set,
 * model '<synthetic>' and zero usage. It is no model call.
 */
export const syntheticError = (error: string, text: string): SdkMessage => ({
  type: "assistant",
  error,
  message: {
    id: `synthetic-${error}`,
    model: "<synthetic>",
    content: [{ type: "text", text }],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  },
});
/** What Agent SDK 0.3.304 throws after Claude Code's error result. */
export const sdkThrow = (text: string) =>
  new Error(`Claude Code returned an error result: ${text}`);

/** The text Claude Code says when Anthropic refuses the sign-in (live check 4, LC-C22). */
export const REFUSED_SIGN_IN_TEXT =
  "Failed to authenticate. API Error: 401 OAuth access token is invalid.";

/**
 * Claude Code when the subscription's limit is reached, in Agent SDK 0.3.304's shape: the
 * rejected rate-limit event, the synthetic error message, the error result, then the throw.
 */
async function* limitReply(resetMs: number): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: "cc-limit" };
  yield {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "rejected",
      resetsAt: Math.ceil(resetMs / 1000),
      rateLimitType: "five_hour",
    },
  };
  yield syntheticError("rate_limit", "You've hit your limit");
  yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" };
  throw sdkThrow("You've hit your limit");
}

/** Claude Code when the sign-in was refused, in Agent SDK 0.3.304's shape (then the throw). */
async function* refusedReply(): AsyncIterable<SdkMessage> {
  yield { type: "system", subtype: "init", session_id: "cc-refused" };
  yield syntheticError("authentication_failed", REFUSED_SIGN_IN_TEXT);
  yield {
    type: "result",
    subtype: "success",
    is_error: true,
    result: REFUSED_SIGN_IN_TEXT,
    total_cost_usd: 0,
    modelUsage: { "<synthetic>": { inputTokens: 0, outputTokens: 0 } },
  };
  throw sdkThrow(REFUSED_SIGN_IN_TEXT);
}

export interface CredWorld {
  home: string;
  clock: SimulatedClock;
  vault: MemoryVault;
  /** Every Claude Code call, oldest first. */
  sdkCalls: SdkCall[];
  /** The Messages API stand-in's log (never a key's characters, only its id). */
  keyRequests(): readonly StandInRequest[];
  /** The model calls that reached the API key (POST /v1/messages). */
  keyCalls(): readonly StandInRequest[];
  /** The key's 401s, per key id. */
  key401s(key?: string): readonly StandInRequest[];
  /** The scripted model behind the API key (its calls, review calls left out by `work`). */
  keyModel: ScriptedProvider;
  /** The subscription is at its limit until `ms` (epoch), or serves again (null). */
  limitSubscription(untilMs: number | null): void;
  /** The subscription serves `calls` more Claude Code calls, then is at its limit until `ms`. */
  limitSubscriptionAfter(calls: number, untilMs: number): void;
  /** The report the subscription's task runs give (a "For the task list:" line, CE-3). */
  setRunReport(text: string): void;
  /** Anthropic refuses the sign-in from now on. */
  refuseSubscription(on?: boolean): void;
  /**
   * A task run on the subscription plays this script instead (null: the default report); it
   * gets the `query()` options (the task's folder in `cwd`, the environment in `env`).
   */
  setRunScript(
    script: ((options: Record<string, unknown>, n: number) => AsyncIterable<SdkMessage>) | null,
  ): void;
  /**
   * A provider call on the subscription (chat, planning, a review) plays this script instead
   * (null: `providerReply`); it gets the call and the `query()` options (its `abortController`).
   */
  setProviderScript(
    script: ((call: SdkCall, options: Record<string, unknown>) => AsyncIterable<SdkMessage>) | null,
  ): void;
  /** The `query()` options of every Claude Code call, oldest first (for its environment). */
  sdkOptions: Record<string, unknown>[];
  /** The key is at its limit until `ms`, refused, answered with the API's 500, or served. */
  setKey(answer: "ok" | "refused" | "error" | { limitUntilMs: number }): void;
  compose(): Promise<{ rt: RuntimeApp; req: Req }>;
}

export type Req = <T>(
  path: string,
  body?: unknown,
  method?: string,
) => Promise<{ status: number; body: T }>;

export function credWorld(opts: {
  clock: SimulatedClock;
  subscription?: boolean;
  key?: boolean;
  timezone?: string;
  prefix?: string;
}): CredWorld {
  const { clock } = opts;
  const home = mkdtempSync(join(tmpdir(), opts.prefix ?? "fr-cred-world-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const vault = new MemoryVault({
    ...(opts.subscription !== false ? { [SECRET_NAMES.anthropicOauth]: WORLD_OAUTH } : {}),
    ...(opts.key !== false ? { [SECRET_NAMES.anthropic]: WORLD_KEY } : {}),
  });
  const sdkCalls: SdkCall[] = [];
  let subLimitUntil: number | null = null;
  let subRefused = false;
  let keyAnswer: "ok" | "refused" | "error" | { limitUntilMs: number } = "ok";
  let runs = 0;
  let limitAfter: { at: number; untilMs: number } | null = null;
  let runReport = SUBSCRIPTION_REPORT;
  let providerScript:
    | ((call: SdkCall, options: Record<string, unknown>) => AsyncIterable<SdkMessage>)
    | null = null;
  let runScript:
    | ((options: Record<string, unknown>, n: number) => AsyncIterable<SdkMessage>)
    | null = null;
  const sdkOptions: Record<string, unknown>[] = [];
  const sdkQuery: QueryLike = ({ prompt, options }) => {
    sdkOptions.push(options ?? {});
    const o = (options ?? {}) as {
      maxTurns?: number;
      tools?: unknown[];
      systemPrompt?: { prompt?: string } | string;
    };
    const system =
      typeof o.systemPrompt === "string" ? o.systemPrompt : (o.systemPrompt?.prompt ?? "");
    const provider = o.maxTurns === 1 && Array.isArray(o.tools) && o.tools.length === 0;
    const call: SdkCall = {
      prompt: String(prompt),
      provider,
      review: provider && system.includes("submit_review"),
      system,
    };
    sdkCalls.push(call);
    if (limitAfter && sdkCalls.length > limitAfter.at) {
      subLimitUntil = limitAfter.untilMs;
      limitAfter = null;
    }
    if (subRefused) return refusedReply();
    if (subLimitUntil !== null && clock.now() < subLimitUntil) return limitReply(subLimitUntil);
    if (provider) return providerScript ? providerScript(call, options ?? {}) : providerReply(call);
    runs++;
    return runScript ? runScript(options ?? {}, runs) : runReply(runs, runReport);
  };
  const keyModel = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
  const answerFor = (_key: string, nowMs: number): KeyAnswer => {
    if (keyAnswer === "ok") return { kind: "ok" };
    if (keyAnswer === "refused") return { kind: "refused" };
    if (keyAnswer === "error") return { kind: "error" };
    if (nowMs >= keyAnswer.limitUntilMs) return { kind: "ok" };
    return {
      kind: "limit",
      form: "429",
      resetAt: new Date(Math.ceil(keyAnswer.limitUntilMs / 60_000) * 60_000).toISOString(),
    };
  };
  const standIn = messagesApiStandIn({
    model: new AcceptingCriticProvider(keyModel),
    clock,
    answerFor,
  });
  const fetchImpl = standInFetch(standIn, {
    fallback: async () => new Response("not here", { status: 404 }),
  });
  const compose = async () => {
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: `sqlite:${join(dirs.data, "state.sqlite")}`,
      vault,
      fetchImpl,
      sdkQuery,
      registryDir: REGISTRY,
      identity: {
        humanName: "J",
        timezone: opts.timezone ?? "Europe/Zurich",
        agentName: "Alice",
      },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
    });
    const { app, token } = createDaemonApp(rt);
    const req: Req = async <T>(path: string, body?: unknown, method?: string) => {
      const res = await app.request(path, {
        method: method ?? (body === undefined ? "GET" : "POST"),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // a plain answer
      }
      return { status: res.status, body: parsed as T };
    };
    return { rt, req };
  };
  return {
    home,
    clock,
    vault,
    sdkCalls,
    keyRequests: () => standIn.requests,
    keyCalls: () =>
      standIn.requests.filter((r) => r.method === "POST" && r.path === "/v1/messages"),
    key401s: (key = WORLD_KEY) =>
      standIn.requests.filter((r) => r.status === 401 && r.keyId === keyIdOf(key)),
    keyModel,
    limitSubscription: (untilMs) => {
      subLimitUntil = untilMs;
    },
    limitSubscriptionAfter: (calls, untilMs) => {
      limitAfter = { at: sdkCalls.length + calls, untilMs };
    },
    setRunReport: (text) => {
      runReport = text;
    },
    refuseSubscription: (on = true) => {
      subRefused = on;
    },
    setRunScript: (script) => {
      runScript = script;
    },
    setProviderScript: (script) => {
      providerScript = script;
    },
    sdkOptions,
    setKey: (answer) => {
      keyAnswer = answer;
    },
    compose,
  };
}

/** A project with ready tasks, as a person's plan leaves it. */
export async function seedProject(
  rt: RuntimeApp,
  name: string,
  titles: readonly string[],
  extra: { specialist?: string } = {},
) {
  const project = await rt.store.project.insert({ name, goal: `${name} goal`, autonomy_level: 2 });
  const tasks = [];
  for (const [i, title] of titles.entries())
    tasks.push(
      await rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} is done`,
        acceptance_criteria: ["it is done"],
        risk_tier: 0,
        status: "ready",
        priority: 5 - i,
        est_cost_usd_micro: 100_000,
        reason: "seed",
        ...(extra.specialist ? { specialist: extra.specialist } : {}),
      }),
    );
  return { project, tasks };
}

/** The person presses Start on the project (a person's session). */
export function startSession(rt: RuntimeApp, projectId: string) {
  return rt.runner.start({
    agentId: rt.agent.id,
    projectId,
    trigger: "manual",
    by: "person",
    budgetCapUsdMicro: 5_000_000,
    grant: {
      allowedTools: [...rt.toolsForRun().names(), ...claudeCodeToolNames()],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
    },
  });
}

/** The person's credential policy, as Settings stores it after their yes. */
export async function setPolicy(rt: RuntimeApp, policy: string) {
  const human = await rt.store.human.get(rt.human.id);
  await rt.store.human.patch(rt.human.id, {
    notify_prefs: { ...(human?.notify_prefs ?? {}), credential_policy: policy } as never,
  });
}

/** Waits (polls, at most `ms` of real time) until `check` holds; says what it saw otherwise. */
export async function until(what: string, check: () => Promise<string | null>, ms = 20_000) {
  const end = Date.now() + ms;
  let seen = "";
  while (Date.now() < end) {
    const r = await check();
    if (r === null) return;
    seen = r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`${what} did not happen within ${ms / 1000} s; last seen: ${seen}`);
}
