/**
 * The WebView's console on the emulator runner's stdout (ADR 0086). `run.mjs` calls
 * `forwardPageConsole(client)` right after the attach, on the page session `connectPage`
 * returned: it sends `Runtime.enable` and prints every `Runtime.consoleAPICalled` and
 * `Runtime.exceptionThrown` of the page as `webview: [level] ...` lines, so a failing smoke
 * step shows what the app said. Chrome's V8 also replays, on `Runtime.enable`, the console
 * messages and exceptions it kept from before the attach, so the app's early output appears
 * too.
 *
 * Its own module (not `cdp.mjs`) so the driver and its typed declarations stay as they are;
 * types: `webview-console.d.mts`. It needs only a client with `onEvent` and `send` (the
 * driver's `CdpClient`). No dependency outside Node.
 */

/** One forwarded line at most this long (a minified stack or a dumped object stays readable). */
export const MAX_FORWARDED_LINE = 2_000;

function describeError(error) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String(error.message);
  return String(error);
}

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

/** `where` goes on the first line of `text`, so a grep for the head line shows the location. */
function withLocation(text, where) {
  if (!where) return text;
  const [first, ...rest] = String(text).split(/\r?\n/);
  return [`${first} (${where})`, ...rest].join("\n");
}

/**
 * `Runtime.consoleAPICalled` as one console line: `webview: [warn] text (url:line:col)`;
 * the call site is added, on the first line, for warnings, errors, assertions and traces.
 * @param {Record<string, any>} params
 * @param {string} [prefix]
 */
export function formatConsoleEvent(params, prefix = "webview:") {
  const level = typeof params?.type === "string" ? params.type : "log";
  const args = Array.isArray(params?.args) ? params.args : [];
  let text = `[${level === "warning" ? "warn" : level}] ${args.map(remoteObjectText).join(" ")}`;
  if (level === "warning" || level === "error" || level === "assert" || level === "trace") {
    const frame = params?.stackTrace?.callFrames?.[0];
    if (frame) text = withLocation(text, frameText(frame));
  }
  return prefixed(prefix, text);
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
 * @param {{ onEvent: (listener: (event: { method: string, params: any }) => void) => () => void, send: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<unknown> }} client
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
