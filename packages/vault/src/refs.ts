import { ForerunnerError } from "@forerunner/platform";
import { assertSecretName, SECRET_NAME_PATTERN, type Vault } from "./types.ts";

/**
 * Secrets by reference. An agent writes `secret:github_pat` as a whole string value inside a
 * tool input; the runtime calls resolveSecretRefs with the run's granted names and the
 * resolved input goes to the tool. The model never sees a value: the audit log, the approval
 * card and the model context all keep the reference.
 */
export const SECRET_PREFIX = "secret:";
const REF_PATTERN = new RegExp(`^${SECRET_PREFIX}${SECRET_NAME_PATTERN.source.slice(1)}`);
const MAX_DEPTH = 64;

/** Values shorter than this are not scrubbed from outputs; they are not secrets. */
export const MIN_REDACT_LENGTH = 4;

/** True only for a whole-string reference with a valid name ("secret:" mid-text never counts). */
export function isSecretRef(value: unknown): value is `secret:${string}` {
  return typeof value === "string" && REF_PATTERN.test(value);
}

/** "secret:github_pat" -> "github_pat". Throws `validation` for anything else. */
export function parseSecretRef(ref: string): string {
  if (typeof ref !== "string" || !ref.startsWith(SECRET_PREFIX)) {
    throw new ForerunnerError("validation", "not a secret reference", {
      details: { ref: typeof ref === "string" ? ref.slice(0, 40) : typeof ref },
    });
  }
  return assertSecretName(ref.slice(SECRET_PREFIX.length));
}

export function formatSecretRef(name: string): string {
  return `${SECRET_PREFIX}${assertSecretName(name)}`;
}

export interface ResolveOptions {
  /** Called once per resolved reference (the name, never the value): for the audit log. */
  audit?: (name: string) => void;
  /** Receives every resolved value so the caller can scrub outputs (see SecretResolver). */
  onValue?: (value: string) => void;
}

/**
 * Deep-walk a tool input and replace whole-string references with vault values. Names
 * outside `granted` throw `secret_not_granted` (before any vault read); names granted but
 * absent from the vault throw `not_found`. The input is never mutated; a new structure comes
 * back. Only arrays and plain objects are walked; class instances (Date, Buffer) pass through.
 */
export async function resolveSecretRefs(
  input: unknown,
  vault: Vault,
  granted: ReadonlySet<string>,
  audit?: ((name: string) => void) | ResolveOptions,
): Promise<unknown> {
  const opts: ResolveOptions = typeof audit === "function" ? { audit } : (audit ?? {});
  const cache = new Map<string, string>();

  const lookup = async (name: string): Promise<string> => {
    if (!granted.has(name)) {
      throw new ForerunnerError(
        "secret_not_granted",
        `secret "${name}" is not granted to this run`,
        {
          details: { name },
        },
      );
    }
    const cached = cache.get(name);
    if (cached !== undefined) return cached;
    const value = await vault.get(name);
    if (value === null) {
      throw new ForerunnerError("not_found", `secret "${name}" is not in the vault`, {
        details: { name },
      });
    }
    cache.set(name, value);
    opts.audit?.(name);
    opts.onValue?.(value);
    return value;
  };

  const walk = async (value: unknown, depth: number): Promise<unknown> => {
    if (depth > MAX_DEPTH) {
      throw new ForerunnerError("validation", "tool input is nested too deeply", {
        details: { maxDepth: MAX_DEPTH },
      });
    }
    if (typeof value === "string") {
      return isSecretRef(value) ? lookup(value.slice(SECRET_PREFIX.length)) : value;
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (const item of value) out.push(await walk(item, depth + 1));
      return out;
    }
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = await walk(v, depth + 1);
      return out;
    }
    return value;
  };

  return walk(input, 0);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Scrub every value (and its JSON-escaped, URL-encoded, base64, base64url with and without
 * padding, and hex forms) out of `text`. Longest values first so a value that contains
 * another is replaced whole.
 */
export function redactValues(
  text: string,
  values: Iterable<string>,
  marker = "[REDACTED]",
): string {
  const needles = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string" || v.length < MIN_REDACT_LENGTH) continue;
    needles.add(v);
    const json = JSON.stringify(v).slice(1, -1);
    if (json !== v) needles.add(json);
    const url = encodeURIComponent(v);
    if (url !== v) needles.add(url);
    const bytes = Buffer.from(v, "utf8");
    const b64 = bytes.toString("base64");
    needles.add(b64);
    // base64url (JWT segments, some Basic-auth clients, `@base64d` pipelines) padded and
    // unpadded, and hex: a tool that prints the value in one of these must not reach the model.
    const b64url = b64.replace(/\+/g, "-").replace(/\//g, "_");
    needles.add(b64url);
    needles.add(b64url.replace(/=+$/, ""));
    const hex = bytes.toString("hex");
    needles.add(hex);
    needles.add(hex.toUpperCase());
  }
  let out = text;
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    if (needle.length >= MIN_REDACT_LENGTH && out.includes(needle)) {
      out = out.split(needle).join(marker);
    }
  }
  return out;
}

/**
 * Per-run adapter: resolves references and remembers the values it handed out so tool
 * outputs and logs can be scrubbed. Structurally matches the runtime's SecretsPort.
 */
export class SecretResolver {
  private readonly values = new Set<string>();

  constructor(
    private readonly vault: Vault,
    private readonly audit?: (name: string) => void,
  ) {}

  resolve(input: unknown, granted: ReadonlySet<string>): Promise<unknown> {
    return resolveSecretRefs(input, this.vault, granted, {
      audit: this.audit,
      onValue: (v) => this.values.add(v),
    });
  }

  redact(text: string): string {
    return redactValues(text, this.values);
  }

  /** How many distinct values this resolver has handed out. */
  get resolvedCount(): number {
    return this.values.size;
  }

  /** Drop remembered values (end of run). */
  forget(): void {
    this.values.clear();
  }
}
