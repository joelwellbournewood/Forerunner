import { statSync, writeFileSync } from "node:fs";
import {
  type Clock,
  errorMessage,
  ForerunnerError,
  isInside,
  join,
  type Logger,
  log,
  safeSegment,
} from "@forerunner/platform";
import type { AuditPort, AutonomyLevel } from "@forerunner/runtime";
import { isSecretRef, parseSecretRef, redactValues } from "@forerunner/vault";
import type { BrowserContext, Locator, Page } from "playwright";
import {
  BROWSER_DESCRIBE_SCRIPT,
  BROWSER_EXTRACT_SCRIPT,
  buildExtract,
  type ExtractOptions,
  type PageExtract,
  type RawExtract,
} from "./extract.ts";
import {
  type BrowserApprovalPort,
  type BrowserIdentity,
  classifyClick,
  classifySubmit,
  classifyTyping,
  type ElementDescriptor,
  GuardEnforcer,
  type GuardKind,
  type GuardVerdict,
} from "./guards.ts";
import { type BlockedRequest, installPolicyRoutes, type SitePolicy, urlHost } from "./policy.ts";
import {
  type BrowserProfileDirs,
  type LaunchProfileOptions,
  launchAgentBrowser,
} from "./profile.ts";

/**
 * `AgentBrowser`: the one persistent Chromium context of an agent (its profile) with the
 * context-wide policy route. `BrowserSession`: one per run, bound to the run's site policy,
 * autonomy level and identity; owns its pages, enforces the guards before every action,
 * writes an audit row for every outward action and can be revoked at once.
 */
export interface BrowserSessionOptions {
  identity: BrowserIdentity;
  policy: SitePolicy;
  autonomy: AutonomyLevel;
  approvals: BrowserApprovalPort;
  audit: AuditPort;
  clock: Clock;
  /**
   * Resolves `secret:<name>` for `fillSecret` when the caller did not already resolve it.
   * The runtime hooks resolve references before a tool runs, so this is for direct callers.
   */
  resolveSecret?: (ref: string) => Promise<string>;
  logger?: Logger;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  /** Default 50 MiB. */
  maxDownloadBytes?: number;
}

export interface NavigationResult {
  url: string;
  status: number | null;
  title: string;
  blockedRequests: number;
  blockedHosts: string[];
}

export interface ActionResult {
  url: string;
  title: string;
  guards: GuardKind[];
  blockedRequests: number;
}

export interface ScreenshotResult {
  path: string;
  url: string;
  fullPage: boolean;
}

export interface DownloadResult {
  path: string;
  filename: string;
  bytes: number;
  url: string;
  contentType?: string;
}

export type SessionState = "open" | "closed" | "revoked";

export class AgentBrowser {
  readonly agentId: string;
  readonly dirs: BrowserProfileDirs;
  readonly userAgent: string;
  readonly headless: boolean;
  private readonly context: BrowserContext;
  private readonly logger: Logger;
  private readonly owners = new Map<Page, BrowserSession>();
  private readonly sessions = new Set<BrowserSession>();
  private closedFlag = false;
  private revokedReason: string | null = null;
  private unroute: (() => Promise<void>) | null = null;

  private constructor(
    agentId: string,
    launched: Awaited<ReturnType<typeof launchAgentBrowser>>,
    logger: Logger,
  ) {
    this.agentId = agentId;
    this.context = launched.context;
    this.dirs = launched.dirs;
    this.userAgent = launched.userAgent;
    this.headless = launched.headless;
    this.logger = logger;
    this.context.on("close", () => {
      this.closedFlag = true;
      for (const s of this.sessions) s.markClosed(this.revokedReason);
    });
  }

  static async launch(opts: LaunchProfileOptions): Promise<AgentBrowser> {
    const logger = opts.logger ?? log("browser");
    const launched = await launchAgentBrowser({ ...opts, logger });
    const browser = new AgentBrowser(opts.agentId, launched, logger);
    browser.unroute = await installPolicyRoutes(
      launched.context,
      (page) => (page ? browser.owners.get(page)?.policy : undefined),
      (info, page) => {
        const session = page ? browser.owners.get(page) : undefined;
        session?.onBlocked(info);
      },
    );
    return browser;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Raw context for callers that need it (tests); production code goes through sessions. */
  get rawContext(): BrowserContext {
    return this.context;
  }

  openSession(opts: BrowserSessionOptions): BrowserSession {
    if (this.closedFlag) {
      throw new ForerunnerError(
        this.revokedReason ? "killed" : "unavailable",
        this.revokedReason ? `browser revoked: ${this.revokedReason}` : "browser closed",
      );
    }
    const session = new BrowserSession(this, opts);
    this.sessions.add(session);
    return session;
  }

  /** @internal */
  async newPage(session: BrowserSession): Promise<Page> {
    const page = await this.context.newPage();
    this.owners.set(page, session);
    page.on("close", () => this.owners.delete(page));
    page.on("dialog", (d) => {
      this.logger.info("dialog dismissed", { type: d.type(), message: d.message().slice(0, 200) });
      d.dismiss().catch(() => undefined);
    });
    return page;
  }

  /** @internal */
  forget(session: BrowserSession): void {
    this.sessions.delete(session);
  }

  /** Live revocation: close the context now; every session and in-flight action fails with `killed`. */
  async revoke(reason = "capability revoked"): Promise<void> {
    if (this.closedFlag) return;
    this.revokedReason = reason;
    for (const s of this.sessions) s.markRevoked(reason);
    await this.closeContext();
    this.logger.warn("revoked", { agentId: this.agentId, reason });
  }

  async close(): Promise<void> {
    if (this.closedFlag) return;
    for (const s of this.sessions) s.markClosed(null);
    await this.closeContext();
  }

  private async closeContext(): Promise<void> {
    this.closedFlag = true;
    try {
      await this.unroute?.();
    } catch {
      // closing anyway
    }
    await this.context.close().catch(() => undefined);
  }
}

const SECRET_MARK = "[REDACTED]";

export class BrowserSession {
  readonly identity: BrowserIdentity;
  readonly policy: SitePolicy;
  readonly guards: GuardEnforcer;
  private page: Page | null = null;
  private state: SessionState = "open";
  private stateReason: string | null = null;
  private blockedSinceNav: BlockedRequest[] = [];
  private blockedTotal = 0;
  private seq = 0;
  private readonly logger: Logger;

  constructor(
    private readonly browser: AgentBrowser,
    private readonly opts: BrowserSessionOptions,
  ) {
    this.identity = opts.identity;
    this.policy = opts.policy;
    this.logger = opts.logger ?? log("browser:session");
    this.guards = new GuardEnforcer({
      approvals: opts.approvals,
      audit: opts.audit,
      clock: opts.clock,
      autonomy: opts.autonomy,
      identity: opts.identity,
    });
  }

  get status(): SessionState {
    return this.state;
  }

  get autonomy(): AutonomyLevel {
    return this.opts.autonomy;
  }

  get dirs(): BrowserProfileDirs {
    return this.browser.dirs;
  }

  get url(): string {
    try {
      return this.page?.url() ?? "about:blank";
    } catch {
      return "about:blank";
    }
  }

  get blockedRequests(): number {
    return this.blockedTotal;
  }

  /** @internal */
  onBlocked(info: BlockedRequest): void {
    this.blockedTotal++;
    this.blockedSinceNav.push(info);
  }

  /** @internal */
  markRevoked(reason: string): void {
    this.state = "revoked";
    this.stateReason = reason;
  }

  /** @internal */
  markClosed(revokedReason: string | null): void {
    if (this.state === "open") {
      this.state = revokedReason ? "revoked" : "closed";
      this.stateReason = revokedReason;
    }
  }

  private assertOpen(): void {
    if (this.state === "revoked") {
      throw new ForerunnerError(
        "killed",
        `browser session revoked: ${this.stateReason ?? "capability revoked"}`,
        {
          details: { runId: this.identity.runId },
        },
      );
    }
    if (this.state === "closed") {
      throw new ForerunnerError("unavailable", "browser session closed", {
        details: { runId: this.identity.runId },
      });
    }
  }

  private async ensurePage(): Promise<Page> {
    this.assertOpen();
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = await this.browser.newPage(this);
    return this.page;
  }

  private requirePage(): Page {
    this.assertOpen();
    if (!this.page || this.page.isClosed()) {
      throw new ForerunnerError("validation", "no page is open: navigate first");
    }
    return this.page;
  }

  private async audit(
    tool: string,
    inputSummary: string,
    resultSummary: string,
    allowed = true,
    deniedReason?: string,
  ): Promise<void> {
    const id = this.identity;
    await this.opts.audit.append({
      sessionId: id.sessionId,
      runId: id.runId,
      agentId: id.agentId,
      humanId: id.humanId,
      tool,
      inputSummary: inputSummary.slice(0, 300),
      resultSummary: resultSummary.slice(0, 300),
      allowed,
      deniedReason,
      costUsdMicro: 0,
      occurredAt: this.opts.clock.nowIso(),
      tokenId: id.tokenId ?? "",
    });
  }

  /** Translate a Playwright failure into a ForerunnerError with the right code. */
  private mapError(e: unknown, action: string, url?: string): ForerunnerError {
    if (e instanceof ForerunnerError) return e;
    const msg = errorMessage(e);
    if (this.state === "revoked") {
      return new ForerunnerError(
        "killed",
        `browser session revoked during ${action}: ${this.stateReason}`,
        {
          cause: e,
        },
      );
    }
    if (
      /has been closed|Target closed|browser has disconnected|Target page, context or browser/i.test(
        msg,
      )
    ) {
      return new ForerunnerError("killed", `browser closed during ${action}`, { cause: e });
    }
    const blocked = this.blockedSinceNav.find(
      (b) => b.resourceType === "document" || (url !== undefined && b.url === url),
    );
    if (
      blocked &&
      /ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|net::ERR_FAILED|frame was detached/i.test(msg)
    ) {
      return new ForerunnerError(
        "domain_not_allowed",
        `${action} blocked by the site policy: ${blocked.host} (${blocked.reason})`,
        { details: { url: blocked.url, host: blocked.host, reason: blocked.reason } },
      );
    }
    if (/Timeout/i.test(msg)) {
      return new ForerunnerError("timeout", `${action} timed out: ${msg.split("\n")[0]}`, {
        cause: e,
      });
    }
    return new ForerunnerError("unavailable", `${action} failed: ${msg.split("\n")[0]}`, {
      cause: e,
      retryable: true,
    });
  }

  private blockedHosts(): string[] {
    return [...new Set(this.blockedSinceNav.map((b) => b.host))];
  }

  async navigate(url: string): Promise<NavigationResult> {
    this.assertOpen();
    try {
      this.policy.assert(url, "navigate");
    } catch (e) {
      const err = e as ForerunnerError;
      await this.audit("browser_navigate", url, "", false, `${err.code}: ${err.message}`);
      throw err;
    }
    const page = await this.ensurePage();
    this.blockedSinceNav = [];
    let status: number | null = null;
    try {
      const resp = await page.goto(url, {
        waitUntil: "load",
        timeout: this.opts.navigationTimeoutMs ?? 30_000,
      });
      status = resp?.status() ?? null;
    } catch (e) {
      const err = this.mapError(e, "navigation", url);
      await this.audit("browser_navigate", url, "", false, `${err.code}: ${err.message}`);
      throw err;
    }
    const finalUrl = page.url();
    const final = this.policy.check(finalUrl);
    if (!final.allowed && finalUrl !== "about:blank") {
      await page.goto("about:blank").catch(() => undefined);
      const err = new ForerunnerError(
        "domain_not_allowed",
        `navigation ended on a host outside the policy: ${final.host}`,
        {
          details: { url: finalUrl, reason: final.reason },
        },
      );
      await this.audit("browser_navigate", url, "", false, `${err.code}: ${err.message}`);
      throw err;
    }
    const title = await page.title().catch(() => "");
    const result: NavigationResult = {
      url: finalUrl,
      status,
      title,
      blockedRequests: this.blockedSinceNav.length,
      blockedHosts: this.blockedHosts(),
    };
    await this.audit(
      "browser_navigate",
      url,
      `status ${status ?? "n/a"} ${JSON.stringify(title)}${result.blockedRequests ? ` blocked ${result.blockedRequests} request(s) to ${result.blockedHosts.join(", ")}` : ""}`,
    );
    return result;
  }

  async read(opts: Omit<ExtractOptions, "url"> = {}): Promise<PageExtract> {
    const page = this.requirePage();
    let raw: RawExtract;
    try {
      raw = (await page.evaluate(BROWSER_EXTRACT_SCRIPT)) as RawExtract;
    } catch (e) {
      throw this.mapError(e, "read");
    }
    const extract = buildExtract(raw, { ...opts, url: page.url() });
    await this.audit(
      "browser_read",
      page.url(),
      `${extract.text.length} chars, ${extract.links.length} links, ${extract.forms.length} forms, ${extract.hidden.length} hidden passage(s)${extract.suspicious ? ", injection suspected" : ""}`,
    );
    if (extract.suspicious) {
      this.logger.warn("instruction-like content on page", {
        url: page.url(),
        visible: extract.report.matches.map((m) => m.rule),
        hidden: extract.hiddenReport?.matches.map((m) => m.rule) ?? [],
      });
    }
    return extract;
  }

  async describe(selector: string): Promise<ElementDescriptor> {
    const page = this.requirePage();
    let d: ElementDescriptor | null;
    try {
      d = (await page.evaluate(
        `(${BROWSER_DESCRIBE_SCRIPT})(${JSON.stringify(selector)})`,
      )) as ElementDescriptor | null;
    } catch (e) {
      throw this.mapError(e, "describe");
    }
    if (!d) {
      throw new ForerunnerError("not_found", `no element matches ${selector}`, {
        details: { selector },
      });
    }
    return d;
  }

  private locator(selector: string): Locator {
    return this.requirePage().locator(selector).first();
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
  }

  private async actionResult(verdict: GuardVerdict, page: Page): Promise<ActionResult> {
    return {
      url: page.url(),
      title: await page.title().catch(() => ""),
      guards: verdict.kinds,
      blockedRequests: this.blockedSinceNav.length,
    };
  }

  async click(selector: string): Promise<ActionResult> {
    const page = this.requirePage();
    const el = await this.describe(selector);
    const verdict = await this.guards.enforce("browser_click", classifyClick(el), el, page.url());
    this.blockedSinceNav = [];
    try {
      await this.locator(selector).click({ timeout: this.opts.actionTimeoutMs ?? 15_000 });
      await this.settle(page);
    } catch (e) {
      const err = this.mapError(e, "click");
      await this.audit(
        "browser_click",
        `${selector} (${el.tag}${el.text ? ` ${JSON.stringify(el.text.slice(0, 60))}` : ""})`,
        "",
        false,
        `${err.code}: ${err.message}`,
      );
      throw err;
    }
    const result = await this.actionResult(verdict, page);
    await this.audit(
      "browser_click",
      `${selector} (${el.tag}${el.text ? ` ${JSON.stringify(el.text.slice(0, 60))}` : ""})${verdict.kinds.length ? ` guards=${verdict.kinds.join("+")}` : ""}`,
      `now at ${result.url}`,
    );
    return result;
  }

  async type(
    selector: string,
    text: string,
    opts: { submit?: boolean } = {},
  ): Promise<ActionResult> {
    const page = this.requirePage();
    const el = await this.describe(selector);
    const kinds = [...classifyTyping(el), ...(opts.submit ? classifySubmit(el.form) : [])];
    const verdict = await this.guards.enforce("browser_type", kinds, el, page.url());
    const sensitive = verdict.kinds.includes("credential") || verdict.kinds.includes("payment");
    const summary = `${selector} (${el.tag}${el.type ? `/${el.type}` : ""}${el.name ? ` name=${el.name}` : ""}) ${text.length} chars${sensitive ? " [sensitive field]" : `: ${JSON.stringify(text.slice(0, 80))}`}${opts.submit ? " +submit" : ""}`;
    try {
      await this.fillLocator(this.locator(selector), text);
      if (opts.submit) {
        this.blockedSinceNav = [];
        await this.locator(selector).press("Enter", {
          timeout: this.opts.actionTimeoutMs ?? 15_000,
        });
        await this.settle(page);
      }
    } catch (e) {
      const err = this.mapError(e, "typing");
      await this.audit("browser_type", summary, "", false, `${err.code}: ${err.message}`);
      throw err;
    }
    const result = await this.actionResult(verdict, page);
    await this.audit(
      "browser_type",
      summary,
      `typed${opts.submit ? `, submitted, now at ${result.url}` : ""}`,
    );
    return result;
  }

  /**
   * Type a vault secret into a field. `secret` is either a `secret:<name>` reference (resolved
   * through `resolveSecret`) or a value the runtime already resolved. The value is never
   * returned, logged or echoed in an error; the audit row carries the name.
   */
  async fillSecret(
    selector: string,
    secret: string,
    opts: { submit?: boolean; name?: string } = {},
  ): Promise<ActionResult & { secret: string }> {
    const page = this.requirePage();
    let value: string;
    let name: string;
    if (isSecretRef(secret)) {
      name = parseSecretRef(secret);
      if (!this.opts.resolveSecret) {
        throw new ForerunnerError(
          "secret_not_granted",
          `secret "${name}" was not resolved by the runtime`,
          {
            details: { name },
          },
        );
      }
      value = await this.opts.resolveSecret(secret);
    } else {
      value = secret;
      name = opts.name ?? "(resolved by runtime)";
    }
    if (!value) throw new ForerunnerError("validation", "secret value is empty");
    const redact = (s: string) => redactValues(s, [value], SECRET_MARK);
    let el: ElementDescriptor;
    try {
      el = await this.describe(selector);
    } catch (e) {
      throw e instanceof ForerunnerError
        ? new ForerunnerError(e.code, redact(e.message), { details: e.details })
        : e;
    }
    const kinds: GuardKind[] = [
      "credential",
      ...classifyTyping(el),
      ...(opts.submit ? classifySubmit(el.form) : []),
    ];
    const verdict = await this.guards.enforce("browser_fill_secret", kinds, el, page.url());
    const summary = `${selector} (${el.tag}${el.type ? `/${el.type}` : ""}${el.name ? ` name=${el.name}` : ""}) <- secret:${name}${opts.submit ? " +submit" : ""}`;
    try {
      await this.fillLocator(this.locator(selector), value);
      if (opts.submit) {
        this.blockedSinceNav = [];
        await this.locator(selector).press("Enter", {
          timeout: this.opts.actionTimeoutMs ?? 15_000,
        });
        await this.settle(page);
      }
    } catch (e) {
      const mapped = this.mapError(e, "filling secret");
      const err = new ForerunnerError(mapped.code, redact(mapped.message), {
        details: mapped.details,
      });
      await this.audit("browser_fill_secret", summary, "", false, `${err.code}: ${err.message}`);
      throw err;
    }
    const result = await this.actionResult(verdict, page);
    await this.audit(
      "browser_fill_secret",
      summary,
      `filled${opts.submit ? `, submitted, now at ${result.url}` : ""}`,
    );
    return { ...result, secret: name };
  }

  private async fillLocator(loc: Locator, text: string): Promise<void> {
    const timeout = this.opts.actionTimeoutMs ?? 15_000;
    try {
      await loc.fill(text, { timeout });
    } catch (e) {
      if (/not an? <input>|not an <input>|Element is not an/i.test(errorMessage(e))) {
        await loc.click({ timeout });
        await loc.pressSequentially(text, { timeout });
        return;
      }
      throw e;
    }
  }

  async screenshot(opts: { fullPage?: boolean; label?: string } = {}): Promise<ScreenshotResult> {
    const page = this.requirePage();
    const stamp = this.opts.clock.nowIso().replace(/[:.]/g, "-");
    const name = `${stamp}-${safeSegment(this.identity.runId, "run")}-${++this.seq}${opts.label ? `-${safeSegment(opts.label)}` : ""}.png`;
    const path = join(this.browser.dirs.screenshots, name);
    if (!isInside(this.browser.dirs.screenshots, path)) {
      throw new ForerunnerError("path_not_allowed", "screenshot path escaped the sandbox");
    }
    try {
      await page.screenshot({ path, fullPage: opts.fullPage ?? false });
    } catch (e) {
      throw this.mapError(e, "screenshot");
    }
    await this.audit(
      "browser_screenshot",
      `${page.url()}${opts.fullPage ? " fullPage" : ""}`,
      `saved ${path}`,
    );
    return { path, url: page.url(), fullPage: opts.fullPage ?? false };
  }

  async download(opts: {
    url?: string;
    selector?: string;
    filename?: string;
  }): Promise<DownloadResult> {
    this.assertOpen();
    if (opts.url) return this.downloadUrl(opts.url, opts.filename);
    if (opts.selector) return this.downloadByClick(opts.selector, opts.filename);
    throw new ForerunnerError("validation", "download needs a url or a selector");
  }

  private targetPath(filename: string): string {
    const safe = safeSegment(filename, "download");
    const path = join(this.browser.dirs.downloads, `${++this.seq}-${safe}`);
    if (!isInside(this.browser.dirs.downloads, path)) {
      throw new ForerunnerError("path_not_allowed", "download path escaped the sandbox");
    }
    return path;
  }

  private async downloadUrl(url: string, filename?: string): Promise<DownloadResult> {
    const maxBytes = this.opts.maxDownloadBytes ?? 50 * 1024 * 1024;
    let current = url;
    try {
      this.policy.assert(current, "download");
      for (let hop = 0; ; hop++) {
        const resp = await this.browser.rawContext.request.get(current, {
          maxRedirects: 0,
          timeout: this.opts.navigationTimeoutMs ?? 30_000,
        });
        const status = resp.status();
        if (status >= 300 && status < 400) {
          const loc = resp.headers().location;
          await resp.dispose().catch(() => undefined);
          if (!loc || hop >= 5) {
            throw new ForerunnerError(
              "unavailable",
              `download redirected too often or without a target (${status})`,
            );
          }
          current = new URL(loc, current).toString();
          this.policy.assert(current, "download");
          continue;
        }
        if (status < 200 || status >= 300) {
          await resp.dispose().catch(() => undefined);
          throw new ForerunnerError("unavailable", `download failed with HTTP ${status}`, {
            details: { url: current, status },
          });
        }
        const declared = Number(resp.headers()["content-length"] ?? "0");
        if (declared > maxBytes) {
          await resp.dispose().catch(() => undefined);
          throw new ForerunnerError(
            "validation",
            `download of ${declared} bytes exceeds the cap of ${maxBytes}`,
          );
        }
        const body = await resp.body();
        if (body.length > maxBytes) {
          throw new ForerunnerError(
            "validation",
            `download of ${body.length} bytes exceeds the cap of ${maxBytes}`,
          );
        }
        const disposition = resp.headers()["content-disposition"] ?? "";
        const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
        const fromUrl = (() => {
          try {
            return decodeURIComponent(
              new URL(current).pathname.split("/").filter(Boolean).pop() ?? "",
            );
          } catch {
            return "";
          }
        })();
        const path = this.targetPath(filename ?? fromHeader ?? fromUrl ?? "download");
        writeFileSync(path, body);
        const result: DownloadResult = {
          path,
          filename: path.slice(this.browser.dirs.downloads.length + 1),
          bytes: body.length,
          url: current,
          contentType: resp.headers()["content-type"],
        };
        await this.audit("browser_download", url, `saved ${result.bytes} bytes to ${path}`);
        return result;
      }
    } catch (e) {
      const err = this.mapError(e, "download", current);
      await this.audit("browser_download", url, "", false, `${err.code}: ${err.message}`);
      throw err;
    }
  }

  private async downloadByClick(selector: string, filename?: string): Promise<DownloadResult> {
    const page = this.requirePage();
    const el = await this.describe(selector);
    await this.guards.enforce("browser_download", classifyClick(el), el, page.url());
    this.blockedSinceNav = [];
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: this.opts.navigationTimeoutMs ?? 30_000 }),
        this.locator(selector).click({ timeout: this.opts.actionTimeoutMs ?? 15_000 }),
      ]);
      const path = this.targetPath(filename ?? download.suggestedFilename() ?? "download");
      await download.saveAs(path);
      const bytes = statSync(path).size;
      const result: DownloadResult = {
        path,
        filename: path.slice(this.browser.dirs.downloads.length + 1),
        bytes,
        url: download.url(),
      };
      await this.audit(
        "browser_download",
        `${selector} -> ${download.url()}`,
        `saved ${bytes} bytes to ${path}`,
      );
      return result;
    } catch (e) {
      const blocked = this.blockedSinceNav[0];
      const err =
        blocked && !(e instanceof ForerunnerError)
          ? new ForerunnerError(
              "domain_not_allowed",
              `download blocked by the site policy: ${blocked.host} (${blocked.reason})`,
              {
                details: { url: blocked.url, host: blocked.host },
              },
            )
          : this.mapError(e, "download");
      await this.audit("browser_download", selector, "", false, `${err.code}: ${err.message}`);
      throw err;
    }
  }

  /** Close this run's pages; the agent's profile stays. */
  async close(): Promise<void> {
    if (this.state !== "open") return;
    this.state = "closed";
    await this.page?.close().catch(() => undefined);
    this.page = null;
    this.browser.forget(this);
    await this.audit(
      "browser_close",
      this.identity.runId,
      `closed after ${this.blockedTotal} blocked request(s)`,
    );
  }

  /** Revoke this run's browser access at once: in-flight actions fail with `killed`. */
  async revoke(reason = "capability revoked"): Promise<void> {
    if (this.state === "revoked") return;
    this.markRevoked(reason);
    await this.page?.close().catch(() => undefined);
    this.page = null;
    this.browser.forget(this);
    await this.audit("browser_revoke", this.identity.runId, reason, false, `killed: ${reason}`);
  }

  /** Whether `url` would pass this session's policy (no side effects). */
  allows(url: string): boolean {
    return this.policy.isAllowed(url) && urlHost(url) !== null;
  }
}
