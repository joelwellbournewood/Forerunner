/**
 * A raw Chrome DevTools Protocol client and a small DOM driver for the Android emulator smoke
 * (ADR 0054). The Android WebView exposes one DevTools socket per page and refuses
 * browser-level commands (`Browser.setDownloadBehavior: Browser context management is not
 * supported`, android.yml run 7), which is why Playwright's `connectOverCDP` cannot attach.
 * This module speaks to the page target directly:
 *
 *   - `listTargets(httpBase)` reads `GET /json/list` (then `/json`) on the forwarded port and
 *     `pickPageTarget` chooses the app's page; `socketUrlFor` keeps the forwarded host and port;
 *   - `CdpClient` is an id-correlated request/response channel over Node 22's global
 *     `WebSocket` with a timeout per request; events are ignored unless a listener asks;
 *   - `Page` and `Locator` cover the handful of Playwright calls the smoke uses, with the same
 *     meaning: `getByTestId`, `getByRole(role, { name, exact })` (headings h1-h6, buttons,
 *     links, explicit roles; name from aria-labelledby, aria-label, labels or text; hidden
 *     elements excluded), `getByText` (innermost element whose normalised text contains the
 *     words, case-insensitive unless `exact`), `locator(css)`, `filter({ has })`, `first`,
 *     `nth`, `count`, `waitFor` (visible), `click` (a layout-settle wait, scroll into view,
 *     measure and hit-test in one call, CDP mouse events at the centre under the in-page
 *     click guard; after three guarded misses at one unchanged box the fallback ladder of
 *     ADR 0087's amendment: a mouse click shifted by the offset the page reported, a tap
 *     through `Input.dispatchTouchEvent`, then `element.click()` in the page, each announced
 *     as a `click fallback:` line), `fill` (focus, select all, `Input.insertText`, native
 *     setter fallback with input and change events), `innerText`, `getAttribute`,
 *     `isVisible`, `evaluate`. Actions are strict: a locator that resolves to several
 *     elements is refused.
 *
 * Every element lookup runs inside the page through `Runtime.evaluate` with the query steps
 * as JSON; nothing is cached between calls, so a re-render never leaves a stale handle.
 * Nothing in the page builds code from a string (no eval, no new Function): the bundle's CSP
 * has no 'unsafe-eval'. Errors carry a stable `code` (`cdp.*`). No dependency outside Node.
 *
 * Node-only tooling, so two repository conventions are relaxed on purpose (ADR 0054): the
 * clock defaults to `Date.now` (callers pass `now`), and errors are this module's `CdpError`
 * rather than `ForerunnerError` (no workspace import in the emulator runner).
 */

export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 100;
/** How long a click's events may take to reach the page after the CDP answer (ms). */
const CLICK_SETTLE_MS = 1_000;
/**
 * The most one in-page layout-settle wait may take before it reports back (ms); the click's
 * own timeout bounds the total, and a wait that ran out is asked again until then.
 */
const SETTLE_BUDGET_MS = 10_000;
/**
 * Guarded misses at one unchanged, settled box before the fallback ladder runs (the first
 * miss cannot be judged, so this means three mouse clicks at the same point): a layout that
 * did not move between settled measurements cannot explain them, so the input path's
 * coordinates and the page's disagree (android.yml run 40013402240).
 */
const CLEAN_MISSES_BEFORE_FALLBACK = 2;

export class CdpError extends Error {
  /**
   * @param {string} code a stable `cdp.*` code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details) {
    super(message);
    this.name = "CdpError";
    this.code = code;
    this.details = details ?? {};
  }
}

/**
 * The runner's `FAIL:` line: the message, then a `CdpError`'s stable code in brackets and its
 * details as JSON when there are any.
 * @param {unknown} error
 * @returns {string}
 */
export function describeFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  const details =
    error && typeof error === "object" && error.details && typeof error.details === "object"
      ? error.details
      : null;
  let line = `FAIL: ${message}${code ? ` [${code}]` : ""}`;
  if (details && Object.keys(details).length > 0) {
    try {
      line += ` ${JSON.stringify(details)}`;
    } catch {
      line += ` (details not serialisable: ${Object.keys(details).join(", ")})`;
    }
  }
  return line;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(s) {
  return s.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------------------

/**
 * The targets the DevTools HTTP endpoint lists: `GET /json/list`, or `GET /json` when the
 * first path is not served.
 * @param {string} httpBase e.g. `http://127.0.0.1:9222`
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
export async function listTargets(httpBase, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = trimSlash(httpBase);
  let lastError = null;
  for (const path of ["/json/list", "/json"]) {
    try {
      const res = await fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        lastError = new CdpError("cdp.list_failed", `GET ${base}${path} -> ${res.status}`);
        continue;
      }
      const body = await res.json();
      if (!Array.isArray(body)) {
        throw new CdpError("cdp.list_failed", `GET ${base}${path} did not return a list`);
      }
      return body;
    } catch (error) {
      if (error instanceof CdpError && error.code !== "cdp.list_failed") throw error;
      lastError =
        error instanceof CdpError
          ? error
          : new CdpError("cdp.list_failed", `GET ${base}${path}: ${describeError(error)}`);
    }
  }
  throw lastError ?? new CdpError("cdp.list_failed", `no target list at ${base}`);
}

/**
 * The page target to drive: the first one `prefer` accepts, else the first page target.
 * Workers and other target types never qualify.
 * @param {Array<Record<string, unknown>>} targets
 * @param {{ prefer?: (target: Record<string, unknown>) => boolean }} [options]
 */
export function pickPageTarget(targets, options = {}) {
  const pages = targets.filter(
    (t) => t && t.type === "page" && typeof t.webSocketDebuggerUrl === "string",
  );
  if (pages.length === 0) {
    throw new CdpError("cdp.no_page_target", "the DevTools endpoint lists no page target", {
      types: targets.map((t) => t?.type ?? "?"),
    });
  }
  const preferred = options.prefer ? pages.find((t) => options.prefer(t)) : undefined;
  return preferred ?? pages[0];
}

/**
 * The WebSocket URL of a target on the forwarded port: Chrome fills `webSocketDebuggerUrl`
 * from the request's Host header, so only its path is trusted.
 * @param {string} httpBase
 * @param {Record<string, unknown>} target
 */
export function socketUrlFor(httpBase, target) {
  const raw = target?.webSocketDebuggerUrl;
  if (typeof raw !== "string" || raw.length === 0) {
    throw new CdpError("cdp.no_socket_url", "the page target carries no webSocketDebuggerUrl");
  }
  const base = new URL(httpBase);
  const path = new URL(raw).pathname;
  const scheme = base.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${base.host}${path}`;
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------

function describeError(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

export class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();
  #closed = null;
  #timeoutMs;

  /**
   * @param {string} url
   * @param {{ WebSocketImpl?: typeof WebSocket, timeoutMs?: number }} [options]
   * @returns {Promise<CdpClient>}
   */
  static connect(url, options = {}) {
    const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof WebSocketImpl !== "function") {
      throw new CdpError("cdp.no_websocket", "no WebSocket implementation (Node 22 has one)");
    }
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocketImpl(url);
      } catch (error) {
        reject(new CdpError("cdp.connect_failed", `${url}: ${describeError(error)}`));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          // closing a socket that never opened
        }
        reject(new CdpError("cdp.connect_timeout", `${url}: no open event in ${timeoutMs} ms`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(new CdpClient(ws, { timeoutMs }));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        (event) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const reason = event && "message" in event ? event.message : "WebSocket error";
          reject(new CdpError("cdp.connect_failed", `${url}: ${reason}`));
        },
        { once: true },
      );
    });
  }

  /** @param {WebSocket} ws an open socket */
  constructor(ws, options = {}) {
    this.#ws = ws;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    ws.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") this.#onMessage(data);
      else if (data && typeof data.text === "function")
        data.text().then((text) => this.#onMessage(text));
      else if (data) this.#onMessage(Buffer.from(data).toString("utf8"));
    });
    ws.addEventListener("close", (event) => {
      this.#onClose(
        `socket closed (${event?.code ?? "?"}${event?.reason ? `: ${event.reason}` : ""})`,
      );
    });
    ws.addEventListener("error", (event) => {
      this.#onClose(`socket error: ${event && "message" in event ? event.message : "unknown"}`);
    });
  }

  get closed() {
    return this.#closed !== null;
  }

  /**
   * @param {(event: { method: string, params: unknown }) => void} listener
   * @returns {() => void} unsubscribe
   */
  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} [params]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<any>} the command's result
   */
  send(method, params = {}, options = {}) {
    if (this.#closed) {
      return Promise.reject(new CdpError("cdp.closed", `${method}: ${this.#closed}`));
    }
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError("cdp.timeout", `${method}: no response in ${timeoutMs} ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      try {
        this.#ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(new CdpError("cdp.send_failed", `${method}: ${describeError(error)}`));
      }
    });
  }

  close() {
    this.#onClose("closed by the client");
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }

  #onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // not a protocol frame
    }
    if (typeof msg.id === "number") {
      const entry = this.#pending.get(msg.id);
      if (!entry) return;
      this.#pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(
          new CdpError(
            "cdp.protocol_error",
            `${entry.method}: ${msg.error.message ?? "error"}${msg.error.data ? ` (${msg.error.data})` : ""}`,
            { code: msg.error.code, method: entry.method },
          ),
        );
      } else {
        entry.resolve(msg.result ?? {});
      }
      return;
    }
    if (typeof msg.method === "string") {
      for (const listener of this.#listeners) {
        try {
          listener({ method: msg.method, params: msg.params });
        } catch {
          // a listener's failure never breaks the channel
        }
      }
    }
  }

  #onClose(reason) {
    if (this.#closed) return;
    this.#closed = reason;
    for (const [id, entry] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new CdpError("cdp.closed", `${entry.method}: ${reason}`));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// In-page query and actions (serialised into Runtime.evaluate; self-contained on purpose)
// ---------------------------------------------------------------------------------------------

/**
 * Runs inside the page. `steps` is the locator chain, `action` what to do with the result.
 * Returns plain data only. Kept free of references to this module's scope: it is sent as
 * source text.
 */
function pageScript(steps, action, arg) {
  const norm = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const matches = (actual, wanted, exact) =>
    exact
      ? norm(actual) === norm(wanted)
      : norm(actual).toLowerCase().includes(norm(wanted).toLowerCase());
  const attrValue = (v) => `"${String(v).replace(/["\\]/g, "\\$&")}"`;
  const win = window;
  const doc = win.document;
  const styleOf = (el) => {
    try {
      return win.getComputedStyle(el);
    } catch {
      return null;
    }
  };
  const hiddenForAria = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.getAttribute("aria-hidden") === "true" || n.hasAttribute("hidden")) return true;
      const style = styleOf(n);
      if (style && (style.display === "none" || style.visibility === "hidden")) return true;
    }
    return false;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset" || type === "image")
        return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "hidden") return null;
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "a" || tag === "area") return el.hasAttribute("href") ? "link" : null;
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "form") return "form";
    if (tag === "dialog") return "dialog";
    if (tag === "li") return "listitem";
    if (tag === "ul" || tag === "ol") return "list";
    if (tag === "img") return "img";
    if (tag === "table") return "table";
    return null;
  };
  const accessibleName = (el) => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent);
      if (parts.length > 0) return norm(parts.join(" "));
    }
    const label = el.getAttribute("aria-label");
    if (label && norm(label)) return norm(label);
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset") return norm(el.value);
      if (el.id) {
        const forLabel = doc.querySelector(`label[for=${attrValue(el.id)}]`);
        if (forLabel) return norm(forLabel.textContent);
      }
      const wrap = el.closest("label");
      if (wrap) return norm(wrap.textContent);
      return norm(el.getAttribute("placeholder") || el.getAttribute("title") || "");
    }
    if (tag === "img") return norm(el.getAttribute("alt") || el.getAttribute("title") || "");
    return norm(el.textContent);
  };
  const SKIP_TEXT = new Set(["script", "style", "noscript", "template", "head", "title"]);
  const visible = (el) => {
    if (!el.isConnected) return false;
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const style = styleOf(el);
    return !(style && style.visibility === "hidden");
  };
  const enabled = (el) => {
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") return false;
    const fieldset = el.closest ? el.closest("fieldset[disabled]") : null;
    return !fieldset;
  };
  const describe = (el) => {
    if (!el) return "nothing";
    const id = el.getAttribute("data-testid");
    const text = norm(el.textContent).slice(0, 40);
    return `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ""}${id ? ` data-testid="${id}"` : ""}>${text ? ` "${text}"` : ""}`;
  };
  const all = (root, css) => Array.from(root.querySelectorAll(css));
  const query = (roots, chain) => {
    let current = roots;
    for (const step of chain) {
      if (step.kind === "nth") {
        current = step.n < 0 ? current.slice(step.n) : current.slice(step.n, step.n + 1);
        continue;
      }
      if (step.kind === "has") {
        current = current.filter((el) => query([el], step.steps).length > 0);
        continue;
      }
      const out = [];
      const seen = new Set();
      for (const root of current) {
        let found = [];
        if (step.kind === "css") found = all(root, step.css);
        else if (step.kind === "testId") found = all(root, `[data-testid=${attrValue(step.id)}]`);
        else if (step.kind === "role") {
          found = all(root, "*").filter(
            (el) =>
              roleOf(el) === step.role &&
              !hiddenForAria(el) &&
              (step.name === undefined || matches(accessibleName(el), step.name, step.exact)),
          );
        } else if (step.kind === "text") {
          const pool = root.nodeType === 1 ? [root, ...all(root, "*")] : all(root, "*");
          const candidates = pool.filter(
            (el) =>
              !SKIP_TEXT.has(el.tagName.toLowerCase()) &&
              matches(el.textContent, step.text, step.exact),
          );
          found = candidates.filter(
            (el) => !candidates.some((other) => other !== el && el.contains(other)),
          );
        }
        for (const el of found) {
          if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
          }
        }
      }
      current = out;
    }
    return current;
  };

  // The click guard (android.yml run 40000764444). Between the box read below and the CDP
  // input events, the page may re-render and move the element (a list arriving above an
  // in-flow nav): the events then land on whatever is at the old point now. The guard sits
  // in the capture phase on `window`, ahead of every page listener: a touch, pointer, mouse
  // or click event whose target is outside the measured element is cancelled and stopped
  // before the page sees it, and recorded with the viewport point the page saw it at
  // (`clientX`/`clientY`: where the browser's input path put the event, which the driver
  // compares with the point it dispatched, run 40013402240); one inside passes.
  // `clickOutcome` reads the record and removes the guard, so the driver can measure again
  // and retry a blocked click.
  const GUARD_KEY = "__forerunnerCdpClickGuard";
  const GUARDED = [
    "touchstart",
    "touchend",
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  ];
  const disarmClickGuard = () => {
    const guard = win[GUARD_KEY];
    if (!guard) return null;
    for (const type of GUARDED) win.removeEventListener(type, guard.listener, true);
    win.clearTimeout(guard.timer);
    delete win[GUARD_KEY];
    return guard;
  };
  const armClickGuard = (el) => {
    disarmClickGuard();
    const guard = { events: [], missed: null, client: null, listener: null, timer: null };
    guard.listener = (event) => {
      const t = event.target;
      const inside =
        Boolean(t) && (t === el || (typeof el.contains === "function" && el.contains(t)));
      guard.events.push(event.type);
      if (inside) return;
      if (guard.missed === null) {
        guard.missed = describe(t && t.nodeType === 1 ? t : null);
        const p = event.touches?.[0] ?? event;
        guard.client =
          typeof p.clientX === "number" && typeof p.clientY === "number"
            ? { x: p.clientX, y: p.clientY }
            : null;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // `passive: false`: Chrome makes a window-level touchstart listener passive by default,
    // and a passive listener cannot cancel the tap that would click the wrong element.
    for (const type of GUARDED) {
      win.addEventListener(type, guard.listener, { capture: true, passive: false });
    }
    // A guard nobody reads (the driver gave up) does not outlive the click for long.
    guard.timer = win.setTimeout(disarmClickGuard, 15_000);
    win[GUARD_KEY] = guard;
  };
  if (action === "clickOutcome") {
    const guard = win[GUARD_KEY];
    if (!guard) return { armed: false, events: [], missed: null, client: null };
    // The release's click may still be queued behind the CDP answer: the caller polls until
    // `click` (or a miss) is in, and only then asks to disarm.
    const out = {
      armed: true,
      events: guard.events.slice(),
      missed: guard.missed,
      client: guard.client,
    };
    if (arg === "disarm") disarmClickGuard();
    return out;
  }

  const found = query([doc], steps);
  if (action === "count") return { count: found.length };
  if (action === "probe") return { count: found.length, visible: found.filter(visible).length };
  if (found.length > 1) return { error: "strict", count: found.length };
  const el = found[0];
  if (!el) return { error: "not_found" };
  if (action === "info") {
    return {
      found: true,
      visible: visible(el),
      innerText: typeof el.innerText === "string" ? el.innerText : norm(el.textContent),
      attr: arg === null || arg === undefined ? null : el.getAttribute(arg),
      tag: el.tagName,
    };
  }
  if (action === "evaluate") {
    // `arg` is the caller's function itself, spliced into the expression by buildExpression.
    if (typeof arg !== "function") return { error: "not_a_function" };
    return { value: arg(el) };
  }
  if (action === "clickPoint") {
    if (!visible(el)) return { error: "not_visible" };
    if (!enabled(el)) return { error: "disabled" };
    // The layout-settle wait (ADR 0087 amendment). Home keeps growing after its first card
    // (the banner and the other cards arrive, the screen polls and re-renders), and on the
    // emulator's old WebView the bottom nav sits in the flow under it. So before the box is
    // measured: the element's box, the page's scroll height and scroll position unchanged
    // over SETTLE_FRAMES animation frames and SETTLE_MS, and no DOM mutation under the
    // document for QUIET_MS (a MutationObserver; a page that mutates without end is let
    // through once its geometry has held for QUIET_CAP_MS). Then the element is scrolled
    // into view instantly and the same wait runs again when that moved it. The measurement,
    // the hit test and the guard's arming happen in this one call, right before the caller's
    // Input.dispatch*, so nothing re-renders between them on this side. The wait is bounded
    // by `budgetMs`: at the deadline the result says `settled: false` and the caller decides.
    const opts = arg && typeof arg === "object" ? arg : {};
    const budgetMs = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : 0;
    const SETTLE_FRAMES = 5;
    const SETTLE_MS = 300;
    const QUIET_MS = 300;
    const QUIET_CAP_MS = 1_500;
    const clock = () =>
      win.performance && typeof win.performance.now === "function"
        ? win.performance.now()
        : Date.now();
    const scroller = doc.scrollingElement || doc.documentElement;
    const geometry = () => {
      const r = el.getBoundingClientRect();
      return {
        box: [r.left, r.top, r.width, r.height],
        scrollY: Number(win.scrollY || win.pageYOffset || 0),
        scrollHeight: scroller ? Number(scroller.scrollHeight || 0) : 0,
      };
    };
    const sameGeometry = (a, b) =>
      a.scrollY === b.scrollY &&
      a.scrollHeight === b.scrollHeight &&
      a.box.every((v, i) => v === b.box[i]);
    const measure = (settled, waited) => {
      const g = geometry();
      const x = g.box[0] + g.box[2] / 2;
      const y = g.box[1] + g.box[3] / 2;
      const hit = doc.elementFromPoint(x, y);
      const hitOk = Boolean(hit) && (hit === el || el.contains(hit));
      if (settled && hitOk) armClickGuard(el);
      return {
        x,
        y,
        hitOk,
        hit: describe(hit),
        settled,
        box: g.box,
        scrollY: g.scrollY,
        scrollHeight: g.scrollHeight,
        waitedMs: waited.waitedMs,
        changes: waited.changes,
        mutations: waited.mutations,
      };
    };
    // `quick`: the fallback ladder re-arms the guard at a box it has just seen stable three
    // times; it measures and probes now, without the wait or the scroll.
    if (opts.quick === true) return measure(true, { waitedMs: 0, changes: 0, mutations: 0 });
    return new Promise((resolve) => {
      const t0 = clock();
      const deadline = t0 + budgetMs;
      let mutations = 0;
      let lastMutation = t0;
      let observer = null;
      try {
        observer = new win.MutationObserver((records) => {
          mutations += records.length;
          lastMutation = clock();
        });
        observer.observe(doc.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        observer = null;
      }
      let last = geometry();
      let stableSince = t0;
      let stableFrames = 0;
      let changes = 0;
      let scrolled = false;
      const finish = (settled) => {
        if (observer) observer.disconnect();
        resolve(measure(settled, { waitedMs: Math.round(clock() - t0), changes, mutations }));
      };
      const frame = (fn) =>
        typeof win.requestAnimationFrame === "function"
          ? win.requestAnimationFrame(fn)
          : win.setTimeout(fn, 16);
      const tick = () => {
        if (!el.isConnected) {
          // Re-rendered away: the caller queries again rather than measuring a stale node.
          if (observer) observer.disconnect();
          resolve({ error: "detached" });
          return;
        }
        const t = clock();
        const g = geometry();
        if (sameGeometry(g, last)) {
          stableFrames += 1;
        } else {
          last = g;
          stableFrames = 0;
          stableSince = t;
          changes += 1;
        }
        const stable = stableFrames >= SETTLE_FRAMES && t - stableSince >= SETTLE_MS;
        const quiet = t - lastMutation >= QUIET_MS || t - stableSince >= QUIET_CAP_MS;
        if (stable && quiet) {
          if (!scrolled) {
            scrolled = true;
            if (typeof el.scrollIntoView === "function") {
              try {
                el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
              } catch {
                el.scrollIntoView();
              }
            }
            // The next frame re-measures: a scroll that moved the box restarts the wait.
            frame(tick);
            return;
          }
          finish(true);
          return;
        }
        if (t >= deadline) {
          finish(false);
          return;
        }
        frame(tick);
      };
      frame(tick);
    });
  }
  if (action === "clickElement") {
    // The last resort of the fallback ladder: the click event raised on the element itself,
    // inside the page, under a guard of its own so the caller learns whether it fired.
    if (!enabled(el)) return { error: "disabled" };
    armClickGuard(el);
    try {
      if (typeof el.click === "function") el.click();
      else el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
    } catch (error) {
      const failed = disarmClickGuard();
      return {
        error: "click_threw",
        message: String(error?.message ?? error),
        events: failed ? failed.events : [],
      };
    }
    const guard = disarmClickGuard();
    return { events: guard ? guard.events.slice() : [], missed: guard ? guard.missed : null };
  }
  if (action === "focusForFill") {
    if (!visible(el)) return { error: "not_visible" };
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.getAttribute("type") || "text").toLowerCase() : "";
    const textLike =
      (tag === "input" &&
        !["checkbox", "radio", "file", "button", "submit", "reset", "image", "hidden"].includes(
          type,
        )) ||
      tag === "textarea" ||
      el.isContentEditable === true;
    if (!textLike) return { error: "not_editable", tag };
    if (!enabled(el) || el.readOnly === true) return { error: "disabled" };
    el.focus();
    if (typeof el.select === "function") {
      el.select();
    } else if (el.isContentEditable) {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const selection = win.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return { ok: true, tag, contentEditable: el.isContentEditable === true };
  }
  if (action === "value") {
    return { value: typeof el.value === "string" ? el.value : el.textContent };
  }
  if (action === "setValue") {
    const value = String(arg ?? "");
    if (el.isContentEditable && typeof el.value !== "string") {
      el.textContent = value;
    } else {
      const proto =
        el.tagName === "TEXTAREA"
          ? win.HTMLTextAreaElement.prototype
          : win.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc?.set) desc.set.call(el, value);
      else el.value = value;
    }
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    return { value: typeof el.value === "string" ? el.value : el.textContent };
  }
  return { error: "unknown_action" };
}

const PAGE_SCRIPT_SOURCE = String(pageScript);

/**
 * The `Runtime.evaluate` expression for one in-page call. Data goes in as JSON; for
 * `evaluate` the caller's function source is spliced in as a function expression, so the page
 * never builds code from a string (no eval, no new Function: the bundle's CSP forbids both).
 */
function buildExpression(steps, action, arg) {
  const argSource = action === "evaluate" ? `(${arg})` : JSON.stringify(arg ?? null);
  return `(${PAGE_SCRIPT_SOURCE})(${JSON.stringify(steps)}, ${JSON.stringify(action)}, ${argSource})`;
}

function describeSteps(steps) {
  return steps
    .map((step) => {
      switch (step.kind) {
        case "testId":
          return `getByTestId(${JSON.stringify(step.id)})`;
        case "role": {
          const opts = [];
          if (step.name !== undefined) opts.push(`name: ${JSON.stringify(step.name)}`);
          if (step.exact) opts.push("exact: true");
          return `getByRole(${JSON.stringify(step.role)}${opts.length ? `, { ${opts.join(", ")} }` : ""})`;
        }
        case "text":
          return `getByText(${JSON.stringify(step.text)}${step.exact ? ", { exact: true }" : ""})`;
        case "css":
          return `locator(${JSON.stringify(step.css)})`;
        case "has":
          return `filter({ has: ${describeSteps(step.steps)} })`;
        case "nth":
          return step.n === 0 ? "first()" : step.n === -1 ? "last()" : `nth(${step.n})`;
        default:
          return step.kind;
      }
    })
    .join(".");
}

// ---------------------------------------------------------------------------------------------
// Page and Locator
// ---------------------------------------------------------------------------------------------

/**
 * The offset between where the driver dispatched its clicks and where the page saw them, when
 * every guarded miss reports the same one (within half a pixel) and it is not zero; null
 * otherwise. A constant offset means the input path transforms the coordinates differently
 * from the page's own `getBoundingClientRect`, and the click can be sent shifted back.
 * @param {Array<{ x: number, y: number, client: { x: number, y: number } | null }>} misses
 * @returns {{ dx: number, dy: number } | null}
 */
function offsetSeenBy(misses) {
  if (misses.length < 2) return null;
  let delta = null;
  for (const m of misses) {
    if (!m.client || typeof m.client.x !== "number" || typeof m.client.y !== "number") {
      return null;
    }
    const d = { dx: Math.round(m.client.x - m.x), dy: Math.round(m.client.y - m.y) };
    if (delta && (Math.abs(d.dx - delta.dx) > 0.5 || Math.abs(d.dy - delta.dy) > 0.5)) {
      return null;
    }
    delta = delta ?? d;
  }
  return delta && (delta.dx !== 0 || delta.dy !== 0) ? delta : null;
}

/** Two settled measurements of one element with the same box, scroll position and page height. */
function sameMeasurement(a, b) {
  return (
    a.scrollY === b.scrollY &&
    a.scrollHeight === b.scrollHeight &&
    Array.isArray(a.box) &&
    Array.isArray(b.box) &&
    a.box.length === b.box.length &&
    a.box.every((v, i) => v === b.box[i])
  );
}

/** A click outcome that counts as landed: the guard saw events, none outside, or the document went. */
function landed(outcome) {
  return outcome.navigated || (outcome.missed === null && outcome.events.length > 0);
}

function roundPoint(x, y) {
  return `(${Math.round(x)}, ${Math.round(y)})`;
}

export class Page {
  /**
   * @param {CdpClient} client
   * @param {{
   *   timeoutMs?: number,
   *   pollMs?: number,
   *   now?: () => number,
   *   log?: (line: string) => void,
   * }} [options]
   */
  constructor(client, options = {}) {
    this.client = client;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? (() => Date.now());
    // The driver's own lines on the runner's stdout (a `click fallback:` line names the path
    // a click had to take); nothing is written when every action takes its first path.
    this.log = typeof options.log === "function" ? options.log : (line) => console.log(line);
  }

  /**
   * Evaluates a JavaScript expression in the page and returns its value (JSON-serialisable).
   * @param {string} expression
   * @param {{ timeoutMs?: number }} [options] the CDP request's timeout (an expression that
   *   waits inside the page, like the layout-settle wait, needs more than the default)
   */
  async evaluate(expression, options = {}) {
    const res = await this.client.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
    if (res.exceptionDetails) {
      const details = res.exceptionDetails;
      const text =
        details.exception?.description ?? details.exception?.value ?? details.text ?? "exception";
      throw new CdpError("cdp.evaluate_failed", `page script failed: ${text}`);
    }
    return res.result?.value;
  }

  async title() {
    return this.evaluate("document.title");
  }

  async url() {
    return this.evaluate("location.href");
  }

  /** @internal */
  async run(steps, action, arg, options = {}) {
    const value = await this.evaluate(buildExpression(steps, action, arg), options);
    if (!value || typeof value !== "object") {
      throw new CdpError("cdp.evaluate_failed", `page script returned ${JSON.stringify(value)}`);
    }
    return value;
  }

  /**
   * Polls `step` every `pollMs` until it returns a value other than `undefined` or `timeout`
   * elapses, then throws `onTimeout()`.
   * @internal
   */
  async poll(step, timeout, onTimeout) {
    const limit = timeout ?? this.timeoutMs;
    const t0 = this.now();
    for (;;) {
      const value = await step();
      if (value !== undefined) return value;
      if (this.now() - t0 >= limit) throw onTimeout();
      await sleep(this.pollMs);
    }
  }

  /** One left click at viewport CSS coordinates. */
  async mouseClick(x, y) {
    const base = { x, y, button: "left", clickCount: 1, modifiers: 0 };
    await this.client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      modifiers: 0,
    });
    await this.client.send("Input.dispatchMouseEvent", { ...base, type: "mousePressed" });
    await this.client.send("Input.dispatchMouseEvent", { ...base, type: "mouseReleased" });
  }

  /** One tap at viewport CSS coordinates, the way a phone clicks: touch start, touch end. */
  async touchTap(x, y) {
    await this.client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
      modifiers: 0,
    });
    await this.client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
      modifiers: 0,
    });
  }

  async insertText(text) {
    await this.client.send("Input.insertText", { text });
  }

  locator(css) {
    return new Locator(this, [{ kind: "css", css }]);
  }

  getByTestId(id) {
    return new Locator(this, [{ kind: "testId", id }]);
  }

  getByRole(role, options = {}) {
    return new Locator(this, [
      { kind: "role", role, name: options.name, exact: options.exact === true },
    ]);
  }

  getByText(text, options = {}) {
    return new Locator(this, [{ kind: "text", text, exact: options.exact === true }]);
  }
}

export class Locator {
  /**
   * @param {Page} page
   * @param {Array<Record<string, unknown>>} steps
   */
  constructor(page, steps) {
    this.page = page;
    this.steps = steps;
  }

  toString() {
    return describeSteps(this.steps);
  }

  #chain(step) {
    return new Locator(this.page, [...this.steps, step]);
  }

  locator(css) {
    return this.#chain({ kind: "css", css });
  }

  getByTestId(id) {
    return this.#chain({ kind: "testId", id });
  }

  getByRole(role, options = {}) {
    return this.#chain({ kind: "role", role, name: options.name, exact: options.exact === true });
  }

  getByText(text, options = {}) {
    return this.#chain({ kind: "text", text, exact: options.exact === true });
  }

  /** Keeps the elements that contain a match of `has` (relative to each element). */
  filter(options) {
    if (!options || !(options.has instanceof Locator)) {
      throw new CdpError("cdp.bad_filter", "filter() needs { has: Locator }");
    }
    return this.#chain({ kind: "has", steps: options.has.steps });
  }

  first() {
    return this.nth(0);
  }

  last() {
    return this.nth(-1);
  }

  nth(n) {
    return this.#chain({ kind: "nth", n });
  }

  async count() {
    return (await this.page.run(this.steps, "count")).count;
  }

  async isVisible() {
    return (await this.page.run(this.steps, "probe")).visible > 0;
  }

  /**
   * Waits until the locator matches one visible element (`state: "attached"` waits for the
   * match only). Several matches are a strict-mode violation.
   * @param {{ timeout?: number, state?: "visible" | "attached" }} [options]
   */
  async waitFor(options = {}) {
    const state = options.state ?? "visible";
    let last = { count: 0, visible: 0 };
    await this.page.poll(
      async () => {
        last = await this.page.run(this.steps, "probe");
        if (last.count > 1) this.#strict(last.count);
        if (state === "attached" ? last.count === 1 : last.visible === 1) return true;
        return undefined;
      },
      options.timeout,
      () =>
        new CdpError(
          "cdp.timeout",
          `${this} did not become ${state} in ${options.timeout ?? this.page.timeoutMs} ms (matches: ${last.count}, visible: ${last.visible})`,
        ),
    );
  }

  #strict(count) {
    throw new CdpError(
      "cdp.strict_mode",
      `${this} resolved to ${count} elements; narrow it with first(), nth() or filter()`,
    );
  }

  #single(result) {
    if (result.error === "strict") this.#strict(result.count);
    if (result.error === "not_found") return undefined;
    return result;
  }

  async #resolve(action, arg, timeout, wantVisible) {
    let lastError = "not_found";
    let lastHit = null;
    const result = await this.page.poll(
      async () => {
        const r = this.#single(await this.page.run(this.steps, action, arg));
        if (r === undefined) {
          lastError = "not_found";
          return undefined;
        }
        if (r.error) {
          lastError = r.error;
          lastHit = r.hit ?? null;
          if (r.error === "not_editable") {
            throw new CdpError("cdp.not_editable", `${this} is not an editable field (${r.tag})`);
          }
          if (r.error === "not_a_function") {
            throw new CdpError("cdp.bad_function", `${this}: evaluate() needs a function source`);
          }
          return undefined;
        }
        if (wantVisible && r.visible === false) {
          lastError = "not_visible";
          return undefined;
        }
        return r;
      },
      timeout,
      () =>
        new CdpError(
          "cdp.timeout",
          `${this} ${
            lastError === "not_found"
              ? "was not found"
              : lastError === "not_visible"
                ? "was not visible"
                : lastError === "disabled"
                  ? "stayed disabled"
                  : `failed: ${lastError}`
          } within ${timeout ?? this.page.timeoutMs} ms`,
          { hit: lastHit },
        ),
    );
    return result;
  }

  /**
   * Clicks the element's centre through CDP mouse events, deterministically (ADR 0087 and
   * its amendment of 2026-10-25):
   *
   *   1. one in-page call waits for the layout to settle (box, scroll height and position
   *      unchanged over five frames and 300 ms, no DOM mutation for 300 ms), scrolls the
   *      element into view instantly and waits again when that moved it, then measures the
   *      box, hit-tests the centre and arms the click guard, all right before the mouse
   *      events (`settled: false` at the budget's end means the click is not sent);
   *   2. the guard (see `pageScript`) stops every touch, pointer, mouse and click event that
   *      lands outside the element before the page sees it, and records where the page saw
   *      it; a miss is measured and sent again (a box that moved in between: the race of run
   *      40000764444);
   *   3. after `CLEAN_MISSES_BEFORE_FALLBACK` further misses at one unchanged settled box the
   *      input path's coordinates and the page's disagree (run 40013402240), and the fallback
   *      ladder runs, each step announced with a `click fallback: <locator> (<code>: <why>)`
   *      line on `page.log`: a mouse click shifted by the offset the page reported (when all
   *      misses reported the same one), a tap through `Input.dispatchTouchEvent`, then
   *      `element.click()` inside the page.
   *
   * Failures: `cdp.click_missed` when the events kept landing elsewhere until `timeout`, or
   * when the whole ladder failed (the details name what was at the point);
   * `cdp.click_intercepted` when the in-page hit test keeps finding another element at the
   * centre (an overlay: no fallback, the page itself says the element is covered);
   * `cdp.click_unsettled` when the layout never held still; `cdp.click_lost` when no event
   * of a click reached the page (never retried: a late event could otherwise click twice).
   * A click that replaced the document (a navigation) counts as landed: the guard went with
   * the old document.
   * @param {{ timeout?: number }} [options]
   */
  async click(options = {}) {
    const timeout = options.timeout ?? this.page.timeoutMs;
    const t0 = this.page.now();
    const remaining = () => Math.max(0, timeout - (this.page.now() - t0));
    let lastError = "not_found";
    let intercepted = null;
    let point = null;
    let last = null;
    const misses = [];
    let cleanMisses = 0;
    for (;;) {
      const budgetMs = Math.min(remaining(), SETTLE_BUDGET_MS);
      const r = this.#single(
        await this.page.run(
          this.steps,
          "clickPoint",
          { budgetMs },
          { timeoutMs: budgetMs + this.page.timeoutMs },
        ),
      );
      if (r === undefined || r.error === "detached") {
        lastError = "not_found";
      } else if (r.error) {
        lastError = r.error;
      } else if (!r.settled) {
        lastError = "unsettled";
        point = r;
        intercepted = r.hitOk ? null : r.hit;
      } else if (!r.hitOk) {
        lastError = "intercepted";
        point = r;
        intercepted = r.hit;
      } else {
        intercepted = null;
        const unchanged = last !== null && sameMeasurement(last, r);
        last = r;
        point = r;
        await this.page.mouseClick(r.x, r.y);
        const outcome = await this.#clickOutcome();
        if (landed(outcome)) return;
        if (outcome.missed === null) {
          throw new CdpError(
            "cdp.click_lost",
            `${this}: no pointer, mouse or click event of the click at ${roundPoint(r.x, r.y)} reached the page`,
            { events: outcome.events },
          );
        }
        misses.push({
          x: r.x,
          y: r.y,
          hit: outcome.missed,
          events: outcome.events,
          client: outcome.client,
        });
        lastError = "missed";
        cleanMisses = unchanged ? cleanMisses + 1 : 0;
        if (cleanMisses >= CLEAN_MISSES_BEFORE_FALLBACK) {
          await this.#clickFallbacks(r, misses);
          return;
        }
      }
      if (remaining() <= 0) {
        if (misses.length > 0) {
          await this.page.run([], "clickOutcome", "disarm").catch(() => undefined);
          const m = misses[misses.length - 1];
          throw new CdpError(
            "cdp.click_missed",
            `${this}: moved before the click landed; ${m.hit} was at ${roundPoint(m.x, m.y)} instead (the click was stopped before the page saw it)`,
            { hit: m.hit, events: m.events, attempts: misses.length },
          );
        }
        if (intercepted !== null) {
          throw new CdpError(
            "cdp.click_intercepted",
            `${this}: ${intercepted} intercepts pointer events at ${roundPoint(point.x, point.y)}`,
          );
        }
        if (lastError === "unsettled") {
          throw new CdpError(
            "cdp.click_unsettled",
            `${this}: the layout did not settle within ${timeout} ms (${point.changes} changes of the box, scroll position or page height and ${point.mutations} DOM mutations in the last ${point.waitedMs} ms)`,
            { box: point.box, changes: point.changes, mutations: point.mutations },
          );
        }
        throw new CdpError(
          "cdp.timeout",
          `${this} ${
            lastError === "not_found"
              ? "was not found"
              : lastError === "not_visible"
                ? "was not visible"
                : lastError === "disabled"
                  ? "stayed disabled"
                  : `failed: ${lastError}`
          } within ${timeout} ms`,
        );
      }
      await sleep(this.page.pollMs);
    }
  }

  /**
   * The fallback ladder after `misses` guarded mouse clicks at `point`, the box unchanged
   * and the in-page hit test on the element every time: the input path puts the point
   * elsewhere than the page does. Each step prints `click fallback: <locator> (<code>: <why>)`
   * on `page.log` before it runs, so the runner's log names the path a click took; a step
   * that lands returns. The last step failing is `cdp.click_missed` with everything tried.
   * @param {{ x: number, y: number, box: number[] }} point
   * @param {Array<{ x: number, y: number, hit: string, events: string[], client: { x: number, y: number } | null }>} misses
   */
  async #clickFallbacks(point, misses) {
    const at = roundPoint(point.x, point.y);
    const n = misses.length;
    const hit = misses[n - 1].hit;
    const where = `${n} mouse clicks at ${at} landed on ${hit} with the box stable`;
    const announce = (why) => this.page.log(`click fallback: ${this} (cdp.click_missed: ${why})`);
    // 1. The page saw every miss at the same offset from the dispatched point: send the
    //    click shifted back, still through the input path the smoke is there to exercise.
    const delta = offsetSeenBy(misses);
    if (delta) {
      const x = point.x - delta.dx;
      const y = point.y - delta.dy;
      announce(
        `mouse click shifted by (${-delta.dx}, ${-delta.dy}) to ${roundPoint(x, y)}; the page saw ${n} clicks at ${roundPoint(point.x + delta.dx, point.y + delta.dy)} instead of ${at}, on ${hit}`,
      );
      if (await this.#armed()) {
        await this.page.mouseClick(x, y);
        const outcome = await this.#clickOutcome();
        if (landed(outcome)) return;
      }
    }
    // 2. A tap, the way a phone clicks.
    let tap = "raised no event in the page";
    announce(`tap through Input.dispatchTouchEvent at ${at}; ${where}`);
    if (await this.#armed()) {
      try {
        await this.page.touchTap(point.x, point.y);
        const outcome = await this.#clickOutcome();
        if (landed(outcome)) return;
        if (outcome.missed !== null) tap = `landed on ${outcome.missed}`;
      } catch (error) {
        if (!(error instanceof CdpError) || error.code !== "cdp.protocol_error") throw error;
        tap = `was refused (${error.message})`;
      }
    } else {
      tap = "was not sent (the element moved)";
    }
    // 3. The click event raised on the element inside the page: no input path at all.
    announce(`element.click() in the page; ${where}; the tap ${tap}`);
    const result = this.#single(await this.page.run(this.steps, "clickElement", null));
    if (result && !result.error && result.missed === null && result.events.includes("click")) {
      return;
    }
    const element =
      result === undefined
        ? "found no element"
        : result.error === "click_threw"
          ? `threw: ${result.message}`
          : result.error
            ? `failed: ${result.error}`
            : "raised no click event";
    throw new CdpError(
      "cdp.click_missed",
      `${this}: the click never reached it; ${where}; the tap ${tap}; element.click() in the page ${element}`,
      {
        hit,
        events: misses[n - 1].events,
        box: point.box,
        attempts: n,
        tap,
        element,
      },
    );
  }

  /**
   * Re-arms the guard for a fallback step: measures and hit-tests now (no wait, the box has
   * just been seen stable) and arms when the centre still hits the element.
   */
  async #armed() {
    const r = this.#single(
      await this.page.run(this.steps, "clickPoint", { budgetMs: 0, quick: true }),
    );
    return Boolean(r && !r.error && r.hitOk);
  }

  /**
   * What the click guard saw: waits up to `CLICK_SETTLE_MS` for the attempt's click event (a
   * miss on the press does not end the wait: the release's events may still be on their way
   * and must meet the guard), then disarms the guard, or keeps it up after a miss whose click
   * never came, until the retry arms its own. `navigated` when the guard is gone: only a new
   * document (the click navigated) drops it. `client` is where the page saw the first
   * misplaced event (its `clientX`/`clientY`), null when nothing missed.
   */
  async #clickOutcome() {
    const t0 = this.page.now();
    for (;;) {
      const seen = await this.page.run([], "clickOutcome", null);
      // The guard is gone only when the measured document was replaced: the click navigated.
      if (!seen.armed) return { events: seen.events, missed: null, client: null, navigated: true };
      // A miss does not settle the attempt: the release's `mouseup` and `click` may still be
      // queued behind the CDP answer, and they must meet the guard too (review finding 1).
      const settled = seen.events.includes("click");
      const late = this.page.now() - t0 >= CLICK_SETTLE_MS;
      if (settled || late) {
        // A miss whose click never came keeps the guard up: the retry's measurement replaces
        // it, so a straggler from this attempt is still stopped until then.
        const keep = seen.missed !== null && !settled;
        const out = await this.page.run([], "clickOutcome", keep ? null : "disarm");
        if (!out.armed) return { events: seen.events, missed: null, client: null, navigated: true };
        return {
          events: out.events,
          missed: out.missed,
          client: out.client ?? null,
          navigated: false,
        };
      }
      await sleep(Math.min(this.page.pollMs, 50));
    }
  }

  /**
   * Focuses the field, selects its content and types `value` through `Input.insertText`
   * (what Playwright's `fill` does); when the page's value does not follow (an IME path the
   * WebView refuses, a re-render), sets it through the native value setter and dispatches
   * `input` and `change`, so React-controlled fields update either way.
   * @param {string} value
   * @param {{ timeout?: number }} [options]
   */
  async fill(value, options = {}) {
    const text = String(value);
    await this.#resolve("focusForFill", null, options.timeout, false);
    await this.page.insertText(text);
    const after = await this.page.run(this.steps, "value");
    if (after.value === text) return;
    const forced = await this.page.run(this.steps, "setValue", text);
    if (forced.value !== text) {
      throw new CdpError(
        "cdp.fill_failed",
        `${this}: value is ${JSON.stringify(forced.value)} after fill(${JSON.stringify(text)})`,
      );
    }
  }

  /** @param {{ timeout?: number }} [options] */
  async innerText(options = {}) {
    const info = await this.#resolve("info", null, options.timeout, false);
    return info.innerText;
  }

  /**
   * The attribute's value, or null when the element has none. Waits for the element to be
   * attached.
   * @param {string} name
   * @param {{ timeout?: number }} [options]
   */
  async getAttribute(name, options = {}) {
    const info = await this.#resolve("info", name, options.timeout, false);
    return info.attr;
  }

  /**
   * Runs `(el) => ...` (given as source text) on the single matched element and returns its
   * JSON value. The source is spliced into the `Runtime.evaluate` expression as a function
   * expression; the page never evaluates a string (CSP, ADR 0054).
   * @param {string} fnSource
   * @param {{ timeout?: number }} [options]
   */
  async evaluate(fnSource, options = {}) {
    const res = await this.#resolve("evaluate", String(fnSource), options.timeout, false);
    return res.value;
  }
}

/** At most this many lines of screen text in `describePage`. */
export const PAGE_TEXT_LINES = 20;

/**
 * What the page shows, for the runner's `page:` lines after a failure: the URL (so the route
 * is visible: a nav click that did not navigate leaves `/`), the title, and the first
 * `PAGE_TEXT_LINES` non-empty lines of the visible text of `<main>` (else `<body>`), each
 * capped at 160 characters. Read through one `Runtime.evaluate` expression; nothing in the
 * page evaluates a string.
 * @param {Page} page
 * @returns {Promise<string>}
 */
export async function describePage(page) {
  const info = await page.evaluate(`(() => {
    const root = document.querySelector("main") || document.body;
    const text = root ? (typeof root.innerText === "string" ? root.innerText : root.textContent) : "";
    return { url: location.href, title: document.title, text: String(text || "") };
  })()`);
  const lines = String(info?.text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const shown = lines
    .slice(0, PAGE_TEXT_LINES)
    .map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l));
  const more =
    lines.length > PAGE_TEXT_LINES ? [`(${lines.length - PAGE_TEXT_LINES} more lines)`] : [];
  return [
    `url ${info?.url ?? "?"} (${info?.title ?? ""})`,
    ...(shown.length ? shown.map((l) => `  ${l}`) : ["  (no text)"]),
    ...more,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// One call for the smoke
// ---------------------------------------------------------------------------------------------

/**
 * Waits for a page target on the DevTools endpoint, connects to it and returns a `Page`.
 * @param {string} httpBase e.g. `http://127.0.0.1:<forwarded port>`
 * @param {{
 *   prefer?: (target: Record<string, unknown>) => boolean,
 *   waitForTargetMs?: number,
 *   pollMs?: number,
 *   timeoutMs?: number,
 *   fetchImpl?: typeof fetch,
 *   WebSocketImpl?: typeof WebSocket,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} [options]
 * @returns {Promise<{ client: CdpClient, page: Page, target: Record<string, unknown> }>}
 */
export async function connectPage(httpBase, options = {}) {
  const waitForTargetMs = options.waitForTargetMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  const now = options.now ?? (() => Date.now());
  const t0 = now();
  let target;
  let lastError = null;
  for (;;) {
    try {
      const targets = await listTargets(httpBase, {
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs,
      });
      target = pickPageTarget(targets, { prefer: options.prefer });
      break;
    } catch (error) {
      lastError = error;
      if (now() - t0 >= waitForTargetMs) {
        throw new CdpError(
          "cdp.no_page_target",
          `no page target at ${httpBase} within ${waitForTargetMs} ms: ${describeError(error)}`,
          { cause: lastError },
        );
      }
      await sleep(pollMs);
    }
  }
  const client = await CdpClient.connect(socketUrlFor(httpBase, target), {
    WebSocketImpl: options.WebSocketImpl,
    timeoutMs: options.timeoutMs,
  });
  const page = new Page(client, { timeoutMs: options.timeoutMs, now, log: options.log });
  return { client, page, target };
}
