/**
 * The raw CDP driver of the Android emulator smoke (`cdp.mjs`) against a fake DevTools
 * endpoint: `node:http` serves `/json/list`, a `ws` server answers the page target's socket,
 * and `Runtime.evaluate` runs the driver's in-page code against a jsdom document that carries
 * a tiny layout stand-in (`data-box="x y w h"` boxes, `elementFromPoint` over them), so the
 * locator semantics the smoke relies on (role and accessible name, test ids, innermost text,
 * `filter({ has })`, strictness, visibility waits) run for real and not as string matches.
 * The page also carries a CSP stand-in: `eval` and `Function` refuse like a page whose policy
 * has no 'unsafe-eval' (the app bundle's), so in-page code that builds code from a string
 * fails here as it would in the WebView. Types: `cdp.d.mts` (driver), `jsdom.d.ts` (jsdom).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { JSDOM, VirtualConsole } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  CdpClient,
  CdpError,
  type CdpTarget,
  connectPage,
  describeFailure,
  describePage,
  listTargets,
  PAGE_TEXT_LINES,
  Page,
  pickPageTarget,
  socketUrlFor,
} from "./cdp.mjs";
import { formatConsoleEvent, formatException, forwardPageConsole } from "./webview-console.mjs";

type Target = {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
};

type Params = Record<string, unknown>;
type Handler = (params: Params, fake: FakeDevTools) => unknown;

interface FakeDevTools {
  httpBase: string;
  port: number;
  calls: Array<{ method: string; params: Params }>;
  listRequests: number;
  handlers: Map<string, Handler>;
  targets: () => Target[];
  dom: JSDOM;
  /** Runs code in the page's realm with the realm's own eval (the CSP stand-in only shadows the page's globals). */
  exec(code: string): unknown;
  sockets: Set<WsSocket>;
  /** Send an event frame (no id) to every open socket. */
  emit(method: string, params: Params): void;
  close(): Promise<void>;
}

const APP_URL = "http://tauri.localhost/m";

const FIXTURE = `<!doctype html><html><head><title>Forerunner</title></head><body>
<main>
  <section>
    <h1 data-box="0 0 300 20">Pair this phone</h1>
    <h2 hidden>Projects</h2>
    <form>
      <input data-testid="m-pair-url" data-box="0 30 300 20" value="">
      <input data-testid="m-pair-code" data-box="0 60 300 20" value="old">
      <button type="button" data-testid="m-pair-submit" data-box="0 90 100 20">Pair</button>
    </form>
  </section>
  <ol>
    <li data-testid="m-request" data-request-id="req_merge" data-box="0 120 300 60">
      <p>Merge the PR</p>
      <button type="button" data-testid="m-option" data-box="0 150 80 20">Approve</button>
    </li>
    <li data-testid="m-request" data-request-id="req_cap" data-box="0 200 300 80">
      <p data-testid="m-request-high">High risk: answering asks for your fingerprint first.</p>
      <button type="button" data-testid="m-option" data-box="0 240 80 20">Confirm</button>
      <div data-testid="m-request-error" hidden data-box="0 260 300 20">
        This answer needs the biometric step first.
      </div>
    </li>
  </ol>
  <a href="/changes" data-box="0 300 100 20">Change log</a>
  <div data-testid="m-result" data-status="done" data-box="0 330 300 20">done</div>
  <span data-testid="m-blocking-count" data-box="0 360 100 20">0 blocking</span>
</main>
<nav data-testid="m-nav" aria-label="Main" data-box="0 400 300 40">
  <a href="/inbox" data-box="0 400 100 40"><span>Inbox</span></a>
  <a href="/remote" data-box="100 400 100 40"><span>Remote</span></a>
</nav>
</body></html>`;

/** Layout stand-in for jsdom: boxes from `data-box`, hit testing over them, click and input recording. */
const LAYOUT = `(() => {
  const boxOf = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      const b = n.getAttribute("data-box");
      if (b) { const [x, y, w, h] = b.split(/[ ,]+/).map(Number); return { x, y, w, h }; }
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  };
  const hiddenNow = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
      if (n.hasAttribute("hidden") || (n.style && n.style.display === "none")) return true;
    }
    return false;
  };
  Element.prototype.getBoundingClientRect = function () {
    const b = hiddenNow(this) ? { x: 0, y: 0, w: 0, h: 0 } : boxOf(this);
    return { x: b.x, y: b.y, left: b.x, top: b.y, width: b.w, height: b.h, right: b.x + b.w, bottom: b.y + b.h };
  };
  Element.prototype.getClientRects = function () {
    const r = this.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? [r] : [];
  };
  Element.prototype.scrollIntoView = function () { window.__scrolled = (window.__scrolled || 0) + 1; };
  document.elementFromPoint = (x, y) => {
    let hit = null;
    for (const el of document.querySelectorAll("*")) {
      if (hiddenNow(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom) hit = el;
    }
    return hit;
  };
  window.__clicks = [];
  document.addEventListener("click", (e) => {
    const t = e.target;
    window.__clicks.push(t.getAttribute("data-testid") || t.textContent.trim());
  });
  window.__inputs = [];
  document.addEventListener("input", (e) => window.__inputs.push([e.target.getAttribute("data-testid"), e.target.value]));
  document.addEventListener("change", (e) => window.__inputs.push(["change:" + e.target.getAttribute("data-testid"), e.target.value]));
})();`;

/** CSP stand-in: the page's `eval` and `Function` refuse, as under `default-src 'self'` without 'unsafe-eval'. */
const CSP_STANDIN = `(() => {
  const refuse = () => {
    throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script (CSP stand-in)");
  };
  window.eval = refuse;
  window.Function = refuse;
})();`;

const INSERT_TEXT = (text: string) => `(() => {
  const el = document.activeElement;
  if (!el || typeof el.value !== "string") return false;
  const s = el.selectionStart ?? el.value.length;
  const e = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, s) + ${JSON.stringify(text)} + el.value.slice(e);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const CLICK_AT = (x: number, y: number) => `(() => {
  const el = document.elementFromPoint(${x}, ${y});
  if (el) el.click();
  return el ? el.tagName : null;
})()`;

/** The code and message of a rejection (Error properties are not enumerable, so no toMatchObject). */
async function failure(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (error) {
    return { code: (error as CdpError).code, message: (error as Error).message };
  }
  throw new Error("expected a rejection");
}

const fakes: FakeDevTools[] = [];
afterEach(async () => {
  for (const f of fakes.splice(0)) await f.close();
});

function defaultHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  handlers.set("Runtime.evaluate", async (params, fake) => {
    try {
      let value: unknown = fake.exec(String(params.expression));
      if (params.awaitPromise && value && typeof (value as Promise<unknown>).then === "function") {
        value = await value;
      }
      if (value === undefined) return { result: { type: "undefined" } };
      return { result: { type: typeof value, value: JSON.parse(JSON.stringify(value)) } };
    } catch (error) {
      const description =
        error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return {
        result: { type: "object", subtype: "error", description },
        exceptionDetails: { text: "Uncaught", exception: { description } },
      };
    }
  });
  handlers.set("Input.insertText", (params, fake) => {
    fake.exec(INSERT_TEXT(String(params.text)));
    return {};
  });
  handlers.set("Input.dispatchMouseEvent", (params, fake) => {
    if (params.type === "mouseReleased") {
      fake.exec(CLICK_AT(Number(params.x), Number(params.y)));
    }
    return {};
  });
  return handlers;
}

async function startFakeDevTools(
  options: {
    html?: string;
    targets?: (fake: FakeDevTools) => Target[];
    listPath?: "/json/list" | "/json";
  } = {},
): Promise<FakeDevTools> {
  const dom = new JSDOM(options.html ?? FIXTURE, {
    url: APP_URL,
    runScripts: "outside-only",
    // requestAnimationFrame runs (at 60 Hz), as in a foreground WebView
    pretendToBeVisual: true,
    // a link click asks jsdom to navigate, which it reports as "not implemented": keep it quiet
    virtualConsole: new VirtualConsole(),
  });
  // The realm's own eval, kept before the CSP stand-in shadows `window.eval`: it plays the
  // DevTools side (Runtime.evaluate), which a page's CSP does not govern.
  const exec = dom.window.eval;
  exec(LAYOUT);
  exec(CSP_STANDIN);
  const wss = new WebSocketServer({ noServer: true });
  const listPath = options.listPath ?? "/json/list";
  const server: Server = createServer((req, res) => {
    if (req.url === listPath) {
      fake.listRequests += 1;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(fake.targets()));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      fake.sockets.add(ws);
      ws.on("close", () => fake.sockets.delete(ws));
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: Params };
        const params = msg.params ?? {};
        fake.calls.push({ method: msg.method, params });
        const handler = fake.handlers.get(msg.method);
        if (!handler) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: { code: -32601, message: `'${msg.method}' wasn't found` },
            }),
          );
          return;
        }
        const result = await handler(params, fake);
        if (result === null) return; // a handler that never answers
        ws.send(JSON.stringify({ id: msg.id, result }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const httpBase = `http://127.0.0.1:${port}`;
  const fake: FakeDevTools = {
    httpBase,
    port,
    calls: [],
    listRequests: 0,
    handlers: defaultHandlers(),
    targets: () => [],
    dom,
    exec,
    sockets: new Set(),
    emit(method, params) {
      for (const ws of fake.sockets) ws.send(JSON.stringify({ method, params }));
    },
    async close() {
      for (const ws of fake.sockets) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      dom.window.close();
    },
  };
  fake.targets =
    options.targets?.bind(null, fake) ??
    (() => [
      {
        id: "SW1",
        type: "service_worker",
        title: "worker",
        url: "http://tauri.localhost/sw.js",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/SW1`,
      },
      {
        id: "PAGE1",
        type: "page",
        title: "Forerunner",
        url: APP_URL,
        webSocketDebuggerUrl: `ws://localhost:${port}/devtools/page/PAGE1`,
      },
    ]);
  fakes.push(fake);
  return fake;
}

async function openPage(
  fake: FakeDevTools,
  timeoutMs = 2_000,
  log?: (line: string) => void,
): Promise<Page> {
  const client = await CdpClient.connect(`ws://127.0.0.1:${fake.port}/devtools/page/PAGE1`);
  return new Page(client, { timeoutMs, pollMs: 20, log });
}

const clicks = (fake: FakeDevTools) => fake.exec("window.__clicks") as string[];
const inputs = (fake: FakeDevTools) => fake.exec("window.__inputs") as string[][];
const mouse = (fake: FakeDevTools) =>
  fake.calls.filter((c) => c.method === "Input.dispatchMouseEvent").map((c) => c.params);
const presses = (fake: FakeDevTools) =>
  mouse(fake)
    .filter((p) => p.type === "mousePressed")
    .map((p) => [p.x, p.y]);
const taps = (fake: FakeDevTools) =>
  fake.calls
    .filter((c) => c.method === "Input.dispatchTouchEvent")
    .map((c) => [c.params.type, c.params.touchPoints]);

/**
 * The emulator run's page shape (android.yml run 40013402240): `#root` is viewport-tall
 * (`height: 100%` is a plain rule the old WebView applies) while the unstyled content is
 * shorter, so a point below the content hits `#root` itself; the nav sits in the flow under
 * Home's list.
 */
const RUN_40013402240 = `<!doctype html><html><head><title>Forerunner</title></head><body>
<div id="root" data-box="0 0 300 900">
<div data-testid="m-shell" data-box="0 0 300 470">
<header data-box="0 0 300 30">Forerunner PharmaWatch live</header>
<main data-box="0 30 300 400"><section data-testid="m-home"><h1>Projects</h1><p>1 request blocks work until you answer.</p></section></main>
<nav data-testid="m-nav" aria-label="Main" data-box="0 430 300 40">
  <a href="/inbox" data-box="0 430 100 40"><span>Inbox</span></a>
</nav>
</div></div></body></html>`;

/**
 * A fake input path: `Input.dispatchMouseEvent` delivers the press and release events to
 * `target(x, y)` (the element the browser would hit), reporting `clientX`/`clientY` as
 * `seenAt(x, y)` (where the page would see the event); `Input.dispatchTouchEvent` likewise
 * through `touchTarget`, when given (without it the fake refuses the touch domain).
 */
function fakeInputPath(
  fake: FakeDevTools,
  options: {
    target: string;
    seenAt?: string;
    touchTarget?: string;
    onPress?: (x: number, y: number) => void;
  },
): void {
  const seenAt = options.seenAt ?? "(x, y) => [x, y]";
  const deliver = (target: string, types: string[], x: number, y: number) =>
    fake.exec(`(() => {
      const [cx, cy] = (${seenAt})(${x}, ${y});
      const el = (${target})(${x}, ${y});
      for (const type of ${JSON.stringify(types)}) {
        if (el) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
      }
    })()`);
  fake.handlers.set("Input.dispatchMouseEvent", (params) => {
    const x = Number(params.x);
    const y = Number(params.y);
    if (params.type === "mousePressed") {
      options.onPress?.(x, y);
      deliver(options.target, ["pointerdown", "mousedown"], x, y);
    } else if (params.type === "mouseReleased") {
      deliver(options.target, ["pointerup", "mouseup", "click"], x, y);
    }
    return {};
  });
  if (options.touchTarget) {
    const touchTarget = options.touchTarget;
    let last = [0, 0];
    fake.handlers.set("Input.dispatchTouchEvent", (params) => {
      const points = params.touchPoints as Array<{ x: number; y: number }>;
      if (params.type === "touchStart") {
        last = [Number(points[0]?.x), Number(points[0]?.y)];
        deliver(touchTarget, ["touchstart", "pointerdown"], last[0], last[1]);
      } else if (params.type === "touchEnd") {
        deliver(touchTarget, ["touchend", "pointerup", "click"], last[0], last[1]);
      }
      return {};
    });
  }
}

describe("page target selection", () => {
  it("lists /json/list and picks the preferred page target over workers and other pages", async () => {
    const fake = await startFakeDevTools({
      targets: (f) => [
        {
          id: "W",
          type: "service_worker",
          title: "worker",
          url: "http://tauri.localhost/sw.js",
          webSocketDebuggerUrl: `ws://127.0.0.1:${f.port}/devtools/page/W`,
        },
        {
          id: "OTHER",
          type: "page",
          title: "about:blank",
          url: "about:blank",
          webSocketDebuggerUrl: `ws://127.0.0.1:${f.port}/devtools/page/OTHER`,
        },
        {
          id: "APP",
          type: "page",
          title: "Forerunner",
          url: APP_URL,
          webSocketDebuggerUrl: `ws://127.0.0.1:${f.port}/devtools/page/APP`,
        },
      ],
    });
    const targets = await listTargets(fake.httpBase);
    expect(targets.map((t) => t.id)).toEqual(["W", "OTHER", "APP"]);
    const picked = pickPageTarget(targets, {
      prefer: (t: CdpTarget) => String(t.url).includes("/m"),
    });
    expect(picked.id).toBe("APP");
    // Without a preference the first page target wins; workers never do.
    expect(pickPageTarget(targets).id).toBe("OTHER");
  });

  it("falls back to /json when /json/list is missing, and reports no page target", async () => {
    const fake = await startFakeDevTools({
      listPath: "/json",
      targets: (f) => [
        {
          id: "W",
          type: "service_worker",
          title: "worker",
          url: "x",
          webSocketDebuggerUrl: `ws://127.0.0.1:${f.port}/devtools/page/W`,
        },
      ],
    });
    const targets = await listTargets(fake.httpBase);
    expect(targets).toHaveLength(1);
    expect(() => pickPageTarget(targets)).toThrow(CdpError);
    try {
      pickPageTarget(targets);
    } catch (error) {
      expect((error as CdpError).code).toBe("cdp.no_page_target");
    }
  });

  it("builds the socket URL from the forwarded port, whatever host the target names", () => {
    expect(
      socketUrlFor("http://127.0.0.1:9333", {
        webSocketDebuggerUrl: "ws://localhost:9222/devtools/page/ABC",
      }),
    ).toBe("ws://127.0.0.1:9333/devtools/page/ABC");
    expect(() => socketUrlFor("http://127.0.0.1:9333", {})).toThrow(CdpError);
  });
});

describe("CdpClient", () => {
  it("correlates responses by id, ignores events, and surfaces protocol errors", async () => {
    const fake = await startFakeDevTools();
    fake.handlers.set("Test.slow", async () => {
      await new Promise((r) => setTimeout(r, 80));
      return { which: "slow" };
    });
    fake.handlers.set("Test.fast", (_params, f) => {
      f.emit("Runtime.executionContextCreated", { context: { id: 1 } });
      return { which: "fast" };
    });
    const client = await CdpClient.connect(`ws://127.0.0.1:${fake.port}/devtools/page/PAGE1`);
    const order: string[] = [];
    const slow = client.send<{ which: string }>("Test.slow").then((r) => {
      order.push(r.which);
      return r;
    });
    const fast = client.send<{ which: string }>("Test.fast").then((r) => {
      order.push(r.which);
      return r;
    });
    expect(await fast).toEqual({ which: "fast" });
    expect(await slow).toEqual({ which: "slow" });
    expect(order).toEqual(["fast", "slow"]);
    expect(await failure(client.send("Nope.method"))).toMatchObject({
      code: "cdp.protocol_error",
      message: expect.stringContaining("Nope.method"),
    });
    client.close();
  });

  it("times out a request that never gets an answer", async () => {
    const fake = await startFakeDevTools();
    fake.handlers.set("Test.never", () => null);
    const client = await CdpClient.connect(`ws://127.0.0.1:${fake.port}/devtools/page/PAGE1`);
    expect(await failure(client.send("Test.never", {}, { timeoutMs: 50 }))).toMatchObject({
      code: "cdp.timeout",
      message: expect.stringContaining("Test.never"),
    });
    client.close();
  });

  it("rejects every pending request when the socket closes", async () => {
    const fake = await startFakeDevTools();
    fake.handlers.set("Test.never", () => null);
    const client = await CdpClient.connect(`ws://127.0.0.1:${fake.port}/devtools/page/PAGE1`);
    const pending = client.send("Test.never", {}, { timeoutMs: 5_000 });
    for (const ws of fake.sockets) ws.close();
    expect(await failure(pending)).toMatchObject({ code: "cdp.closed" });
    expect(await failure(client.send("Test.fast"))).toMatchObject({ code: "cdp.closed" });
  });

  it("fails the connect when nothing listens on the socket", async () => {
    const fake = await startFakeDevTools();
    const port = fake.port;
    await fake.close();
    fakes.pop();
    expect(
      await failure(
        CdpClient.connect(`ws://127.0.0.1:${port}/devtools/page/PAGE1`, { timeoutMs: 1_000 }),
      ),
    ).toMatchObject({ code: "cdp.connect_failed" });
  });
});

describe("Page and locators over Runtime.evaluate", () => {
  it("evaluates by value and turns a page exception into a CdpError", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    expect(await page.evaluate("1 + 2")).toBe(3);
    expect(await page.title()).toBe("Forerunner");
    const call = fake.calls.find((c) => c.method === "Runtime.evaluate");
    expect(call?.params).toMatchObject({ returnByValue: true, awaitPromise: true });
    expect(await failure(page.evaluate("(() => { throw new Error('boom') })()"))).toMatchObject({
      code: "cdp.evaluate_failed",
      message: expect.stringContaining("boom"),
    });
  });

  it("finds headings, buttons and links by role and accessible name (substring, case-insensitive, exact on request; hidden excluded)", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    expect(await page.getByRole("heading", { name: "Pair this phone" }).count()).toBe(1);
    expect(await page.getByRole("heading", { name: "pair this PHONE" }).count()).toBe(1);
    expect(await page.getByRole("heading", { name: "Pair", exact: true }).count()).toBe(0);
    expect(await page.getByRole("heading", { name: "Projects" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Approve" }).count()).toBe(1);
    expect(await page.getByRole("button").count()).toBe(3);
    expect(await page.getByRole("link", { name: "Change log" }).count()).toBe(1);
    expect(await page.getByRole("link", { name: "Change log" }).getAttribute("href")).toBe(
      "/changes",
    );
  });

  it("scopes chained queries, picks the innermost text match, and filters by a descendant", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    const inbox = page.getByTestId("m-nav").getByText("Inbox");
    expect(await inbox.count()).toBe(1);
    expect(await inbox.evaluate("(el) => el.tagName")).toBe("SPAN");
    expect(await page.getByText("Inbox").count()).toBe(1);
    expect(await page.getByTestId("m-request").count()).toBe(2);
    const high = page.getByTestId("m-request").filter({ has: page.getByTestId("m-request-high") });
    expect(await high.count()).toBe(1);
    expect(await high.getAttribute("data-request-id")).toBe("req_cap");
    expect(await page.getByTestId("m-request").first().getAttribute("data-request-id")).toBe(
      "req_merge",
    );
    expect(await page.getByTestId("m-request").nth(1).getAttribute("data-request-id")).toBe(
      "req_cap",
    );
    expect(await page.locator('[data-testid="m-result"][data-status="done"]').count()).toBe(1);
    expect(await page.getByTestId("m-blocking-count").getByText("0 blocking").count()).toBe(1);
    expect(await page.getByTestId("m-request-high").innerText()).toMatch(/fingerprint/);
    expect(
      await failure(page.getByTestId("missing").getAttribute("x", { timeout: 60 })),
    ).toMatchObject({ code: "cdp.timeout", message: expect.stringContaining("not found") });
  });

  it("waitFor resolves once the element is visible and times out naming the locator", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    const error = page.getByTestId("m-request-error");
    expect(await error.count()).toBe(1);
    expect(await error.isVisible()).toBe(false);
    // Attached but hidden is not enough: the wait times out and says it waited for "visible".
    expect(await failure(error.waitFor({ timeout: 60 }))).toMatchObject({
      code: "cdp.timeout",
      message: expect.stringContaining("visible"),
    });
    let unhidden = false;
    setTimeout(() => {
      fake.exec(
        'document.querySelector("[data-testid=m-request-error]").removeAttribute("hidden")',
      );
      unhidden = true;
    }, 120);
    await error.waitFor({ timeout: 2_000 });
    expect(unhidden).toBe(true);
    expect(await error.isVisible()).toBe(true);
    expect(await error.innerText()).toMatch(/biometric/i);
    expect(await failure(page.getByTestId("never-there").waitFor({ timeout: 100 }))).toMatchObject({
      code: "cdp.timeout",
      message: expect.stringContaining('getByTestId("never-there")'),
    });
  });

  it("clicks at the centre of the element with CDP mouse events after scrolling it into view", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    await page.getByTestId("m-request").first().getByRole("button", { name: "Approve" }).click();
    expect(mouse(fake).map((p) => p.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse(fake)[1]).toMatchObject({ x: 40, y: 160, button: "left", clickCount: 1 });
    expect(mouse(fake)[2]).toMatchObject({ x: 40, y: 160, button: "left", clickCount: 1 });
    expect(clicks(fake)).toEqual(["m-option"]);
    expect(fake.exec("window.__scrolled")).toBe(1);
    await page.getByTestId("m-nav").getByText("Remote").click();
    expect(clicks(fake)).toEqual(["m-option", "Remote"]);
  });

  it("never lets a click land on what moved under the point after it was measured (android.yml run 40000764444)", async () => {
    // The emulator's WebView applies none of the app's Tailwind v4 rules (cascade layers need
    // Chrome 99+), so the bottom nav sits in the flow right under Home's project list. The
    // runner clicked "Inbox" while `/projects` was still on its way: the driver measured the
    // nav item, the list arrived and pushed the nav down, and the mouse events went to the old
    // point, now inside Home's section. The route stayed `/`, and `m-request` had 0 matches.
    const fake = await startFakeDevTools({
      html: `<!doctype html><html><head><title>Forerunner</title></head><body>
<main><section data-testid="m-home" data-box="0 0 300 100"><h1>Projects</h1></section></main>
<nav data-testid="m-nav" aria-label="Main" data-box="0 100 300 40">
  <a href="/inbox" data-box="0 100 100 40"><span>Inbox</span></a>
</nav></body></html>`,
    });
    // Real event order at the point: pointer and mouse down on press, up and click on release.
    // The first mouse event of the click is when the project list lands and the nav moves.
    let shifted = false;
    fake.handlers.set("Input.dispatchMouseEvent", (params, f) => {
      if (!shifted) {
        shifted = true;
        f.exec(`(() => {
          document.querySelector("[data-testid=m-home]").setAttribute("data-box", "0 0 300 400");
          document.querySelector("[data-testid=m-nav]").setAttribute("data-box", "0 400 300 40");
          document.querySelector("a[href='/inbox']").setAttribute("data-box", "0 400 100 40");
        })()`);
      }
      const types =
        params.type === "mousePressed"
          ? ["pointerdown", "mousedown"]
          : params.type === "mouseReleased"
            ? ["pointerup", "mouseup", "click"]
            : [];
      f.exec(`(() => {
        const el = document.elementFromPoint(${Number(params.x)}, ${Number(params.y)});
        for (const type of ${JSON.stringify(types)}) {
          if (el) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true,
            clientX: ${Number(params.x)}, clientY: ${Number(params.y)} }));
        }
      })()`);
      return {};
    });
    fake.exec(`window.__downs = [];
      document.addEventListener("mousedown", (e) => window.__downs.push(e.target.getAttribute("data-testid") || e.target.textContent.trim()));`);
    await openPage(fake).then((page) => page.getByTestId("m-nav").getByText("Inbox").click());
    // The misplaced press and click were stopped before the page saw them; the retry
    // measured the nav where it now is and clicked there.
    expect(clicks(fake)).toEqual(["Inbox"]);
    expect(fake.exec("window.__downs")).toEqual(["Inbox"]);
    const presses = mouse(fake).filter((p) => p.type === "mousePressed");
    expect(presses.map((p) => [p.x, p.y])).toEqual([
      [50, 120],
      [50, 420],
    ]);
  });

  it("keeps the guard up until the click of a missed press arrives, so late release events never reach the page (review finding 1)", async () => {
    const fake = await startFakeDevTools({
      html: `<!doctype html><html><head><title>Forerunner</title></head><body>
<main><section data-testid="m-home" data-box="0 0 300 100"><h1>Projects</h1></section></main>
<nav data-testid="m-nav" aria-label="Main" data-box="0 100 300 40">
  <a href="/inbox" data-box="0 100 100 40"><span>Inbox</span></a>
</nav></body></html>`,
    });
    // The nav moves on the first press; every release's mouseup and click reach the page
    // 150 ms after the CDP answer (queued behind it), at the point of that release.
    let shifted = false;
    fake.handlers.set("Input.dispatchMouseEvent", (params, f) => {
      if (!shifted && params.type === "mousePressed") {
        shifted = true;
        f.exec(`(() => {
          document.querySelector("[data-testid=m-home]").setAttribute("data-box", "0 0 300 400");
          document.querySelector("[data-testid=m-nav]").setAttribute("data-box", "0 400 300 40");
          document.querySelector("a[href='/inbox']").setAttribute("data-box", "0 400 100 40");
        })()`);
      }
      const types =
        params.type === "mousePressed"
          ? ["mousedown"]
          : params.type === "mouseReleased"
            ? ["mouseup", "click"]
            : [];
      const delay = params.type === "mouseReleased" ? 150 : -1;
      f.exec(`(() => {
        const fire = () => {
          const el = document.elementFromPoint(${Number(params.x)}, ${Number(params.y)});
          for (const type of ${JSON.stringify(types)}) {
            if (el) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
          }
        };
        if (${delay} < 0) fire(); else setTimeout(fire, ${delay});
      })()`);
      return {};
    });
    fake.exec(`window.__ups = [];
      document.addEventListener("mouseup", (e) => window.__ups.push(e.target.getAttribute("data-testid") || e.target.textContent.trim()));`);
    await openPage(fake).then((page) => page.getByTestId("m-nav").getByText("Inbox").click());
    // Let any straggler arrive before looking.
    await new Promise((r) => setTimeout(r, 400));
    // One click on Inbox (the old guard let a second one through), none on Home.
    expect(clicks(fake)).toEqual(["Inbox"]);
    expect(fake.exec("window.__ups")).toEqual(["Inbox"]);
    expect(mouse(fake).filter((p) => p.type === "mousePressed")).toHaveLength(2);
  });

  it("counts a click that replaced the document as landed, not lost (review finding 2)", async () => {
    const fake = await startFakeDevTools();
    // The release navigates: the new document has no guard and no event record.
    fake.handlers.set("Input.dispatchMouseEvent", (params, f) => {
      if (params.type === "mouseReleased") f.exec("delete window.__forerunnerCdpClickGuard");
      return {};
    });
    const page = await openPage(fake);
    await page.getByRole("button", { name: "Approve" }).click({ timeout: 2_000 });
    expect(mouse(fake).filter((p) => p.type === "mousePressed")).toHaveLength(1);
  });

  it("fails naming what got the click when the element keeps moving away from the point", async () => {
    const fake = await startFakeDevTools({
      html: `<!doctype html><html><head><title>Forerunner</title></head><body>
<main><section data-testid="m-home" data-box="0 0 300 100"><h1>Projects</h1></section></main>
<nav data-testid="m-nav" aria-label="Main" data-box="0 100 300 40">
  <a href="/inbox" data-box="0 100 100 40"><span>Inbox</span></a>
</nav></body></html>`,
    });
    // Every press moves the nav one row further down before it lands: a page that never
    // settles under the pointer.
    let row = 100;
    fake.handlers.set("Input.dispatchMouseEvent", (params, f) => {
      if (params.type === "mousePressed") {
        row += 100;
        f.exec(`(() => {
          document.querySelector("[data-testid=m-home]").setAttribute("data-box", "0 0 300 ${row}");
          document.querySelector("[data-testid=m-nav]").setAttribute("data-box", "0 ${row} 300 40");
          document.querySelector("a[href='/inbox']").setAttribute("data-box", "0 ${row} 100 40");
        })()`);
      }
      const types =
        params.type === "mousePressed"
          ? ["mousedown"]
          : params.type === "mouseReleased"
            ? ["mouseup", "click"]
            : [];
      f.exec(`(() => {
        const el = document.elementFromPoint(${Number(params.x)}, ${Number(params.y)});
        for (const type of ${JSON.stringify(types)}) {
          if (el) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
        }
      })()`);
      return {};
    });
    const page = await openPage(fake);
    expect(
      await failure(page.getByTestId("m-nav").getByText("Inbox").click({ timeout: 400 })),
    ).toMatchObject({
      code: "cdp.click_missed",
      message: expect.stringMatching(/<h1> "Projects" was at \(50, \d+\) instead/),
    });
    // Nothing on the page ever received one of the misplaced clicks.
    expect(clicks(fake)).toEqual([]);
  });

  it("reports a click whose mouse events never reached the page", async () => {
    const fake = await startFakeDevTools();
    fake.handlers.set("Input.dispatchMouseEvent", () => ({}));
    const page = await openPage(fake);
    expect(
      await failure(page.getByRole("button", { name: "Approve" }).click({ timeout: 2_000 })),
    ).toMatchObject({ code: "cdp.click_lost", message: expect.stringContaining("Approve") });
    expect(mouse(fake).filter((p) => p.type === "mousePressed")).toHaveLength(1);
  });

  it("clicks where the element settles when its box still moves after scrollIntoView", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    // A scroll still in flight: the first scrollIntoView moves the button once, just after the
    // call returns (before the next animation frame and before any CDP mouse event).
    fake.exec(`(() => {
      const el = document.querySelector("[data-testid=m-pair-submit]");
      el.scrollIntoView = function () {
        if (this.__moved) return;
        this.__moved = true;
        setTimeout(() => this.setAttribute("data-box", "0 500 100 20"), 0);
      };
    })()`);
    await page.getByTestId("m-pair-submit").click({ timeout: 2_000 });
    expect(mouse(fake).map((p) => p.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse(fake)[1]).toMatchObject({ x: 50, y: 510 });
    expect(mouse(fake)[2]).toMatchObject({ x: 50, y: 510 });
    expect(clicks(fake)).toEqual(["m-pair-submit"]);
  });

  it("waits for the layout to settle (box, page height and DOM mutations quiet) before the one click, when the page keeps growing after the click starts", async () => {
    // Home's banner and cards arrive after the first card, each pushing the in-flow nav down,
    // and the screen's text keeps changing for a while (a re-render per poll). The old driver
    // measured at once and needed the guard's retry; the settled click is one press, after
    // the last change.
    const fake = await startFakeDevTools({
      html: `<!doctype html><html><head><title>Forerunner</title></head><body>
<main><section data-testid="m-home" data-box="0 0 300 100"><h1>Projects</h1><p>loading</p></section></main>
<nav data-testid="m-nav" aria-label="Main" data-box="0 100 300 40">
  <a href="/inbox" data-box="0 100 100 40"><span>Inbox</span></a>
</nav></body></html>`,
    });
    const base = fake.handlers.get("Runtime.evaluate") as Handler;
    let started = false;
    fake.handlers.set("Runtime.evaluate", (params, f) => {
      // The page grows from the moment the driver starts measuring: frame 2 and frame 4 move
      // the nav (box changes), frames 5 to 30 change Home's text (mutations, no box change).
      if (!started && String(params.expression).includes('"clickPoint"')) {
        started = true;
        f.exec(`(() => {
          window.__log = [];
          const home = document.querySelector("[data-testid=m-home]");
          const nav = document.querySelector("[data-testid=m-nav]");
          const link = document.querySelector("a[href='/inbox']");
          const place = (row) => {
            home.setAttribute("data-box", "0 0 300 " + row);
            nav.setAttribute("data-box", "0 " + row + " 300 40");
            link.setAttribute("data-box", "0 " + row + " 100 40");
            window.__log.push("move");
          };
          let frame = 0;
          const tick = () => {
            frame += 1;
            if (frame === 2) place(400);
            if (frame === 4) place(420);
            if (frame >= 5 && frame <= 30) {
              home.querySelector("p").textContent = "poll " + frame;
              window.__log.push("text");
            }
            if (frame <= 30) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })()`);
      }
      return base(params, f);
    });
    fakeInputPath(fake, {
      target: "(x, y) => document.elementFromPoint(x, y)",
      onPress: () => fake.exec('window.__log.push("press")'),
    });
    const page = await openPage(fake, 5_000);
    await page.getByTestId("m-nav").getByText("Inbox").click();
    expect(clicks(fake)).toEqual(["Inbox"]);
    // One press, at the settled position, after every layout change and text change.
    expect(presses(fake)).toEqual([[50, 440]]);
    const log = fake.exec("window.__log") as string[];
    expect(log.filter((e) => e === "move")).toHaveLength(2);
    expect(log.filter((e) => e === "text")).toHaveLength(26);
    expect(log.at(-1)).toBe("press");
  });

  it("corrects a constant offset between the dispatched point and where the page saw the events, through the mouse path (android.yml run 40013402240)", async () => {
    // The box is stable and the in-page probe hits the nav item, but every mouse event
    // arrives 30 px lower than dispatched and lands on bare #root below the content. After
    // three misses at one unchanged box, the driver reads the offset the guard saw and sends
    // the click shifted by it: the page sees it at the measured point.
    const fake = await startFakeDevTools({ html: RUN_40013402240 });
    fakeInputPath(fake, {
      target: "(x, y) => document.elementFromPoint(x, y + 30)",
      seenAt: "(x, y) => [x, y + 30]",
    });
    const lines: string[] = [];
    const page = await openPage(fake, 5_000, (l) => lines.push(l));
    await page.getByTestId("m-nav").getByText("Inbox").click();
    expect(clicks(fake)).toEqual(["Inbox"]);
    expect(presses(fake)).toEqual([
      [50, 450],
      [50, 450],
      [50, 450],
      [50, 420],
    ]);
    expect(taps(fake)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^click fallback: getByTestId\("m-nav"\)\.getByText\("Inbox"\) \(cdp\.click_missed: mouse click shifted by \(0, -30\) to \(50, 420\); the page saw 3 clicks at \(50, 480\) instead of \(50, 450\), on <div id="root">/,
    );
  });

  it("taps the way a phone does when the box is stable and the mouse events keep landing on another element with no offset to learn", async () => {
    // The page sees the events at the dispatched coordinates, yet the browser's hit target
    // is #root: the mouse path cannot land. The touch path (Input.dispatchTouchEvent) does.
    const fake = await startFakeDevTools({ html: RUN_40013402240 });
    fakeInputPath(fake, {
      target: "() => document.getElementById('root')",
      touchTarget: "(x, y) => document.elementFromPoint(x, y)",
    });
    const lines: string[] = [];
    const page = await openPage(fake, 5_000, (l) => lines.push(l));
    await page.getByTestId("m-nav").getByText("Inbox").click();
    expect(clicks(fake)).toEqual(["Inbox"]);
    expect(presses(fake)).toEqual([
      [50, 450],
      [50, 450],
      [50, 450],
    ]);
    expect(taps(fake)).toEqual([
      ["touchStart", [{ x: 50, y: 450 }]],
      ["touchEnd", []],
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^click fallback: getByTestId\("m-nav"\)\.getByText\("Inbox"\) \(cdp\.click_missed: tap through Input\.dispatchTouchEvent at \(50, 450\); 3 mouse clicks there landed on <div id="root">/,
    );
    // #root never saw a click that passed the guard.
    expect(fake.exec("window.__clicks.length")).toBe(1);
  });

  it("falls back to element.click() in the page, with a printed line, when the tap misses too; cdp.click_missed stays the error when even that fails", async () => {
    const fake = await startFakeDevTools({ html: RUN_40013402240 });
    fakeInputPath(fake, {
      target: "() => document.getElementById('root')",
      touchTarget: "() => document.getElementById('root')",
    });
    const lines: string[] = [];
    const page = await openPage(fake, 5_000, (l) => lines.push(l));
    await page.getByTestId("m-nav").getByText("Inbox").click();
    expect(clicks(fake)).toEqual(["Inbox"]);
    expect(presses(fake)).toHaveLength(3);
    expect(taps(fake)).toHaveLength(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^click fallback: .* \(cdp\.click_missed: tap through /);
    expect(lines[1]).toMatch(
      /^click fallback: getByTestId\("m-nav"\)\.getByText\("Inbox"\) \(cdp\.click_missed: element\.click\(\) in the page; 3 mouse clicks and a tap at \(50, 450\) landed on <div id="root">/,
    );
    // The last resort has no further fallback: a page whose element.click() raises no event
    // (and a WebView that refuses the touch domain) fails as cdp.click_missed with the hit.
    const fake2 = await startFakeDevTools({ html: RUN_40013402240 });
    fakeInputPath(fake2, { target: "() => document.getElementById('root')" });
    fake2.exec("HTMLElement.prototype.click = function () {}");
    const lines2: string[] = [];
    const page2 = await openPage(fake2, 5_000, (l) => lines2.push(l));
    const error = await failure(page2.getByTestId("m-nav").getByText("Inbox").click());
    expect(error).toMatchObject({
      code: "cdp.click_missed",
      message: expect.stringMatching(
        /^getByTestId\("m-nav"\)\.getByText\("Inbox"\): the click never reached it; 3 mouse clicks at \(50, 450\) landed on <div id="root">.*; the tap was refused \(Input\.dispatchTouchEvent: 'Input\.dispatchTouchEvent' wasn't found\); element\.click\(\) in the page raised no click event$/,
      ),
    });
    expect(lines2.map((l) => l.replace(/ \(cdp\.click_missed: (\S+).*/, " $1"))).toEqual([
      'click fallback: getByTestId("m-nav").getByText("Inbox") tap',
      'click fallback: getByTestId("m-nav").getByText("Inbox") element.click()',
    ]);
    expect(clicks(fake2)).toEqual([]);
  });

  it("evaluate splices the function source into the expression; the page never evaluates a string (CSP)", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    // The stand-in refuses a string eval in the page, like the bundle's CSP.
    expect(() => fake.exec("window.eval('1')")).toThrow(/unsafe-eval/);
    const fn = '(el) => el.getAttribute("data-request-id") + ":" + el.tagName';
    expect(await page.getByTestId("m-request").last().evaluate(fn)).toBe("req_cap:LI");
    const sent = fake.calls
      .filter((c) => c.method === "Runtime.evaluate")
      .map((c) => String(c.params.expression))
      .filter((e) => e.includes('"evaluate"'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`, "evaluate", (${fn}))`);
    expect(sent[0]).not.toMatch(/\beval\s*\(|new\s+Function|\bFunction\s*\(/);
    expect(
      await failure(page.getByTestId("m-result").evaluate("42", { timeout: 500 })),
    ).toMatchObject({ code: "cdp.bad_function" });
  });

  it("refuses an ambiguous click at once and reports an element that intercepts the click", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    expect(await failure(page.getByTestId("m-request").click({ timeout: 5_000 }))).toMatchObject({
      code: "cdp.strict_mode",
      message: expect.stringContaining("2 elements"),
    });
    fake.exec(
      'const o = document.createElement("div"); o.id = "overlay"; o.setAttribute("data-box", "0 140 300 40"); document.body.appendChild(o);',
    );
    expect(
      await failure(page.getByRole("button", { name: "Approve" }).click({ timeout: 300 })),
    ).toMatchObject({
      code: "cdp.click_intercepted",
      message: expect.stringContaining("overlay"),
    });
    expect(clicks(fake)).toEqual([]);
    expect(
      await failure(page.getByTestId("m-request-error").click({ timeout: 150 })),
    ).toMatchObject({ code: "cdp.timeout", message: expect.stringContaining("visible") });
  });

  it("fills through Input.insertText after focusing and selecting, replacing the old value", async () => {
    const fake = await startFakeDevTools();
    const page = await openPage(fake);
    await page.getByTestId("m-pair-url").fill("http://127.0.0.1:8788");
    await page.getByTestId("m-pair-code").fill("ABCD-1234");
    const inserts = fake.calls.filter((c) => c.method === "Input.insertText");
    expect(inserts.map((c) => c.params.text)).toEqual(["http://127.0.0.1:8788", "ABCD-1234"]);
    expect(fake.exec('document.querySelector("[data-testid=m-pair-url]").value')).toBe(
      "http://127.0.0.1:8788",
    );
    expect(fake.exec('document.querySelector("[data-testid=m-pair-code]").value')).toBe(
      "ABCD-1234",
    );
    expect(inputs(fake)).toEqual([
      ["m-pair-url", "http://127.0.0.1:8788"],
      ["m-pair-code", "ABCD-1234"],
    ]);
  });

  it("falls back to the native value setter with input and change events when insertText changes nothing", async () => {
    const fake = await startFakeDevTools();
    fake.handlers.set("Input.insertText", () => ({}));
    const page = await openPage(fake);
    await page.getByTestId("m-pair-code").fill("XYZ");
    expect(fake.exec('document.querySelector("[data-testid=m-pair-code]").value')).toBe("XYZ");
    expect(inputs(fake)).toEqual([
      ["m-pair-code", "XYZ"],
      ["change:m-pair-code", "XYZ"],
    ]);
    expect(await failure(page.getByTestId("m-result").fill("x", { timeout: 100 }))).toMatchObject({
      code: "cdp.not_editable",
    });
  });
});

describe("connectPage", () => {
  it("waits for the page target to appear, connects to it, and drives the page", async () => {
    let polls = 0;
    const fake = await startFakeDevTools({
      targets: (f) => {
        polls += 1;
        if (polls < 3) return [];
        return [
          {
            id: "PAGE1",
            type: "page",
            title: "Forerunner",
            url: APP_URL,
            webSocketDebuggerUrl: `ws://localhost:${f.port}/devtools/page/PAGE1`,
          },
        ];
      },
    });
    const { page, client, target } = await connectPage(fake.httpBase, {
      prefer: (t: CdpTarget) => String(t.url).includes("/m"),
      waitForTargetMs: 5_000,
      pollMs: 20,
      timeoutMs: 2_000,
    });
    expect(target.id).toBe("PAGE1");
    expect(fake.listRequests).toBeGreaterThanOrEqual(3);
    expect(await page.title()).toBe("Forerunner");
    await page.getByRole("heading", { name: "Pair this phone" }).waitFor({ timeout: 1_000 });
    client.close();
  });

  it("gives up with a stable code when no page target appears in time", async () => {
    const fake = await startFakeDevTools({ targets: () => [] });
    expect(
      await failure(connectPage(fake.httpBase, { waitForTargetMs: 150, pollMs: 20 })),
    ).toMatchObject({ code: "cdp.no_page_target" });
  });
});

describe("describeFailure (the runner's FAIL line)", () => {
  it("keeps a CdpError's stable code and details next to the message", async () => {
    const fake = await startFakeDevTools();
    const client = await CdpClient.connect(`ws://127.0.0.1:${fake.port}/devtools/page/PAGE1`);
    let protocolError: unknown;
    try {
      await client.send("Nope.method");
    } catch (error) {
      protocolError = error;
    }
    client.close();
    expect(describeFailure(protocolError)).toBe(
      `FAIL: Nope.method: 'Nope.method' wasn't found [cdp.protocol_error] {"code":-32601,"method":"Nope.method"}`,
    );
    expect(describeFailure(new CdpError("cdp.timeout", "slow"))).toBe("FAIL: slow [cdp.timeout]");
    expect(describeFailure(new Error("plain"))).toBe("FAIL: plain");
    expect(describeFailure("text")).toBe("FAIL: text");
  });
});

describe("describePage (the runner's page: lines)", () => {
  it("names the route and the title and lists the screen's text, capped", async () => {
    const fake = await startFakeDevTools({
      html: `<!doctype html><html><head><title>Forerunner</title></head><body>
<header>Forerunner</header>
<main><h1>Projects</h1>
<p>1 request blocks work until you answer.</p>
${Array.from({ length: 30 }, (_, i) => `<p>line ${i} ${"x".repeat(i === 3 ? 200 : 1)}</p>`).join("\n")}
</main></body></html>`,
    });
    const page = await openPage(fake);
    const shown = (await describePage(page)).split("\n");
    expect(shown[0]).toBe(`url ${APP_URL} (Forerunner)`);
    // The text of <main> only (not the header), one trimmed line each.
    expect(shown[1]).toBe("  Projects");
    expect(shown[2]).toBe("  1 request blocks work until you answer.");
    expect(shown).toHaveLength(1 + PAGE_TEXT_LINES + 1);
    expect(shown.at(-1)).toBe(`(${32 - PAGE_TEXT_LINES} more lines)`);
    expect(shown.find((l) => l.startsWith("  line 3"))?.length).toBeLessThanOrEqual(2 + 161);
    // The expression is plain DevTools-side code: no eval or Function inside the page.
    const sent = fake.calls.filter((c) => c.method === "Runtime.evaluate").at(-1);
    expect(String(sent?.params.expression)).not.toMatch(/\beval\s*\(|new\s+Function/);
  });

  it("run.mjs waits for Home's list before the nav click, checks each screen opened, and prints page: lines on a failure", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./run.mjs", import.meta.url), "utf8");
    const at = (needle: string) => {
      const i = source.indexOf(needle);
      expect(i, needle).toBeGreaterThan(0);
      return i;
    };
    const projects = at('getByRole("heading", { name: "Projects" }).waitFor(');
    const list = at('getByTestId("m-project-card").first().waitFor(');
    const inboxClick = at('getByTestId("m-nav").getByText("Inbox").click()');
    const inboxHeading = at('getByRole("heading", { name: "Inbox", exact: true }).waitFor(');
    const cards = at('getByTestId("m-request").first()');
    expect(list).toBeGreaterThan(projects);
    expect(inboxClick).toBeGreaterThan(list);
    expect(inboxHeading).toBeGreaterThan(inboxClick);
    expect(cards).toBeGreaterThan(inboxHeading);
    expect(at('getByRole("heading", { name: "Remote control" }).waitFor(')).toBeGreaterThan(
      at('getByTestId("m-nav").getByText("Remote").click()'),
    );
    // The page is read before the cleanups close the socket, and printed after the FAIL line.
    const read = at("await describePage(attachedPage)");
    expect(at("await cleanup();\n    if (error instanceof Skip)")).toBeGreaterThan(read);
    expect(at("console.error(`page: ")).toBeGreaterThan(
      at("console.error(describeFailure(error))"),
    );
  });
});

/**
 * What Chrome does after `Runtime.enable`, on the fake: the page's `console.*` calls arrive as
 * `Runtime.consoleAPICalled` with RemoteObject arguments and a call site. Simpler than Chrome
 * in one way: V8 also replays, on enable, the console messages it kept from before; the fake
 * hooks the console only from the enable on, so the tests can tell when forwarding started.
 */
function enableRuntimeOnFake(fake: FakeDevTools): void {
  fake.handlers.set("Runtime.enable", (_params, f) => {
    const win = f.dom.window as unknown as {
      console: Record<string, (...args: unknown[]) => void>;
    };
    const remote = (v: unknown) => {
      if (typeof v === "string") return { type: "string", value: v };
      if (typeof v === "number" || typeof v === "boolean") return { type: typeof v, value: v };
      if (v === undefined) return { type: "undefined" };
      if (v === null) return { type: "object", subtype: "null", value: null };
      if (v instanceof (f.dom.window as unknown as { Error: ErrorConstructor }).Error) {
        const e = v as Error;
        return {
          type: "object",
          subtype: "error",
          className: e.name,
          description: `${e.name}: ${e.message}\n    at send (http://tauri.localhost/assets/index.js:1:200)`,
        };
      }
      return { type: "object", className: "Object", description: "Object" };
    };
    const levels: Record<string, string> = {
      log: "log",
      info: "info",
      warn: "warning",
      error: "error",
      debug: "debug",
    };
    for (const [name, type] of Object.entries(levels)) {
      win.console[name] = (...args: unknown[]) =>
        f.emit("Runtime.consoleAPICalled", {
          type,
          args: args.map(remote),
          executionContextId: 1,
          timestamp: 1_760_000_000_000,
          stackTrace: {
            callFrames: [
              {
                functionName: "assertHighRisk",
                url: "http://tauri.localhost/assets/index.js",
                lineNumber: 0,
                columnNumber: 4120,
              },
            ],
          },
        });
    }
    f.emit("Runtime.executionContextCreated", { context: { id: 1, origin: APP_URL } });
    return {};
  });
}

describe("forwardPageConsole: the WebView's console on the runner's stdout", () => {
  it("enables Runtime on the page session and writes console calls as webview: lines", async () => {
    const fake = await startFakeDevTools();
    enableRuntimeOnFake(fake);
    const page = await openPage(fake);
    // Before forwarding is on, the fake reports nothing (Chrome would replay this on enable).
    await page.evaluate("console.warn('before'), true");
    const lines: string[] = [];
    const forwarding = await forwardPageConsole(page.client, {
      write: (l: string) => lines.push(l),
    });
    expect(forwarding.enabled).toBe(true);
    expect(fake.calls.filter((c) => c.method === "Runtime.enable")).toHaveLength(1);
    await page.evaluate(
      "console.info('forerunner: high-risk answer: asking the biometric prompt (60000 ms limit)'), true",
    );
    await page.evaluate(
      "console.warn('forerunner: high-risk answer refused on the phone:', 'Biometrics not enrolled.'), true",
    );
    await page.evaluate("console.error(new Error('boom'), 42, null, undefined, {a: 1}), true");
    await page.evaluate("console.log('two', 'words'), true");
    await expect.poll(() => lines.length).toBe(4);
    expect(lines[0]).toBe(
      "webview: [info] forerunner: high-risk answer: asking the biometric prompt (60000 ms limit)",
    );
    expect(lines[1]).toBe(
      "webview: [warn] forerunner: high-risk answer refused on the phone: Biometrics not enrolled. (http://tauri.localhost/assets/index.js:1:4121)",
    );
    // A multi-line error description keeps the prefix on every line, and the call site sits
    // on the head line (a grep for `webview: [error]` shows where), not after the stack.
    expect(lines[2]?.split("\n")).toEqual([
      "webview: [error] Error: boom (http://tauri.localhost/assets/index.js:1:4121)",
      "webview:       at send (http://tauri.localhost/assets/index.js:1:200) 42 null undefined Object",
    ]);
    expect(lines[3]).toBe("webview: [log] two words");
    expect(lines.join("\n")).not.toContain("before");
    // Other events (execution contexts) are not console output; stop() ends the forwarding.
    forwarding.stop();
    await page.evaluate("console.error('after stop'), true");
    await new Promise((r) => setTimeout(r, 50));
    expect(lines).toHaveLength(4);
    page.client.close();
  });

  it("writes uncaught exceptions and unhandled rejections with their location and stack", async () => {
    const fake = await startFakeDevTools();
    enableRuntimeOnFake(fake);
    const page = await openPage(fake);
    const lines: string[] = [];
    await forwardPageConsole(page.client, { write: (l: string) => lines.push(l) });
    fake.emit("Runtime.exceptionThrown", {
      timestamp: 1_760_000_000_000,
      exceptionDetails: {
        exceptionId: 1,
        text: "Uncaught",
        lineNumber: 11,
        columnNumber: 4,
        url: "http://tauri.localhost/assets/index.js",
        exception: {
          type: "object",
          subtype: "error",
          className: "TypeError",
          description:
            "TypeError: Cannot read properties of undefined (reading 'ticket')\n    at assertHighRisk (http://tauri.localhost/assets/index.js:12:5)",
        },
      },
    });
    fake.emit("Runtime.exceptionThrown", {
      timestamp: 1_760_000_000_001,
      exceptionDetails: {
        exceptionId: 2,
        text: "Uncaught (in promise)",
        lineNumber: 0,
        columnNumber: 0,
        exception: { type: "string", value: "biometric.status not allowed" },
        stackTrace: {
          callFrames: [
            {
              functionName: "",
              url: "http://tauri.localhost/assets/core.js",
              lineNumber: 2,
              columnNumber: 9,
            },
          ],
        },
      },
    });
    await expect.poll(() => lines.length).toBe(2);
    expect(lines[0]?.split("\n")).toEqual([
      "webview: [exception] Uncaught TypeError: Cannot read properties of undefined (reading 'ticket') (http://tauri.localhost/assets/index.js:12:5)",
      "webview:       at assertHighRisk (http://tauri.localhost/assets/index.js:12:5)",
    ]);
    expect(lines[1]).toBe(
      "webview: [exception] Uncaught (in promise) biometric.status not allowed (http://tauri.localhost/assets/core.js:3:10)",
    );
    page.client.close();
  });

  it("never fails the smoke: a page that refuses Runtime.enable is reported as one line", async () => {
    const fake = await startFakeDevTools(); // no Runtime.enable handler: a protocol error
    const page = await openPage(fake);
    const lines: string[] = [];
    const forwarding = await forwardPageConsole(page.client, {
      write: (l: string) => lines.push(l),
    });
    expect(forwarding.enabled).toBe(false);
    expect(lines).toEqual([
      "webview: [runner] console forwarding unavailable: Runtime.enable: 'Runtime.enable' wasn't found",
    ]);
    // The session still drives the page.
    expect(await page.title()).toBe("Forerunner");
    page.client.close();
  });

  it("formats the RemoteObject shapes DevTools sends and caps a runaway line", () => {
    expect(
      formatConsoleEvent({
        type: "log",
        args: [
          { type: "number", unserializableValue: "NaN" },
          { type: "bigint", unserializableValue: "10n" },
          { type: "boolean", value: false },
          { type: "object", subtype: "array", className: "Array", description: "Array(2)" },
          { type: "object", value: { ok: true } },
          { type: "function", className: "Function", description: "() => {}" },
        ],
      }),
    ).toBe('webview: [log] NaN 10n false Array(2) {"ok":true} () => {}');
    expect(formatConsoleEvent({ type: "debug", args: [] }, "phone:")).toBe("phone: [debug] ");
    const long = formatConsoleEvent({
      type: "log",
      args: [{ type: "string", value: "x".repeat(5_000) }],
    });
    expect(long.length).toBeLessThan(2_100);
    expect(long.endsWith("…")).toBe(true);
    expect(formatException({})).toBe("webview: [exception] Uncaught");
  });

  it("run.mjs turns the forwarding on right after the attach, on the same page session", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./run.mjs", import.meta.url), "utf8");
    const attach = source.indexOf("await connectPage(");
    const forward = source.indexOf("await forwardPageConsole(client)");
    const smoke = source.indexOf("await smoke(page");
    expect(attach).toBeGreaterThan(0);
    expect(forward).toBeGreaterThan(attach);
    expect(smoke).toBeGreaterThan(forward);
  });
});
