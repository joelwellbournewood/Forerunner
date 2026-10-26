/**
 * FakeGitHost: an in-process GitHub stand-in. REST API in GitHub's shapes (Hono on
 * @hono/node-server, 127.0.0.1 on an ephemeral port), git smart HTTP through
 * `git http-backend`, token scopes and permissions, rate limits, webhooks with HMAC
 * signatures and an admin API for seeding. See docs/maintainers/testing.md, "Fake git host".
 */
import type { Server } from "node:http";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  log,
  redact,
  systemClock,
} from "@forerunner/platform";
import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";
import {
  canSeeRepo,
  checkRepoAccess,
  newTokenValue,
  normaliseRepoPattern,
  RateLimiter,
  type TokenRecord,
} from "./auth.ts";
import { handleGitHttp } from "./cgi.ts";
import { locateHttpBackend } from "./git.ts";
import { type AuthContext, DOCS_URL, type HostContext, type HostEnv, HttpError } from "./http.ts";
import { LOGIN_NAME, RepoOps } from "./ops.ts";
import { INSTALLATION_TOKEN_TTL_MS, registerAppRoutes } from "./routes-app.ts";
import { registerCheckRoutes } from "./routes-checks.ts";
import { registerIssueRoutes } from "./routes-issues.ts";
import { registerProjectRoutes } from "./routes-projects.ts";
import { registerPullRoutes } from "./routes-pulls.ts";
import { registerReleaseRoutes } from "./routes-releases.ts";
import { registerRepoRoutes } from "./routes-repos.ts";
import {
  HostStore,
  type InstallationRecord,
  type Json,
  type RepoRecord,
  type UserRecord,
} from "./store.ts";
import type {
  CreateAppInput,
  CreateInstallationInput,
  CreateOrgInput,
  CreateRepoInput,
  CreateTokenInput,
  CreateUserInput,
  FakeGitHostOptions,
  HostEvent,
  IssuedToken,
  PermissionLevel,
  RepoPermission,
  RequestLogEntry,
  SeedCommitResult,
  WebhookDelivery,
} from "./types.ts";
import { WebhookDispatcher } from "./webhooks.ts";

const logger = log("testenv:githost");

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

export interface RepoSummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  /** The bare repository directory on disk. */
  dir: string;
}

export interface UserSummary {
  id: number;
  login: string;
  type: "User" | "Organization";
}

export class FakeGitHost {
  readonly clock: Clock;
  readonly store: HostStore;
  readonly ops: RepoOps;
  readonly rootDir: string;
  private readonly app: Hono<HostEnv>;
  private readonly limiter: RateLimiter;
  private readonly dispatcher: WebhookDispatcher;
  private readonly pending = new Set<Promise<unknown>>();
  private server: Server | null = null;
  private httpBackend: string | null = null;
  private requestCounter = 0;
  private baseUrlValue = "";

  private constructor(opts: FakeGitHostOptions) {
    this.clock = opts.clock ?? systemClock;
    this.rootDir = opts.rootDir;
    this.store = new HostStore(this.clock);
    this.ops = new RepoOps(this.store, this.clock, this.rootDir);
    this.limiter = new RateLimiter(this.clock, opts.rateLimit?.perHour ?? 5000);
    this.dispatcher = new WebhookDispatcher(this.clock);
    this.store.onEvent = (repo, event) => this.dispatcher.dispatch(event, repo.hooks.values());
    this.app = this.buildApp();
  }

  /** Start listening. `baseUrl` is `http://127.0.0.1:<port>` until `stop()`. */
  static async start(opts: FakeGitHostOptions): Promise<FakeGitHost> {
    const host = new FakeGitHost(opts);
    host.httpBackend = await locateHttpBackend();
    if (!host.httpBackend) logger.warn("git http-backend not found; git over HTTP is disabled");
    const server = createAdaptorServer({ fetch: host.app.fetch }) as Server;
    host.server = server;
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    const addr = server.address();
    if (!addr || typeof addr === "string")
      throw new ForerunnerError("internal", "fake git host: no address");
    host.baseUrlValue = `http://${addr.address}:${addr.port}`;
    host.store.baseUrl = host.baseUrlValue;
    return host;
  }

  get baseUrl(): string {
    return this.baseUrlValue;
  }

  /** False when `git http-backend` could not be located; git over HTTP then answers 503. */
  get gitHttpAvailable(): boolean {
    return this.httpBackend !== null;
  }

  async stop(): Promise<void> {
    await this.settle();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
  }

  /** Wait for post-push processing and every webhook delivery started so far. */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
    await this.dispatcher.flush();
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  // ---- admin API -----------------------------------------------------------------------------

  createUser(input: CreateUserInput): UserSummary {
    return this.addAccount(input.login, "User", input.name, input.email, []);
  }

  createOrg(input: CreateOrgInput): UserSummary {
    return this.addAccount(input.login, "Organization", input.name, undefined, input.members ?? []);
  }

  addMember(org: string, login: string): void {
    const o = this.store.user(org);
    if (o?.type !== "Organization") throw new ForerunnerError("not_found", `org ${org} not found`);
    if (!this.store.user(login)) throw new ForerunnerError("not_found", `user ${login} not found`);
    o.members.add(login.toLowerCase());
  }

  addCollaborator(repo: string, login: string): void {
    const r = this.requireRepo(repo);
    if (!this.store.user(login)) throw new ForerunnerError("not_found", `user ${login} not found`);
    r.collaborators.add(login.toLowerCase());
  }

  createToken(input: CreateTokenInput): IssuedToken {
    const owner = this.store.user(input.owner);
    if (!owner) throw new ForerunnerError("not_found", `user ${input.owner} not found`);
    let record: TokenRecord;
    if (input.kind === "classic") {
      record = this.newToken(
        "classic",
        owner.login,
        input.scopes,
        {},
        ["*"],
        input.expiresAt ?? null,
        null,
      );
    } else if (input.kind === "fine_grained") {
      record = this.newToken(
        "fine_grained",
        owner.login,
        [],
        input.permissions,
        input.repos.map((r) => normaliseRepoPattern(r, owner.login)),
        input.expiresAt ?? null,
        null,
      );
    } else {
      const inst = this.store.installations.get(input.installationId);
      if (!inst)
        throw new ForerunnerError("not_found", `installation ${input.installationId} not found`);
      record = this.issueInstallationToken(inst, {
        repos: input.repos,
        permissions: input.permissions,
      });
    }
    return this.issued(record);
  }

  createApp(input: CreateAppInput): { id: number; slug: string } {
    if (!this.store.user(input.owner))
      throw new ForerunnerError("not_found", `user ${input.owner} not found`);
    const id = this.store.nextId();
    this.store.apps.set(id, {
      id,
      slug: input.slug,
      name: input.name ?? input.slug,
      owner: input.owner,
    });
    const bot = `${input.slug}[bot]`;
    if (!this.store.user(bot))
      this.addAccount(bot, "User", input.name ?? input.slug, undefined, [], true);
    return { id, slug: input.slug };
  }

  createInstallation(input: CreateInstallationInput): { id: number } {
    if (!this.store.apps.get(input.appId))
      throw new ForerunnerError("not_found", `app ${input.appId} not found`);
    if (!this.store.user(input.account))
      throw new ForerunnerError("not_found", `account ${input.account} not found`);
    const id = this.store.nextId();
    this.store.installations.set(id, {
      id,
      appId: input.appId,
      account: input.account,
      repos:
        input.repos === "all"
          ? "all"
          : input.repos.map((r) => normaliseRepoPattern(r, input.account)),
      permissions: { ...input.permissions },
    });
    return { id };
  }

  async createRepo(input: CreateRepoInput): Promise<RepoSummary> {
    const repo = await this.ops.createRepo(input);
    return this.summary(repo);
  }

  /** Commit files on a branch (created from the default branch when missing); emits `push`. */
  async seedCommit(
    repo: string | { owner: string; name: string },
    files: Record<string, string | Uint8Array | null>,
    message: string,
    branch?: string,
  ): Promise<SeedCommitResult> {
    const r = this.requireRepo(repo);
    const target = branch ?? r.defaultBranch;
    const sha = await this.ops.commitFiles(r, target, files, message, r.owner);
    return { sha, branch: target };
  }

  repo(repo: string | { owner: string; name: string }): RepoSummary | null {
    const r =
      typeof repo === "string"
        ? this.store.repoByFullName(repo)
        : this.store.repo(repo.owner, repo.name);
    return r ? this.summary(r) : null;
  }

  /** Clone URL with the token embedded the way GitHub documents it (`x-access-token:<token>@`). */
  cloneUrl(repo: string | { owner: string; name: string }, token?: string): string {
    const r = this.requireRepo(repo);
    const url = new URL(`${this.baseUrl}/${r.fullName}.git`);
    if (token) {
      url.username = "x-access-token";
      url.password = token;
    }
    return url.toString();
  }

  events(): HostEvent[] {
    return [...this.store.events];
  }

  deliveries(): WebhookDelivery[] {
    return [...this.dispatcher.deliveries];
  }

  requests(): RequestLogEntry[] {
    return [...this.store.requests];
  }

  // ---- internals -----------------------------------------------------------------------------

  private addAccount(
    login: string,
    type: "User" | "Organization",
    name: string | undefined,
    email: string | undefined,
    members: string[],
    allowBotSuffix = false,
  ): UserSummary {
    const plain = allowBotSuffix ? login.replace(/\[bot\]$/, "") : login;
    if (!LOGIN_NAME.test(plain)) throw new ForerunnerError("validation", `invalid login: ${login}`);
    if (this.store.user(login))
      throw new ForerunnerError("validation", `account ${login} already exists`);
    for (const m of members) {
      if (!this.store.user(m)) throw new ForerunnerError("not_found", `user ${m} not found`);
    }
    const u: UserRecord = {
      id: this.store.nextId(),
      login,
      name: name ?? login,
      email: email ?? `${login.replace(/\[bot\]$/, "")}@users.noreply.fake-git-host`,
      type,
      members: new Set(members.map((m) => m.toLowerCase())),
      createdAt: this.clock.nowIso(),
    };
    this.store.users.set(login.toLowerCase(), u);
    return { id: u.id, login: u.login, type: u.type };
  }

  private newToken(
    kind: TokenRecord["kind"],
    owner: string,
    scopes: string[],
    permissions: Partial<Record<RepoPermission, PermissionLevel>>,
    repos: string[],
    expiresAt: string | null,
    installationId: number | null,
  ): TokenRecord {
    const record: TokenRecord = {
      id: this.store.nextId(),
      value: newTokenValue(kind),
      kind,
      owner,
      scopes: [...scopes],
      permissions: { ...permissions },
      repos,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : null,
      installationId,
      createdAt: this.clock.nowIso(),
    };
    this.store.tokens.set(record.value, record);
    this.store.tokensById.set(record.id, record);
    return record;
  }

  private issueInstallationToken(
    inst: InstallationRecord,
    narrow: { repos?: string[]; permissions?: Partial<Record<RepoPermission, PermissionLevel>> },
  ): TokenRecord {
    const appRec = this.store.apps.get(inst.appId);
    const bot = appRec ? `${appRec.slug}[bot]` : inst.account;
    const repos = narrow.repos
      ? narrow.repos.map((r) => normaliseRepoPattern(r, inst.account))
      : inst.repos === "all"
        ? [`${inst.account.toLowerCase()}/*`]
        : [...inst.repos];
    const permissions = narrow.permissions ?? inst.permissions;
    return this.newToken(
      "app_installation",
      bot,
      [],
      permissions,
      repos,
      new Date(this.clock.now() + INSTALLATION_TOKEN_TTL_MS).toISOString(),
      inst.id,
    );
  }

  private issued(t: TokenRecord): IssuedToken {
    return {
      id: t.id,
      token: t.value,
      kind: t.kind,
      owner: t.owner,
      scopes: [...t.scopes],
      permissions: { ...t.permissions },
      repos: [...t.repos],
      expiresAt: t.expiresAt ? new Date(t.expiresAt).toISOString() : null,
      installationId: t.installationId,
    };
  }

  private requireRepo(repo: string | { owner: string; name: string }): RepoRecord {
    const r =
      typeof repo === "string"
        ? this.store.repoByFullName(repo)
        : this.store.repo(repo.owner, repo.name);
    if (!r)
      throw new ForerunnerError(
        "not_found",
        `repo ${typeof repo === "string" ? repo : `${repo.owner}/${repo.name}`} not found`,
      );
    return r;
  }

  private summary(r: RepoRecord): RepoSummary {
    return {
      id: r.id,
      owner: r.owner,
      name: r.name,
      fullName: r.fullName,
      private: r.private,
      defaultBranch: r.defaultBranch,
      htmlUrl: `${this.baseUrl}/${r.fullName}`,
      cloneUrl: `${this.baseUrl}/${r.fullName}.git`,
      dir: r.dir,
    };
  }

  private track<T>(p: Promise<T>): void {
    const wrapped = p
      .catch((e: unknown) =>
        logger.warn("post-request work failed", { error: redact(errorMessage(e)) }),
      )
      .finally(() => this.pending.delete(wrapped));
    this.pending.add(wrapped);
  }

  /** Parse the Authorization header into a token (or an app JWT). `bad` when it names nothing. */
  private parseAuth(header: string | undefined, path: string): AuthContext & { bad: boolean } {
    const empty: AuthContext & { bad: boolean } = {
      token: null,
      subject: this.store.subjectFor(null),
      login: null,
      appJwt: null,
      bad: false,
    };
    if (!header) return empty;
    const space = header.indexOf(" ");
    const scheme = (space === -1 ? header : header.slice(0, space)).toLowerCase();
    const rest = space === -1 ? "" : header.slice(space + 1).trim();
    let candidate = "";
    if (scheme === "token" || scheme === "bearer") candidate = rest;
    else if (scheme === "basic") {
      const decoded = Buffer.from(rest, "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      const user = colon === -1 ? decoded : decoded.slice(0, colon);
      const pass = colon === -1 ? "" : decoded.slice(colon + 1);
      candidate = pass && pass !== "x-oauth-basic" ? pass : user;
    } else return { ...empty, bad: true };
    if (
      scheme === "bearer" &&
      (path === "/app" || path.startsWith("/app/")) &&
      candidate.split(".").length === 3
    ) {
      const payload = candidate.split(".")[1] ?? "";
      try {
        const json: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (json && typeof json === "object") return { ...empty, appJwt: json as Json };
      } catch {
        // not a JWT after all; fall through to token lookup
      }
    }
    const token = this.store.tokens.get(candidate);
    if (!token) return { ...empty, bad: true };
    if (token.expiresAt !== null && this.clock.now() >= token.expiresAt)
      return { ...empty, bad: true };
    return {
      token,
      subject: this.store.subjectFor(token),
      login: token.owner,
      appJwt: null,
      bad: false,
    };
  }

  private buildApp(): Hono<HostEnv> {
    const app = new Hono<HostEnv>();
    const store = this.store;

    // request log + auth parsing
    app.use("*", async (c, next) => {
      const started = this.clock.monotonic();
      const parsed = this.parseAuth(c.req.header("authorization"), c.req.path);
      c.set("auth", parsed);
      c.set("rate", null);
      await next();
      this.requestCounter += 1;
      const url = new URL(c.req.url);
      const entry: RequestLogEntry = {
        id: this.requestCounter,
        at: this.clock.nowIso(),
        method: c.req.method,
        path: url.pathname,
        query: url.search.replace(/^\?/, ""),
        status: c.res.status,
        auth: parsed.token
          ? { kind: parsed.token.kind, login: parsed.token.owner, tokenId: parsed.token.id }
          : null,
        durationMs: Math.round(this.clock.monotonic() - started),
      };
      store.requests.push(entry);
      c.res.headers.set("X-GitHub-Request-Id", `FAKE:${entry.id}`);
    });

    // git smart HTTP
    app.use("*", async (c, next) => {
      const m = GIT_PATH.exec(c.req.path);
      if (!m) return next();
      return this.handleGit(c, m[1] ?? "", m[2] ?? "", m[3] ?? "/");
    });

    // API: credentials, rate limit, common headers
    app.use("*", async (c, next) => {
      const auth = c.get("auth") as AuthContext & { bad?: boolean };
      if (auth.bad) throw new HttpError(401, "Bad credentials");
      const key = auth.token ? `token:${auth.token.id}` : "anon:127.0.0.1";
      const counted = c.req.path !== "/rate_limit";
      const rate = counted
        ? this.limiter.consume(key)
        : { ...this.limiter.peek(key), exceeded: false };
      c.set("rate", rate);
      const setRateHeaders = (headers: Headers) => {
        headers.set("X-RateLimit-Limit", String(rate.limit));
        headers.set("X-RateLimit-Remaining", String(rate.remaining));
        headers.set("X-RateLimit-Reset", String(rate.reset));
        headers.set("X-RateLimit-Used", String(rate.used));
        headers.set("X-RateLimit-Resource", "core");
        headers.set("X-GitHub-Media-Type", "github.v3; format=json");
        if (auth.token?.kind === "classic") {
          headers.set("X-OAuth-Scopes", auth.token.scopes.join(", "));
          headers.set("X-Accepted-OAuth-Scopes", "");
        }
      };
      if (rate.exceeded) {
        const who = auth.token ? `user ID ${store.user(auth.token.owner)?.id ?? 0}` : "127.0.0.1";
        const res = c.json(
          {
            message: `API rate limit exceeded for ${who}. (But here's the good news: Authenticated requests get a higher rate limit. Check out the documentation for more details.)`,
            documentation_url: `${DOCS_URL}/overview/resources-in-the-rest-api#rate-limiting`,
          },
          403,
        );
        setRateHeaders(res.headers);
        res.headers.set(
          "Retry-After",
          String(Math.max(1, rate.reset - Math.floor(this.clock.now() / 1000))),
        );
        return res;
      }
      await next();
      setRateHeaders(c.res.headers);
    });

    const ctx = {
      store,
      ops: this.ops,
      issueInstallationToken: (
        inst: InstallationRecord,
        narrow: Parameters<FakeGitHost["issueInstallationToken"]>[1],
      ) => this.issueInstallationToken(inst, narrow),
    };
    registerRepoRoutes(app, ctx);
    registerPullRoutes(app, ctx);
    registerIssueRoutes(app, ctx);
    registerReleaseRoutes(app, ctx);
    registerCheckRoutes(app, ctx);
    registerProjectRoutes(app, ctx);
    registerAppRoutes(app, ctx);

    app.notFound((c) => c.json({ message: "Not Found", documentation_url: DOCS_URL }, 404));
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        const res = c.json(err.body(), err.status);
        if (err.status === 401) res.headers.set("WWW-Authenticate", 'Basic realm="GitHub"');
        return res;
      }
      const message = redact(errorMessage(err));
      logger.error("unhandled error", { path: c.req.path, error: message });
      return c.json({ message: `Internal error: ${message}`, documentation_url: DOCS_URL }, 500);
    });
    return app;
  }

  private async handleGit(
    c: HostContext,
    ownerSeg: string,
    nameSeg: string,
    rest: string,
  ): Promise<Response> {
    const auth = c.get("auth") as AuthContext & { bad?: boolean };
    const unauthorized = () =>
      new Response("Authentication required\n", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="GitHub"', "Content-Type": "text/plain" },
      });
    if (auth.bad) return unauthorized();
    // GitHub's git endpoint authenticates Basic only: `bearer` / `token` answer 401 "invalid
    // credentials" there even for a token the REST API accepts (github.com, 2026-10-26).
    const header = c.req.header("authorization");
    if (header && !/^basic\s/i.test(header)) {
      return new Response("invalid credentials", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="GitHub"', "Content-Type": "text/plain" },
      });
    }
    const repo = this.store.repo(decodeURIComponent(ownerSeg), decodeURIComponent(nameSeg));
    const service =
      c.req.query("service") ??
      (rest.endsWith("/git-receive-pack") ? "git-receive-pack" : "git-upload-pack");
    const isWrite = service === "git-receive-pack";
    if (!repo || !canSeeRepo(auth.subject, repo)) {
      return auth.token
        ? new Response("Repository not found.\n", {
            status: 404,
            headers: { "Content-Type": "text/plain" },
          })
        : unauthorized();
    }
    const decision = checkRepoAccess(auth.subject, repo, "contents", isWrite ? "write" : "read");
    if (decision === "unauthenticated") return unauthorized();
    if (decision !== "ok") {
      return new Response(
        isWrite
          ? "Write access to repository not granted.\n"
          : "Read access to repository not granted.\n",
        {
          status: 403,
          headers: { "Content-Type": "text/plain" },
        },
      );
    }
    if (!this.httpBackend) {
      return new Response("git http-backend is not available on this machine\n", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    }
    const body = c.req.method === "POST" ? new Uint8Array(await c.req.arrayBuffer()) : null;
    const before = isWrite && c.req.method === "POST" ? await this.ops.refSnapshot(repo) : null;
    const url = new URL(c.req.url);
    const { response, done } = await handleGitHttp(this.httpBackend, {
      rootDir: this.rootDir,
      pathInfo: `/${repo.owner}/${repo.name}.git${rest}`,
      method: c.req.method,
      query: url.search.replace(/^\?/, ""),
      headers: c.req.raw.headers,
      body,
      remoteUser: auth.login,
      serverName: url.hostname,
      serverPort: url.port,
    });
    if (before) {
      const pusher = auth.login ?? repo.owner;
      this.track(
        done.then(async ({ code, stderr }) => {
          if (code !== 0)
            logger.debug("git-receive-pack exited non-zero", { code, stderr: redact(stderr) });
          const after = await this.ops.refSnapshot(repo);
          await this.ops.applyRefChanges(repo, before, after, pusher);
        }),
      );
    }
    return response;
  }
}
