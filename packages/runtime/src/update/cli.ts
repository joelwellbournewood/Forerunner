import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { errorMessage, isForerunnerError, resolve } from "@forerunner/platform";
import type { Command } from "commander";
import { type ComposedUpdate, composeUpdateManager } from "./compose.ts";
import type { UpdateManager } from "./install.ts";
import { ReleaseManifest, type SignedManifest } from "./manifest.ts";
import { generateSigningKeyPair, signManifest } from "./sign.ts";

/**
 * `fr update check|apply|rollback|status|health` for the user, `fr update keygen|sign` for
 * whoever cuts a release. The manager factory is injectable so the commands are testable
 * without a feed or a database; the default composes from this install's configuration.
 */
export interface UpdateCliDeps {
  /** Returns a manager and a close function; the default opens the configured store. */
  manager: () => Promise<{ manager: UpdateManager; close(): Promise<void> }>;
  out: (line: string) => void;
  err: (line: string) => void;
}

function defaultDeps(): UpdateCliDeps {
  return {
    manager: async (): Promise<ComposedUpdate> => composeUpdateManager(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

async function withManager<T>(
  deps: UpdateCliDeps,
  fn: (m: UpdateManager) => Promise<T>,
): Promise<T> {
  const { manager, close } = await deps.manager();
  try {
    return await fn(manager);
  } finally {
    await close();
  }
}

function fail(deps: UpdateCliDeps, e: unknown): void {
  const reason = isForerunnerError(e)
    ? ` [${e.code}${e.details.reason ? `: ${String(e.details.reason)}` : ""}]`
    : "";
  deps.err(`error${reason}: ${errorMessage(e)}`);
  process.exitCode = 1;
}

export function registerUpdateCli(
  program: Command,
  overrides: Partial<UpdateCliDeps> = {},
): Command {
  const deps: UpdateCliDeps = { ...defaultDeps(), ...overrides };
  const update = program
    .command("update")
    .description("Signed updates: check, apply (update and restart), rollback, status");

  update
    .command("check")
    .description("Ask the release feed for a newer signed release on this install's channel")
    .option("--json", "machine readable", false)
    .action(async (opts: { json: boolean }) => {
      try {
        const check = await withManager(deps, (m) => m.check({ kind: "human", id: null }));
        if (opts.json) return deps.out(JSON.stringify(check, null, 2));
        if (check.available) {
          deps.out(
            `Update available: ${check.available.version} (running ${check.runningVersion}, ${check.channel})`,
          );
          deps.out(check.available.notes.trim() || "(no notes)");
          deps.out("Run `fr update apply` to stage it and restart.");
        } else deps.out(`Up to date at ${check.runningVersion} (${check.channel}).`);
        for (const r of check.rejected)
          deps.out(`Refused ${r.version}: ${r.reason} (${r.message})`);
      } catch (e) {
        fail(deps, e);
      }
    });

  update
    .command("apply")
    .description(
      "Stage the newest signed release (or --version), verify it, point current.json at it and restart",
    )
    .option("--version <semver>", "a specific release on the channel")
    .option("--json", "machine readable", false)
    .action(async (opts: { version?: string; json: boolean }) => {
      try {
        const r = await withManager(deps, (m) =>
          m.apply({ by: { kind: "human", id: null }, version: opts.version }),
        );
        if (opts.json)
          return deps.out(
            JSON.stringify(
              {
                version: r.version,
                previous: r.previous,
                dir: r.staged.dir,
                state: r.pointer.state,
              },
              null,
              2,
            ),
          );
        deps.out(`Staged ${r.version} in ${r.staged.dir} (previous: ${r.previous ?? "none"}).`);
        deps.out(
          "Restart Forerunner to finish; the health check runs on first start and rolls back on failure.",
        );
      } catch (e) {
        fail(deps, e);
      }
    });

  update
    .command("rollback")
    .description("Go back to the previous version named in current.json")
    .option("--reason <text>", "why", "manual rollback from the command line")
    .option("--json", "machine readable", false)
    .action(async (opts: { reason: string; json: boolean }) => {
      try {
        const r = await withManager(deps, (m) =>
          m.rollback({ by: { kind: "human", id: null }, reason: opts.reason }),
        );
        if (opts.json) return deps.out(JSON.stringify({ from: r.from, to: r.to }, null, 2));
        deps.out(`Rolled back ${r.from} -> ${r.to}. Restart Forerunner to finish.`);
      } catch (e) {
        fail(deps, e);
      }
    });

  update
    .command("status")
    .description("Current and previous version, pending health check, versions on disk")
    .option("--json", "machine readable", false)
    .action(async (opts: { json: boolean }) => {
      try {
        const s = await withManager(deps, async (m) => m.status());
        if (opts.json) return deps.out(JSON.stringify(s, null, 2));
        deps.out(
          `Running ${s.runningVersion}, channel ${s.channel}, platform ${s.platform ?? "unsupported"}`,
        );
        if (s.pointer) {
          deps.out(
            `current.json: current ${s.pointer.current ?? "(packaged)"}, previous ${s.pointer.previous ?? "none"}, state ${s.pointer.state}`,
          );
          if (s.pointer.lastRollback)
            deps.out(
              `last rollback: ${s.pointer.lastRollback.from} -> ${s.pointer.lastRollback.to ?? "none"} (${s.pointer.lastRollback.reason})`,
            );
        } else deps.out("current.json: none (no staged install yet)");
        deps.out(`versions on disk: ${s.versionsOnDisk.join(", ") || "none"}`);
        deps.out(`trusted keys: ${s.trustedKeyIds.join(", ") || "none (updates will be refused)"}`);
      } catch (e) {
        fail(deps, e);
      }
    });

  update
    .command("health")
    .description(
      "Run the first-start health check; rolls back automatically when it fails (the shells call this after a restart)",
    )
    .option("--json", "machine readable", false)
    .action(async (opts: { json: boolean }) => {
      try {
        const o = await withManager(deps, (m) => m.healthCheck());
        if (opts.json) deps.out(JSON.stringify(o, null, 2));
        else if (o.kind === "not_pending") deps.out("No health check pending.");
        else if (o.kind === "healthy") deps.out(`Version ${o.version} is healthy: ${o.detail}`);
        else if (o.kind === "rolled_back")
          deps.out(`Rolled back ${o.from} -> ${o.to}: ${o.reason}`);
        else deps.out(`Version ${o.version} failed and no previous version exists: ${o.reason}`);
        if (o.kind === "rolled_back" || o.kind === "failed_no_previous") process.exitCode = 1;
      } catch (e) {
        fail(deps, e);
      }
    });

  update
    .command("keygen")
    .description(
      "Generate an Ed25519 release-signing key pair; the private key is written to a file (owner-only), never printed",
    )
    .requiredOption("--out <file>", "where to write the private key (base64 seed)")
    .action((opts: { out: string }) => {
      try {
        const out = resolve(opts.out);
        if (existsSync(out)) throw new Error(`refusing to overwrite ${out}`);
        const pair = generateSigningKeyPair();
        writeFileSync(out, `${pair.privateKey}\n`, { mode: 0o600 });
        try {
          chmodSync(out, 0o600);
        } catch {
          // Windows has no POSIX modes; ACLs follow the user's profile directory.
        }
        deps.out(
          `Private key written to ${out} (store it in the vault or as a CI secret; never commit it).`,
        );
        deps.out(`Public key (add to update.trustedKeys): ${pair.publicKey}`);
        deps.out(`Key id: ${pair.keyId}`);
      } catch (e) {
        fail(deps, e);
      }
    });

  update
    .command("sign")
    .description(
      "Sign a release manifest with the private key in --key-file (the release workflow step)",
    )
    .requiredOption("--manifest <file>", "unsigned manifest JSON")
    .requiredOption(
      "--key-file <file>",
      "private key file from keygen (or a CI secret written to a temp file)",
    )
    .requiredOption("--out <file>", "where to write the signed manifest")
    .action((opts: { manifest: string; keyFile: string; out: string }) => {
      try {
        const manifest = ReleaseManifest.parse(
          JSON.parse(readFileSync(resolve(opts.manifest), "utf8")),
        );
        const key = readFileSync(resolve(opts.keyFile), "utf8");
        const signed: SignedManifest = signManifest(manifest, key);
        writeFileSync(resolve(opts.out), `${JSON.stringify(signed, null, 2)}\n`);
        deps.out(
          `Signed ${manifest.version} with key ${signed.signature?.keyId ?? "?"} -> ${resolve(opts.out)}`,
        );
      } catch (e) {
        fail(deps, e);
      }
    });

  return update;
}
