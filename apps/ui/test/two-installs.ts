/**
 * Two people's Forerunners as people run them (w8-two-homes, wave 8; the owner's D9 of
 * 2026-11-09: "if multiple people will be running it they will be using their own api and
 * subscription and running it on their pc"). Each home is a whole runtime composed as `fr daemon`
 * composes it, on its own FORERUNNER_HOME with its own SQLite store, vault, identity, device row
 * (the install id) and GitHub login; the two meet only on one GitHub with the users ada and bob
 * and the organisation team (team/shared with one commit, team/empty with none). The test drives
 * each daemon only through the UI's own client (`createClient` over `app.request`), never by
 * patching a store, `settings.members` or `shared_with` (validation rules 1 and 3).
 *
 * Two GitHubs, one shape:
 * - `host: "memory"` (fast): one `MemoryGitHost` and a per-login view for each home
 *   (`asLogin`), with bare git repositories on disk as the clone URLs.
 * - `host: "http"`: the testenv stand-in GitHub (`FakeGitHost`, its REST API and git smart HTTP)
 *   with two users, an organisation and one classic token each; each home's `GitHubHost` sends
 *   its own token, so the host's request log names the login of every call.
 *
 * The API (later areas append helpers, never change these; shared_files of wave8-plan.json):
 * - `composeTwo(opts)`: both homes, the host and the repositories; `close()` settles and closes
 *   both daemons, stops the host and removes every folder it made.
 * - `home.client`, `home.rt`: the UI's client and the runtime (read-only use for assertions).
 * - `home.restart()`: compose that home again on the same home and vault (the daemon started
 *   again); `client` and `rt` are replaced.
 * - `home.githubOff()` / `home.githubOn()`: GitHub unreachable for that home only: every call of
 *   its GitHub client fails as a refused connection does (`provider_error`, "GitHub API
 *   unreachable at ..."); the other home is unaffected. Git over HTTP (`http`) and the bare
 *   repositories (`memory`) are not cut: the bench's `cut.mjs` cuts the whole connection.
 * - `home.holdModelCalls(when)`: hold that home's model calls matching `when` until `release()`
 *   (as scenario 04's holds), so a test can freeze a session mid-task.
 * - `two.writesBy(login)`: every write that login made on the host, in order (the memory host's
 *   write log, or the stand-in's request log: non-GET calls and git pushes).
 * - `two.pullRequests()`: the host's pull requests in any state, read by neither home.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { appDirs, ForerunnerError, join, run, SystemClock } from "@forerunner/platform";
import {
  type ComposeOptions,
  composeRuntime,
  type RuntimeApp,
} from "@forerunner/runtime/daemon/compose";
import { createDaemonApp } from "@forerunner/runtime/daemon/server";
import type { ModelProvider, ModelRequest } from "@forerunner/runtime/provider/types";
import { SECRET_NAMES } from "@forerunner/runtime/setup/wizard";
import { MemoryVault } from "@forerunner/vault";
import { GitOps } from "../../../packages/capabilities/src/githost/git.ts";
import { GitHubHost } from "../../../packages/capabilities/src/githost/github.ts";
import { MemoryGitHost } from "../../../packages/capabilities/src/githost/memory.ts";
import type {
  GitHost,
  PullRequestInfo,
  RepoRef,
} from "../../../packages/capabilities/src/githost/types.ts";
import { removeHomes, settleSessions } from "../../../packages/runtime/test/helpers.ts";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import {
  type BenchOptions,
  benchOptionsFromEnv,
  createRolePlayer,
} from "../../../testenv/src/bench/role-player.ts";
import { FakeGitHost } from "../../../testenv/src/githost/fake-git-host.ts";
import { createClient, type DaemonClient } from "../src/api/client.ts";

const REGISTRY = fileURLToPath(new URL("../../../evals/registry", import.meta.url));

/** No container engine, whatever the machine has (U-079): tier 0 and 1 run in the stand-in. */
const NO_ENGINE = {
  engine: "none" as const,
  problem: "not_installed" as const,
  reason: "test: no engine",
  checkedAt: "2026-11-24T08:00:00.000Z",
};

/** The people of the two homes: their name here, their GitHub login, their agent's name. */
export const PEOPLE = {
  ada: { humanName: "Ada", login: "ada", agentName: "Ada's agent" },
  bob: { humanName: "Bob", login: "bob", agentName: "Bob's agent" },
} as const;
export type PersonKey = keyof typeof PEOPLE;

/** The organisation's repositories both people can push to. */
export const TEAM_SHARED: RepoRef = { owner: "team", name: "shared" };
export const TEAM_EMPTY: RepoRef = { owner: "team", name: "empty" };

/** What a write did, the same on both hosts. */
export type HostWriteAction =
  | "repo.create"
  | "file"
  | "push"
  | "pull_request.create"
  | "pull_request.update"
  | "pull_request.merge"
  | "review"
  | "comment"
  | "comment.update"
  | "issue.create"
  | "issue.update"
  | "other";

/** One write a login made on the host. */
export interface HostWrite {
  login: string;
  action: HostWriteAction;
  /** The memory host's operation (`createPullRequest`), or `METHOD /path` on the stand-in. */
  op: string;
  /** "owner/name", when the write names a repository. */
  repo: string;
  /** The pull request or issue number, when the write names one. */
  number?: number;
  detail?: string;
}

/** Model calls a test holds until it lets them go (scenario 04's holds). */
export interface HeldCalls {
  /** Resolves with the first held request; rejects after 20 s with what it waited for. */
  waiting: Promise<ModelRequest>;
  release(): void;
  readonly released: boolean;
}

export interface Home {
  readonly key: PersonKey;
  readonly login: string;
  readonly humanName: string;
  /** This home's FORERUNNER_HOME. */
  readonly home: string;
  rt: RuntimeApp;
  /** The UI's own client against this home's daemon. */
  client: DaemonClient;
  /** The bench stand-in's knobs, read at each call. */
  readonly bench: BenchOptions;
  /** Every model call this home's stand-in received, in order. */
  readonly modelCalls: ModelRequest[];
  restart(): Promise<void>;
  githubOff(): void;
  githubOn(): void;
  readonly githubIsOff: boolean;
  holdModelCalls(when: (req: ModelRequest) => boolean): HeldCalls;
}

export interface TwoHomes {
  readonly kind: "memory" | "http";
  readonly ada: Home;
  readonly bob: Home;
  readonly repo: RepoRef;
  readonly emptyRepo: RepoRef;
  /** The memory host (memory) or the stand-in GitHub (http). */
  readonly memory: MemoryGitHost | null;
  readonly http: FakeGitHost | null;
  writesBy(login: string): HostWrite[];
  pullRequests(repo?: RepoRef): Promise<PullRequestInfo[]>;
  close(): Promise<void>;
}

export interface ComposeTwoOptions {
  host: "memory" | "http";
  /** Stand-in knobs per home (`FORERUNNER_BENCH_*`), beside FORERUNNER_BENCH_DELAY_MS=0. */
  bench?: Partial<Record<PersonKey, Record<string, string>>>;
}

/** What a refused connection to GitHub throws through `GitHubHost` (its `send`). */
function unreachable(baseUrl: string): ForerunnerError {
  return new ForerunnerError(
    "provider_error",
    `GitHub API unreachable at ${baseUrl}: connection refused`,
    { retryable: true },
  );
}

/** A GitHost whose every call fails while `off()` says so (the home's GitHub-off switch). */
function switchable(inner: GitHost, off: () => boolean): GitHost {
  return new Proxy(inner, {
    get(target, prop) {
      // Read on the target itself: a getter or a method keeps its own `this`.
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (off()) {
          const failed = Promise.reject(unreachable(target.baseUrl));
          return failed;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** The bench stand-in for one home, with holds and a record of every call. */
function standIn(home: string, env: Record<string, string>) {
  const bench = benchOptionsFromEnv(
    { FORERUNNER_BENCH_DELAY_MS: "0", ...env },
    new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
  );
  const provider: ModelProvider = createRolePlayer(bench);
  const calls: ModelRequest[] = [];
  const holds: { when: (r: ModelRequest) => boolean; held: HeldCallsImpl }[] = [];
  const gate = async (req: ModelRequest) => {
    calls.push({ ...req, messages: structuredClone(req.messages) });
    for (const h of holds) if (!h.held.released && h.when(req)) await h.held.hold(req);
  };
  const stream = provider.stream.bind(provider);
  provider.stream = async function* (req) {
    await gate(req);
    yield* stream(req);
  };
  return {
    bench,
    provider,
    calls,
    hold(when: (r: ModelRequest) => boolean): HeldCalls {
      const held = new HeldCallsImpl();
      holds.push({ when, held });
      return held;
    },
    releaseAll: () => {
      for (const h of holds) h.held.release();
    },
  };
}

class HeldCallsImpl implements HeldCalls {
  private first: ((r: ModelRequest) => void) | null = null;
  private gates: (() => void)[] = [];
  released = false;
  readonly waiting: Promise<ModelRequest>;
  constructor() {
    this.waiting = new Promise<ModelRequest>((resolve, reject) => {
      this.first = resolve;
      const timer = setTimeout(
        () => reject(new Error("still waiting after 20 s for a held model call")),
        20_000,
      );
      timer.unref?.();
    });
    this.waiting.catch(() => undefined);
  }
  hold(req: ModelRequest): Promise<void> {
    this.first?.(req);
    this.first = null;
    if (this.released) return Promise.resolve();
    return new Promise<void>((resolve) => this.gates.push(resolve));
  }
  release(): void {
    this.released = true;
    for (const g of this.gates.splice(0)) g();
  }
}

/** A bare repository on disk: with a README commit on main, or with no commit at all. */
async function bareRepo(dir: string, name: string, seeded: boolean): Promise<string> {
  const bare = join(dir, `${name}.git`);
  await run(["git", "init", "--bare", "-b", "main", bare]);
  if (seeded) {
    const seed = new GitOps({
      cwd: join(dir, `${name}-seed`),
      identity: { name: "Seed", email: "seed@example.test" },
    });
    await seed.clone(bare);
    writeFileSync(join(dir, `${name}-seed`, "README.md"), `# ${name}\n`);
    await seed.commitAll("seed");
    await seed.push("main");
  }
  return bare;
}

const MEMORY_ACTIONS: Record<string, HostWriteAction> = {
  createRepo: "repo.create",
  putFile: "file",
  createPullRequest: "pull_request.create",
  updatePullRequest: "pull_request.update",
  mergePullRequest: "pull_request.merge",
  reviewPullRequest: "review",
  commentOnPullRequest: "comment",
  commentOnIssue: "comment",
  createIssue: "issue.create",
  updateIssue: "issue.update",
};

/** A stand-in request as a write: the repository, the number and what it did. */
function writeOfRequest(login: string, method: string, path: string): HostWrite {
  const repo = /^\/repos\/([^/]+)\/([^/]+)/.exec(path);
  const git = /^\/([^/]+)\/([^/]+?)\.git\/git-receive-pack$/.exec(path);
  const num = /^\/repos\/[^/]+\/[^/]+\/(?:pulls|issues)\/(\d+)/.exec(path);
  const rest = repo ? path.slice(repo[0].length) : path;
  const name = repo ? `${repo[1]}/${repo[2]}` : git ? `${git[1]}/${git[2]}` : "";
  const action: HostWriteAction = git
    ? "push"
    : /^\/(user|orgs\/[^/]+)\/repos$/.test(path) && method === "POST"
      ? "repo.create"
      : rest.startsWith("/contents/")
        ? "file"
        : rest === "/pulls" && method === "POST"
          ? "pull_request.create"
          : /^\/pulls\/\d+$/.test(rest) && method === "PATCH"
            ? "pull_request.update"
            : /^\/pulls\/\d+\/merge$/.test(rest)
              ? "pull_request.merge"
              : /^\/pulls\/\d+\/reviews/.test(rest)
                ? "review"
                : /^\/issues\/\d+\/comments$/.test(rest) && method === "POST"
                  ? "comment"
                  : /^\/issues\/comments\/\d+$/.test(rest)
                    ? "comment.update"
                    : rest === "/issues" && method === "POST"
                      ? "issue.create"
                      : /^\/issues\/\d+$/.test(rest) && method === "PATCH"
                        ? "issue.update"
                        : "other";
  return {
    login,
    action,
    op: git ? "git push" : `${method} ${path}`,
    repo: name,
    ...(num ? { number: Number(num[1]) } : {}),
  };
}

export async function composeTwo(opts: ComposeTwoOptions): Promise<TwoHomes> {
  const work = mkdtempSync(join(tmpdir(), "fr-two-homes-"));
  const clock = new SystemClock();
  let memory: MemoryGitHost | null = null;
  let http: FakeGitHost | null = null;
  const tokens: Partial<Record<PersonKey, string>> = {};
  if (opts.host === "memory") {
    const shared = await bareRepo(work, "shared", true);
    const empty = await bareRepo(work, "empty", false);
    // The repositories exist before either person: made by an account neither home is.
    memory = new MemoryGitHost("github-setup");
    await memory.createRepo({ ...TEAM_SHARED, private: true, cloneUrl: shared });
    await memory.createRepo({ ...TEAM_EMPTY, private: true, cloneUrl: empty });
  } else {
    http = await FakeGitHost.start({ rootDir: join(work, "github"), clock });
    for (const key of Object.keys(PEOPLE) as PersonKey[])
      http.createUser({ login: PEOPLE[key].login, name: PEOPLE[key].humanName });
    http.createOrg({ login: "team", name: "Team", members: ["ada", "bob"] });
    await http.createRepo({
      ...TEAM_SHARED,
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# shared\n" },
    });
    await http.createRepo({ ...TEAM_EMPTY, private: true, defaultBranch: "main" });
    for (const key of Object.keys(PEOPLE) as PersonKey[])
      tokens[key] = http.createToken({
        owner: PEOPLE[key].login,
        kind: "classic",
        scopes: ["repo"],
      }).token;
  }

  const homes: Home[] = [];
  const makeHome = async (key: PersonKey): Promise<Home> => {
    const person = PEOPLE[key];
    const home = join(work, `home-${key}`);
    mkdirSync(home, { recursive: true });
    const env = { FORERUNNER_HOME: home };
    const vault = new MemoryVault();
    const model = standIn(home, opts.bench?.[key] ?? {});
    let off = false;
    let inner: GitHost;
    let config: ComposeOptions["config"] = null;
    if (memory) inner = memory.asLogin(person.login);
    else {
      const host = http as FakeGitHost;
      const token = tokens[key] as string;
      await vault.set(SECRET_NAMES.github, token);
      // The home's GitHub calls go through this fetch: with GitHub off they fail as a refused
      // connection does, so the GitHub client says it in its own words.
      const fetchImpl: typeof fetch = (input, init) =>
        off ? Promise.reject(new TypeError("fetch failed")) : fetch(input, init);
      inner = new GitHubHost({ token, baseUrl: host.baseUrl, clock, fetchImpl });
      config = {
        version: 1,
        profile: "default",
        timezone: "Europe/Zurich",
        githubApiBase: host.baseUrl,
        anthropicApiBase: "http://an.test",
        repos: [],
        credentials: { github: true, anthropic: false, anthropicSubscription: false },
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      };
    }
    const gitHost = switchable(inner, () => off);
    const compose = async () => {
      const rt = await composeRuntime({
        env,
        dirs: appDirs({ env }),
        config,
        clock,
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        vault,
        provider: model.provider,
        registryDir: REGISTRY,
        identity: {
          humanName: person.humanName,
          timezone: "Europe/Zurich",
          agentName: person.agentName,
        },
        appVersion: "0.0.0-two-homes",
        sandboxDetection: NO_ENGINE,
        gitHost,
        tryIt: false,
        data: { projectsRoot: join(home, "projects") },
        startServices: false,
        // Its own device row, the install id (compose registers it with this option and no
        // services; the remote watcher stays off without services).
        remote: { enabled: true },
      });
      const { app, token } = createDaemonApp(rt);
      const client = createClient(
        {
          baseUrl: "http://daemon.test",
          token,
          source: "env",
          installId: null,
          platform: null,
          shellVersion: null,
        },
        (input, init) => Promise.resolve(app.request(input, init)),
      );
      return { rt, client };
    };
    const first = await compose();
    const h: Home = {
      key,
      login: person.login,
      humanName: person.humanName,
      home,
      rt: first.rt,
      client: first.client,
      bench: model.bench,
      modelCalls: model.calls,
      async restart() {
        await settleSessions(h.rt);
        await h.rt.close();
        const next = await compose();
        h.rt = next.rt;
        h.client = next.client;
      },
      githubOff() {
        off = true;
      },
      githubOn() {
        off = false;
      },
      get githubIsOff() {
        return off;
      },
      holdModelCalls: (when) => model.hold(when),
    };
    // On close every hold lets go, so no session waits on a test that ended.
    (h as Home & { releaseAll: () => void }).releaseAll = model.releaseAll;
    homes.push(h);
    return h;
  };

  let observer: GitHubHost | null = null;
  try {
    const ada = await makeHome("ada");
    const bob = await makeHome("bob");
    return {
      kind: opts.host,
      ada,
      bob,
      repo: TEAM_SHARED,
      emptyRepo: TEAM_EMPTY,
      memory,
      http,
      writesBy(login) {
        if (memory)
          return memory
            .writesBy(login)
            .map((w) => ({ ...w, action: MEMORY_ACTIONS[w.op] ?? "other" }));
        const host = http as FakeGitHost;
        return host
          .requests()
          .filter(
            (r) =>
              r.method !== "GET" &&
              r.method !== "HEAD" &&
              r.auth?.login.toLowerCase() === login.toLowerCase() &&
              !/\/git-upload-pack$/.test(r.path),
          )
          .map((r) => writeOfRequest(r.auth?.login ?? login, r.method, r.path));
      },
      async pullRequests(repo = TEAM_SHARED) {
        if (memory) return memory.listPullRequests(repo, { state: "all" });
        // Read with a token of the test's own (ada's account, a token neither home holds):
        // reads are never writes, so `writesBy` is unchanged.
        const host = http as FakeGitHost;
        observer ??= new GitHubHost({
          token: host.createToken({ owner: "ada", kind: "classic", scopes: ["repo"] }).token,
          baseUrl: host.baseUrl,
          clock,
        });
        return observer.listPullRequests(repo, { state: "all" });
      },
      async close() {
        const failures: unknown[] = [];
        for (const h of homes) {
          (h as Home & { releaseAll?: () => void }).releaseAll?.();
          await settleSessions(h.rt).catch((e: unknown) => failures.push(e));
          await h.rt.close().catch(() => undefined);
        }
        await http?.stop().catch(() => undefined);
        try {
          removeHomes([work]);
        } catch (e) {
          failures.push(e);
        }
        if (failures.length > 0) throw failures[0];
      },
    };
  } catch (e) {
    for (const h of homes) await h.rt.close().catch(() => undefined);
    await http?.stop().catch(() => undefined);
    removeHomes([work]);
    throw e;
  }
}
