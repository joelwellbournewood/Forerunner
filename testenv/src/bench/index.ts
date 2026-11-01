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
