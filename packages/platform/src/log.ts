/**
 * Structured logger with mandatory secret redaction. Every log line passes through
 * redact() so a key pasted into a message never reaches disk.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: Record<string, unknown>;
}

export type LogSink = (rec: LogRecord) => void;

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g, // Anthropic API keys and OAuth tokens
  /sk-ant-oat01-[A-Za-z0-9_-]{10,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9+/]{32,}={0,2}\b(?=.*(?:secret|token|key|password))/gi,
  /(?:bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*["']?[^\s"',;]{6,}/gi,
];

/**
 * The password of a connection string (`scheme://user:password@host`): the most common way a
 * database password reaches a log line (`FORERUNNER_STATE_URL`, a migration error echoing the
 * URL). The scheme, user and host stay so the line is still useful. The user may be empty
 * (`redis://:password@host`, `amqp://:password@host`): the password is still a password.
 */
const URL_USERINFO = /([a-z][\w+.-]*:\/\/[^\s:@/]*:)([^\s@/]+)@/gi;

/**
 * Keys whose value is masked whatever its shape: the usual names, `credential(s)`, `passwd`,
 * `passphrase`, and any `*_key` / `*-key` / `*Key` / `*KEY` / bare `key` in any case (private,
 * signing, vault, session keys; `PRIVATE_KEY` and the other env-style names of a dumped
 * `process.env` included); a public key is an identifier and stays. The camel-case form needs
 * a case switch before the suffix (a lower-case letter or digit, then `Key` or `KEY`), so that
 * `monkey`, `hockey` or `MONKEY` is not a credential while `signingKey` and `signingKEY` are.
 */
const SECRET_KEY_NAME =
  /(secret|token|password|passwd|passphrase|credential|api[_-]?key|authorization|cookie)/i;
const KEY_SUFFIX = /(^|[_-])key$/i;
const CAMEL_KEY_SUFFIX = /[a-z0-9](Key|KEY)$/;
const PUBLIC_KEY_NAME = /^public[_-]?key$/i;

export function isSecretKeyName(key: string): boolean {
  if (SECRET_KEY_NAME.test(key)) return true;
  if (PUBLIC_KEY_NAME.test(key)) return false;
  return KEY_SUFFIX.test(key) || CAMEL_KEY_SUFFIX.test(key);
}

/** Replace anything that looks like a credential with a stable marker. */
export function redact(input: string): string {
  let out = input.replace(URL_USERINFO, (_m, prefix: string) => `${prefix}[REDACTED]@`);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      const eq = m.match(/^([A-Za-z_ -]+[=:]\s*)/);
      if (eq?.[1]) return `${eq[1]}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return out;
}

/** Deeper than this a subtree is replaced by a marker: nothing is ever passed through in clear. */
const MAX_DEPTH = 64;

/**
 * Redact every string and every secret-named key at any depth. A cycle is cut with
 * `[Circular]` (a `WeakSet` of the objects on the current path), so the result always
 * serialises; a subtree deeper than `MAX_DEPTH` becomes `[TRUNCATED]` rather than leaking.
 */
export function redactDeep<T>(value: T, depth = 0, path: WeakSet<object> = new WeakSet()): T {
  if (typeof value === "string") return redact(value) as T;
  if (!value || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return "[TRUNCATED]" as unknown as T;
  if (path.has(value)) return "[Circular]" as unknown as T;
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1, path)) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKeyName(k) ? "[REDACTED]" : redactDeep(v, depth + 1, path);
    }
    return out as T;
  } finally {
    path.delete(value);
  }
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private static sinks: LogSink[] = [defaultConsoleSink];
  private static minLevel: LogLevel = (process.env.FORERUNNER_LOG_LEVEL as LogLevel) || "info";

  static setSinks(sinks: LogSink[]): void {
    Logger.sinks = sinks;
  }
  static addSink(sink: LogSink): () => void {
    Logger.sinks.push(sink);
    return () => {
      Logger.sinks = Logger.sinks.filter((s) => s !== sink);
    };
  }
  static setLevel(level: LogLevel): void {
    Logger.minLevel = level;
  }

  constructor(readonly scope: string) {}

  child(sub: string): Logger {
    return new Logger(`${this.scope}:${sub}`);
  }

  private emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[Logger.minLevel]) return;
    const rec: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      msg: redact(msg),
    };
    if (data) rec.data = redactDeep(data);
    for (const s of Logger.sinks) {
      try {
        s(rec);
      } catch {
        // a failing sink must never take the app down
      }
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit("debug", msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.emit("info", msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit("warn", msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.emit("error", msg, data);
  }
}

function defaultConsoleSink(rec: LogRecord): void {
  const line = `${rec.ts} ${rec.level.toUpperCase().padEnd(5)} [${rec.scope}] ${rec.msg}${
    rec.data ? ` ${JSON.stringify(rec.data)}` : ""
  }`;
  if (rec.level === "error") console.error(line);
  else if (rec.level === "warn") console.warn(line);
  else console.log(line);
}

export const log = (scope: string): Logger => new Logger(scope);
