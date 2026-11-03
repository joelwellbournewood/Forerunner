import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "@forerunner/platform";
import { keyRuleFromEnv, messagesApiStandIn, standInFetch } from "../provider/messages-api.ts";
import type { ModelProvider } from "../provider/types.ts";
import { ModelCallLog, modelCallLogPath, type PriceOf, withModelCallLog } from "./call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "./role-player.ts";

/**
 * What `fr daemon --provider bench | bench-live` loads (packages/runtime/src/cli/main.ts, a
 * dynamic import that exists only in a repository checkout). See scripts/bench/README.md.
 */
export * from "./call-log.ts";
export * from "./plans.ts";
export * from "./role-player.ts";
export * from "./roles.ts";

/**
 * The role-playing stand-in model, configured from the environment, logging every call; with
 * `priceOf` each line carries `usd` (null on the stand-in's `fake-*` rungs, which have no price).
 */
export function benchProvider(opts: { env: NodeJS.ProcessEnv; priceOf?: PriceOf }): ModelProvider {
  const log = new ModelCallLog({
    file: modelCallLogPath(opts.env),
    ...(opts.priceOf ? { priceOf: opts.priceOf } : {}),
  });
  console.log(`[bench] stand-in model; model-call log: ${log.file}`);
  return createRolePlayer(benchOptionsFromEnv(opts.env, log));
}

/** The stand-in Messages API's request log: `<model-call log's folder>/api-requests.jsonl`. */
export function apiRequestLogPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(modelCallLogPath(env)), "api-requests.jsonl");
}

/**
 * `fr daemon --provider bench-api` (U-078): the app keeps its own routed provider over the
 * vault's credentials, and the Anthropic API it calls is the Messages API stand-in
 * (`testenv/src/provider/messages-api.ts`) with the role-playing model behind it. The returned
 * `fetch` sends the API's requests (api.anthropic.com, or `FORERUNNER_ANTHROPIC_API`) to the
 * stand-in and everything else to the network. Keys are answered by `FORERUNNER_BENCH_API_*`
 * (`keyRuleFromEnv`: a key holding "refused" gets 401, one holding "limited" a usage limit with
 * its reset time); every request is logged in `api-requests.jsonl` with the key's id, never its
 * text, and every model call in the model-call log as with `--provider bench`.
 */
export function benchApiFetch(opts: { env: NodeJS.ProcessEnv; priceOf?: PriceOf }): typeof fetch {
  const model = benchProvider(opts);
  const file = apiRequestLogPath(opts.env);
  mkdirSync(dirname(file), { recursive: true });
  const standIn = messagesApiStandIn({
    model,
    answerFor: keyRuleFromEnv(opts.env),
    onRequest: (entry) => appendFileSync(file, `${JSON.stringify(entry)}\n`),
  });
  console.log(`[bench] Messages API stand-in; request log: ${file}`);
  const base = opts.env.FORERUNNER_ANTHROPIC_API?.trim();
  return standInFetch(standIn, base ? { base } : {});
}

/**
 * A real provider with every call written to the same log; `secrets` never reach the file,
 * whole or in part; with `priceOf` each line carries what it cost (`usd`, `price`).
 */
export function benchLiveProvider(
  inner: ModelProvider,
  opts: { env: NodeJS.ProcessEnv; secrets: readonly string[]; priceOf?: PriceOf },
): ModelProvider {
  const log = new ModelCallLog({
    file: modelCallLogPath(opts.env),
    secrets: opts.secrets,
    ...(opts.priceOf ? { priceOf: opts.priceOf } : {}),
  });
  console.log(`[bench] live provider ${inner.name}; model-call log: ${log.file}`);
  return withModelCallLog(inner, log);
}
