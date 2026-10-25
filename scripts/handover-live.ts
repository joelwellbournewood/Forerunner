#!/usr/bin/env -S pnpm exec tsx
/**
 * handover-live: the V.8 live handover run (ADR 0060) on a dedicated install, in one command.
 *
 * Usage (from the repository root, credentials in the environment only):
 *   pnpm exec tsx scripts/handover-live.ts --profile <name> --repo <owner/name>
 *     [--budget-usd <usd>] [--dry-run]
 *
 * Environment: FORERUNNER_HOME (required, a directory used for nothing else),
 * FORERUNNER_GITHUB_TOKEN, FORERUNNER_ANTHROPIC_KEY (or FORERUNNER_SUBSCRIPTION_TOKEN),
 * optionally FORERUNNER_ANTHROPIC_WORKSPACE_ID, FORERUNNER_GITHUB_API, FORERUNNER_ANTHROPIC_API.
 *
 * Steps, each through the code the product itself uses:
 *  1. refuses unless FORERUNNER_HOME is a dedicated directory and --profile names a profile of
 *     its own (never `default`, never the normal install's), and nothing points the run at
 *     another install's store or human;
 *  2. `runSetup` non-interactively (what `fr setup --non-interactive` calls) for that profile:
 *     the credentials come from the environment, are validated and go into the profile's vault;
 *  3. composes the runtime (what every `fr` one-shot does), connects the repository as a
 *     `github_repo` source through `SourceDiscovery` (`fr sources add`), scans it and accepts
 *     the proposal into a project, or reuses the project an earlier run made;
 *  4. sets `settings.handover` through the daemon's own `PUT /projects/:id/settings` (version
 *     checked) and the autonomy to 2 through `POST /commands/execute` (`autonomy.set`, the
 *     settings screen's tap), both on the daemon app in process;
 *  5. runs `rt.jobs.handover.run(projectId, { force: true })` (`fr jobs handover --force`) and
 *     prints the report, the PR URL, the run's cost from the cost ledger and
 *     `HANDOVER RESULT: <status>`.
 *
 * Exit code 0 only when the job ran and its report has no stuck place (the seeded change made,
 * nothing re-read, failed or refused); 1 when it ran and the agent got stuck, was skipped or
 * failed; 2 when the script refused to run or a step before the job failed. `--dry-run` stops
 * before step 5 (exit 0 when every earlier step worked).
 *
 * No secret is printed, logged or passed as a process argument: every output line is scrubbed
 * of the credential values, and the credential variables are removed from the environment the
 * runtime (and every process it spawns) sees once the setup stored them in the vault.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { appDirs, errorMessage, isInside, join, resolve } from "@forerunner/platform";
import type { ComposeOptions, RuntimeApp } from "@forerunner/runtime/daemon/compose";
import {
  DEFAULT_HANDOVER_BUDGET_USD_MICRO,
  formatHandoverReport,
  type HandoverRunResult,
  handoverSettingsOf,
} from "@forerunner/runtime/jobs/handover";
import { readConfig, runSetup, SUBSCRIPTION_TOKEN_ENV } from "@forerunner/runtime/setup/wizard";
import { openVault, type Vault } from "@forerunner/vault";

/** The environment variables the non-interactive setup reads credentials from (wizard.ts). */
export const CREDENTIAL_ENV = [
  "FORERUNNER_GITHUB_TOKEN",
  "FORERUNNER_ANTHROPIC_KEY",
  SUBSCRIPTION_TOKEN_ENV,
] as const;

/** Variables that would point the run at another install's store or human; refused. */
export const FOREIGN_INSTALL_ENV = ["FORERUNNER_STATE_URL", "FORERUNNER_HUMAN"] as const;

/** Written into FORERUNNER_HOME on the first run: the directory belongs to this script. */
export const HOME_MARKER = "handover-live.json";

export const RESULT_PREFIX = "HANDOVER RESULT:";

export type HandoverLiveStatus =
  | "passed"
  | "stuck"
  | "skipped"
  | "failed"
  | "refused"
  | "error"
  | "dry-run";

export interface HandoverLiveDeps {
  /** The environment (credentials included); the entry point passes `process.env`. */
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  /** The profile's vault; default `openVault({ profile, env })`, the vault `fr setup` opens. */
  openVault?: (profile: string, env: NodeJS.ProcessEnv) => Promise<Vault>;
  /** fetch for the setup's credential checks (tests point it nowhere else). */
  setupFetch?: typeof fetch;
  /** Extra compose options (tests: the fake provider, no container probe, the fake host's git base). */
  compose?: Partial<ComposeOptions>;
}

export interface HandoverLiveOptions {
  home: string;
  profile: string;
  repo: string;
  budgetUsd: number;
  dryRun: boolean;
}

const USAGE =
  "usage: pnpm exec tsx scripts/handover-live.ts --profile <name> --repo <owner/name> [--budget-usd <usd>] [--dry-run]";
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * The checks before anything is written: the reasons the run is refused (empty: go). Pure
 * apart from reading the directory and the normal install's config.
 */
export function preflight(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { options: HandoverLiveOptions | null; refusals: string[]; help: boolean } {
  const refusals: string[] = [];
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        profile: { type: "string" },
        repo: { type: "string" },
        "budget-usd": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    // An unknown flag (a token passed as --github-token, say) is refused without echoing it.
    const msg = errorMessage(e).split("\n")[0] ?? "bad arguments";
    return {
      options: null,
      refusals: [`${msg.replace(/'[^']*'/g, "an option")}. ${USAGE}`],
      help: false,
    };
  }
  if (values.help) return { options: null, refusals: [], help: true };

  const homeRaw = env.FORERUNNER_HOME?.trim();
  let home = "";
  if (!homeRaw) {
    refusals.push(
      "FORERUNNER_HOME is not set: point it at a directory used for nothing but this run, so the normal install is never touched.",
    );
  } else {
    home = resolve(homeRaw);
    const { FORERUNNER_HOME: _drop, ...normalEnv } = env;
    const normal = appDirs({ env: normalEnv });
    const normalRoots = Object.values(normal);
    if (normalRoots.some((d) => isInside(d, home) || isInside(home, d)))
      refusals.push(
        `FORERUNNER_HOME ${home} overlaps the normal install's directories; use a separate directory.`,
      );
    const userHome = env.HOME ?? env.USERPROFILE;
    if (userHome && isInside(home, userHome))
      refusals.push("FORERUNNER_HOME is your home directory; use a directory of its own.");
    if (existsSync(home)) {
      const entries = readdirSync(home);
      const markerPath = join(home, HOME_MARKER);
      if (entries.length > 0 && !existsSync(markerPath))
        refusals.push(
          `FORERUNNER_HOME ${home} is not empty and was not made by this script (no ${HOME_MARKER}); use an empty or new directory.`,
        );
      else if (existsSync(markerPath) && typeof values.profile === "string") {
        try {
          const m = JSON.parse(readFileSync(markerPath, "utf8")) as { profile?: unknown };
          if (m.profile !== values.profile)
            refusals.push(
              `FORERUNNER_HOME ${home} belongs to profile ${String(m.profile)}, not ${values.profile}.`,
            );
        } catch {
          refusals.push(`${markerPath} is unreadable; use an empty or new directory.`);
        }
      }
    }
    const normalConfig = readConfig(normal);
    if (
      normalConfig &&
      typeof values.profile === "string" &&
      normalConfig.profile === values.profile
    )
      refusals.push(
        `profile ${values.profile} is the normal install's profile; pick a profile of its own.`,
      );
  }

  const profile = typeof values.profile === "string" ? values.profile.trim() : "";
  if (!profile) refusals.push("--profile <name> is required (a profile of its own for this run).");
  else if (profile === "default")
    refusals.push("--profile default is the normal install's vault; pick a profile of its own.");
  else if (!PROFILE_RE.test(profile))
    refusals.push("--profile takes letters, digits, '-' and '_' (at most 64).");

  const repo = typeof values.repo === "string" ? values.repo.trim() : "";
  if (!repo) refusals.push("--repo <owner/name> is required (the repository the run works on).");
  else if (!REPO_RE.test(repo)) refusals.push("--repo must be owner/name.");

  let budgetUsd = DEFAULT_HANDOVER_BUDGET_USD_MICRO / 1_000_000;
  if (typeof values["budget-usd"] === "string") {
    const n = Number(values["budget-usd"]);
    if (!Number.isFinite(n) || n <= 0) refusals.push("--budget-usd must be a positive number.");
    else budgetUsd = n;
  }

  for (const name of FOREIGN_INSTALL_ENV)
    if (env[name]?.trim())
      refusals.push(`${name} is set: it would bind the run to another install; unset it.`);

  if (refusals.length > 0) return { options: null, refusals, help: false };
  return {
    options: { home, profile, repo, budgetUsd, dryRun: values["dry-run"] === true },
    refusals,
    help: false,
  };
}

/** Every credential value of `env` (empty ones ignored), longest first. */
function secretValues(env: NodeJS.ProcessEnv): string[] {
  return CREDENTIAL_ENV.map((k) => env[k]?.trim())
    .filter((v): v is string => !!v && v.length >= 8)
    .sort((a, b) => b.length - a.length);
}

function scrub(line: string, secrets: readonly string[]): string {
  let s = line;
  for (const v of secrets) s = s.split(v).join("[REDACTED]");
  return s;
}

function usd(micro: number): string {
  return (micro / 1_000_000).toFixed(4);
}

/** Passed: the job ran and the report names no stuck place (the change made, cleanly). */
export function handoverPassed(r: HandoverRunResult): boolean {
  return r.status === "ran" && !!r.report && r.report.stuck.length === 0;
}

export async function handoverLive(
  argv: readonly string[],
  deps: HandoverLiveDeps,
): Promise<number> {
  const secrets = secretValues(deps.env);
  const out = (line: string) => deps.out(scrub(line, secrets));
  const result = (status: HandoverLiveStatus, code: number): number => {
    out(`${RESULT_PREFIX} ${status}`);
    return code;
  };

  const pre = preflight(argv, deps.env);
  if (pre.help) {
    out(USAGE);
    return 0;
  }
  if (!pre.options) {
    for (const r of pre.refusals) out(`refused: ${r}`);
    return result("refused", 2);
  }
  const o = pre.options;
  const have = CREDENTIAL_ENV.filter((k) => !!deps.env[k]?.trim());
  out(`Live handover run (V.8)${o.dryRun ? " - DRY RUN, the job will not run" : ""}`);
  out(`  install home: ${o.home} (profile ${o.profile})`);
  out(`  repository:   ${o.repo}`);
  out(`  credentials:  from the environment: ${have.join(", ") || "none"} (values never printed)`);
  out(
    "  1. fr setup --non-interactive for the profile (credentials validated, stored in its vault)",
  );
  out(
    `  2. connect github_repo ${o.repo} as a source, scan it, accept it into a project (or reuse it)`,
  );
  out(`  3. settings.handover: enabled, budget USD ${o.budgetUsd}; autonomy 2 (autonomy.set)`);
  out(
    o.dryRun
      ? "  4. (skipped: dry run) fr jobs handover --force"
      : "  4. fr jobs handover --force: a fresh agent makes the seeded change and opens a REAL pull request",
  );

  mkdirSync(o.home, { recursive: true });
  const markerPath = join(o.home, HOME_MARKER);
  if (!existsSync(markerPath))
    writeFileSync(
      markerPath,
      `${JSON.stringify({ profile: o.profile, repo: o.repo, purpose: "scripts/handover-live.ts (V.8)" }, null, 2)}\n`,
    );

  // The runtime and everything it spawns sees the environment without the credential values:
  // from here on they come from the vault by name.
  const runtimeEnv: NodeJS.ProcessEnv = { ...deps.env, FORERUNNER_HOME: o.home };
  const dirs = appDirs({ env: runtimeEnv });
  let rt: RuntimeApp | null = null;
  try {
    const vault = await (deps.openVault ?? ((profile, env) => openVault({ profile, env })))(
      o.profile,
      runtimeEnv,
    );
    // 1. Setup.
    const setup = await runSetup(vault, {
      nonInteractive: true,
      profile: o.profile,
      repos: [o.repo],
      env: runtimeEnv,
      dirs,
      ...(deps.setupFetch ? { fetchImpl: deps.setupFetch } : {}),
    });
    for (const k of CREDENTIAL_ENV) {
      delete runtimeEnv[k];
      if (deps.env === process.env) delete process.env[k];
    }
    out(`Setup: config ${setup.configPath}, vault ${vault.backend}`);
    for (const [k, r] of Object.entries(setup.results)) {
      out(`  ${k}: ${r.ok ? "ok" : "needs changes"} - ${r.summary}`);
      for (const p of r.problems) out(`    - ${p}`);
    }
    if (setup.stored.length) out(`  stored in the vault: ${setup.stored.join(", ")}`);
    if (!setup.complete) {
      out(
        `refused: setup is not complete (missing: ${setup.skipped.join(", ") || "a credential"}); set the variables in .env.build.`,
      );
      return result("refused", 2);
    }

    // 2. The runtime, the source and the project.
    const { composeRuntime } = await import("@forerunner/runtime/daemon/compose");
    rt = await composeRuntime({
      env: runtimeEnv,
      dirs,
      vault,
      startServices: false,
      ...deps.compose,
    });
    const actor = { humanId: rt.human.id };
    const sameRepo = (s: string) => s.toLowerCase() === o.repo.toLowerCase();
    let source = (await rt.sources.list(actor)).find(
      (s) => s.kind === "github_repo" && sameRepo(s.locator),
    );
    if (source) out(`Source: ${source.id} github_repo ${source.locator} (reused)`);
    else {
      source = await rt.sources.add({ kind: "github_repo", locator: o.repo }, actor);
      out(`Source: ${source.id} github_repo ${source.locator} (connected)`);
    }
    const scan = await rt.sources.scan(source.id, actor);
    const cand = scan.candidates.find((c) => sameRepo(c.locator)) ?? scan.candidates[0];
    if (!cand) {
      out(
        `refused: the scan of ${o.repo} found no repository (check the token's repository access).`,
      );
      return result("refused", 2);
    }
    let projectId: string;
    if ((cand.status === "accepted" || cand.status === "duplicate") && cand.projectId) {
      projectId = cand.projectId;
      out(`Project: ${projectId} (reused; candidate ${cand.id} ${cand.status})`);
    } else if (cand.status === "proposed") {
      const accepted = await rt.sources.accept(cand.id, {}, actor);
      projectId = accepted.project.id;
      out(`Project: ${projectId} (${accepted.project.name}, created from ${cand.locator})`);
      const docs = (
        (await rt.store.project.mustGet(projectId)).summary_cache as {
          docs?: { pr_url?: unknown };
        }
      ).docs;
      if (typeof docs?.pr_url === "string")
        out(`  the standard doc set scaffold opened ${docs.pr_url}`);
    } else {
      out(
        `refused: candidate ${cand.id} for ${cand.locator} is ${cand.status}; rescan or check the repository.`,
      );
      return result("refused", 2);
    }

    // 3. Settings and autonomy through the daemon's own routes, in process.
    const { createDaemonApp } = await import("@forerunner/runtime/daemon/server");
    const { app, token } = createDaemonApp(rt);
    const call = async (path: string, method: string, body: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json };
    };
    const before = await rt.store.project.mustGet(projectId);
    const put = await call(`/projects/${projectId}/settings`, "PUT", {
      version: before.version,
      settings: { handover: { enabled: true, budget_usd: o.budgetUsd } },
    });
    if (put.status !== 200) {
      out(
        `refused: PUT /projects/${projectId}/settings answered ${put.status}: ${JSON.stringify(put.json)}`,
      );
      return result("refused", 2);
    }
    out(
      `Settings: handover enabled, budget USD ${o.budgetUsd} (version ${String(put.json.version)})`,
    );
    const exec = await call("/commands/execute", "POST", {
      commands: [{ name: "autonomy.set", params: { level: 2, project: projectId } }],
      source: "ui",
      projectId,
      confirm: "tap",
    });
    if (exec.status !== 200 || exec.json.status !== "done") {
      out(
        `refused: autonomy.set answered ${exec.status} ${String(exec.json.status ?? "")}: ${String(exec.json.reason ?? exec.json.sentence ?? "")}`,
      );
      return result("refused", 2);
    }
    out(`Autonomy: ${String(exec.json.sentence ?? "set to 2")}`);
    const ready = await rt.store.project.mustGet(projectId);
    const hs = handoverSettingsOf(ready.settings);
    if (ready.autonomy_level !== 2 || !hs) {
      out(
        `refused: the project reads autonomy ${ready.autonomy_level}, handover ${hs ? "on" : "off"}.`,
      );
      return result("refused", 2);
    }

    if (o.dryRun) {
      out(`Dry run: project ${projectId} is ready; the handover job was not run.`);
      return result("dry-run", 0);
    }

    // 4. The job, as `fr jobs handover --force`.
    const startedAt = rt.clock.nowIso();
    const r = await rt.jobs.handover.run(projectId, { force: true });
    if (r.status !== "ran" || !r.report) {
      out(`handover ${r.status}: ${r.reason ?? "unknown"}`);
      return result(r.status === "skipped" ? "skipped" : "failed", 1);
    }
    out(formatHandoverReport(r.report));
    out(`PR: ${r.report.task.prUrl ?? "none opened"}`);
    const session = await rt.store.costLedger.sum({ sessionId: r.report.sessionId });
    const run = await rt.store.costLedger.sum({ projectId, from: startedAt });
    out(
      `Cost (cost ledger): session ${r.report.sessionId} USD ${usd(session.usd_micro)} (CHF ${usd(session.chf_micro)}, ${session.entries} entries); project since the run started USD ${usd(run.usd_micro)} (CHF ${usd(run.chf_micro)})`,
    );
    return handoverPassed(r) ? result("passed", 0) : result("stuck", 1);
  } catch (e) {
    out(`error: ${errorMessage(e)}`);
    return result("error", 2);
  } finally {
    await rt?.close().catch(() => undefined);
  }
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
  handoverLive(process.argv.slice(2), { env: process.env, out: (l) => console.log(l) }).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`error: ${errorMessage(e)}`);
      process.exitCode = 2;
    },
  );
}
