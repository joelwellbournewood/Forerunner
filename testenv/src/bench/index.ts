import type { ModelProvider } from "../provider/types.ts";
import { ModelCallLog, modelCallLogPath, withModelCallLog } from "./call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "./role-player.ts";

/**
 * What `fr daemon --provider bench | bench-live` loads (packages/runtime/src/cli/main.ts, a
 * dynamic import that exists only in a repository checkout). See scripts/bench/README.md.
 */
export * from "./call-log.ts";
export * from "./plans.ts";
export * from "./role-player.ts";
export * from "./roles.ts";

/** The role-playing stand-in model, configured from the environment, logging every call. */
export function benchProvider(opts: { env: NodeJS.ProcessEnv }): ModelProvider {
  const log = new ModelCallLog({ file: modelCallLogPath(opts.env) });
  console.log(`[bench] stand-in model; model-call log: ${log.file}`);
  return createRolePlayer(benchOptionsFromEnv(opts.env, log));
}

/** A real provider with every call written to the same log; `secrets` never reach the file. */
export function benchLiveProvider(
  inner: ModelProvider,
  opts: { env: NodeJS.ProcessEnv; secrets: readonly string[] },
): ModelProvider {
  const log = new ModelCallLog({ file: modelCallLogPath(opts.env), secrets: opts.secrets });
  console.log(`[bench] live provider ${inner.name}; model-call log: ${log.file}`);
  return withModelCallLog(inner, log);
}
