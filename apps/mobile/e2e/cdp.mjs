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
 *   - `forwardPageConsole` is such a listener: after `Runtime.enable` it writes every
 *     `Runtime.consoleAPICalled` and `Runtime.exceptionThrown` of the page to the runner's
 *     stdout as `webview: [level] ...` lines (`formatConsoleEvent`, `formatException`);
 *   - `Page` and `Locator` cover the handful of Playwright calls the smoke uses, with the same
 *     meaning: `getByTestId`, `getByRole(role, { name, exact })` (headings h1-h6, buttons,
 *     links, explicit roles; name from aria-labelledby, aria-label, labels or text; hidden
 *     elements excluded), `getByText` (innermost element whose normalised text contains the
 *     words, case-insensitive unless `exact`), `locator(css)`, `filter({ has })`, `first`,
 *     `nth`, `count`, `waitFor` (visible), `click` (scroll into view, hit test, CDP mouse
 *     events at the centre), `fill` (focus, select all, `Input.insertText`, native setter
 *     fallback with input and change events), `innerText`, `getAttribute`, `isVisible`,
 *     `evaluate`. Actions are strict: a locator that resolves to several elements is refused.
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
    if (typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", inline: "center" });
    }
    const before = el.getBoundingClientRect();
    // One animation frame (or 100 ms when frames are not running) between two reads of the
    // box: a smooth scroll or a transition still moving the element is reported as unstable
    // and the caller polls again instead of clicking where the element used to be.
    return new Promise((resolve) => {
      let done = false;
      const settle = () => {
        if (done) return;
        done = true;
        const rect = el.getBoundingClientRect();
        if (
          rect.left !== before.left ||
          rect.top !== before.top ||
          rect.width !== before.width ||
          rect.height !== before.height
        ) {
          resolve({ error: "unstable" });
          return;
        }
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = doc.elementFromPoint(x, y);
        const hitOk = Boolean(hit) && (hit === el || el.contains(hit));
        resolve({ x, y, hitOk, hit: describe(hit) });
      };
      if (typeof win.requestAnimationFrame === "function") win.requestAnimationFrame(settle);
      win.setTimeout(settle, 100);
    });
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

export class Page {
  /**
   * @param {CdpClient} client
   * @param {{ timeoutMs?: number, pollMs?: number, now?: () => number }} [options]
   */
  constructor(client, options = {}) {
    this.client = client;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Evaluates a JavaScript expression in the page and returns its value (JSON-serialisable).
   * @param {string} expression
   */
  async evaluate(expression) {
    const res = await this.client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
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
  async run(steps, action, arg) {
    const value = await this.evaluate(buildExpression(steps, action, arg));
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
   * Scrolls the element into view and clicks its centre through CDP mouse events once the
   * hit test lands on it (or inside it).
   * @param {{ timeout?: number }} [options]
   */
  async click(options = {}) {
    const timeout = options.timeout ?? this.page.timeoutMs;
    const t0 = this.page.now();
    let lastHit = "nothing";
    for (;;) {
      const remaining = Math.max(0, timeout - (this.page.now() - t0));
      const point = await this.#resolve("clickPoint", null, remaining, false);
      if (point.hitOk) {
        await this.page.mouseClick(point.x, point.y);
        return;
      }
      lastHit = point.hit;
      if (this.page.now() - t0 >= timeout) {
        throw new CdpError(
          "cdp.click_intercepted",
          `${this}: ${lastHit} intercepts pointer events at (${Math.round(point.x)}, ${Math.round(point.y)})`,
        );
      }
      await sleep(this.page.pollMs);
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

// ---------------------------------------------------------------------------------------------
// The page's console on the runner's stdout
// ---------------------------------------------------------------------------------------------

/** One forwarded line at most this long (a minified stack or a dumped object stays readable). */
export const MAX_FORWARDED_LINE = 2_000;

/**
 * The text of one `Runtime.RemoteObject` the way DevTools prints it in a console line:
 * strings as they are, other primitives by value, `-0`, `NaN`, bigints by their
 * unserialisable value, objects and errors by their description.
 * @param {Record<string, any> | undefined} arg
 */
export function remoteObjectText(arg) {
  if (!arg || typeof arg !== "object") return String(arg);
  if (arg.type === "string") return String(arg.value ?? "");
  if (arg.type === "undefined") return "undefined";
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
  if ("value" in arg && arg.subtype !== "error") {
    return typeof arg.value === "object" && arg.value !== null
      ? JSON.stringify(arg.value)
      : String(arg.value);
  }
  if (typeof arg.description === "string" && arg.description) return arg.description;
  if (arg.subtype === "null") return "null";
  return arg.className ? String(arg.className) : String(arg.type ?? "?");
}

function frameText(frame) {
  if (!frame || typeof frame !== "object") return "";
  const url = typeof frame.url === "string" && frame.url ? frame.url : "<anonymous>";
  // CDP line and column numbers are 0-based; DevTools shows them 1-based.
  const line = Number.isFinite(frame.lineNumber) ? frame.lineNumber + 1 : "?";
  const column = Number.isFinite(frame.columnNumber) ? frame.columnNumber + 1 : "?";
  return `${url}:${line}:${column}`;
}

/** Every line of `text` gets the prefix, so a grep for it finds multi-line stacks whole. */
function prefixed(prefix, text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) =>
      line.length > MAX_FORWARDED_LINE ? `${line.slice(0, MAX_FORWARDED_LINE)}…` : line,
    )
    .map((line, i) => (i === 0 ? `${prefix} ${line}` : `${prefix}   ${line}`))
    .join("\n");
}

/**
 * `Runtime.consoleAPICalled` as one console line: `webview: [warn] text (url:line:col)`;
 * the call site is added for warnings, errors and assertions.
 * @param {Record<string, any>} params
 * @param {string} [prefix]
 */
export function formatConsoleEvent(params, prefix = "webview:") {
  const level = typeof params?.type === "string" ? params.type : "log";
  const args = Array.isArray(params?.args) ? params.args : [];
  let text = args.map(remoteObjectText).join(" ");
  if (level === "warning" || level === "error" || level === "assert" || level === "trace") {
    const frame = params?.stackTrace?.callFrames?.[0];
    if (frame) text += ` (${frameText(frame)})`;
  }
  return prefixed(prefix, `[${level === "warning" ? "warn" : level}] ${text}`);
}

/**
 * `Runtime.exceptionThrown` (an uncaught error or an unhandled rejection) as
 * `webview: [exception] Uncaught TypeError: ... (url:line:col)` with the stack below it.
 * @param {Record<string, any>} params
 * @param {string} [prefix]
 */
export function formatException(params, prefix = "webview:") {
  const details = params?.exceptionDetails ?? {};
  const head = typeof details.text === "string" && details.text ? details.text : "Uncaught";
  const description = details.exception ? remoteObjectText(details.exception) : "";
  const where =
    typeof details.url === "string" && details.url
      ? ` (${frameText(details)})`
      : details.stackTrace?.callFrames?.[0]
        ? ` (${frameText(details.stackTrace.callFrames[0])})`
        : "";
  // Chrome's description of an Error is "TypeError: msg\n    at ..."; the head says "Uncaught".
  const [first, ...stack] = description ? description.split(/\r?\n/) : [""];
  const body = first && first !== head ? `${head} ${first}` : head;
  return prefixed(prefix, [`[exception] ${body}${where}`, ...stack].join("\n"));
}

/**
 * Forwards the page's console messages and uncaught exceptions to `write` (the runner's
 * stdout) over the CDP session the smoke already holds: listens for
 * `Runtime.consoleAPICalled` and `Runtime.exceptionThrown`, then sends `Runtime.enable`.
 * Diagnostics never fail the smoke: when the page refuses `Runtime.enable` the reason is
 * written as a `webview:` line and the smoke goes on. Returns a function that stops it.
 * @param {CdpClient} client
 * @param {{ write?: (line: string) => void, prefix?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ stop: () => void, enabled: boolean }>}
 */
export async function forwardPageConsole(client, options = {}) {
  const write = options.write ?? ((line) => console.log(line));
  const prefix = options.prefix ?? "webview:";
  const stop = client.onEvent(({ method, params }) => {
    if (method === "Runtime.consoleAPICalled") write(formatConsoleEvent(params, prefix));
    else if (method === "Runtime.exceptionThrown") write(formatException(params, prefix));
  });
  try {
    await client.send("Runtime.enable", {}, { timeoutMs: options.timeoutMs });
    return { stop, enabled: true };
  } catch (error) {
    write(`${prefix} [runner] console forwarding unavailable: ${describeError(error)}`);
    return { stop, enabled: false };
  }
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
  const page = new Page(client, { timeoutMs: options.timeoutMs, now });
  return { client, page, target };
}
