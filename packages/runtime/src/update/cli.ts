import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  basename,
  errorMessage,
  ForerunnerError,
  isForerunnerError,
  resolve,
  systemClock,
} from "@forerunner/platform";
import { openVault, type Vault } from "@forerunner/vault";
import type { Command } from "commander";
import { type ComposedUpdate, composeUpdateManager } from "./compose.ts";
import type { UpdateManager } from "./install.ts";
import {
  ARTIFACT_PLATFORMS,
  type ArtifactPlatform,
  ReleaseManifest,
  type SignedManifest,
  UPDATE_CHANNELS,
  type UpdateChannel,
} from "./manifest.ts";
import {
  buildReleaseManifest,
  generateSigningKeyPair,
  type ManifestArtifactInput,
  signManifest,
  signManifestWithSecret,
} from "./sign.ts";

/**
 * `fr update check|apply|rollback|status|health` for the user, `fr update keygen|manifest|sign`
 * for whoever cuts a release. The manager factory and the vault are injectable so the commands
 * are testable without a feed, a database or an OS keyring; the defaults compose from this
 * install's configuration.
 */
export interface UpdateCliDeps {
  /** Returns a manager and a close function; the default opens the configured store. */
  manager: () => Promise<{ manager: UpdateManager; close(): Promise<void> }>;
  /** The vault that holds the signing key for `sign --key-secret`; the default is this install's. */
  vault: () => Promise<Pick<Vault, "get">>;
  out: (line: string) => void;
  err: (line: string) => void;
}

function defaultDeps(): UpdateCliDeps {
  return {
    manager: async (): Promise<ComposedUpdate> => composeUpdateManager(),
    vault: () => openVault(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  };
}

/** `<platform>:<file>`; the split is on the first colon so Windows drive letters survive. */
export function parseArtifactSpec(spec: string, baseUrl: string): ManifestArtifactInput {
  const colon = spec.indexOf(":");
  const platform = colon > 0 ? spec.slice(0, colon) : "";
  const file = colon > 0 ? spec.slice(colon + 1) : "";
  if (!(ARTIFACT_PLATFORMS as readonly string[]).includes(platform) || !file) {
    throw new ForerunnerError(
      "validation",
      `--artifact must be <platform>:<file> with platform one of ${ARTIFACT_PLATFORMS.join(", ")}`,
      { details: { spec: spec.slice(0, 80) } },
    );
  }
  const resolved = resolve(file);
  const name = basename(resolved);
  return {
    platform: platform as ArtifactPlatform,
    file: resolved,
    url: `${baseUrl.replace(/\/$/, "")}/${encodeURIComponent(name)}`,
    name,
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
    .command("manifest")
    .description(
      "Write the unsigned release manifest: hashes and sizes are computed from the built artefacts",
    )
    .requiredOption("--version <semver>", "release version (the git tag without v)")
    .option("--channel <stable|beta>", "release channel", "stable")
    .requiredOption("--notes-file <file>", "changelog section for this release (Markdown)")
    .requiredOption("--min-schema <n>", "oldest state schema this release can start from")
    .requiredOption(
      "--base-url <url>",
      "where the artefacts will be downloadable (the Release's download URL prefix)",
    )
    .requiredOption(
      "--artifact <platform:file>",
      "built artefact per platform (windows-x64, linux-x64, android); repeatable",
      (value: string, prev: string[] = []) => [...prev, value],
    )
    .option("--published-at <iso>", "publication time (ISO-8601 UTC); default now")
    .requiredOption("--out <file>", "where to write the unsigned manifest")
    .action(
      (opts: {
        version: string;
        channel: string;
        notesFile: string;
        minSchema: string;
        baseUrl: string;
        artifact: string[];
        publishedAt?: string;
        out: string;
      }) => {
        try {
          if (!(UPDATE_CHANNELS as readonly string[]).includes(opts.channel))
            throw new ForerunnerError("validation", "--channel must be stable or beta");
          const minSchema = Number(opts.minSchema);
          if (!Number.isInteger(minSchema) || minSchema < 0)
            throw new ForerunnerError("validation", "--min-schema must be a non-negative integer");
          const manifest = buildReleaseManifest({
            version: opts.version,
            channel: opts.channel as UpdateChannel,
            publishedAt: opts.publishedAt ?? systemClock.nowIso(),
            notes: readFileSync(resolve(opts.notesFile), "utf8"),
            minSchema,
            artifacts: opts.artifact.map((spec) => parseArtifactSpec(spec, opts.baseUrl)),
          });
          writeFileSync(resolve(opts.out), `${JSON.stringify(manifest, null, 2)}\n`);
          deps.out(
            `Manifest for ${manifest.version} (${manifest.channel}, ${manifest.artifacts.length} artefact(s)) -> ${resolve(opts.out)}`,
          );
          for (const a of manifest.artifacts)
            deps.out(`  ${a.platform.padEnd(12)} ${a.name} ${a.size} bytes sha256 ${a.sha256}`);
        } catch (e) {
          fail(deps, e);
        }
      },
    );

  update
    .command("sign")
    .description(
      "Sign a release manifest with the private key from --key-file or the vault secret --key-secret (the release workflow step)",
    )
    .requiredOption("--manifest <file>", "unsigned manifest JSON")
    .option(
      "--key-file <file>",
      "private key file from keygen (or a CI secret written to a temp file)",
    )
    .option(
      "--key-secret <ref>",
      "vault reference of the private key, e.g. secret:update_signing_key",
    )
    .requiredOption("--out <file>", "where to write the signed manifest")
    .action(
      async (opts: { manifest: string; keyFile?: string; keySecret?: string; out: string }) => {
        try {
          if (!opts.keyFile && !opts.keySecret)
            throw new ForerunnerError(
              "validation",
              "one of --key-file or --key-secret is required",
            );
          if (opts.keyFile && opts.keySecret)
            throw new ForerunnerError("validation", "--key-file and --key-secret are exclusive");
          const manifest = ReleaseManifest.parse(
            JSON.parse(readFileSync(resolve(opts.manifest), "utf8")),
          );
          let signed: SignedManifest;
          if (opts.keySecret) {
            signed = await signManifestWithSecret(manifest, opts.keySecret, await deps.vault());
          } else {
            signed = signManifest(manifest, readFileSync(resolve(opts.keyFile as string), "utf8"));
          }
          writeFileSync(resolve(opts.out), `${JSON.stringify(signed, null, 2)}\n`);
          deps.out(
            `Signed ${manifest.version} with key ${signed.signature?.keyId ?? "?"} -> ${resolve(opts.out)}`,
          );
        } catch (e) {
          fail(deps, e);
        }
      },
    );

  return update;
}
