import { type Clock, ForerunnerError, log } from "@forerunner/platform";
import { EncryptedFileVault } from "./file.ts";
import {
  type KeyringDetection,
  type KeyringEntryFactory,
  KeyringVault,
  type KeyringVaultOptions,
} from "./keyring.ts";
import { MemoryVault } from "./memory.ts";
import type { Vault, VaultBackend } from "./types.ts";

/** `FORERUNNER_VAULT_BACKEND=keyring|file|memory` forces a backend (tests, cloud runner). */
export const VAULT_BACKEND_ENV = "FORERUNNER_VAULT_BACKEND";

export interface OpenVaultOptions {
  /** Install profile: keyring service "forerunner-<profile>", file "vault.<profile>.json". */
  profile?: string;
  /** Which backend to try first. Default keyring. */
  prefer?: "keyring" | "file";
  /** File backend path (default under appDirs().config). */
  path?: string;
  /** File backend passphrase instead of a device key. */
  passphrase?: string;
  env?: NodeJS.ProcessEnv;
  clock?: Clock;
  /** Test hooks: replace the availability probe or the keyring entries. */
  detectKeyring?: (opts: KeyringVaultOptions) => Promise<KeyringDetection>;
  keyringEntries?: KeyringEntryFactory;
}

function parseBackend(raw: string | undefined): VaultBackend | undefined {
  if (raw === undefined || raw === "") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "keyring" || v === "file" || v === "memory") return v;
  throw new ForerunnerError("validation", `${VAULT_BACKEND_ENV} must be keyring, file or memory`, {
    details: { value: v.slice(0, 20) },
  });
}

/**
 * Pick a backend: the env override, else `prefer` (keyring by default) with a fall back to the
 * encrypted file when the OS keyring is unavailable. Logs the choice, never a value.
 */
export async function openVault(opts: OpenVaultOptions = {}): Promise<Vault> {
  const env = opts.env ?? process.env;
  const logger = log("vault");
  const forced = parseBackend(env[VAULT_BACKEND_ENV]);
  const want: VaultBackend = forced ?? opts.prefer ?? "keyring";

  if (want === "memory") {
    logger.warn("vault backend: memory (nothing persists)", { forced: forced !== undefined });
    return new MemoryVault();
  }

  if (want === "keyring") {
    const keyringOpts: KeyringVaultOptions = {
      profile: opts.profile,
      entries: opts.keyringEntries,
      clock: opts.clock,
    };
    const detection = await (opts.detectKeyring ?? KeyringVault.detect)(keyringOpts);
    if (detection.available) {
      logger.info("vault backend: keyring", { service: detection.service });
      return new KeyringVault(keyringOpts);
    }
    if (forced === "keyring") {
      throw new ForerunnerError("unavailable", "OS keyring unavailable and backend forced", {
        details: { service: detection.service, reason: detection.reason },
      });
    }
    logger.warn("OS keyring unavailable, falling back to the encrypted file vault", {
      service: detection.service,
      reason: detection.reason,
    });
  }

  const vault = await EncryptedFileVault.open({
    path: opts.path,
    profile: opts.profile,
    env,
    passphrase: opts.passphrase,
  });
  logger.info("vault backend: file", { path: vault.path, mode: vault.unlockMode });
  return vault;
}
