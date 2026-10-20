import { errorMessage, log, osFacts } from "@forerunner/platform";
import { readRunnerConfig } from "./config.ts";
import { type CloudRunner, RELOCK_EXIT_CODE, startCloudRunner } from "./runner.ts";

/**
 * `pnpm runner` (the image's CMD): read the environment, start the runner, stop cleanly on
 * SIGINT / SIGTERM. Exit codes: 0 after a signal, 1 on a start failure (the reason is logged,
 * never a credential), 75 (`RELOCK_EXIT_CODE`) when the vault key was forgotten at the end of
 * the auto-unlock window and the runner is idle: the supervisor restarts the container and the
 * fresh process asks the human for the key again.
 */
const logger = log("cloud-runner:main");

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  logger.info("forerunner runner starting", { ...osFacts(env) });
  let runner: CloudRunner | null = null;
  let exitCode: number | null = null;
  const finish = (code: number) =>
    new Promise<number>((resolve) => {
      if (exitCode !== null) return resolve(exitCode);
      exitCode = code;
      const done = runner ? runner.stop() : Promise.resolve();
      done
        .catch((e: unknown) => logger.warn("stop failed", { error: errorMessage(e) }))
        .then(() => resolve(code));
    });
  const ended = new Promise<number>((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => {
      logger.info("signal received; stopping", { signal });
      void finish(0).then(resolve);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    void (async () => {
      try {
        const config = readRunnerConfig(env);
        runner = await startCloudRunner({
          config,
          env,
          onRestart: (reason) => {
            logger.warn("restarting to forget the vault key", { reason });
            void finish(RELOCK_EXIT_CODE).then(resolve);
          },
        });
      } catch (e) {
        logger.error("runner failed to start", { error: errorMessage(e) });
        resolve(await finish(1));
      }
    })();
  });
  return ended;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() ?? "");
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      logger.error("runner crashed", { error: errorMessage(e) });
      process.exit(1);
    },
  );
}
