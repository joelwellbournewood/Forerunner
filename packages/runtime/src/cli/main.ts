#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { registerMirrorCli } from "@forerunner/capabilities";
import { appDirs, errorMessage, log, osFacts, run, which } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { openVault } from "@forerunner/vault";
import { Command } from "commander";
import type { RuntimeApp } from "../daemon/compose.ts";
import {
  describeIdentityCheck,
  installIdentitySelectors,
  lookupInstallHuman,
} from "../daemon/identity.ts";
import type { RunningDaemon } from "../daemon/server.ts";
import { writeKillRequest } from "../enforcement/killfile.ts";
import { registerJobsCli } from "../jobs/cli.ts";
import { registerModelWatchCli } from "../models/watch-cli.ts";
import { describePlanAllowance } from "../setup/plan-allowance.ts";
import {
  ensureDirs,
  readConfig,
  runSetup,
  type SetupConfig,
  type SetupReport,
} from "../setup/wizard.ts";
import { registerSourcesCli } from "../sources/cli.ts";
import { registerUpdateCli } from "../update/cli.ts";
import { composeUpdateManager } from "../update/compose.ts";
import { registerAuditCli } from "./audit.ts";

/**
 * `fr`: the Forerunner command line. Used by the setup wizard, the fresh-install scripts, the
 * tray and the tests. Every subcommand works on Windows and Linux. `buildProgram()` is what
 * the tests inspect; the module runs it only when it is the entry point.
 */
export const APP_VERSION = "0.1.0";

/**
 * Upper bound on the graceful stop before `fr daemon` ends the process on a restart request
 * or a signal: the server's bounded stop (open SSE streams are ended, then the connections
 * closed) plus closing the store. The process always exits with the requested code.
 */
export const EXIT_DEADLINE_MS = 8_000;

/** Settle `work` or give up after `ms`; never throws (the caller exits either way). */
function bounded(work: () => Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    work()
      .catch((e: unknown) => log("fr").warn(`shutdown step failed: ${errorMessage(e)}`))
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

export interface CliDeps {
  env?: NodeJS.ProcessEnv;
  /** Composes the runtime for the commands that need the whole product (models, mirror, daemon). */
  compose?: (opts: Record<string, unknown>) => Promise<RuntimeApp>;
  out?: (line: string) => void;
  /** Where relative output paths land; the process's working directory by default. */
  cwd?: () => string;
}

export function buildProgram(deps: CliDeps = {}): Command {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((line: string) => console.log(line));
  const appVersion = env.FORERUNNER_VERSION ?? APP_VERSION;
  const program = new Command();
  program.name("fr").description("Forerunner command line").version(appVersion);

  // One composed runtime per invocation for the commands that need it, closed after the action.
  let runtime: RuntimeApp | null = null;
  const openRuntime = async (opts: Record<string, unknown> = {}): Promise<RuntimeApp> => {
    if (runtime) return runtime;
    const compose =
      deps.compose ??
      (async (o: Record<string, unknown>) =>
        (await import("../daemon/compose.ts")).composeRuntime(o));
    runtime = await compose({ env, appVersion, ...opts });
    return runtime;
  };
  const closeRuntime = async (): Promise<void> => {
    const rt = runtime;
    runtime = null;
    if (rt) await rt.close();
  };
  program.hook("postAction", async () => {
    await closeRuntime();
  });

  program
    .command("setup")
    .description("Guided setup: app directories, credentials (validated on paste), vault, config")
    .option("--non-interactive", "take values from flags or FORERUNNER_* env; never prompt", false)
    .option("--profile <name>", "install profile (lets two installs share one machine)")
    .option("--human-name <name>", "your name")
    .option(
      "--email <address>",
      "your email: on a shared store the human this install binds to (created at first start when nobody has it)",
    )
    .option(
      "--human-id <id>",
      "bind this install to an existing human of the shared store by id (FORERUNNER_HUMAN overrides for one start)",
    )
    .option("--timezone <tz>", "IANA time zone")
    .option("--github-token <token>", "GitHub fine-grained token (or FORERUNNER_GITHUB_TOKEN)")
    .option(
      "--anthropic-key <key>",
      "Anthropic API key or subscription token (or FORERUNNER_ANTHROPIC_KEY)",
    )
    .option(
      "--subscription-token <token>",
      "Claude subscription token from `claude setup-token` (or FORERUNNER_SUBSCRIPTION_TOKEN); format-checked, stored in the vault",
    )
    .option(
      "--plan-usd-monthly <usd>",
      "the subscription's plan allowance: API-equivalent usage per month in USD (or FORERUNNER_PLAN_USD_MONTHLY); the plan share cap stops subscription work at 95% of it",
    )
    .option("--repos <list>", "comma separated owner/name repositories to verify access to")
    .option("--github-api <url>", "GitHub API base (fake git host in tests)")
    .option("--anthropic-api <url>", "Anthropic API base")
    .option(
      "--anthropic-workspace <id>",
      "Anthropic workspace id for a user-scoped key (or FORERUNNER_ANTHROPIC_WORKSPACE_ID)",
    )
    .option("--state-url <url>", "sqlite:<path> or postgres://...")
    .action(async (opts) => {
      const profile: string = opts.profile ?? readConfig()?.profile ?? "default";
      const vault = await openVault({ profile });
      const io: { rl: Interface | null } = { rl: null };
      const prompt = opts.nonInteractive
        ? undefined
        : async (q: string) => {
            io.rl ??= createInterface({ input: process.stdin, output: process.stdout });
            return io.rl.question(q);
          };
      try {
        const report = await runSetup(vault, {
          nonInteractive: !!opts.nonInteractive,
          profile,
          humanName: opts.humanName,
          humanEmail: opts.email,
          humanId: opts.humanId,
          timezone: opts.timezone,
          githubToken: opts.githubToken,
          anthropicKey: opts.anthropicKey,
          subscriptionToken: opts.subscriptionToken,
          planUsdMonthly: opts.planUsdMonthly,
          repos: opts.repos
            ? String(opts.repos)
                .split(",")
                .map((s: string) => s.trim())
                .filter(Boolean)
            : undefined,
          githubApiBase: opts.githubApi,
          anthropicApiBase: opts.anthropicApi,
          anthropicWorkspaceId: opts.anthropicWorkspace,
          stateUrl: opts.stateUrl,
          prompt,
        });
        out(`Config: ${report.configPath}`);
        out(`Identity: ${describeConfiguredIdentity(report.config)}`);
        out(`Install record: ${report.installRecordPath} (${report.installRecord.installDir})`);
        out(`Vault backend: ${vault.backend}`);
        for (const [k, r] of Object.entries(report.results)) {
          out(`${k}: ${r.ok ? "ok" : "needs changes"} - ${r.summary}`);
          for (const p of r.problems) out(`  - ${p}`);
        }
        if (report.stored.length) out(`Stored in vault: ${report.stored.join(", ")}`);
        out(`Billing sources: ${billingSourcesLine(report.sources)}`);
        if (report.skipped.length)
          out(`Not configured yet: ${report.skipped.join(", ")} (run fr setup again any time)`);
        out(report.complete ? "Setup complete." : "Setup saved; credentials can be added later.");
      } finally {
        io.rl?.close();
      }
    });

  program
    .command("status")
    .description("Show directories, config and which credentials exist (names only)")
    .option("--profile <name>")
    .option("--json", "machine readable", false)
    .action(async (opts) => {
      const dirs = appDirs();
      const config = readConfig(dirs);
      const vault = await openVault({ profile: opts.profile ?? config?.profile ?? "default" });
      const names = await vault.list();
      const result = { dirs, config, vault: { backend: vault.backend, names }, os: osFacts() };
      if (opts.json) out(JSON.stringify(result, null, 2));
      else {
        out(
          `Platform: ${result.os.platform} ${result.os.release} (${result.os.arch}), keychain: ${result.os.keychain}`,
        );
        out(
          `Config: ${config ? `profile ${config.profile}, state ${config.stateUrl}` : "not set up (run fr setup)"}`,
        );
        out(`Vault: ${vault.backend}, ${names.length} secret(s): ${names.join(", ") || "none"}`);
        for (const [k, v] of Object.entries(dirs)) out(`  ${k}: ${v}`);
      }
    });

  program
    .command("doctor")
    .description("Check prerequisites on this machine")
    .option("--json", "machine readable", false)
    .action(async (opts) => {
      const checks: { name: string; ok: boolean; detail: string }[] = [];
      const [major] = process.versions.node.split(".").map(Number);
      checks.push({ name: "node", ok: (major ?? 0) >= 22, detail: process.versions.node });
      for (const bin of ["git", "pnpm"]) {
        const p = await which(bin);
        checks.push({ name: bin, ok: !!p, detail: p ?? "not found" });
      }
      const docker = await which("docker");
      const podman = await which("podman");
      let engine = "none";
      if (docker) {
        const r = await run([docker, "info", "--format", "{{.ServerVersion}}"], {
          allowFailure: true,
          timeoutMs: 15_000,
        });
        engine = r.code === 0 ? `docker ${r.stdout.trim()}` : "docker (daemon not reachable)";
      } else if (podman) engine = "podman";
      checks.push({
        name: "container engine",
        ok: engine.startsWith("docker ") || engine === "podman",
        detail: engine,
      });
      try {
        const v = await openVault();
        checks.push({ name: "vault", ok: true, detail: v.backend });
      } catch (e) {
        checks.push({ name: "vault", ok: false, detail: String(e) });
      }
      const config = readConfig();
      checks.push({
        name: "config",
        ok: !!config,
        detail: config ? "present" : "run fr setup",
      });
      // Which human the next daemon start binds to (ADR 0082), read from the configured
      // store without creating anything; a set-up install only.
      if (config) checks.push(await identityCheck(env, config));
      if (opts.json) out(JSON.stringify(checks, null, 2));
      else for (const c of checks) out(`${c.ok ? "ok " : "!! "} ${c.name.padEnd(18)} ${c.detail}`);
      process.exitCode = checks.filter((c) => !c.ok && ["node", "git", "pnpm"].includes(c.name))
        .length
        ? 1
        : 0;
    });

  program
    .command("kill")
    .description("Stop all sessions (kill switch); optionally one agent or one session")
    .option("--agent <id>")
    .option("--session <id>")
    .option("--reason <text>", "why", "manual stop from the command line")
    .action((opts) => {
      const scope =
        opts.agent || opts.session ? { agentId: opts.agent, sessionId: opts.session } : "all";
      const p = writeKillRequest({
        scope,
        reason: opts.reason,
        requestedAt: new Date().toISOString(),
        requestedBy: "fr kill",
      });
      out(`Kill request written: ${p}`);
    });

  program
    .command("daemon")
    .description("Run the local runtime daemon (the desktop shell starts this as a sidecar)")
    .option("--port <n>", "port on 127.0.0.1 (default: random free port)")
    .option("--provider <name>", "fake | anthropic (default: anthropic when a credential exists)")
    .action(async (opts) => {
      const { startDaemon } = await import("../daemon/server.ts");
      let daemon: RunningDaemon | null = null;
      let keep: RuntimeApp | null = null;
      // "Update and restart": end the streams and stop the server, close the store, then exit
      // with the restart code the shells react to (daemon/restart.ts). The stop is bounded by
      // EXIT_DEADLINE_MS so an attached UI (which holds /events open) can never keep the old
      // daemon alive. Never spawns anything.
      const exit = (code: number) => {
        void bounded(async () => {
          await daemon?.stop();
          await (keep ?? runtime)?.close();
        }, EXIT_DEADLINE_MS).then(() => process.exit(code));
      };
      const rt = await openRuntime({
        exit,
        ...(opts.provider === "fake"
          ? { provider: (await import("../daemon/fake-provider-shim.ts")).fakeProvider() }
          : {}),
      });
      daemon = await startDaemon(rt, { port: opts.port ? Number(opts.port) : undefined });
      out(`Forerunner daemon listening on ${daemon.url} (daemon.json in ${rt.dirs.runtime})`);
      // First start after an update: the health check verifies this build and rolls back on
      // failure (spec M.4). It does nothing unless current.json says one is pending.
      try {
        const health = await rt.updates.healthCheck();
        if (health.kind !== "not_pending") {
          out(`Update health check: ${health.kind}`);
          // After an update the schema sync gate is re-evaluated against the shared state
          // with the code that now runs (spec M: sync resumes once both sides match).
          const compat = await rt.schemaSync.refresh("update");
          if (!compat.compatible) out(`Sync paused: ${compat.message}`);
        }
      } catch (e) {
        log("fr").error(`update health check failed: ${errorMessage(e)}`);
      }
      // The daemon keeps running; the runtime is closed by the shutdown handlers, not the hook.
      keep = runtime;
      runtime = null;
      const shutdown = async () => {
        await bounded(async () => {
          await daemon?.stop();
          await keep?.close();
        }, EXIT_DEADLINE_MS);
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });

  program
    .command("dirs")
    .description("Print the application directories for this platform")
    .action(() => {
      for (const [k, v] of Object.entries(ensureDirs())) out(`${k}: ${v}`);
    });

  // Signed updates (spec M): check, apply, rollback, status, health, keygen, sign. The CLI
  // composes a manager of its own (no daemon needed); apply stages and asks for a restart.
  registerUpdateCli(program, {
    manager: () => composeUpdateManager({ env, runningVersion: appVersion }),
    out,
    err: (line) => console.error(line),
  });

  // Weekly model watch (spec D): run it now, read reports. A one-shot: the runtime is composed
  // without its background services (no connector is started, the scheduler never ticks).
  registerModelWatchCli(program, async () => ({
    watch: (await openRuntime({ startServices: false })).modelWatch,
    out,
  }));

  // Monthly jobs (ADR 0060): the critic calibration and the handover test by hand, their
  // reports. One-shots like the model watch; each closes the runtime it opened.
  registerJobsCli(program, {
    open: async () => {
      const rt = await openRuntime({ startServices: false });
      return { jobs: rt.jobs, store: rt.store };
    },
    out,
  });

  // One-way GitHub Projects mirror: sync, enable, disable (the runtime is closed by the hook).
  registerMirrorCli(program, {
    open: async () => {
      const rt = await openRuntime({ startServices: false });
      return { store: rt.store, mirror: rt.mirror };
    },
    out,
  });

  // Source discovery (spec A.4): connect, scan, accept and remove sources through the same
  // SourceDiscovery as the daemon's /sources routes; a one-shot.
  registerSourcesCli(program, {
    open: async () => {
      const rt = await openRuntime({ startServices: false });
      return { sources: rt.sources, human: rt.human };
    },
    out,
  });

  // Audit log export (spec S.9): a one-shot over the store through the daemon's export module.
  registerAuditCli(program, {
    open: () => openRuntime({ startServices: false }),
    out,
    cwd: deps.cwd ?? (() => process.cwd()),
  });

  return program;
}

/**
 * The setup summary's billing line: which sources the next start registers and, for the
 * subscription, the plan allowance in force and where it came from (ADR 0044).
 */
/** The `fr setup` summary's identity line: the selector `config.json` carries, or what first start does. */
export function describeConfiguredIdentity(config: SetupConfig): string {
  if (config.humanId) return `bound to human ${config.humanId}`;
  if (config.humanEmail)
    return `${config.humanEmail} (found in the store at first start, or created then)`;
  return "the store's only human (created at first start; on a shared store run fr setup --email or --human-id)";
}

/** `fr doctor`'s identity line: the store opened read-only for the lookup, closed again. */
async function identityCheck(
  env: NodeJS.ProcessEnv,
  config: SetupConfig,
): Promise<{ name: string; ok: boolean; detail: string }> {
  const name = "identity";
  const stateUrl = env.FORERUNNER_STATE_URL ?? config.stateUrl;
  try {
    const store = await openStore({ url: stateUrl });
    try {
      const lookup = await lookupInstallHuman(store, installIdentitySelectors({ env, config }));
      return { name, ...describeIdentityCheck(lookup) };
    } finally {
      await store.close().catch(() => undefined);
    }
  } catch (e) {
    const reason = errorMessage(e).replace(/\/\/[^@\s]*@/g, "//[REDACTED]@");
    return { name, ok: false, detail: `state store not reachable: ${reason}` };
  }
}

export function billingSourcesLine(sources: SetupReport["sources"]): string {
  const allowance = sources.planAllowance
    ? `; ${describePlanAllowance(sources.planAllowance)}`
    : "";
  const parts = [
    ...(sources.subscription
      ? [`subscription (anthropic_subscription_token, Agent SDK${allowance})`]
      : []),
    ...(sources.apiKey ? ["API key (anthropic_api_key)"] : []),
  ];
  return parts.length
    ? `${parts.join(", ")}${parts.length === 2 ? "; the router picks per task, subscription first" : ""}`
    : "none yet (sessions need an API key or a subscription token)";
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  buildProgram()
    .parseAsync(process.argv)
    .catch((e) => {
      log("fr").error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    });
}
