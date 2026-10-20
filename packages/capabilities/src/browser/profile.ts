import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import {
  type AppDirsOptions,
  appDirs,
  currentPlatform,
  errorMessage,
  ForerunnerError,
  join,
  type Logger,
  log,
  safeSegment,
} from "@forerunner/platform";
import { type BrowserContext, chromium } from "playwright";

/**
 * One isolated, persistent Chromium profile per agent under the app data directory. Never the
 * human's own browser profile: the agent's cookies and logins (agent-owned accounts) live
 * here and nowhere else. Headless by default; downloads land in a per-agent sandbox directory;
 * no geolocation, clipboard, notification or other permission is ever granted; the user agent
 * carries a fixed suffix that identifies the agent as an AI agent.
 */
export const AI_AGENT_UA_SUFFIX = "Forerunner-AI-Agent/1.0 (automated; acting for a named human)";

export const BROWSER_EXECUTABLE_ENV = "FORERUNNER_BROWSER_EXECUTABLE";

export interface BrowserProfileDirs {
  /** `<data>/browser/<agent>` */
  root: string;
  /** Chromium user data dir. */
  profile: string;
  /** Downloads sandbox. */
  downloads: string;
  /** Screenshots. */
  screenshots: string;
}

export function browserProfileDirs(agentId: string, dirs: AppDirsOptions = {}): BrowserProfileDirs {
  const root = join(appDirs(dirs).data, "browser", safeSegment(agentId, "agent"));
  return {
    root,
    profile: join(root, "profile"),
    downloads: join(root, "downloads"),
    screenshots: join(root, "screenshots"),
  };
}

export function ensureProfileDirs(d: BrowserProfileDirs): BrowserProfileDirs {
  for (const p of [d.root, d.profile, d.downloads, d.screenshots])
    mkdirSync(p, { recursive: true });
  return d;
}

export interface ChromiumProbe {
  ok: boolean;
  /** Set when a specific executable (override or discovered) should be passed to Playwright. */
  executablePath?: string;
  reason: string;
}

const LINUX_CANDIDATES = [
  ["chrome-linux", "chrome"],
  ["chrome-linux64", "chrome"],
  ["chrome-linux", "headless_shell"],
  ["chrome-headless-shell-linux64", "chrome-headless-shell"],
];
const WINDOWS_CANDIDATES = [
  ["chrome-win", "chrome.exe"],
  ["chrome-win64", "chrome.exe"],
  ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
];
const MAC_CANDIDATES = [
  ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"],
  ["chrome-headless-shell-mac", "chrome-headless-shell"],
];

function browsersRoot(env: NodeJS.ProcessEnv): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0")
    return env.PLAYWRIGHT_BROWSERS_PATH;
  const platform = currentPlatform();
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  if (platform === "windows")
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  if (platform === "macos") return join(home, "Library", "Caches", "ms-playwright");
  return join(env.XDG_CACHE_HOME ?? join(home, ".cache"), "ms-playwright");
}

/**
 * Find a Chromium Playwright can drive, without ever running `playwright install`:
 * 1. `FORERUNNER_BROWSER_EXECUTABLE` when set (must exist);
 * 2. the revision Playwright pins, when it is installed;
 * 3. any `chromium-*` or `chromium_headless_shell-*` under the browsers path (newest first;
 *    the full browser before the headless shell), for the case where the installed revision
 *    and the Playwright version drifted apart.
 */
export function resolveChromiumExecutable(env: NodeJS.ProcessEnv = process.env): ChromiumProbe {
  const override = env[BROWSER_EXECUTABLE_ENV];
  if (override) {
    if (existsSync(override))
      return { ok: true, executablePath: override, reason: `${BROWSER_EXECUTABLE_ENV}` };
    return { ok: false, reason: `${BROWSER_EXECUTABLE_ENV}=${override} does not exist` };
  }
  let pinned = "";
  try {
    pinned = chromium.executablePath();
  } catch {
    pinned = "";
  }
  if (pinned && existsSync(pinned)) return { ok: true, reason: "playwright pinned revision" };

  const root = browsersRoot(env);
  if (!existsSync(root)) {
    return {
      ok: false,
      reason: `no Chromium: ${pinned || "no pinned path"} missing and ${root} does not exist`,
    };
  }
  const platform = currentPlatform();
  const candidates =
    platform === "windows"
      ? WINDOWS_CANDIDATES
      : platform === "macos"
        ? MAC_CANDIDATES
        : LINUX_CANDIDATES;
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  const revisions = entries
    .map((name) => /^(chromium|chromium_headless_shell)-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[0], kind: m[1] ?? "", rev: Number(m[2]) }))
    .sort((a, b) => b.rev - a.rev || (a.kind === "chromium" ? -1 : 1));
  for (const r of revisions) {
    for (const c of candidates) {
      const p = join(root, r.name, ...c);
      if (existsSync(p))
        return { ok: true, executablePath: p, reason: `discovered ${r.name} under ${root}` };
    }
  }
  return {
    ok: false,
    reason: `no Chromium: ${pinned || "no pinned path"} missing and nothing usable under ${root}`,
  };
}

export interface LaunchProfileOptions {
  agentId: string;
  /** Default true. Headed mode is for a human watching the agent, never the default. */
  headless?: boolean;
  executablePath?: string;
  env?: NodeJS.ProcessEnv;
  appDirs?: AppDirsOptions;
  viewport?: { width: number; height: number };
  locale?: string;
  /** Launch timeout in ms (default 60 s). */
  timeoutMs?: number;
  logger?: Logger;
}

export interface LaunchedProfile {
  context: BrowserContext;
  dirs: BrowserProfileDirs;
  userAgent: string;
  executablePath?: string;
  headless: boolean;
}

interface UaCache {
  executable: string;
  version: string;
  userAgent: string;
}

const UA_CACHE_FILE = "ua.json";

function readUaCache(root: string): UaCache | null {
  try {
    const parsed = JSON.parse(readFileSync(join(root, UA_CACHE_FILE), "utf8")) as Partial<UaCache>;
    if (
      typeof parsed.executable === "string" &&
      typeof parsed.version === "string" &&
      typeof parsed.userAgent === "string"
    )
      return parsed as UaCache;
  } catch {
    // no cache
  }
  return null;
}

function writeUaCache(root: string, cache: UaCache): void {
  try {
    writeFileSync(join(root, UA_CACHE_FILE), JSON.stringify(cache, null, 2));
  } catch {
    // best effort
  }
}

/**
 * The Chromium features Playwright itself disables (`chromiumSwitches` in playwright-core),
 * copied here because Chromium honours only the last `--disable-features` flag on its command
 * line and Playwright does not merge a caller's flag into its own. Every entry Playwright adds
 * or removes must be mirrored; `browser-profile.test.ts` compares this list with the installed
 * Playwright's and fails when they drift.
 */
export const PLAYWRIGHT_DISABLED_FEATURES: readonly string[] = [
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
  "DialMediaRouteProvider",
  "GlobalMediaControls",
  "HttpsUpgrades",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "BlockOriginHeaderModificationOnRedirect",
  "AvoidCorsURLLoaderRestartOnRedirect",
  "Translate",
  "AutoDeElevate",
  "OptimizationHints",
  "NetworkTimeServiceQuerying",
  "AimEnabled",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
];

/**
 * Features Forerunner disables on top. `LocalNetworkAccessChecks`: the policy route answers
 * every HTTP(S) request from interception (see policy.ts), so a document carries no network
 * address and Chromium would treat it as public and refuse the real connections that remain
 * (WebSockets, event streams) to loopback and LAN hosts such as a local dev server. The site
 * policy decides what a page may reach; the check would only add a second, blunter rule.
 */
export const FORERUNNER_DISABLED_FEATURES: readonly string[] = ["LocalNetworkAccessChecks"];

export const DISABLE_FEATURES_ARG = `--disable-features=${[...PLAYWRIGHT_DISABLED_FEATURES, ...FORERUNNER_DISABLED_FEATURES].join(",")}`;

/** Chromium flags on top of Playwright's defaults; each one removes a way out of the sandbox. */
export const HARDENING_ARGS = [
  "--block-new-web-contents", // no popups or new windows: every page is one we opened and route
  "--deny-permission-prompts", // geolocation, camera, microphone, clipboard: prompts are denied
  "--disable-notifications",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-component-update",
  "--disable-client-side-phishing-detection",
  "--password-store=basic", // never the OS keychain of the human
  "--use-mock-keychain",
  DISABLE_FEATURES_ARG,
];

/**
 * Launch (or relaunch) the agent's persistent context. The first launch per executable reads
 * Chromium's default user agent, caches it in the profile root and relaunches with the AI
 * agent suffix appended; later launches use the cache (re-detected when the version changed).
 */
export async function launchAgentBrowser(opts: LaunchProfileOptions): Promise<LaunchedProfile> {
  const logger = opts.logger ?? log("browser:profile");
  const env = opts.env ?? process.env;
  const dirs = ensureProfileDirs(browserProfileDirs(opts.agentId, opts.appDirs ?? { env }));
  const headless = opts.headless ?? true;
  let executablePath = opts.executablePath;
  if (!executablePath) {
    const probe = resolveChromiumExecutable(env);
    if (!probe.ok) {
      throw new ForerunnerError("unavailable", `browser unavailable: ${probe.reason}`, {
        details: { reason: probe.reason },
      });
    }
    executablePath = probe.executablePath;
  }
  const executableKey = executablePath ?? "playwright-default";

  const baseOptions = {
    headless,
    executablePath,
    acceptDownloads: true,
    downloadsPath: dirs.downloads,
    serviceWorkers: "block" as const,
    permissions: [] as string[],
    viewport: opts.viewport ?? { width: 1280, height: 900 },
    locale: opts.locale,
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    args: HARDENING_ARGS,
    timeout: opts.timeoutMs ?? 60_000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  };

  const launch = async (userAgent?: string): Promise<BrowserContext> => {
    try {
      return await chromium.launchPersistentContext(dirs.profile, {
        ...baseOptions,
        ...(userAgent ? { userAgent } : {}),
      });
    } catch (e) {
      throw new ForerunnerError(
        "unavailable",
        `browser could not be launched: ${errorMessage(e).split("\n")[0]}`,
        {
          details: {
            executablePath: executablePath ?? "(playwright default)",
            profile: dirs.profile,
          },
          cause: e,
        },
      );
    }
  };

  const detect = async (): Promise<UaCache> => {
    const probeCtx = await launch();
    try {
      const page = await probeCtx.newPage();
      const ua = String(await page.evaluate("navigator.userAgent"));
      const version = probeCtx.browser()?.version() ?? "unknown";
      await page.close();
      return { executable: executableKey, version, userAgent: ua };
    } finally {
      await probeCtx.close().catch(() => undefined);
    }
  };

  let cache = readUaCache(dirs.root);
  if (!cache || cache.executable !== executableKey) {
    cache = await detect();
    writeUaCache(dirs.root, cache);
  }
  const withSuffix = (ua: string) =>
    ua.includes(AI_AGENT_UA_SUFFIX) ? ua : `${ua} ${AI_AGENT_UA_SUFFIX}`;
  let context = await launch(withSuffix(cache.userAgent));
  const version = context.browser()?.version() ?? "unknown";
  if (version !== cache.version) {
    await context.close().catch(() => undefined);
    cache = await detect();
    writeUaCache(dirs.root, cache);
    context = await launch(withSuffix(cache.userAgent));
  }
  await context.clearPermissions().catch(() => undefined);
  context.setDefaultNavigationTimeout(30_000);
  context.setDefaultTimeout(15_000);
  logger.info("launched", {
    agentId: opts.agentId,
    profile: dirs.profile,
    headless,
    executable: executableKey,
    version,
  });
  return { context, dirs, userAgent: withSuffix(cache.userAgent), executablePath, headless };
}
