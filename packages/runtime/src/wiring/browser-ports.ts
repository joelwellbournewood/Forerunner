/**
 * The daemon's side of the sandboxed browser (spec L.2, S.30, S.31; ADR 0014, ADR 0047): the
 * mode the install runs in (Chromium through Playwright, or the static page reader when no
 * Chromium exists), the per-run binding the browser session is opened on (the run token's
 * domains as the allow list, the project's block list on top, the project's autonomy level),
 * the project's own site allowlist that widens the session grant, and the presence switch
 * that reads the `browser` extension row (installed, enabled, neither pending nor errored),
 * so the tools are absent from a run until a human adds the capability from the catalog and
 * approves it in the inbox. Nothing here decides anything the hooks, the gate or the session
 * policy do not check again per call.
 */
import type { browser } from "@forerunner/capabilities";
import type { ExtensionRow, JsonObject } from "@forerunner/state";
import type { ToolExecutionContext } from "../agent/tools.ts";
import { type AutonomyLevel, isValidAutonomyLevel } from "../enforcement/autonomy.ts";
import type { CapabilityClaims } from "../enforcement/token.ts";
import { extensionRowEnabled } from "./desktop-ports.ts";

/** The catalog id and row name of the browser capability (`src/extensions/catalog.json`). */
export const BROWSER_CAPABILITY_NAME = "browser";

/** `project.settings.browser`: the project's own site allowlist and block list. */
export const BROWSER_SETTINGS_KEY = "browser";

export type BrowserMode = "chromium" | "static";

/** `FORERUNNER_BROWSER_MODE`: `static` never launches Chromium, `chromium` insists on it. */
export const BROWSER_MODE_ENV = "FORERUNNER_BROWSER_MODE";

/**
 * The mode this install runs the browser tools in: the option (tests), else the environment,
 * else `chromium` when `resolveChromiumExecutable` finds one and `static` otherwise. A launch
 * is never probed at compose (it costs seconds and a display); a Chromium that exists but
 * fails to launch surfaces as the first navigation's error, which the hooks audit.
 */
export function browserModeFor(
  env: NodeJS.ProcessEnv,
  probe: Pick<browser.ChromiumProbe, "ok">,
  override?: BrowserMode,
): BrowserMode {
  if (override) return override;
  const flag = env[BROWSER_MODE_ENV]?.trim().toLowerCase();
  if (flag === "static" || flag === "chromium") return flag;
  return probe.ok ? "chromium" : "static";
}

export interface BrowserProjectSettings {
  /** Host patterns (`example.com`, `*.example.com`) the project's sessions may browse. */
  allowedDomains: string[];
  /** Host patterns no session of the project may reach, whatever the token says. */
  blockedDomains: string[];
}

function hostPatterns(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const x of v) {
    if (typeof x !== "string") continue;
    const host = x.trim().toLowerCase();
    if (/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) out.add(host);
  }
  return [...out].sort();
}

/** The browser settings of a project, every entry a host pattern; anything else is dropped. */
export function browserSettingsOf(settings: JsonObject | null | undefined): BrowserProjectSettings {
  const raw = settings?.[BROWSER_SETTINGS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { allowedDomains: [], blockedDomains: [] };
  }
  const s = raw as Record<string, unknown>;
  return {
    allowedDomains: hostPatterns(s.allowedDomains ?? s.allowed_domains),
    blockedDomains: hostPatterns(s.blockedDomains ?? s.blocked_domains),
  };
}

export interface BrowserBindingDeps {
  /** The live claims of the run (`TokenIssuer.claimsForRun`). */
  claims: (runId: string) => CapabilityClaims | undefined;
  projects: {
    get(id: string): Promise<{ autonomy_level: number; settings: JsonObject } | undefined>;
  };
  humans: { get(id: string): Promise<{ default_autonomy: number } | undefined> };
}

/**
 * The binding a run's browser session is opened on: the run token's domains as the allow
 * list (the hooks already refused a URL outside them; the session policy covers subresources,
 * redirects and WebSockets), the project's block list on top, `autonomy` from the run's
 * project (the human's default without a project; 0 when neither exists), the token id for
 * the audit rows. A run whose token this issuer does not hold (revoked, expired, foreign)
 * gets no domain at all, so its first navigation is refused by the policy.
 */
export function browserBindingResolver(deps: BrowserBindingDeps): browser.BindingResolver {
  return async (ctx: ToolExecutionContext): Promise<browser.BrowserRunBinding> => {
    const claims = deps.claims(ctx.runId);
    const project = ctx.projectId ? await deps.projects.get(ctx.projectId) : undefined;
    const level = project
      ? project.autonomy_level
      : ((await deps.humans.get(ctx.humanId))?.default_autonomy ?? 0);
    const autonomy: AutonomyLevel = isValidAutonomyLevel(level) ? level : 0;
    return {
      allowedDomains: claims ? [...claims.allowedDomains] : [],
      blockedDomains: browserSettingsOf(project?.settings).blockedDomains,
      autonomy,
      ...(claims ? { tokenId: claims.id } : {}),
    };
  };
}

/**
 * Whether a capability's tools are offered to the next run: a cached answer the composition
 * refreshes at every session start and on the events that change it (an extension toggle, a
 * settings write), read synchronously where the run's tool registry and the session grant
 * are built. The per-call checks (the extension gate, the policy) stay in force for a run
 * already in flight.
 */
export class CapabilityPresence {
  private on = false;
  constructor(
    readonly name: string,
    private readonly read: () => Promise<boolean>,
  ) {}

  enabled(): boolean {
    return this.on;
  }

  async refresh(): Promise<boolean> {
    this.on = await this.read();
    return this.on;
  }
}

/** The browser capability's presence: the `browser` extension row as the gate reads it. */
export function browserPresence(extensions: {
  byName(kind: string, name: string): Promise<ExtensionRow | undefined>;
}): CapabilityPresence {
  return new CapabilityPresence(BROWSER_CAPABILITY_NAME, async () =>
    extensionRowEnabled(await extensions.byName("capability", BROWSER_CAPABILITY_NAME)),
  );
}
