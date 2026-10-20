import { ForerunnerError } from "@forerunner/platform";

/**
 * The vault contract. Every backend stores name -> value only; metadata (scope, grants,
 * who may read) lives in the state store's `secret_ref` table, never here. Values are
 * strings because every consumer (env vars, headers, tool inputs) wants a string; the file
 * backend keeps plaintext in Buffers internally and zeroes them after use.
 */
export type VaultBackend = "keyring" | "file" | "memory";

export interface Vault {
  readonly backend: VaultBackend;
  /** Store or replace a value. Throws `validation` on a bad name or value. */
  set(name: string, value: string): Promise<void>;
  /** The value, or null when the name is not stored. */
  get(name: string): Promise<string | null>;
  /** True when something was deleted. */
  delete(name: string): Promise<boolean>;
  /** Stored names, sorted. Never values. */
  list(): Promise<string[]>;
  has(name: string): Promise<boolean>;
}

/**
 * Secret names: lowercase, start with a letter, then letters, digits, `_ . : -`, at most
 * 128 characters. Internal keyring entries (`__index__`, probes, chunks) can never collide
 * with a user name because they start with `_` or contain `#`.
 */
export const SECRET_NAME_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

/** Upper bound on a stored value, in UTF-16 code units. Enough for keys and certificates. */
export const MAX_SECRET_VALUE_LENGTH = 64 * 1024;

export function isValidSecretName(name: unknown): name is string {
  return typeof name === "string" && SECRET_NAME_PATTERN.test(name);
}

/** Returns the name when valid, otherwise throws a `validation` ForerunnerError. */
export function assertSecretName(name: unknown): string {
  if (isValidSecretName(name)) return name;
  const shown = typeof name === "string" ? name.slice(0, 40) : typeof name;
  throw new ForerunnerError(
    "validation",
    `invalid secret name "${shown}": must match ${SECRET_NAME_PATTERN.source}`,
    { details: { name: shown } },
  );
}

/** Validates a value without ever echoing it. */
export function assertSecretValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new ForerunnerError("validation", "secret value must be a string", {
      details: { type: typeof value },
    });
  }
  if (value.length === 0) {
    throw new ForerunnerError("validation", "secret value must not be empty");
  }
  if (value.length > MAX_SECRET_VALUE_LENGTH) {
    throw new ForerunnerError("validation", "secret value is too large", {
      details: { length: value.length, max: MAX_SECRET_VALUE_LENGTH },
    });
  }
  return value;
}
