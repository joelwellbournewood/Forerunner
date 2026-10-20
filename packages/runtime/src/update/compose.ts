import { type AppDirs, appDirs, type Clock, join, systemClock } from "@forerunner/platform";
import { MIGRATIONS, openStore, type StateStore } from "@forerunner/state";
import { readConfig } from "../setup/wizard.ts";
import { readUpdateConfig, type UpdateConfig } from "./config.ts";
import { feedFromConfig } from "./feed.ts";
import { DefaultHealthProbe, type HealthProbe } from "./health.ts";
import { UpdateManager } from "./install.ts";
import { HumanRequestUpdatePort, RecordingRestarter, type Restarter } from "./ports.ts";
import { ReleaseVerifier } from "./verify.ts";

/**
 * Build an UpdateManager from this install's configuration (used by the CLI and by the daemon
 * composition). Everything that needs a shell (restart) or a UI is injectable. The daemon
 * passes its own open store (`store`), so one process holds one connection; the CLI leaves it
 * out and a store is opened and closed here.
 */
export interface ComposeUpdateOptions {
  dirs?: AppDirs;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  runningVersion?: string;
  restarter?: Restarter;
  probe?: HealthProbe;
  fetchImpl?: typeof fetch;
  config?: UpdateConfig;
  stateUrl?: string;
  humanId?: string | null;
  /** An already open store (the daemon's). When given it is neither opened nor closed here. */
  store?: StateStore;
}

export interface ComposedUpdate {
  manager: UpdateManager;
  config: UpdateConfig;
  dirs: AppDirs;
  close(): Promise<void>;
}

export async function composeUpdateManager(
  opts: ComposeUpdateOptions = {},
): Promise<ComposedUpdate> {
  const env = opts.env ?? process.env;
  const dirs = opts.dirs ?? appDirs({ env });
  const clock = opts.clock ?? systemClock;
  const setup = readConfig(dirs);
  const config = opts.config ?? readUpdateConfig(dirs, env);
  const stateUrl =
    opts.stateUrl ??
    env.FORERUNNER_STATE_URL ??
    setup?.stateUrl ??
    `sqlite:${join(dirs.data, "state.sqlite")}`;
  const owned = opts.store === undefined;
  const store = opts.store ?? (await openStore({ url: stateUrl, clock }));
  const manager = new UpdateManager({
    dirs,
    clock,
    feed: feedFromConfig(config.feed, { fetchImpl: opts.fetchImpl }),
    verifier: new ReleaseVerifier(config.trustedKeys),
    store: { release: store.release, auditLog: store.auditLog },
    human: new HumanRequestUpdatePort(store.humanRequest, opts.humanId ?? null),
    restarter: opts.restarter ?? new RecordingRestarter(),
    probe: opts.probe ?? new DefaultHealthProbe({ dirs, fetchImpl: opts.fetchImpl }),
    config,
    runningVersion: opts.runningVersion ?? env.FORERUNNER_APP_VERSION ?? "0.0.0",
    localSchemaVersion: store.migration?.version ?? MIGRATIONS.length,
    fetchImpl: opts.fetchImpl,
    humanId: opts.humanId ?? null,
  });
  return {
    manager,
    config,
    dirs,
    close: async () => {
      if (owned) await store.close();
    },
  };
}
