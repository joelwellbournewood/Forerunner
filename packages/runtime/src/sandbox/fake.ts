import { ForerunnerError, normalizeNewlines, type RunResult } from "@forerunner/platform";
import { containPath } from "./contain.ts";
import type { NetworkPolicy, Sandbox, SandboxRunOptions } from "./types.ts";

/**
 * In-memory sandbox for unit tests of callers (executors, tools). Files live in a Map keyed by
 * forward-slash relative path; commands return scripted results matched in order of
 * registration, or the default result. Every call is recorded.
 */
export type FakeRunMatcher = string | RegExp | ((argv: readonly string[]) => boolean);

export interface FakeRunRule {
  match: FakeRunMatcher;
  result:
    | Partial<RunResult>
    | ((argv: readonly string[], opts: SandboxRunOptions) => Partial<RunResult>);
}

export interface FakeSandboxOptions {
  worktree?: string;
  network?: NetworkPolicy;
  files?: Record<string, string>;
  rules?: FakeRunRule[];
  defaultResult?: Partial<RunResult>;
}

export interface FakeSandboxCall {
  argv: string[];
  opts: SandboxRunOptions;
}

const DEFAULT_WORKTREE = "/fake/worktree";

export class FakeSandbox implements Sandbox {
  readonly kind = "fake" as const;
  readonly worktree: string;
  readonly network: NetworkPolicy;
  readonly files = new Map<string, string>();
  readonly calls: FakeSandboxCall[] = [];
  destroyed = false;
  private readonly rules: FakeRunRule[];
  private readonly defaultResult: Partial<RunResult>;

  constructor(opts: FakeSandboxOptions = {}) {
    this.worktree = opts.worktree ?? DEFAULT_WORKTREE;
    this.network = opts.network ?? { mode: "none" };
    this.rules = [...(opts.rules ?? [])];
    this.defaultResult = opts.defaultResult ?? {};
    for (const [p, c] of Object.entries(opts.files ?? {})) this.files.set(this.key(p), c);
  }

  /** Add a scripted result; later rules win over earlier ones. */
  script(match: FakeRunMatcher, result: FakeRunRule["result"]): this {
    this.rules.unshift({ match, result });
    return this;
  }

  async run(argv: readonly string[], opts: SandboxRunOptions = {}): Promise<RunResult> {
    if (this.destroyed) throw new ForerunnerError("unavailable", "fake sandbox was destroyed");
    if (argv.length === 0) throw new ForerunnerError("validation", "empty argv");
    containPath(this.worktree, opts.cwd ?? "");
    this.calls.push({ argv: [...argv], opts });
    const rule = this.rules.find((r) => matches(r.match, argv));
    const partial = rule
      ? typeof rule.result === "function"
        ? rule.result(argv, opts)
        : rule.result
      : this.defaultResult;
    return {
      code: 0,
      signal: null,
      stdout: "",
      stderr: "",
      truncated: false,
      timedOut: false,
      durationMs: 1,
      ...partial,
    };
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    this.files.set(this.key(relPath), normalizeNewlines(content));
  }

  async readFile(relPath: string): Promise<string> {
    const v = this.files.get(this.key(relPath));
    if (v === undefined) throw new ForerunnerError("not_found", `file not found: ${relPath}`);
    return v;
  }

  async exists(relPath: string): Promise<boolean> {
    const k = this.key(relPath);
    if (this.files.has(k)) return true;
    const prefix = `${k}/`;
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
    return false;
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  private key(relPath: string): string {
    return containPath(this.worktree, relPath).rel;
  }
}

function matches(m: FakeRunMatcher, argv: readonly string[]): boolean {
  if (typeof m === "function") return m(argv);
  const line = argv.join(" ");
  if (typeof m === "string") return argv[0] === m || line === m || line.includes(m);
  return m.test(line);
}
