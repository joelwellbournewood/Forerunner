/**
 * A research install on the scenario world with the capabilities of spec module L and the
 * email tools of module S (scenario 6 "Injection"): the install's own executor stack (a
 * `LoopTaskExecutor` with the built-in file tools, the sandboxed browser's tools and the
 * agent email tools inside the install's `PrTaskExecutor`, the install's hooks, driver,
 * critic and memory), a `SessionRunner` on it, and the notifier wired to the loop's
 * `injection_flagged` run events the way the daemon raises every other urgent notification.
 *
 * The browser is the real `BrowserSessionManager` over Playwright's Chromium when one can be
 * launched (profile under the install's own home, headless, the site policy bound to the run's
 * domains). Where no Chromium exists (a runner without the browsers), the same two tool
 * specs run on a stand-in that fetches the page over HTTP after the same `SitePolicy.assert`,
 * follows a redirect hop by hop through the same policy and the same hop cap as the session
 * (never through `fetch`'s own follow), and extracts the page with the static half of the same
 * extractor (`extractFromHtml`: visible text, hidden text apart, the same injection scan); the
 * scenario says which mode ran. The enforcement around the tools (allowlist, domains, paths,
 * autonomy, audit, untrusted output wrapping and scanning) is the production hooks either way.
 *
 * Nothing here widens a grant: the run's token covers the research tools only; the registry
 * also holds the tools an injected instruction would reach for (`email_send`, `run_command`,
 * `browser_fill_secret`, ...) so the hooks, not a missing registration, are what refuse them.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PrTaskExecutor } from "@forerunner/capabilities";
import {
  HumanRequestApprovalPort as BrowserApprovals,
  BrowserSessionManager,
  browserTools,
  extractFromHtml,
  launchAgentBrowser,
  MAX_REDIRECT_HOPS,
  renderExtract,
  resolveChromiumExecutable,
  SitePolicy,
} from "@forerunner/capabilities/browser/index";
import { emailTools, type Mailbox } from "@forerunner/capabilities/email/index";
import { errorMessage, ForerunnerError, join } from "@forerunner/platform";
import {
  type InjectionReport,
  LoopTaskExecutor,
  type RunEvent,
  type SessionResult,
  SessionRunner,
  type SessionStartOptions,
  type SpecialistSpec,
  StateAudit,
  StaticPlanner,
  type ToolExecutionContext,
  type ToolRegistry,
  type ToolSpec,
} from "@forerunner/runtime";
import { fileTools } from "@forerunner/runtime/daemon/tools";
import type { TaskRow } from "@forerunner/state";
// The cloud runner is a service, not a workspace package of tests/e2e: its mailbox watcher
// (the only one in the codebase) is reached by relative path.
import type { EmailWatch } from "../../../services/cloud-runner/src/email-watch.ts";
import { type ScenarioNotifier, scenarioNotifier } from "./scenario-notify.ts";
import type { Install, ScenarioEvent, ScenarioWorld } from "./scenario-world.ts";
import { briefOf, flatPricing, hasTool } from "./world.ts";

// ---------------------------------------------------------------------------------------
// Chromium

export type BrowserMode = "chromium" | "static";

export interface BrowserProbe {
  mode: BrowserMode;
  reason: string;
}

/**
 * Whether Playwright's Chromium (its pinned revision, or one under PLAYWRIGHT_BROWSERS_PATH)
 * can be launched with a profile under `home`; `playwright install` is never run.
 */
export async function probeBrowser(home: string): Promise<BrowserProbe> {
  const probe = resolveChromiumExecutable();
  if (!probe.ok) return { mode: "static", reason: probe.reason };
  try {
    const launched = await launchAgentBrowser({
      agentId: "probe",
      appDirs: { env: { ...process.env, FORERUNNER_HOME: home } },
      timeoutMs: 60_000,
    });
    await launched.context.close();
    return { mode: "chromium", reason: probe.reason };
  } catch (e) {
    return { mode: "static", reason: errorMessage(e).split("\n")[0] ?? "launch failed" };
  }
}

// ---------------------------------------------------------------------------------------
// Sites on the loopback interface

export interface Hit {
  method: string;
  url: string;
  host: string;
  userAgent: string;
}

export interface LoopbackSite {
  /** The origin the policy sees (hostname and port). */
  origin: string;
  host: string;
  port: number;
  hits: Hit[];
  close(): Promise<void>;
}

/** A path's answer: an HTML page (200), or a redirect (302 by default) to `location`. */
export type LoopbackPage = string | { redirect: string; status?: number };

/**
 * One HTTP server on 127.0.0.1 answering `pages` by path (404 otherwise), addressed by
 * `hostname` so two sites on the loopback interface are told apart by name as a token tells
 * domains apart: the run allows one hostname and not the other. A redirect page answers with
 * a `Location` header and no body, the way a site bounces a visitor to another host.
 */
export async function loopbackSite(
  hostname: "127.0.0.1" | "localhost",
  pages: Record<string, LoopbackPage>,
): Promise<LoopbackSite> {
  const hits: Hit[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    hits.push({
      method: req.method ?? "",
      url,
      host: String(req.headers.host ?? ""),
      userAgent: String(req.headers["user-agent"] ?? ""),
    });
    const path = url.split("?")[0] ?? url;
    const page = pages[path];
    if (page === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    if (typeof page !== "string") {
      res.writeHead(page.status ?? 302, { location: page.redirect });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return {
    origin: `http://${hostname}:${port}`,
    host: hostname,
    port,
    hits,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ---------------------------------------------------------------------------------------
// The research install

/** Tools the research grant covers: reading the web and the mailbox, writing in the worktree. */
export const RESEARCH_TOOLS = [
  "read_file",
  "write_file",
  "list_dir",
  "browser_navigate",
  "browser_read",
  "browser_screenshot",
  "browser_close",
  "email_list",
  "email_read",
] as const;

export interface ResearchInstallOptions {
  /** The agent mailbox watcher whose policy, settings, identity and sent log the email tools use. */
  watch: EmailWatch;
  mailbox: Mailbox;
  /** Hostnames the research runs may reach (the page site); the git host's is added. */
  pageHosts: string[];
  browser: BrowserMode;
  /** FORERUNNER_HOME of the browser profile; default `<world root>/home-<install>`. */
  home?: string;
  /** Specialist caps for the research runs (the registry's otherwise). */
  specialist?: { maxTurns?: number; maxBudgetUsdMicro?: number; timeoutMs?: number };
}

export interface FlaggedRecord {
  taskId: string;
  tool: string;
  report: InjectionReport;
  at: string;
}

export interface ResearchInstall {
  mode: BrowserMode;
  tools: ToolRegistry;
  grant: SessionStartOptions["grant"];
  runner: SessionRunner;
  notify: ScenarioNotifier;
  browser: BrowserSessionManager;
  /** Every `injection_flagged` run event, in order. */
  flagged: FlaggedRecord[];
  /** Every run event per task (model calls, tool calls, denials, warnings). */
  runEvents: Array<{ taskId: string; event: RunEvent; at: string }>;
  runSession(opts?: { budgetCapUsdMicro?: number }): Promise<SessionResult>;
  /** Resolves once every notification raised so far has been delivered (or failed). */
  settled(): Promise<void>;
  close(): Promise<void>;
}

export async function researchInstall(
  world: ScenarioWorld,
  install: Install,
  opts: ResearchInstallOptions,
): Promise<ResearchInstall> {
  const { store, clock } = world;
  const home = opts.home ?? join(world.root, `home-${install.name.toLowerCase()}`);
  const gitHostName = new URL(world.gitHost.baseUrl).hostname;
  const domains = [...new Set([...opts.pageHosts, gitHostName])];
  const notify = scenarioNotifier(world);
  const flagged: FlaggedRecord[] = [];
  const runEvents: ResearchInstall["runEvents"] = [];

  // The browser: the production manager over the agent's profile; the production inbox port
  // answers its guards (passwords, payment, purchases) as human requests.
  const browser = new BrowserSessionManager({
    binding: () => ({ allowedDomains: domains, autonomy: 2 }),
    approvals: new BrowserApprovals(store.humanRequest, clock),
    audit: new StateAudit(store),
    clock,
    launch: { appDirs: { env: { ...process.env, FORERUNNER_HOME: home } }, timeoutMs: 60_000 },
  });
  const tools = fileTools();
  const realBrowserTools = browserTools(browser);
  for (const t of opts.browser === "chromium"
    ? realBrowserTools
    : staticBrowserTools(realBrowserTools, domains))
    tools.register(t);
  for (const t of emailTools({
    policy: opts.watch.policy,
    settings: opts.watch.settings,
    identity: opts.watch.identity,
    sentLog: opts.watch.sentLog,
    mailboxFor: async () => opts.mailbox,
    clock,
  }))
    tools.register(t);

  // The researcher: the registry's prompt and caps, the research tools and the page hosts.
  const specialistSpec = (name: string): SpecialistSpec | undefined => {
    const d = world.registry.specialists.get(name);
    if (!d) return undefined;
    return {
      name: d.name,
      prompt: d.prompt,
      promptVersion: d.promptVersion,
      defaultTier: d.default_tier,
      defaultEffort: d.default_effort,
      allowedTools: [...RESEARCH_TOOLS],
      allowedDomains: domains,
      maxBudgetUsdMicro:
        opts.specialist?.maxBudgetUsdMicro ?? Math.round(d.max_budget_usd * 1_000_000),
      maxTurns: opts.specialist?.maxTurns ?? d.max_turns,
      timeoutMs: opts.specialist?.timeoutMs ?? d.timeout_minutes * 60_000,
    };
  };
  // Notifications in flight: the run goes on while the notifier delivers (as in the daemon),
  // and `settled()` lets a scenario wait for every delivery before it reads the records.
  const inFlight = new Set<Promise<void>>();
  const onEvent = (taskId: string, ev: RunEvent) => {
    runEvents.push({ taskId, event: ev, at: clock.nowIso() });
    if (ev.type !== "injection_flagged") return;
    flagged.push({ taskId, tool: ev.tool, report: ev.report, at: clock.nowIso() });
    // What the daemon owes on this event (spec L, scenario 6): the human is told, urgently.
    const delivery = (async () => {
      const [active] = await store.session.active(install.agent.id);
      await notify.producers.injectionFlagged(install.human.id, ev.report, {
        origin: ev.tool,
        sessionId: active?.id,
        projectId: active?.project_id ?? null,
      });
    })().catch(() => undefined);
    inFlight.add(delivery);
    void delivery.finally(() => inFlight.delete(delivery));
  };
  const loopDeps = {
    store,
    clock,
    tokens: install.tokens,
    driver: install.driver,
    provider: world.gated,
    pricing: flatPricing,
    tools,
    billingSourceId: `bs-${install.name.toLowerCase()}`,
    specialists: specialistSpec,
    ...(install.memory ? { memory: install.memory } : {}),
    onEvent,
  };
  const executor = new PrTaskExecutor({
    store,
    clock,
    host: install.github,
    inner: {
      execute: (ctx) => new LoopTaskExecutor(loopDeps).execute(ctx),
      withWorktree: (dir) => new LoopTaskExecutor({ ...loopDeps, worktreeFor: async () => dir }),
    },
    repoFor: async (task: TaskRow) => {
      const project = await store.project.get(task.project_id);
      const full = project?.repos[0];
      if (!full?.includes("/")) return null;
      const [owner, name] = full.split("/") as [string, string];
      const info = await install.github.getRepo({ owner, name });
      return { clone: world.project.cloneUrl, repo: { owner, name }, base: info.defaultBranch };
    },
    worktreeRoot: install.worktreeRoot,
    token: install.gitTokenValue,
    identity: { name: `${install.agent.name} (Forerunner)`, email: install.human.email },
  });
  const runner = new SessionRunner({
    store,
    clock,
    tokens: install.tokens,
    kill: install.kill,
    planner: new StaticPlanner(),
    executor,
    critic: install.critic,
    ...(install.memory ? { memory: install.memory } : {}),
  });
  const grant: SessionStartOptions["grant"] = {
    allowedTools: [...RESEARCH_TOOLS],
    allowedPaths: [install.worktreeRoot],
    allowedDomains: domains,
    grantedSecrets: [],
    maxDepth: 2,
  };
  return {
    mode: opts.browser,
    tools,
    grant,
    runner,
    notify,
    browser,
    flagged,
    runEvents,
    runSession: (o = {}) =>
      runner.start({
        agentId: install.agent.id,
        projectId: world.project.id,
        trigger: "manual",
        budgetCapUsdMicro: o.budgetCapUsdMicro ?? 5_000_000,
        appVersion: "1.0.0-scenario",
        grant,
        onEvent: (type, payload) => {
          const e: ScenarioEvent = {
            seq: world.events.length,
            agentId: install.agent.id,
            agentName: install.agent.name,
            projectId: world.project.id,
            trigger: "manual",
            type,
            payload,
            at: clock.nowIso(),
          };
          world.events.push(e);
        },
      }),
    settled: async () => {
      await Promise.all([...inFlight]);
    },
    close: async () => {
      await browser.closeAll();
    },
  };
}

/**
 * The stand-in for a machine without Chromium: `browser_navigate` fetches the page over HTTP
 * after the same `SitePolicy.assert` the session applies, `browser_read` extracts it with the
 * static half of the same extractor and returns it marked untrusted exactly as the real tool
 * does. Every other browser tool keeps its real spec (and is refused by the hooks before it
 * would run, as in the real mode, when it is not granted).
 *
 * Redirects are never left to `fetch` (whose default follows them to any host): the fetch is
 * `redirect: "manual"` and each `Location` is asserted through the policy as "follow the
 * redirect" before the next hop, at most `MAX_REDIRECT_HOPS` hops, exactly as
 * `BrowserSession.followRedirects` does over the route's record. A page on the allowed host
 * that bounces to another host therefore ends in `domain_not_allowed` and that host sees no
 * request.
 */
export function staticBrowserTools(real: ToolSpec[], allowedDomains: string[]): ToolSpec[] {
  const pages = new Map<string, { url: string; html: string }>();
  const policy = new SitePolicy({ allow: allowedDomains });
  return real.map((spec) => {
    if (spec.name === "browser_navigate") {
      const navigate: ToolSpec<{ url: string }> = {
        ...(spec as ToolSpec<{ url: string }>),
        async execute(input: { url: string }, ctx: ToolExecutionContext) {
          policy.assert(input.url, "navigate");
          const { url, res } = await fetchThroughPolicy(policy, input.url);
          const html = await res.text();
          pages.set(ctx.runId, { url, html });
          const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? "";
          return { content: `Opened ${url} (HTTP ${res.status}) ${JSON.stringify(title)}.` };
        },
      };
      return navigate as ToolSpec;
    }
    if (spec.name === "browser_read") {
      const read: ToolSpec<{ maxChars?: number }> = {
        ...(spec as ToolSpec<{ maxChars?: number }>),
        async execute(input: { maxChars?: number }, ctx: ToolExecutionContext) {
          const page = pages.get(ctx.runId);
          if (!page) {
            return { content: "no browser page is open for this run", isError: true };
          }
          const x = extractFromHtml(page.html, { url: page.url, maxChars: input.maxChars });
          return {
            content: renderExtract(x),
            untrusted: { source: "web_page", origin: x.url },
            artifacts: {
              suspicious: x.suspicious,
              hidden: x.hidden.length,
              truncated: x.truncated,
            },
          };
        },
      };
      return read as ToolSpec;
    }
    return spec;
  });
}

/**
 * GET `url` without letting `fetch` follow anything: a 3xx answer is followed here, hop by
 * hop, each target asserted through `policy` first, at most `MAX_REDIRECT_HOPS` hops (the
 * session's cap); a redirect without a target or one hop too many is `unavailable`, as in the
 * session. Returns the final URL and its response.
 */
export async function fetchThroughPolicy(
  policy: SitePolicy,
  url: string,
): Promise<{ url: string; res: Response }> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const res = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "forerunner (AI agent)" },
    });
    if (res.status < 300 || res.status >= 400) return { url: current, res };
    const location = res.headers.get("location");
    await res.body?.cancel().catch(() => undefined);
    if (!location) {
      throw new ForerunnerError("unavailable", `redirect without a target (${res.status})`, {
        details: { url: current, status: res.status },
      });
    }
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new ForerunnerError("unavailable", `more than ${MAX_REDIRECT_HOPS} redirects`, {
        details: { url: current },
      });
    }
    const target = new URL(location, current).toString();
    policy.assert(target, "follow the redirect");
    current = target;
  }
}

/** The researcher's request for the task whose brief names `title`. */
export function researcherOn(
  title: string,
): (req: import("@forerunner/testenv").ModelRequest) => boolean {
  return (req) => hasTool(req, "browser_navigate") && briefOf(req).includes(title);
}
