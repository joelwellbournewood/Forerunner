import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { errorMessage, isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import {
  type AutonomyLevel,
  KillSwitch,
  StateAudit,
  type ToolExecutionContext,
} from "@forerunner/runtime";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault, SecretResolver } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AI_AGENT_UA_SUFFIX,
  type BrowserApprovalAnswer,
  type BrowserApprovalRequest,
  BrowserSessionManager,
  browserTools,
  FakeBrowserApprovals,
  launchAgentBrowser,
  resolveChromiumExecutable,
} from "../src/browser/index.ts";

/**
 * The sandboxed browser against two local HTTP servers: one inside the run's allowlist, one
 * outside. Skips visibly when no Chromium can be launched (Playwright's pinned revision or a
 * discovered one under PLAYWRIGHT_BROWSERS_PATH; `playwright install` is never run).
 */
const AGENT = "agent browser/test";
const SECRET_VALUE = ["correct", "horse", "battery", "staple"].join("-"); // not-a-secret

interface Ready {
  ok: boolean;
  reason: string;
  home: string;
}

async function prepare(): Promise<Ready> {
  const home = mkdtempSync(join(tmpdir(), "fr-browser-"));
  const probe = resolveChromiumExecutable();
  if (!probe.ok) return { ok: false, reason: probe.reason, home };
  try {
    const launched = await launchAgentBrowser({
      agentId: "probe",
      appDirs: { env: { ...process.env, FORERUNNER_HOME: home } },
      timeoutMs: 60_000,
    });
    await launched.context.close();
    return { ok: true, reason: probe.reason, home };
  } catch (e) {
    return { ok: false, reason: errorMessage(e).split("\n")[0] ?? "launch failed", home };
  }
}

let ready: Ready = { ok: false, reason: "not probed", home: "" };
try {
  ready = await prepare();
} catch (e) {
  ready = { ok: false, reason: errorMessage(e), home: "" };
}

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", "browser", name), "utf8");

interface Hit {
  method: string;
  url: string;
  body: string;
  userAgent: string;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

describe.skipIf(!ready.ok)(
  `sandboxed browser (${ready.ok ? ready.reason : `skipped: ${ready.reason}`})`,
  () => {
    let allowed: http.Server;
    let blocked: http.Server;
    let allowedPort = 0;
    let blockedPort = 0;
    const allowedHits: Hit[] = [];
    const blockedHits: Hit[] = [];
    let store: StateStore;
    let manager: BrowserSessionManager;
    let autonomy: AutonomyLevel = 2;
    let answer: BrowserApprovalAnswer = "approved";
    const approvals = new FakeBrowserApprovals((_req: BrowserApprovalRequest) => answer);
    const clock = new SimulatedClock("2026-06-01T09:00:00Z");
    let runSeq = 0;
    const controllers = new Map<string, AbortController>();
    const origin = () => `http://127.0.0.1:${allowedPort}`;
    const blockedOrigin = () => `http://127.0.0.1:${blockedPort}`;

    function ctx(runId = `run-${++runSeq}`): ToolExecutionContext {
      const ac = new AbortController();
      controllers.set(runId, ac);
      return {
        runId,
        sessionId: "sess-1",
        agentId: AGENT,
        humanId: "human-1",
        projectId: "proj-1",
        allowedPaths: [],
        signal: ac.signal,
      };
    }

    function page(name: string): string {
      return fixture(name).replaceAll("__BLOCKED__", blockedOrigin());
    }

    beforeAll(async () => {
      const handler =
        (hits: Hit[]) =>
        (req: http.IncomingMessage, res: http.ServerResponse): void => {
          let body = "";
          req.on("data", (c: Buffer) => {
            body += c.toString("utf8");
          });
          req.on("end", () => {
            hits.push({
              method: req.method ?? "",
              url: req.url ?? "",
              body,
              userAgent: String(req.headers["user-agent"] ?? ""),
            });
            const url = req.url ?? "/";
            const html = (s: string) => {
              res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
              res.end(s);
            };
            if (url === "/ua")
              return html(`<main><p id="ua">${String(req.headers["user-agent"] ?? "")}</p></main>`);
            if (url.startsWith("/landing")) return html(page("landing.html"));
            if (url === "/login" && req.method === "GET") return html(page("login.html"));
            if (url === "/login" && req.method === "POST")
              return html("<main><h1>Signed in</h1></main>");
            if (url === "/checkout" && req.method === "GET") return html(page("checkout.html"));
            if (url === "/checkout" && req.method === "POST")
              return html("<main><h1>Order placed</h1></main>");
            if (url === "/signup" && req.method === "GET") return html(page("signup.html"));
            if (url === "/signup" && req.method === "POST")
              return html("<main><h1>Account created</h1></main>");
            if (url === "/notes") return html(page("injection.html"));
            if (url === "/file.bin") {
              res.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="changelog.bin"',
              });
              return res.end(Buffer.from("FORERUNNER-DOWNLOAD-" + "x".repeat(1000)));
            }
            if (url === "/redirect-blocked") {
              res.writeHead(302, { location: `${blockedOrigin()}/landing` });
              return res.end();
            }
            if (url === "/slow") {
              setTimeout(() => html("<main><p>slow</p></main>"), 8_000);
              return;
            }
            if (url === "/pixel.png") {
              res.writeHead(200, { "content-type": "image/png" });
              return res.end(Buffer.from("89504e470d0a1a0a", "hex"));
            }
            res.writeHead(404);
            res.end("not found");
          });
        };
      allowed = http.createServer(handler(allowedHits));
      blocked = http.createServer(handler(blockedHits));
      allowedPort = await listen(allowed);
      blockedPort = await listen(blocked);
      store = await openStore({ url: "sqlite::memory:", clock });
      const vault = new MemoryVault({ shop_login: SECRET_VALUE });
      const resolver = new SecretResolver(vault);
      manager = new BrowserSessionManager({
        binding: () => ({
          allowedDomains: [`127.0.0.1:${allowedPort}`],
          autonomy,
          tokenId: "tok-1",
        }),
        approvals,
        audit: new StateAudit(store),
        clock,
        launch: { appDirs: { env: { ...process.env, FORERUNNER_HOME: ready.home } } },
        resolveSecret: async (ref) =>
          String(
            ((await resolver.resolve({ v: ref }, new Set(["shop_login"]))) as { v: string }).v,
          ),
      });
    });

    afterAll(async () => {
      await manager?.closeAll();
      await store?.close();
      await new Promise<void>((r) => allowed?.close(() => r()));
      await new Promise<void>((r) => blocked?.close(() => r()));
      for (const ac of controllers.values()) ac.abort();
      if (ready.home) rmSync(ready.home, { recursive: true, force: true });
    });

    async function auditRows(tool?: string) {
      return store.auditLog.list(tool ? { tool } : {});
    }

    it("uses an isolated profile under data/browser/<agent>, headless, with the AI agent user agent", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      const r = await s.navigate(`${origin()}/ua`);
      expect(r.status).toBe(200);
      const x = await s.read();
      expect(x.text).toContain(AI_AGENT_UA_SUFFIX);
      expect(allowedHits.at(-1)?.userAgent).toContain(AI_AGENT_UA_SUFFIX);
      expect(s.dirs.profile).toBe(
        join(ready.home, "data", "browser", "agent-browser-test", "profile"),
      );
      expect(existsSync(s.dirs.profile)).toBe(true);
      expect(existsSync(join(ready.home, "data", "browser", "agent-browser-test", "ua.json"))).toBe(
        true,
      );
      await manager.closeRun(c.runId);
    });

    it("refuses navigation outside the allowlist before any request and audits the denial", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      blockedHits.length = 0;
      const err = await s.navigate(`${blockedOrigin()}/landing`).catch((e) => e);
      expect(isForerunnerError(err, "domain_not_allowed")).toBe(true);
      expect(blockedHits).toHaveLength(0);
      const rows = await auditRows("browser_navigate");
      const denied = rows.find((r) => !r.allowed);
      expect(denied?.denied_reason).toContain("domain_not_allowed");
      expect(denied?.input_summary).toContain(`${blockedOrigin()}/landing`);
      expect(denied?.token_id).toBe("tok-1");
      await manager.closeRun(c.runId);
    });

    it("aborts subresources and redirects to hosts outside the allowlist", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      blockedHits.length = 0;
      const r = await s.navigate(`${origin()}/landing`);
      expect(r.status).toBe(200);
      expect(r.blockedRequests).toBeGreaterThanOrEqual(1);
      expect(r.blockedHosts).toEqual(["127.0.0.1"]);
      expect(blockedHits).toHaveLength(0);
      const err = await s.navigate(`${origin()}/redirect-blocked`).catch((e) => e);
      expect(isForerunnerError(err, "domain_not_allowed")).toBe(true);
      expect(blockedHits).toHaveLength(0);
      await manager.closeRun(c.runId);
    });

    it("reads visible content, lists hidden text separately and flags injection", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/landing`);
      const x = await s.read();
      expect(x.title).toBe("Acme Widgets — Home");
      expect(x.text).toContain("We make reliable widgets for small teams.");
      expect(x.text).not.toContain("Pricing");
      const reasons = new Set(x.hidden.map((h) => h.reason));
      for (const r of [
        "html_comment",
        "display_none",
        "visibility_hidden",
        "off_screen",
        "same_colour",
        "font_size_zero",
        "zero_size",
        "aria_hidden",
      ])
        expect(reasons, r).toContain(r);
      for (const h of x.hidden) expect(x.text).not.toContain(h.text.slice(0, 30));
      expect(x.hiddenReport?.suspicious).toBe(true);
      expect(x.report.suspicious).toBe(false);
      expect(x.links.map((l) => l.href)).toContain(`${origin()}/docs/getting-started`);
      const tool = browserTools(manager).find((t) => t.name === "browser_read");
      const out = await tool?.execute({}, c);
      expect(out?.untrusted).toEqual({ source: "web_page", origin: `${origin()}/landing` });
      expect(out?.content).toContain("Hidden content:");
      await s.navigate(`${origin()}/notes`);
      const notes = await s.read();
      expect(notes.report.suspicious).toBe(true);
      expect(notes.hidden).toHaveLength(0);
      const rows = await auditRows("browser_read");
      expect(rows.at(-1)?.result_summary).toContain("injection suspected");
      await manager.closeRun(c.runId);
    });

    it("typing into a password field needs approval at every autonomy level", async () => {
      autonomy = 4;
      answer = "denied";
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/login`);
      await s.type("#username", "alice");
      const before = approvals.requests.length;
      const err = await s.type("#password", "typed-by-model").catch((e) => e);
      expect(isForerunnerError(err, "approval_required")).toBe(true);
      expect(approvals.requests.length).toBe(before + 1);
      expect(approvals.requests.at(-1)?.guards).toEqual(["credential"]);
      expect(approvals.requests.at(-1)?.actionClass).toBe("credential");
      const x = await s.read();
      expect(x.forms[0]?.fields.find((f) => f.name === "username")).toBeTruthy();
      const err2 = await s.type("#otp", "123456").catch((e) => e);
      expect(isForerunnerError(err2, "approval_required")).toBe(true);
      answer = "approved";
      const r = await s.type("#password", "typed-by-model");
      expect(r.guards).toEqual(["credential"]);
      await manager.closeRun(c.runId);
    });

    it("fills a vault secret without the value reaching results, logs or the audit", async () => {
      autonomy = 2;
      answer = "approved";
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/login`);
      await s.type("#username", "alice");
      const r = await s.fillSecret("#password", "secret:shop_login", { submit: true });
      expect(r.secret).toBe("shop_login");
      expect(r.url).toBe(`${origin()}/login`);
      expect(r.title).toBe("");
      const posted = allowedHits.find((h) => h.method === "POST" && h.url === "/login");
      expect(posted?.body).toContain(`password=${encodeURIComponent(SECRET_VALUE)}`);
      expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(approvals.requests)).not.toContain(SECRET_VALUE);
      const rows = await auditRows();
      for (const row of rows) {
        expect(row.input_summary).not.toContain(SECRET_VALUE);
        expect(row.result_summary).not.toContain(SECRET_VALUE);
      }
      expect(rows.find((x) => x.tool === "browser_fill_secret")?.input_summary).toContain(
        "secret:shop_login",
      );
      const unresolved = manager.peek(c.runId);
      expect(unresolved).toBe(s);
      await manager.closeRun(c.runId);
    });

    it("purchases need approval even at autonomy 4; personal data only below 4", async () => {
      autonomy = 4;
      answer = "denied";
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/checkout`);
      await s.type("#cardname", "Alice Example");
      const payErr = await s.type("#cardnumber", "4111111111111111").catch((e) => e);
      expect(isForerunnerError(payErr, "approval_required")).toBe(true);
      const err = await s.click("#place-order").catch((e) => e);
      expect(isForerunnerError(err, "approval_required")).toBe(true);
      expect(approvals.requests.at(-1)?.guards).toEqual(["purchase"]);
      expect(allowedHits.some((h) => h.method === "POST" && h.url === "/checkout")).toBe(false);
      await s.click("#apply-coupon"); // plain form: no approval
      expect(approvals.requests.at(-1)?.guards).toEqual(["purchase"]);

      await s.navigate(`${origin()}/signup`);
      await s.type("#email", "alice@example.test");
      const asked = approvals.requests.length;
      await s.click("#terms");
      await s.click("#create");
      expect(approvals.requests.length).toBe(asked);
      expect(allowedHits.some((h) => h.method === "POST" && h.url === "/signup")).toBe(true);

      autonomy = 2;
      const c2 = ctx();
      const s2 = await manager.sessionFor(c2);
      await s2.navigate(`${origin()}/signup`);
      const termsErr = await s2.click("#terms").catch((e) => e);
      expect(isForerunnerError(termsErr, "approval_required")).toBe(true);
      expect(approvals.requests.at(-1)?.guards).toEqual(["accept_terms"]);
      const submitErr = await s2.click("#create").catch((e) => e);
      expect(isForerunnerError(submitErr, "approval_required")).toBe(true);
      expect(approvals.requests.at(-1)?.guards).toEqual(["personal_submit"]);
      await manager.closeRun(c.runId);
      await manager.closeRun(c2.runId);
    });

    it("saves screenshots and downloads inside the agent sandbox and audits the paths", async () => {
      autonomy = 2;
      answer = "approved";
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/notes`);
      const shot = await s.screenshot({ label: "notes" });
      expect(shot.path.startsWith(s.dirs.screenshots)).toBe(true);
      expect(statSync(shot.path).size).toBeGreaterThan(100);
      const shotRow = (await auditRows("browser_screenshot")).at(-1);
      expect(shotRow?.result_summary).toContain(shot.path);

      const byUrl = await s.download({ url: `${origin()}/file.bin` });
      expect(byUrl.path.startsWith(s.dirs.downloads)).toBe(true);
      expect(byUrl.filename).toContain("changelog.bin");
      expect(readFileSync(byUrl.path, "utf8").startsWith("FORERUNNER-DOWNLOAD-")).toBe(true);
      const byClick = await s.download({ selector: "#download-link" });
      expect(byClick.path.startsWith(s.dirs.downloads)).toBe(true);
      expect(byClick.bytes).toBe(byUrl.bytes);
      const blockedErr = await s.download({ url: `${blockedOrigin()}/file.bin` }).catch((e) => e);
      expect(isForerunnerError(blockedErr, "domain_not_allowed")).toBe(true);
      const rows = await auditRows("browser_download");
      expect(rows.filter((r) => r.allowed)).toHaveLength(2);
      expect(rows.at(-1)?.allowed).toBe(false);
      await manager.closeRun(c.runId);
    });

    it("revokes live: an in-flight navigation fails, later calls are refused, the context is closed", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/notes`);
      const inflight = s.navigate(`${origin()}/slow`);
      await new Promise((r) => setTimeout(r, 500));
      const t0 = performance.now();
      const report = await manager.revoke({ agentId: AGENT }, "panel: browser revoked");
      expect(performance.now() - t0).toBeLessThan(5_000);
      expect(report).toEqual({ sessions: 1, browsers: 1 });
      const err = await inflight.catch((e) => e);
      expect(isForerunnerError(err, "killed")).toBe(true);
      const later = await s.navigate(`${origin()}/notes`).catch((e) => e);
      expect(isForerunnerError(later, "killed")).toBe(true);
      expect(s.status).toBe("revoked");
      expect(manager.openSessions).toBe(0);
      const rows = await auditRows("browser_revoke");
      expect(rows.at(-1)?.denied_reason).toContain("panel: browser revoked");
      // a new grant starts a fresh browser
      const c2 = ctx();
      const s2 = await manager.sessionFor(c2);
      expect((await s2.navigate(`${origin()}/notes`)).status).toBe(200);
      await manager.closeRun(c2.runId);
    });

    it("the kill switch revokes browser sessions", async () => {
      const kill = new KillSwitch();
      const detach = manager.attachKillSwitch(kill);
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/notes`);
      await kill.stop("all", "test kill");
      for (let i = 0; i < 50 && s.status === "open"; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(s.status).toBe("revoked");
      expect(manager.openSessions).toBe(0);
      detach();
    });
  },
);

if (!ready.ok) {
  it.skip(`sandboxed browser skipped: ${ready.reason}`, () => {});
}
