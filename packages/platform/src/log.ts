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

/** Replace anything that looks like a credential with a stable marker. */
export function redact(input: string): string {
  let out = input;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => {
      const eq = m.match(/^([A-Za-z_ -]+[=:]\s*)/);
      if (eq?.[1]) return `${eq[1]}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return out;
}

export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 8) return value;
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/(secret|token|password|api[_-]?key|authorization|cookie)/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v, depth + 1);
      }
    }
    return out as T;
  }
  return value;
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
