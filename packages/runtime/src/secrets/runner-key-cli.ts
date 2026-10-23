import { readFile } from "node:fs/promises";
import { ForerunnerError, isAbsolute, resolve } from "@forerunner/platform";
import {
  decodeStoredKey,
  runnerKeySecretName,
  toBase64,
  UNLOCK_KEY_BYTES,
  type Vault,
} from "@forerunner/vault";
import type { Command } from "commander";

/**
 * `fr runner-key import|status|remove <runner>` (spec S.12, ADR 0068): put a cloud runner's
 * 32-byte vault key into this install's vault under `cloud_runner_vault_key:<runner>`
 * (`runnerKeySecretName`), the entry the daemon's `POST /runner-unlock/wrap` reads when the
 * desktop inbox's unlock card answers that runner. The key comes from a file (the runner
 * vault's `vault.key`, raw 32 bytes, or its base64), never from an argument, so it is not in
 * the shell history or the process list; no output line carries it.
 */
export interface RunnerKeyCliDeps {
  /** The vault the daemon opens for this profile (`openVault({ profile, env })`). */
  open: (opts: { profile?: string }) => Promise<Pick<Vault, "backend" | "get" | "set" | "delete">>;
  out: (line: string) => void;
  cwd: () => string;
  read?: (path: string) => Promise<Uint8Array>;
}

/**
 * The key in a key file: exactly 32 raw bytes (a `vault.key`), or the base64 of 32 bytes with
 * optional surrounding whitespace. Null for anything else. The caller zeroes the result.
 */
export function parseRunnerKeyFile(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length === UNLOCK_KEY_BYTES) return new Uint8Array(bytes);
  if (bytes.length > 256) return null;
  return decodeStoredKey(new TextDecoder().decode(bytes));
}

export function registerRunnerKeyCli(program: Command, deps: RunnerKeyCliDeps): void {
  const read = deps.read ?? ((path: string) => readFile(path));
  const cmd = program
    .command("runner-key")
    .description(
      "A cloud runner's vault key in this install's vault, so the desktop inbox can answer its unlock (never printed)",
    );

  cmd
    .command("import")
    .description(
      "Store the runner's vault key from a file: its vault.key (32 raw bytes) or the base64 of it",
    )
    .argument("<runner>", "the runner id its unlock requests name")
    .argument("<file>", "path of the key file")
    .option("--profile <name>")
    .action(async (runnerId: string, file: string, opts: { profile?: string }) => {
      const path = isAbsolute(file) ? file : resolve(deps.cwd(), file);
      const raw = await read(path);
      const key = parseRunnerKeyFile(raw);
      raw.fill(0);
      if (!key) {
        throw new ForerunnerError(
          "validation",
          `the key file must hold exactly ${UNLOCK_KEY_BYTES} raw bytes or their base64`,
          { details: { path } },
        );
      }
      const name = runnerKeySecretName(runnerId);
      try {
        const vault = await deps.open(opts.profile ? { profile: opts.profile } : {});
        const replaced = (await vault.get(name)) !== null;
        await vault.set(name, toBase64(key));
        deps.out(
          `${replaced ? "Replaced" : "Stored"} the vault key of runner "${runnerId}" as ${name} in the ${vault.backend} vault. The desktop inbox can now answer its unlock.`,
        );
      } finally {
        key.fill(0);
      }
    });

  cmd
    .command("status")
    .description("Whether this install's vault holds a usable key for the runner (never the key)")
    .argument("<runner>")
    .option("--profile <name>")
    .action(async (runnerId: string, opts: { profile?: string }) => {
      const name = runnerKeySecretName(runnerId);
      const vault = await deps.open(opts.profile ? { profile: opts.profile } : {});
      const key = decodeStoredKey(await vault.get(name));
      deps.out(
        key
          ? `${name}: present in the ${vault.backend} vault`
          : `${name}: missing from the ${vault.backend} vault (fr runner-key import ${runnerId} <file>)`,
      );
      key?.fill(0);
    });

  cmd
    .command("remove")
    .description("Delete the runner's vault key from this install's vault")
    .argument("<runner>")
    .option("--profile <name>")
    .action(async (runnerId: string, opts: { profile?: string }) => {
      const name = runnerKeySecretName(runnerId);
      const vault = await deps.open(opts.profile ? { profile: opts.profile } : {});
      const deleted = await vault.delete(name);
      deps.out(deleted ? `Removed ${name}.` : `${name} was not stored.`);
    });
}
