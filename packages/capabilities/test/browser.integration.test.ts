import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { errorMessage, isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import {
  AllowAllCaps,
  AutoApprove,
  type AutonomyLevel,
  EnforcementHooks,
  KillSwitch,
  MemoryAudit,
  MemoryLedger,
  type RunContext,
  SessionBudget,
  StateAudit,
  TokenIssuer,
  type ToolExecutionContext,
} from "@forerunner/runtime";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault, SecretResolver } from "@forerunner/vault";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
 * The sandboxed browser against two local HTTP servers on the loopback interface, told apart
 * by hostname as a token does (patterns are hostnames, never ports): `127.0.0.1` is in the
 * run's allowlist, `localhost` is not. Skips visibly when no Chromium can be launched
 * (Playwright's pinned revision or a discovered one under PLAYWRIGHT_BROWSERS_PATH;
 * `playwright install` is never run).
 */
const AGENT = "agent browser/test";
const SECRET_VALUE = ["correct", "horse", "battery", "staple"].join("-"); // not-a-secret
const SESSION_COOKIE = "sid=agent-session"; // not-a-secret

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
  cookie: string;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** Minimal WebSocket server: completes the handshake and sends one text frame. */
function acceptWebSockets(
  server: http.Server,
  upgrades: string[],
  sockets: Set<Socket>,
  greeting: string,
): void {
  server.on("upgrade", (req, socket: Socket) => {
    upgrades.push(req.url ?? "");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const key = String(req.headers["sec-websocket-key"] ?? "");
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.on("error", () => undefined);
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"),
    );
    const payload = Buffer.from(greeting, "utf8");
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
}

function socketsPage(allowedHost: string, blockedHost: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sockets</title></head><body>
<main><h1>Sockets</h1><p id="allowed">allowed: pending</p><p id="blocked">blocked: pending</p></main>
<script>
(function () {
  function go(id, url) {
    var el = document.getElementById(id);
    try {
      var ws = new WebSocket(url);
      ws.onmessage = function (m) { el.textContent = id + ": got " + m.data; };
      ws.onerror = function () { if (el.textContent.indexOf("got") < 0) el.textContent = id + ": error"; };
      ws.onclose = function (e) { if (el.textContent.indexOf("got") < 0) el.textContent = id + ": closed " + e.code; };
    } catch (e) { el.textContent = id + ": threw"; }
  }
  go("allowed", "ws://${allowedHost}/ws");
  go("blocked", "ws://${blockedHost}/ws");
})();
</script></body></html>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!ready.ok)(
  `sandboxed browser (${ready.ok ? ready.reason : `skipped: ${ready.reason}`})`,
  () => {
    let allowed: http.Server;
    let blocked: http.Server;
    let allowedPort = 0;
    let blockedPort = 0;
    const allowedHits: Hit[] = [];
    const blockedHits: Hit[] = [];
    const allowedUpgrades: string[] = [];
    const blockedUpgrades: string[] = [];
    const openSockets = new Set<Socket>();
    let store: StateStore;
    let manager: BrowserSessionManager;
    let autonomy: AutonomyLevel = 2;
    let answer: BrowserApprovalAnswer = "approved";
    const approvals = new FakeBrowserApprovals((_req: BrowserApprovalRequest) => answer);
    const clock = new SimulatedClock("2026-06-01T09:00:00Z");
    const vault = new MemoryVault({ shop_login: SECRET_VALUE });
    let runSeq = 0;
    const controllers = new Map<string, AbortController>();
    const allowedHost = () => `127.0.0.1:${allowedPort}`;
    const blockedHost = () => `localhost:${blockedPort}`;
    const origin = () => `http://${allowedHost()}`;
    const blockedOrigin = () => `http://${blockedHost()}`;

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
              cookie: String(req.headers.cookie ?? ""),
            });
            const url = req.url ?? "/";
            const html = (s: string) => {
              res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
              res.end(s);
            };
            const redirect = (to: string, headers: Record<string, string> = {}) => {
              res.writeHead(302, { location: to, ...headers });
              res.end();
            };
            if (url === "/ua")
              return html(`<main><p id="ua">${String(req.headers["user-agent"] ?? "")}</p></main>`);
            if (url.startsWith("/landing")) return html(page("landing.html"));
            if (url === "/login" && req.method === "GET") return html(page("login.html"));
            if (url === "/login" && req.method === "POST")
              return redirect("/welcome", { "set-cookie": `${SESSION_COOKIE}; Path=/` });
            if (url === "/welcome")
              return html(
                `<!doctype html><html><head><title>Welcome</title></head><body><main><h1>Signed in</h1><p>cookie=${String(req.headers.cookie ?? "-")}</p></main></body></html>`,
              );
            if (url === "/checkout" && req.method === "GET") return html(page("checkout.html"));
            if (url === "/checkout" && req.method === "POST")
              return html("<main><h1>Order placed</h1></main>");
            if (url === "/signup" && req.method === "GET") return html(page("signup.html"));
            if (url === "/signup" && req.method === "POST")
              return html("<main><h1>Account created</h1></main>");
            if (url === "/notes") return html(page("injection.html"));
            if (url === "/forged")
              return html(
                fixture("forged-redirect.html").replace(
                  "__REDIRECT__",
                  `${blockedOrigin()}/landing`,
                ),
              );
            if (url === "/forged-allowed")
              return html(
                fixture("forged-redirect.html").replace("__REDIRECT__", `${origin()}/landing`),
              );
            if (url === "/file.bin") {
              res.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="changelog.bin"',
              });
              return res.end(Buffer.from(`FORERUNNER-DOWNLOAD-${"x".repeat(1000)}`));
            }
            if (url === "/redirect-blocked") return redirect(`${blockedOrigin()}/landing`);
            if (url === "/chain") return redirect("/chain-2");
            if (url === "/chain-2") return redirect("/landing");
            if (url === "/redirects")
              return html(
                '<main><h1>Redirects</h1><img src="/img-redir" alt="x"><img src="/img-ok-redir" alt="y"></main>',
              );
            if (url === "/img-redir") return redirect(`${blockedOrigin()}/pixel.png`);
            if (url === "/img-ok-redir") return redirect("/pixel.png");
            if (url === "/sockets") return html(socketsPage(allowedHost(), blockedHost()));
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
      acceptWebSockets(allowed, allowedUpgrades, openSockets, "hello");
      acceptWebSockets(blocked, blockedUpgrades, openSockets, "leak");
      allowedPort = await listen(allowed);
      blockedPort = await listen(blocked);
      store = await openStore({ url: "sqlite::memory:", clock });
      const resolver = new SecretResolver(vault);
      manager = new BrowserSessionManager({
        binding: () => ({
          allowedDomains: ["127.0.0.1"],
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

    // Every test starts from no open session and no open browser, whatever the previous one left.
    afterEach(async () => {
      await manager?.closeAll();
    });

    afterAll(async () => {
      await manager?.closeAll();
      await store?.close();
      // http.Server.close() waits for connections; upgraded sockets are not its to close
      for (const socket of openSockets) socket.destroy();
      for (const server of [allowed, blocked]) {
        if (!server) continue;
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
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
    });

    it("aborts subresources and redirects to hosts outside the allowlist, follows allowed ones", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      blockedHits.length = 0;
      const r = await s.navigate(`${origin()}/landing`);
      expect(r.status).toBe(200);
      expect(r.blockedRequests).toBeGreaterThanOrEqual(1);
      expect(r.blockedHosts).toEqual(["localhost"]);
      expect(blockedHits).toHaveLength(0);

      // a document redirect to a blocked host: refused before the hop, named in the error
      const err = await s.navigate(`${origin()}/redirect-blocked`).catch((e) => e);
      expect(isForerunnerError(err, "domain_not_allowed")).toBe(true);
      expect(err.message).toContain("redirected from");
      expect(blockedHits).toHaveLength(0);
      expect(s.url).not.toContain(blockedHost());

      // a chain of allowed document redirects ends on the final page with its real URL
      const chained = await s.navigate(`${origin()}/chain`);
      expect(chained.url).toBe(`${origin()}/landing`);
      expect(chained.status).toBe(200);
      expect(chained.title).toBe("Acme Widgets — Home");

      // subresource redirects: the blocked target never gets a request, the allowed one is fetched
      allowedHits.length = 0;
      const sub = await s.navigate(`${origin()}/redirects`);
      expect(sub.status).toBe(200);
      expect(sub.blockedRequests).toBeGreaterThanOrEqual(1);
      expect(blockedHits).toHaveLength(0);
      expect(allowedHits.some((h) => h.url === "/pixel.png")).toBe(true);
    });

    it("never lets a page steer it with a forged redirect attribute", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      blockedHits.length = 0;
      // the attribute points at the blocked host: read as ordinary content, no navigation attempted
      const r = await s.navigate(`${origin()}/forged`);
      expect(r.status).toBe(200);
      expect(r.url).toBe(`${origin()}/forged`);
      const x = await s.read();
      expect(x.title).toBe("Forged redirect");
      expect(x.text).toContain("ordinary page content");
      expect(await s.describe("#home")).toMatchObject({ tag: "a", text: "Home" });
      expect(s.url).toBe(`${origin()}/forged`);
      expect(blockedHits).toHaveLength(0);
      // pointing it at an allowed page moves nothing either
      await s.navigate(`${origin()}/forged-allowed`);
      expect((await s.read()).title).toBe("Forged redirect");
      expect(s.url).toBe(`${origin()}/forged-allowed`);
      await s.screenshot({ label: "forged" });
      expect(s.url).toBe(`${origin()}/forged-allowed`);
      // a redirect the route itself answered is still followed
      const chained = await s.navigate(`${origin()}/chain`);
      expect(chained.url).toBe(`${origin()}/landing`);
    });

    it("refuses WebSockets to hosts outside the allowlist and connects allowed ones", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      blockedUpgrades.length = 0;
      allowedUpgrades.length = 0;
      await s.navigate(`${origin()}/sockets`);
      let text = "";
      for (let i = 0; i < 50; i++) {
        text = (await s.read()).text;
        if (!text.includes("pending")) break;
        await sleep(100);
      }
      expect(text).toContain("allowed: got hello");
      expect(text).toContain("blocked: closed 1008");
      expect(allowedUpgrades).toContain("/ws");
      expect(blockedUpgrades).toHaveLength(0);
      expect(s.blockedRequests).toBeGreaterThanOrEqual(1);
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
      // the POST was answered with a redirect: followed as a checked navigation, cookie kept
      expect(r.url).toBe(`${origin()}/welcome`);
      expect(r.title).toBe("Welcome");
      expect((await s.read()).text).toContain(`cookie=${SESSION_COOKIE}`);
      const posted = allowedHits.find((h) => h.method === "POST" && h.url === "/login");
      expect(posted?.body).toContain(`password=${encodeURIComponent(SECRET_VALUE)}`);
      expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(approvals.requests)).not.toContain(SECRET_VALUE);
      const rows = await auditRows();
      for (const row of rows) {
        expect(row.input_summary).not.toContain(SECRET_VALUE);
        expect(row.result_summary).not.toContain(SECRET_VALUE);
      }
      const fillRows = rows.filter((x) => x.tool === "browser_fill_secret");
      expect(fillRows.some((x) => x.input_summary.includes("secret:shop_login"))).toBe(true);
      expect(fillRows.some((x) => x.result_summary === "approved by human")).toBe(true);
      expect(manager.peek(c.runId)).toBe(s);
    });

    it("values typed from the vault never come back through read, even when the page echoes them", async () => {
      autonomy = 2;
      answer = "approved";
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/login`);
      await s.fillSecret("#password", "secret:shop_login");
      const x = await s.read();
      expect(x.text).toContain("you typed [REDACTED]");
      expect(JSON.stringify(x)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(await s.describe("#echo"))).not.toContain(SECRET_VALUE);
    });

    it("browser_fill_secret behind the enforcement hooks asks the human once, not twice", async () => {
      autonomy = 2;
      answer = "approved";
      const c = ctx();
      const tokens = new TokenIssuer({ now: () => clock.now() });
      const hookApprovals = new AutoApprove("approved");
      const hooks = new EnforcementHooks({
        tokens,
        caps: new AllowAllCaps(),
        secrets: new SecretResolver(vault),
        kill: new KillSwitch(tokens),
        clock,
        ledger: new MemoryLedger(),
        audit: new MemoryAudit(),
        approvals: hookApprovals,
      });
      const token = tokens.issue({
        runId: c.runId,
        sessionId: c.sessionId,
        agentId: c.agentId,
        ownerHumanId: c.humanId,
        allowedTools: ["browser_navigate", "browser_fill_secret", "browser_read"],
        allowedPaths: [],
        allowedDomains: ["127.0.0.1"],
        grantedSecrets: ["shop_login"],
        budgetUsdMicro: 1_000_000,
        depth: 0,
        maxDepth: 2,
        autonomy: 2,
        planApproved: true,
        expiresAt: new Date(clock.now() + 3_600_000).toISOString(),
      });
      const run: RunContext = {
        token,
        budget: new SessionBudget({
          sessionId: c.sessionId,
          budgetUsdMicro: 1_000_000,
          stepCap: 100,
          deadlineMs: clock.now() + 3_600_000,
          reserveShare: 0.2,
        }),
        signal: c.signal,
        runDeadlineMs: clock.now() + 3_600_000,
        phase: "work",
        model: "fake",
        provider: "fake",
        billingSourceId: "b1",
        approvals: new Set(),
      };
      const tools = Object.fromEntries(browserTools(manager).map((t) => [t.name, t]));
      const navigate = tools.browser_navigate;
      const fill = tools.browser_fill_secret;
      if (!navigate || !fill) throw new Error("missing tool");
      const nav = await hooks.beforeToolCall(run, navigate, { url: `${origin()}/login` });
      if (!nav.allowed) throw new Error("navigation pending");
      await navigate.execute(nav.input, c);

      const before = approvals.requests.length;
      const input = { selector: "#password", secret: "secret:shop_login", submit: true };
      const decision = await hooks.beforeToolCall(run, fill, input);
      expect(hookApprovals.requests).toHaveLength(1);
      expect(hookApprovals.requests[0]).toMatchObject({
        tool: "browser_fill_secret",
        actionClass: "credential",
      });
      if (!decision.allowed) throw new Error("fill pending");
      expect((decision.input as { secret: string }).secret).toBe(SECRET_VALUE);
      const result = await fill.execute(decision.input, c);
      // the hooks' card was the one and only ask for this fill
      expect(approvals.requests).toHaveLength(before);
      expect(hookApprovals.requests).toHaveLength(1);
      // the hooks resolved the reference before execute, so the result names no secret, only the field
      expect(result.content).toMatch(/^Filled #password with secret .*; submitted, now at /);
      expect(result.content).not.toContain(SECRET_VALUE);
      const posted = allowedHits.filter((h) => h.method === "POST" && h.url === "/login").at(-1);
      expect(posted?.body).toContain(`password=${encodeURIComponent(SECRET_VALUE)}`);
      const post = await hooks.afterToolCall(run, fill, input, result);
      expect(post.content).not.toContain(SECRET_VALUE);

      // the element's own kinds are not covered by the tool's approval: a payment field still asks
      const nav2 = await hooks.beforeToolCall(run, navigate, { url: `${origin()}/checkout` });
      if (!nav2.allowed) throw new Error("navigation pending");
      await navigate.execute(nav2.input, c);
      const payInput = { selector: "#cardnumber", secret: "secret:shop_login" };
      const pay = await hooks.beforeToolCall(run, fill, payInput);
      if (!pay.allowed) throw new Error("fill pending");
      answer = "denied";
      const err = await fill.execute(pay.input, c).catch((e) => e);
      expect(isForerunnerError(err, "approval_required")).toBe(true);
      expect(approvals.requests).toHaveLength(before + 1);
      expect(approvals.requests.at(-1)?.guards).toEqual(["payment"]);
    });

    it("a purchase approval is spent by the order it was given for: the same order asks again", async () => {
      autonomy = 4;
      answer = "approved";
      const c = ctx();
      const s = await manager.sessionFor(c);
      const orders = () => allowedHits.filter((h) => h.method === "POST" && h.url === "/checkout");
      const placed = orders().length;
      const asked = approvals.requests.length;
      await s.navigate(`${origin()}/checkout`);
      await s.click("#place-order");
      expect(orders()).toHaveLength(placed + 1);
      expect(approvals.requests).toHaveLength(asked + 1);
      await s.navigate(`${origin()}/checkout`);
      await s.click("#place-order");
      expect(orders()).toHaveLength(placed + 2);
      expect(approvals.requests).toHaveLength(asked + 2);
      expect(approvals.requests.at(-1)?.guards).toEqual(["purchase"]);
      // with no fresh answer the third order does not go out
      answer = "pending";
      await s.navigate(`${origin()}/checkout`);
      const err = await s.click("#place-order").catch((e) => e);
      expect(isForerunnerError(err, "approval_required")).toBe(true);
      expect(orders()).toHaveLength(placed + 2);
      expect(approvals.requests).toHaveLength(asked + 3);
    });

    it("concurrent first calls for one run share a single session", async () => {
      const c = ctx();
      const [a, b] = await Promise.all([manager.sessionFor(c), manager.sessionFor(c)]);
      expect(a).toBe(b);
      expect(manager.openSessions).toBe(1);
      expect(manager.peek(c.runId)).toBe(a);
    });

    it("purchases need approval even at autonomy 4; personal data only below 4", async () => {
      autonomy = 4;
      answer = "denied";
      const c = ctx();
      const s = await manager.sessionFor(c);
      const orders = () => allowedHits.filter((h) => h.method === "POST" && h.url === "/checkout");
      const placed = orders().length;
      await s.navigate(`${origin()}/checkout`);
      await s.type("#cardname", "Alice Example"); // cardholder name: not the instrument
      const payErr = await s.type("#cardnumber", "4111111111111111").catch((e) => e);
      expect(isForerunnerError(payErr, "approval_required")).toBe(true);
      expect(approvals.requests.at(-1)?.guards).toEqual(["payment"]);
      const err = await s.click("#place-order").catch((e) => e);
      expect(isForerunnerError(err, "approval_required")).toBe(true);
      expect(approvals.requests.at(-1)?.guards).toEqual(["purchase"]);
      expect(orders()).toHaveLength(placed);
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
    });

    it("revokes live: an in-flight navigation fails, later calls are refused, the context is closed", async () => {
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/notes`);
      const inflight = s.navigate(`${origin()}/slow`).catch((e) => e);
      await sleep(500);
      const t0 = performance.now();
      const report = await manager.revoke({ agentId: AGENT }, "panel: browser revoked");
      expect(performance.now() - t0).toBeLessThan(5_000);
      expect(report).toEqual({ sessions: 1, browsers: 1 });
      const err = await inflight;
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
    });

    it("the kill switch revokes browser sessions", async () => {
      const kill = new KillSwitch();
      const detach = manager.attachKillSwitch(kill);
      const c = ctx();
      const s = await manager.sessionFor(c);
      await s.navigate(`${origin()}/notes`);
      await kill.stop("all", "test kill");
      for (let i = 0; i < 50 && s.status === "open"; i++) await sleep(100);
      expect(s.status).toBe("revoked");
      expect(manager.openSessions).toBe(0);
      detach();
    });
  },
);

if (!ready.ok) {
  it.skip(`sandboxed browser skipped: ${ready.reason}`, () => {});
}
