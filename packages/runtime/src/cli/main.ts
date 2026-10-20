#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline/promises";
import { appDirs, log, osFacts, run, which } from "@forerunner/platform";
import { openVault } from "@forerunner/vault";
import { Command } from "commander";
import { writeKillRequest } from "../enforcement/killfile.ts";
import { ensureDirs, readConfig, runSetup } from "../setup/wizard.ts";

/**
 * `fr`: the Forerunner command line. Used by the setup wizard, the fresh-install scripts, the
 * tray and the tests. Every subcommand works on Windows and Linux.
 */
const program = new Command();
program.name("fr").description("Forerunner command line").version("0.1.0");

program
  .command("setup")
  .description("Guided setup: app directories, credentials (validated on paste), vault, config")
  .option("--non-interactive", "take values from flags or FORERUNNER_* env; never prompt", false)
  .option("--profile <name>", "install profile (lets two installs share one machine)")
  .option("--human-name <name>", "your name")
  .option("--timezone <tz>", "IANA time zone")
  .option("--github-token <token>", "GitHub fine-grained token (or FORERUNNER_GITHUB_TOKEN)")
  .option(
    "--anthropic-key <key>",
    "Anthropic API key or subscription token (or FORERUNNER_ANTHROPIC_KEY)",
  )
  .option("--repos <list>", "comma separated owner/name repositories to verify access to")
  .option("--github-api <url>", "GitHub API base (fake git host in tests)")
  .option("--anthropic-api <url>", "Anthropic API base")
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
        timezone: opts.timezone,
        githubToken: opts.githubToken,
        anthropicKey: opts.anthropicKey,
        repos: opts.repos
          ? String(opts.repos)
              .split(",")
              .map((s: string) => s.trim())
              .filter(Boolean)
          : undefined,
        githubApiBase: opts.githubApi,
        anthropicApiBase: opts.anthropicApi,
        stateUrl: opts.stateUrl,
        prompt,
      });
      console.log(`Config: ${report.configPath}`);
      console.log(`Vault backend: ${vault.backend}`);
      for (const [k, r] of Object.entries(report.results)) {
        console.log(`${k}: ${r.ok ? "ok" : "needs changes"} - ${r.summary}`);
        for (const p of r.problems) console.log(`  - ${p}`);
      }
      if (report.stored.length) console.log(`Stored in vault: ${report.stored.join(", ")}`);
      if (report.skipped.length)
        console.log(
          `Not configured yet: ${report.skipped.join(", ")} (run fr setup again any time)`,
        );
      console.log(
        report.complete ? "Setup complete." : "Setup saved; credentials can be added later.",
      );
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
    const out = { dirs, config, vault: { backend: vault.backend, names }, os: osFacts() };
    if (opts.json) console.log(JSON.stringify(out, null, 2));
    else {
      console.log(
        `Platform: ${out.os.platform} ${out.os.release} (${out.os.arch}), keychain: ${out.os.keychain}`,
      );
      console.log(
        `Config: ${config ? `profile ${config.profile}, state ${config.stateUrl}` : "not set up (run fr setup)"}`,
      );
      console.log(
        `Vault: ${vault.backend}, ${names.length} secret(s): ${names.join(", ") || "none"}`,
      );
      for (const [k, v] of Object.entries(dirs)) console.log(`  ${k}: ${v}`);
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
    checks.push({
      name: "config",
      ok: !!readConfig(),
      detail: readConfig() ? "present" : "run fr setup",
    });
    if (opts.json) console.log(JSON.stringify(checks, null, 2));
    else
      for (const c of checks)
        console.log(`${c.ok ? "ok " : "!! "} ${c.name.padEnd(18)} ${c.detail}`);
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
    console.log(`Kill request written: ${p}`);
  });

program
  .command("daemon")
  .description("Run the local runtime daemon (the desktop shell starts this as a sidecar)")
  .option("--port <n>", "port on 127.0.0.1 (default: random free port)")
  .option("--provider <name>", "fake | anthropic (default: anthropic when a credential exists)")
  .action(async (opts) => {
    const { composeRuntime } = await import("../daemon/compose.ts");
    const { startDaemon } = await import("../daemon/server.ts");
    const rt = await composeRuntime(
      opts.provider === "fake"
        ? { provider: (await import("../daemon/fake-provider-shim.ts")).fakeProvider() }
        : {},
    );
    const d = await startDaemon(rt, { port: opts.port ? Number(opts.port) : undefined });
    console.log(`Forerunner daemon listening on ${d.url} (daemon.json in ${rt.dirs.runtime})`);
    const shutdown = async () => {
      await d.stop();
      await rt.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("dirs")
  .description("Print the application directories for this platform")
  .action(() => {
    for (const [k, v] of Object.entries(ensureDirs())) console.log(`${k}: ${v}`);
  });

program.parseAsync(process.argv).catch((e) => {
  log("fr").error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
