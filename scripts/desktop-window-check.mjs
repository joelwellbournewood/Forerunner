#!/usr/bin/env node
// The desktop window check (phase F2; docs/maintainers/testing.md, "The desktop window check").
// Every walk before it drove the UI in Chromium, but the desktop shell opens links, files and
// windows its own way: the owner's "Clicking PR does nothing" was a shell-only bug
// (apps/desktop/src-tauri/src/windows.rs, on_navigation / on_new_window). This drives the
// INSTALLED app's own window, as a person uses it, and asserts what the SHELL did.
//
// What it does (`--exe`, Windows CI after the MSI is installed):
//   1. copies the stand-in model (testenv/src/bench and testenv/src/provider) into the installed
//      runtime: `fr daemon --provider bench` loads it from <runtime>/testenv and refuses to start
//      without it, so an install never runs the stand-in unless a test put it there;
//   2. starts the installed exe the way a person does (no arguments) on a fresh data folder, with
//      the window's DevTools asked for two ways, on two ports (`windowEnv`): the shell's own
//      switch FORERUNNER_WEBVIEW_DEVTOOLS_PORT=<port> (apps/desktop/src-tauri/src/devtools.rs)
//      and WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<port + 1> (also wry's
//      default, its disabled features and autoplay policy, with occlusion tracking off,
//      `WEBVIEW2_DISABLED_FEATURES` and `WRY_AUTOPLAY_POLICY`, and --enable-logging), and
//      FORERUNNER_DAEMON_PROVIDER=bench (the shell starts its daemon on the stand-in model,
//      apps/desktop/src-tauri/src/supervisor.rs `daemon_flags`);
//   3. waits for the daemon (daemon.json, /health) and for the window's page on either DevTools
//      port (the one that answers says which way worked; if neither does, the Windows
//      diagnostics say what WebView2 did with the switch: `diagnoseWebview`), and drives that
//      page over raw CDP (apps/mobile/e2e/cdp.mjs, the Android emulator job's driver): Set up
//      later, New project with a one-line brief, the plan card in the Inbox, Approve and start,
//      the session to its end, the Tasks tab;
//   4. then the shell's hand-offs, each read back from the shell's own log
//      (<home>/logs/desktop-shell.log: "handed to the system browser (link|new window): <url>",
//      "handed to the file manager: <folder>"): the PR link on the Tasks tab (the task's pr_url is
//      written into the store first, pointing at a page this script serves, so it can also see
//      the browser fetch it), Settings → Sandbox's "Get Docker Desktop" link, a target="_blank"
//      link (the new-window path), a file: link (must open nothing) and Open folder on the
//      Overview. After each, the window must still show the app on the same page;
//   5. saves a screenshot (Page.captureScreenshot) and the visible text of every step, and of
//      the page where the journey stopped (with `--exe`, the whole screen there too:
//      `desktopScreenshot`), the shell's and the daemon's logs and result.json under --out;
//      ends the app (POST /shutdown, then the shell's process tree).
// Exit 1 when a required check failed. The step summary on GitHub lists every check.
//
// `--attach <DevTools URL>` drives a page that is already open instead (a dry run of the journey
// against a bench in Chromium, `--home` the bench's home): no shell, so the hand-off checks are
// reported as skipped. Usage:
//   node scripts/desktop-window-check.mjs --exe <installed .exe> --home <new data folder> --out <dir>
//        [--cdp-port 9333] [--runtime-dir <install>/runtime] [--timeout-min 20]
//   node scripts/desktop-window-check.mjs --attach http://127.0.0.1:9333 --app-origin <ui url>
//        --home <bench home> --out <dir>
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect as connectTcp, createServer as createNetServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, describePage, listTargets } from "../apps/mobile/e2e/cdp.mjs";
import { forwardPageConsole } from "../apps/mobile/e2e/webview-console.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where the shell's own pages live (apps/desktop/src-tauri/src/inject.rs `app_origins`). */
export const APP_ORIGINS = Object.freeze([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

/** What the stand-in model needs from testenv/, copied into <runtime>/testenv/. */
export const STAND_IN_PARTS = Object.freeze(["package.json", "src/bench", "src/provider"]);

/** The Settings card's link while Docker is not installed (sandbox/readiness-types.ts). */
export const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";

/** Variables never passed to the app: model credentials and this machine's tokens. */
export const NEVER_PASSED = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

/**
 * The options; unknown arguments are refused. `--exe` and `--attach` exclude each other and one
 * of them is required; `--home` and `--out` are required.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = {
    exe: null,
    attach: null,
    appOrigin: null,
    home: null,
    out: null,
    runtimeDir: null,
    cdpPort: 9333,
    timeoutMin: 20,
    brief: "A page that shows a random quote",
    project: "Window check",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--exe") out.exe = value();
    else if (a === "--attach") out.attach = value();
    else if (a === "--app-origin") out.appOrigin = value();
    else if (a === "--home") out.home = value();
    else if (a === "--out") out.out = value();
    else if (a === "--runtime-dir") out.runtimeDir = value();
    else if (a === "--brief") out.brief = value();
    else if (a === "--project") out.project = value();
    else if (a === "--cdp-port" || a === "--timeout-min") {
      const n = Number(value());
      if (!Number.isInteger(n) || n <= 0) throw new Error(`${a} needs a positive whole number`);
      // The shell takes 1024 to 65535 (devtools.rs); the variable's port is the next one.
      if (a === "--cdp-port" && (n < 1024 || n > 65534))
        throw new Error(`${a} needs a port from 1024 to 65534 (the next one is asked for too)`);
      if (a === "--cdp-port") out.cdpPort = n;
      else out.timeoutMin = n;
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!out.exe === !out.attach)
    throw new Error("give either --exe <installed app> or --attach <DevTools URL>");
  if (!out.home) throw new Error("--home <data folder> is required");
  if (!out.out) throw new Error("--out <folder for screenshots and logs> is required");
  return out;
}

/**
 * The features wry turns off in WebView2 when the app names no browser arguments
 * (wry's webview2/mod.rs), plus `CalculateNativeWinOcclusion`: once the system browser opens
 * over the window (the PR link), Chromium's occlusion tracking may stop painting the covered
 * page, and the driver's clicks wait for animation frames. WebView2 may use the variable in
 * place of the app's own arguments, so wry's list is repeated here, with `WRY_AUTOPLAY_POLICY`.
 * The shell's own switch (`devtools.rs`) turns off the same four.
 */
export const WEBVIEW2_DISABLED_FEATURES = Object.freeze([
  "msWebOOUI",
  "msPdfOOUI",
  "msSmartScreenProtection",
  "CalculateNativeWinOcclusion",
]);

/**
 * The rest of wry's default WebView2 arguments (wry's webview2/mod.rs; its autoplay attribute
 * is on by default and Tauri never turns it off): media plays without a click, so a spoken
 * alert does in the driven window as it does in the shipped app. Repeated with the features
 * for the same reason; the shell's switch carries it too (`devtools.rs`).
 */
export const WRY_AUTOPLAY_POLICY = "--autoplay-policy=no-user-gesture-required";

/**
 * The shell's own DevTools switch (apps/desktop/src-tauri/src/devtools.rs): a port from 1024
 * to 65535 that every window gets in the arguments the shell gives WebView2.
 */
export const DEVTOOLS_PORT_ENV = "FORERUNNER_WEBVIEW_DEVTOOLS_PORT";

/**
 * The installed app's environment: a fresh data folder, the stand-in model, the window's
 * DevTools, the vault a file in that folder (never this machine's keyring), and no model
 * credential, token or other FORERUNNER_* setting of this machine.
 * `FORERUNNER_SANDBOX_ENGINE=podman` makes the sandbox "not installed" whatever Docker the
 * runner has, so Settings shows the "Get Docker Desktop" link this check clicks.
 *
 * DevTools is asked for twice, on two ports, so the port that answers says which way worked:
 * `shellPort` through the shell's switch (`FORERUNNER_WEBVIEW_DEVTOOLS_PORT`, in the app's own
 * WebView2 arguments) and `envPort` through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` (read by
 * the WebView2 loader; the first Windows run opened no port with it alone). The variable also
 * carries `--enable-logging`, so a browser that got it writes chrome_debug.log in its data
 * folder, where a DevTools server that could not start says why.
 * @param {Record<string, string | undefined>} base
 * @param {{ home: string, shellPort: number, envPort: number }} opts
 */
export function windowEnv(base, { home, shellPort, envPort }) {
  const env = { ...base };
  for (const k of NEVER_PASSED) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith("FORERUNNER_")) delete env[k];
  env.FORERUNNER_HOME = home;
  env.FORERUNNER_DAEMON_PROVIDER = "bench";
  env.FORERUNNER_VAULT_BACKEND = "file";
  env.FORERUNNER_SANDBOX_ENGINE = "podman";
  env.FORERUNNER_BENCH_DELAY_MS = "100";
  env[DEVTOOLS_PORT_ENV] = String(shellPort);
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${envPort} --disable-features=${WEBVIEW2_DISABLED_FEATURES.join(",")} ${WRY_AUTOPLAY_POLICY} --enable-logging`;
  return env;
}

/**
 * A port for DevTools that this machine lets a process bind on 127.0.0.1: `preferred` when it
 * can be bound (and is not in `avoid`), else one the system hands out, with the reason. A port
 * another process holds, or one in a range Windows reserves (Hyper-V, WinNAT: `netsh interface
 * ipv4 show excludedportrange`), would leave WebView2 without a DevTools server and nothing
 * said.
 * @param {number} preferred
 * @param {{ avoid?: number[], host?: string }} [opts]
 * @returns {Promise<{ port: number, note: string | null }>}
 */
export async function freePort(preferred, { avoid = [], host = "127.0.0.1" } = {}) {
  const bind = (port) =>
    new Promise((resolve) => {
      const server = createNetServer();
      server.once("error", (e) => resolve({ ok: false, why: e?.code ?? e?.message ?? String(e) }));
      server.listen({ port, host, exclusive: true }, () => {
        const address = server.address();
        const bound = typeof address === "object" && address ? address.port : port;
        server.close(() => resolve({ ok: true, port: bound }));
      });
    });
  let why = "the other switch has it";
  if (!avoid.includes(preferred)) {
    const r = await bind(preferred);
    if (r.ok) return { port: r.port, note: null };
    why = r.why;
  }
  for (let i = 0; i < 5; i++) {
    const r = await bind(0);
    if (r.ok && !avoid.includes(r.port) && r.port >= 1024)
      return {
        port: r.port,
        note: `port ${preferred} could not be used (${why}); ${r.port} instead`,
      };
  }
  throw new Error(`no free port for DevTools (${preferred}: ${why})`);
}

/**
 * What a plain TCP connection to `host:port` meets: accepted, refused, or nothing in time
 * (fetch only says "fetch failed").
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
export function tcpProbe(host, port, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const socket = connectTcp({ host, port });
    const done = (words) => {
      socket.destroy();
      resolve(words);
    };
    socket.setTimeout(timeoutMs, () => done(`no answer within ${Math.round(timeoutMs / 1000)} s`));
    socket.once("connect", () => done("a connection was accepted"));
    socket.once("error", (e) =>
      done(
        e?.code === "ECONNREFUSED" ? "refused (ECONNREFUSED)" : `error ${e?.code ?? e?.message}`,
      ),
    );
  });
}

/**
 * The switches of a Chromium command line as Windows reports it (Win32_Process.CommandLine), in
 * order: `--name`, `--name=value` or `--name="value with spaces"`. Names are lower case.
 * @param {string} commandLine
 * @returns {Array<{ name: string, value: string | null }>}
 */
export function parseSwitches(commandLine) {
  const out = [];
  const re = /(?:^|\s)--([A-Za-z0-9][A-Za-z0-9._-]*)(?:=(?:"([^"]*)"|([^\s"]*)))?/g;
  for (const m of String(commandLine ?? "").matchAll(re))
    out.push({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? null });
  return out;
}

/**
 * Which way the DevTools switch reached a browser process: its `--remote-debugging-port`
 * values against the two ports asked for. Chromium uses the last value of a switch given twice.
 * @param {number[]} debugPorts
 * @param {{ shell: number, env: number }} ports
 */
export function switchMechanism(debugPorts, ports) {
  const hasShell = debugPorts.includes(ports.shell);
  const hasEnv = debugPorts.includes(ports.env);
  const effective = debugPorts.length ? debugPorts[debugPorts.length - 1] : null;
  if (hasShell && hasEnv)
    return {
      via: "both",
      effective,
      words: `both: the shell's switch (${ports.shell}) and WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (${ports.env}); Chromium uses the last, ${effective}`,
    };
  if (hasShell)
    return {
      via: "shell",
      effective,
      words: `the shell's switch only (${DEVTOOLS_PORT_ENV}, port ${ports.shell}): WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (port ${ports.env}) is not on it`,
    };
  if (hasEnv)
    return {
      via: "env",
      effective,
      words: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS only (port ${ports.env}): the shell's switch (port ${ports.shell}) is not on it`,
    };
  if (debugPorts.length)
    return {
      via: "other",
      effective,
      words: `a port neither way asked for: ${debugPorts.join(", ")}`,
    };
  return {
    via: "none",
    effective: null,
    words: "neither: no --remote-debugging-port on its command line",
  };
}

/**
 * The port ranges Windows keeps from programs (`netsh interface ipv4 show excludedportrange
 * protocol=tcp`): a port in one cannot be bound.
 * @param {string | string[]} text
 * @returns {Array<{ start: number, end: number }>}
 */
export function parseExcludedPortRanges(text) {
  const lines = Array.isArray(text) ? text : String(text ?? "").split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(\d+)\s*\*?\s*$/.exec(String(line));
    if (m) out.push({ start: Number(m[1]), end: Number(m[2]) });
  }
  return out;
}

/**
 * A list as Windows PowerShell's ConvertTo-Json may write it: a list, one object where the list
 * had one entry, nothing, or (PowerShell 5.1 with an array wrapped in a PSObject)
 * `{ "value": [...], "Count": n }`.
 */
export const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  if (typeof v === "object" && Array.isArray(v.value) && "Count" in v) return v.value;
  return [v];
};

/**
 * What the Windows diagnostics found (`collectWebviewDiagnostics`' JSON), read for this app:
 * the msedgewebview2.exe browser processes (no `--type=`), which of them are this app's (its
 * child, its data folder or its exe name), the DevTools switch on each command line and which
 * way it came, the TCP ports they listen on, who holds the asked-for ports, the policies, the
 * runtime's version and the excluded port ranges. Pure: the files in the data folder are read
 * by `userDataClues`.
 * @param {any} raw
 * @param {{ ports: { shell: number, env: number }, appPid?: number | null, identifier?: string, exeName?: string }} ctx
 */
export function diagnoseWebview(raw, { ports, appPid = null, identifier = "", exeName = "" }) {
  const processes = asArray(raw?.processes).map((p) => {
    const switches = parseSwitches(p?.commandLine);
    const values = (n) => switches.filter((s) => s.name === n).map((s) => s.value);
    return {
      pid: Number(p?.pid),
      parent: Number(p?.parent),
      path: String(p?.path ?? ""),
      type: values("type").at(-1) ?? null,
      userDataDir: values("user-data-dir").at(-1) ?? null,
      exeName: values("webview-exe-name").at(-1) ?? null,
      debugPorts: values("remote-debugging-port")
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n)),
      enableLogging: switches.some((s) => s.name === "enable-logging"),
      disabledFeatures: values("disable-features").flatMap((v) => String(v ?? "").split(",")),
      commandLine: String(p?.commandLine ?? ""),
    };
  });
  const listening = asArray(raw?.listening).map((l) => ({
    pid: Number(l?.pid),
    address: String(l?.address ?? ""),
    port: Number(l?.port),
  }));
  const lower = (s) => String(s ?? "").toLowerCase();
  const ours = (b) =>
    (appPid !== null && b.parent === appPid) ||
    (!!identifier && lower(b.userDataDir).includes(lower(identifier))) ||
    (!!exeName && lower(b.exeName) === lower(exeName));
  const browsers = processes
    .filter((p) => p.type === null)
    .map((b) => {
      const family = new Set([
        b.pid,
        ...processes.filter((p) => p.parent === b.pid).map((p) => p.pid),
      ]);
      return {
        ...b,
        ours: ours(b),
        listening: listening.filter((l) => family.has(l.pid)),
        mechanism: switchMechanism(b.debugPorts, ports),
      };
    });
  const excluded = parseExcludedPortRanges(asArray(raw?.excludedPorts).map(String));
  const asked = [ports.shell, ports.env];
  return {
    ports,
    processCount: processes.length,
    browsers,
    ours: browsers.filter((b) => b.ours),
    onPorts: asArray(raw?.onPorts).map((h) => ({
      port: Number(h?.port),
      pid: Number(h?.pid),
      owner: String(h?.owner ?? ""),
      address: String(h?.address ?? ""),
      state: String(h?.state ?? ""),
    })),
    excluded: asked
      .map((port) => ({ port, range: excluded.find((r) => r.start <= port && port <= r.end) }))
      .filter((x) => x.range),
    policies: asArray(raw?.policies).map((p) => ({
      key: String(p?.key ?? ""),
      name: String(p?.name ?? ""),
      value: String(p?.value ?? ""),
    })),
    runtime: asArray(raw?.runtime).map((r) => ({
      source: String(r?.source ?? ""),
      version: String(r?.version ?? ""),
    })),
  };
}

/**
 * Files Chromium leaves in a browser's data folder: `DevToolsActivePort` (written once its
 * DevTools server listens: the port, then the browser's socket path) and the log
 * `--enable-logging` writes (chrome_debug.log, or debug.log), of which the lines about DevTools.
 * @param {string | null} userDataDir
 * @param {{ exists?: (f: string) => boolean, read?: (f: string) => string }} [fs]
 */
export function userDataClues(
  userDataDir,
  { exists = existsSync, read = (f) => readFileSync(f, "utf8") } = {},
) {
  if (!userDataDir) return { activePort: null, activePortText: null, logFile: null, logLines: [] };
  let activePortText = null;
  const portFile = path.join(userDataDir, "DevToolsActivePort");
  try {
    if (exists(portFile)) activePortText = read(portFile).trim();
  } catch (e) {
    activePortText = `(unreadable: ${e.message})`;
  }
  const first = activePortText ? Number(activePortText.split(/\r?\n/)[0]) : Number.NaN;
  let logFile = null;
  let logLines = [];
  for (const name of ["chrome_debug.log", "debug.log"]) {
    const f = path.join(userDataDir, name);
    try {
      if (!exists(f)) continue;
      logFile = f;
      logLines = read(f)
        .split(/\r?\n/)
        .filter((l) => /devtools|remote.?debugging|http server|policy|policies/i.test(l))
        .slice(-15)
        .map((l) => oneLine(l));
      break;
    } catch {
      // unreadable: no lines
    }
  }
  return {
    activePort: Number.isInteger(first) && first > 0 ? first : null,
    activePortText,
    logFile,
    logLines,
  };
}

/**
 * The check's other arguments found on a browser's command line: `--enable-logging` only the
 * variable carries, `CalculateNativeWinOcclusion` both ways carry (wry's default list has not).
 * @param {{ enableLogging: boolean, disabledFeatures: string[] }} b
 */
export function arrivedArguments(b) {
  const out = [];
  if (b.enableLogging) out.push("the variable's --enable-logging");
  if (b.disabledFeatures.includes("CalculateNativeWinOcclusion"))
    out.push("CalculateNativeWinOcclusion in --disable-features");
  return out;
}

/**
 * One sentence on what happened to the DevTools switch, from the diagnosis (`clues` per
 * browser pid from `userDataClues`).
 * @param {ReturnType<typeof diagnoseWebview>} d
 * @param {Record<number, ReturnType<typeof userDataClues>>} [clues]
 */
export function devtoolsVerdict(d, clues = {}) {
  if (!d.ours.length)
    return d.browsers.length
      ? `no msedgewebview2.exe browser process of this app (${d.browsers.length} of other programs)`
      : "no msedgewebview2.exe browser process at all: the window has no WebView2 browser";
  const b = d.ours[0];
  const reasons = [];
  const devtoolsPolicies = d.policies.filter((p) =>
    /DeveloperToolsAvailability|RemoteDebugging|AdditionalBrowserArguments/i.test(
      `${p.key}\\${p.name}`,
    ),
  );
  for (const p of devtoolsPolicies) reasons.push(`policy ${p.key}\\${p.name} = ${p.value}`);
  if (b.mechanism.via === "none") {
    // The rest of what each way carries tells "arguments dropped whole" from "the port switch
    // alone removed".
    const arrived = arrivedArguments(b);
    reasons.push(
      arrived.length
        ? `${arrived.join(" and ")} did arrive, so the port switch alone was removed`
        : "nor did the rest of either way's arguments (--enable-logging, CalculateNativeWinOcclusion), so they were dropped whole",
    );
    return `the switch never reached msedgewebview2.exe: neither ${DEVTOOLS_PORT_ENV} (the shell's) nor WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is on its command line; ${reasons.join("; ")}`;
  }
  const at = (l) => `${l.address}:${l.port}`;
  const onEffective = b.listening.filter((l) => l.port === b.mechanism.effective);
  if (onEffective.length)
    return `msedgewebview2.exe listens on ${onEffective.map(at).join(", ")} (the switch came by ${b.mechanism.via})`;
  if (b.listening.length)
    return `the switch reached msedgewebview2.exe (port ${b.mechanism.effective}, by ${b.mechanism.via}) but DevTools opened elsewhere: ${b.listening.map(at).join(", ")}`;
  const portHolders = d.onPorts.filter((h) => h.port === b.mechanism.effective);
  for (const h of portHolders)
    reasons.push(`port ${h.port} is held by ${h.owner || "?"} (pid ${h.pid}, ${h.state})`);
  for (const x of d.excluded.filter((e) => e.port === b.mechanism.effective))
    reasons.push(
      `port ${x.port} is in a range Windows keeps from programs (${x.range.start}-${x.range.end})`,
    );
  const c = clues[b.pid];
  if (c?.logLines?.length) reasons.push(`its log: ${c.logLines.slice(-2).join(" / ")}`);
  else if (c && !c.logFile)
    reasons.push(
      b.enableLogging
        ? "no chrome_debug.log in its data folder"
        : "no log (the variable's --enable-logging is not on it)",
    );
  return `the switch reached msedgewebview2.exe (port ${b.mechanism.effective}, by ${b.mechanism.via}) but no DevTools server listens${reasons.length ? `: ${reasons.join("; ")}` : " (no policy, no other holder, not an excluded port)"}`;
}

/**
 * The short form of the diagnosis for the log and the step summary.
 * @param {ReturnType<typeof diagnoseWebview>} d
 * @param {Record<number, ReturnType<typeof userDataClues>>} [clues]
 */
export function diagnosisLines(d, clues = {}) {
  const lines = [
    `msedgewebview2.exe: ${d.processCount} process(es), ${d.browsers.length} browser process(es), ${d.ours.length} of this app`,
  ];
  for (const b of d.ours) {
    lines.push(
      `browser pid ${b.pid} (parent ${b.parent}), data folder ${b.userDataDir ?? "(none named)"}`,
    );
    lines.push(`the DevTools switch on its command line: ${b.mechanism.words}`);
    const arrived = arrivedArguments(b);
    lines.push(
      `the check's other arguments on it: ${arrived.length ? arrived.join(", ") : "none (no --enable-logging, no CalculateNativeWinOcclusion)"}`,
    );
    lines.push(
      b.listening.length
        ? `it listens on ${b.listening.map((l) => `${l.address}:${l.port}`).join(", ")}`
        : "it listens on no TCP port",
    );
    const c = clues[b.pid];
    if (c) {
      lines.push(
        c.activePortText
          ? `DevToolsActivePort: ${c.activePortText.split(/\r?\n/).join(" ")}`
          : "no DevToolsActivePort in its data folder (no DevTools server started)",
      );
      if (c.logFile)
        lines.push(
          `${path.basename(c.logFile)}: ${c.logLines.length ? c.logLines.join(" / ") : "nothing about DevTools"}`,
        );
    }
  }
  for (const port of [d.ports.shell, d.ports.env]) {
    const held = d.onPorts.filter((h) => h.port === port);
    lines.push(
      held.length
        ? `port ${port}: ${held.map((h) => `${h.owner || "?"} pid ${h.pid} ${h.state} on ${h.address}`).join(", ")}`
        : `port ${port}: no socket`,
    );
  }
  for (const x of d.excluded)
    lines.push(`port ${x.port} is in an excluded range (${x.range.start}-${x.range.end})`);
  lines.push(
    d.policies.length
      ? `policies: ${d.policies.map((p) => `${p.key}\\${p.name} = ${p.value}`).join("; ")}`
      : "policies: none under Software\\Policies\\Microsoft\\Edge that bear on DevTools or browser arguments",
  );
  lines.push(
    d.runtime.length
      ? `WebView2 runtime: ${[...new Set(d.runtime.map((r) => r.version))].join(", ")}`
      : "WebView2 runtime: version not found",
  );
  lines.push(`verdict: ${devtoolsVerdict(d, clues)}`);
  return lines;
}

/**
 * Windows PowerShell, a fixed script: the msedgewebview2.exe processes and their command lines
 * (Win32_Process), the TCP ports they listen on and who holds the asked-for ports
 * (Get-NetTCPConnection), the Edge and WebView2 policy values under HKLM and HKCU that bear on
 * DevTools or browser arguments (and every WebView2 loader override), the WebView2 runtime's
 * version (EdgeUpdate's `pv` and the exe's own), and the excluded port ranges (netsh). Its
 * only inputs are `FR_DEVTOOLS_PORTS` (digits and commas, checked by the caller) and
 * `FR_DIAG_OUT`, the JSON file it writes (UTF-8, whatever the console's code page).
 */
export const WEBVIEW_DIAG_PS = String.raw`$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$out = [ordered]@{}
$ports = @($env:FR_DEVTOOLS_PORTS -split ',' | Where-Object { $_ -match '^[0-9]+$' } | ForEach-Object { [int]$_ })
$procs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'msedgewebview2.exe'" -OperationTimeoutSec 30)
$list = New-Object System.Collections.Generic.List[object]
foreach ($p in $procs) { [void]$list.Add([ordered]@{ pid = [int]$p.ProcessId; parent = [int]$p.ParentProcessId; path = [string]$p.ExecutablePath; commandLine = [string]$p.CommandLine }) }
$out.processes = $list
$ids = @($procs | ForEach-Object { [uint32]$_.ProcessId })
$listen = New-Object System.Collections.Generic.List[object]
if ($ids.Count -gt 0) {
  foreach ($c in @(Get-NetTCPConnection -State Listen -OwningProcess $ids)) { [void]$listen.Add([ordered]@{ pid = [int]$c.OwningProcess; address = [string]$c.LocalAddress; port = [int]$c.LocalPort }) }
}
$out.listening = $listen
$held = New-Object System.Collections.Generic.List[object]
foreach ($port in $ports) {
  foreach ($c in @(Get-NetTCPConnection -LocalPort $port)) {
    $name = [string](Get-Process -Id $c.OwningProcess).ProcessName
    [void]$held.Add([ordered]@{ port = [int]$port; pid = [int]$c.OwningProcess; owner = $name; address = [string]$c.LocalAddress; state = [string]$c.State })
  }
}
$out.onPorts = $held
$pol = New-Object System.Collections.Generic.List[object]
foreach ($root in @('HKLM:\SOFTWARE\Policies\Microsoft\Edge', 'HKCU:\SOFTWARE\Policies\Microsoft\Edge', 'HKLM:\SOFTWARE\WOW6432Node\Policies\Microsoft\Edge')) {
  $key = Get-Item -LiteralPath $root
  if ($key) {
    foreach ($n in $key.GetValueNames()) { if ($n -match 'Debug|DevTools|Developer|Argument|WebView') { [void]$pol.Add([ordered]@{ key = [string]$key.Name; name = [string]$n; value = [string]$key.GetValue($n) }) } }
    $wv = Join-Path $root 'WebView2'
    foreach ($k in @(@(Get-Item -LiteralPath $wv) + @(Get-ChildItem -LiteralPath $wv -Recurse))) {
      if ($k) { foreach ($n in $k.GetValueNames()) { [void]$pol.Add([ordered]@{ key = [string]$k.Name; name = [string]$n; value = [string]$k.GetValue($n) }) } }
    }
  }
}
$out.policies = $pol
$rt = New-Object System.Collections.Generic.List[object]
foreach ($k in @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')) {
  $pv = (Get-ItemProperty -LiteralPath $k).pv
  if ($pv) { [void]$rt.Add([ordered]@{ source = $k; version = [string]$pv }) }
}
foreach ($exe in @($procs | ForEach-Object { [string]$_.ExecutablePath } | Where-Object { $_ } | Sort-Object -Unique)) {
  [void]$rt.Add([ordered]@{ source = $exe; version = [string](Get-Item -LiteralPath $exe).VersionInfo.ProductVersion })
}
$out.runtime = $rt
$out.excludedPorts = @(& netsh.exe interface ipv4 show excludedportrange protocol=tcp | ForEach-Object { [string]$_ })
$json = ConvertTo-Json -InputObject $out -Depth 6 -Compress
[System.IO.File]::WriteAllText($env:FR_DIAG_OUT, $json, (New-Object System.Text.UTF8Encoding $false))
`;

/**
 * What Windows PowerShell said on stderr, as text. Started with -EncodedCommand and its output
 * redirected, it may write its error stream as CLIXML (`#< CLIXML`, then `<Objs>` with progress
 * records and one `<S S="Error">` per line, line breaks escaped as `_x000D__x000A_`): cut to a
 * few hundred characters, that is mostly header. Returns the error lines unescaped, after any
 * text before the header; anything else (plain text, CLIXML without an error) as it came.
 * @param {string} text
 */
export function powerShellWords(text) {
  const s = String(text ?? "");
  const at = s.indexOf("#< CLIXML");
  if (at < 0) return s;
  const errors = [...s.slice(at).matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
      .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&amp;/g, "&")
      .replace(/_x([0-9a-f]{4})_/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16))),
  );
  if (!errors.length) return s;
  return `${s.slice(0, at)}${errors.join("")}`;
}

/**
 * Everything a PowerShell run wrote, for the artifact (`devtools-<label>.ps.txt`): its exit,
 * whether it timed out, stdout and stderr as they came, and stderr's errors as text when they
 * were CLIXML.
 * @param {{ status: number | null, timedOut: boolean, stdout: string, stderr: string }} o
 */
export function powerShellReport(o) {
  const shown = (t) => (t ? (t.endsWith("\n") ? t : `${t}\n`) : "(nothing)\n");
  const words = powerShellWords(o.stderr);
  return [
    `exit: ${o.status ?? "none"}\n`,
    `timed out: ${o.timedOut ? "yes" : "no"}\n`,
    `--- stdout ---\n${shown(o.stdout)}`,
    `--- stderr ---\n${shown(o.stderr)}`,
    words !== o.stderr ? `--- stderr, the errors as text ---\n${shown(words)}` : "",
  ].join("");
}

/** PowerShell's -EncodedCommand form of a script (UTF-16LE, base64): no quoting of any kind. */
export function encodePowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

/**
 * Runs a program with an argv array, its output captured, and gives up after `timeoutMs`
 * (the process is ended, and the answer does not wait for it).
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: Record<string, string | undefined>, timeoutMs: number }} opts
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string, timedOut: boolean, error?: Error }>}
 */
export function runCaptured(cmd, args, { env, timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut: false, ...r });
    };
    let child;
    try {
      child = spawn(cmd, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ status: null, stdout, stderr, timedOut: false, error });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      finish({ status: null, timedOut: true });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdout.length < 100_000) stdout += d;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 100_000) stderr += d;
    });
    child.once("error", (error) => finish({ status: null, error }));
    child.once("close", (status) => finish({ status }));
  });
}

/**
 * Runs `WEBVIEW_DIAG_PS` (Windows only) and returns its JSON, or why there is none. Never
 * throws and never takes longer than `timeoutMs`.
 * @param {string} file the JSON file PowerShell writes
 * @param {number[]} ports the DevTools ports asked for
 * @param {{ platform?: string, run?: typeof runCaptured, timeoutMs?: number }} [deps]
 */
export async function collectWebviewDiagnostics(
  file,
  ports,
  { platform = process.platform, run = runCaptured, timeoutMs = 90_000 } = {},
) {
  if (platform !== "win32") return { ok: false, why: "not Windows" };
  if (!ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536))
    return { ok: false, why: `not ports: ${ports.join(",")}` };
  let r;
  try {
    r = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(WEBVIEW_DIAG_PS)],
      {
        env: { ...process.env, FR_DEVTOOLS_PORTS: ports.join(","), FR_DIAG_OUT: file },
        timeoutMs,
      },
    );
  } catch (e) {
    return { ok: false, why: `PowerShell did not start: ${e?.message ?? e}` };
  }
  // All it wrote goes into the artifact when there is no JSON (`powerShellReport`).
  const output = {
    status: r.status,
    timedOut: !!r.timedOut,
    stdout: String(r.stdout ?? ""),
    stderr: String(r.stderr ?? ""),
  };
  if (r.timedOut)
    return {
      ok: false,
      why: `PowerShell did not finish within ${Math.round(timeoutMs / 1000)} s`,
      output,
    };
  if (r.status !== 0 || !existsSync(file)) {
    const said = (
      r.error?.message ||
      powerShellWords(output.stderr).trim() ||
      output.stdout.trim()
    ).trim();
    return {
      ok: false,
      why: `PowerShell exit ${r.status}${said ? `: ${oneLine(said, 600)}` : ""}`,
      output,
    };
  }
  try {
    return { ok: true, raw: JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) };
  } catch (e) {
    return { ok: false, why: `its output is not JSON: ${e.message}` };
  }
}

/**
 * Words for what the DevTools endpoints answered on the last try.
 * @param {Array<{ base: string, error?: string, targets?: Array<Record<string, unknown>> }>} seen
 */
export function endpointWords(seen) {
  return seen
    .map((s) =>
      s.targets
        ? `${s.base} answered with ${s.targets.length} target(s)${s.targets.length ? `: ${s.targets.map((t) => `${t.type} ${t.url}`).join(", ")}` : ""}`
        : `${s.base}: ${s.error ?? "no answer"}`,
    )
    .join("; ");
}

/**
 * The shell's own words about the DevTools switch in its log (devtools.rs `resolve`): the
 * port it turned on, or why it refused or ignored the variable.
 * @param {string} text
 * @returns {{ port: number, args: string } | { refused: string } | null}
 */
export function parseShellDevtools(text) {
  let found = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    const on =
      /WebView2 DevTools on port (\d+) for every window \(FORERUNNER_WEBVIEW_DEVTOOLS_PORT[^)]*\): (.+)$/.exec(
        line,
      );
    if (on) {
      found = { port: Number(on[1]), args: on[2] };
      continue;
    }
    const off = /(FORERUNNER_WEBVIEW_DEVTOOLS_PORT=.* ignored: .+)$/.exec(line);
    if (off) found = { refused: off[1] };
  }
  return found;
}

/** Which way of asking a DevTools port belongs to, in words. */
export function viaWords(via) {
  if (via === "shell") return `the shell's switch (${DEVTOOLS_PORT_ENV})`;
  if (via === "env") return "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
  if (via === "elsewhere") return "neither: found where the diagnostics saw WebView2 listen";
  return via;
}

/**
 * DevTools endpoints the diagnostics point at: where this app's browser process listens, and
 * the port in its DevToolsActivePort file (DevTools that opened somewhere not asked for).
 * @param {ReturnType<typeof diagnoseWebview>} d
 * @param {Record<number, ReturnType<typeof userDataClues>>} clues
 */
export function fallbackEndpoints(d, clues = {}) {
  const out = [];
  const add = (address, port) => {
    if (!Number.isInteger(port) || port <= 0) return;
    const host =
      address === "::1"
        ? "[::1]"
        : address === "0.0.0.0" || address === "::"
          ? "127.0.0.1"
          : address;
    if (host !== "127.0.0.1" && host !== "[::1]") return;
    const base = `http://${host}:${port}`;
    if (!out.includes(base)) out.push(base);
  };
  for (const b of d.ours) {
    for (const l of b.listening) add(l.address, l.port);
    const c = clues[b.pid];
    if (c?.activePort) add("127.0.0.1", c.activePort);
  }
  return out;
}

/** The identifier the app's WebView2 data folder is named after (tauri.conf.json). */
export function appIdentifier() {
  try {
    const conf = JSON.parse(
      readFileSync(path.join(REPO, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
    );
    return String(conf.identifier ?? "");
  } catch {
    return "";
  }
}

/** The last `max` bytes of a file into another (a browser log can be large). */
function copyTail(from, to, max) {
  try {
    const bytes = readFileSync(from);
    writeFileSync(to, bytes.subarray(Math.max(0, bytes.length - max)));
  } catch (e) {
    console.log(`could not copy ${from}: ${e.message}`);
  }
}

/**
 * The Windows diagnostics of the window's DevTools, saved under `out`
 * (`devtools-<label>.json`, PowerShell's own `devtools-<label>.raw.json`, the browser's log):
 * the short lines, the verdict, the way the switch came and endpoints to try. Never throws.
 * @param {{ out: string, label: string, ports: { shell: number, env: number }, appPid: number | null, identifier: string, exeName: string }} ctx
 */
async function webviewDiagnostics({ out, label, ports, appPid, identifier, exeName }) {
  const collected = await collectWebviewDiagnostics(path.join(out, `devtools-${label}.raw.json`), [
    ports.shell,
    ports.env,
  ]);
  if (!collected.ok) {
    const words = `no WebView2 diagnostics: ${collected.why}`;
    const lines = [words];
    if (collected.output) {
      const file = path.join(out, `devtools-${label}.ps.txt`);
      try {
        writeFileSync(file, powerShellReport(collected.output));
        lines.push(`all PowerShell wrote: ${file}`);
      } catch (e) {
        lines.push(`could not save what PowerShell wrote: ${e.message}`);
      }
    }
    return { lines, verdict: words, mechanism: null, fallbacks: [] };
  }
  const d = diagnoseWebview(collected.raw, { ports, appPid, identifier, exeName });
  const clues = {};
  for (const b of d.ours) clues[b.pid] = userDataClues(b.userDataDir);
  for (const [pid, c] of Object.entries(clues))
    if (c.logFile)
      copyTail(
        c.logFile,
        path.join(out, `webview-${label}-${pid}-${path.basename(c.logFile)}`),
        2_000_000,
      );
  const lines = diagnosisLines(d, clues);
  const verdict = devtoolsVerdict(d, clues);
  writeFileSync(
    path.join(out, `devtools-${label}.json`),
    `${JSON.stringify({ diagnosis: d, clues, lines, verdict }, null, 2)}\n`,
  );
  return {
    lines,
    verdict,
    mechanism: d.ours[0]?.mechanism ?? null,
    fallbacks: fallbackEndpoints(d, clues),
  };
}

/** Windows PowerShell: the whole desktop into the PNG named by `FR_SHOT` (.NET's screen copy). */
const DESKTOP_SHOT_PS = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
  "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
  "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
  "$g = [System.Drawing.Graphics]::FromImage($bmp)",
  "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)",
  "$bmp.Save($env:FR_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)",
  "$g.Dispose()",
  "$bmp.Dispose()",
].join("; ");

/**
 * A screenshot of the whole screen where the journey stopped: a stop before the window's page
 * could be driven (no daemon, no DevTools page) has no page to capture, and a dialog of the
 * shell's is outside the page. Windows only; the file's path goes in an environment variable,
 * never into the script text. Returns what happened, in words.
 * @param {string} file
 * @param {{ platform?: string, run?: typeof spawnSync }} [deps]
 */
export function desktopScreenshot(file, { platform = process.platform, run = spawnSync } = {}) {
  if (platform !== "win32") return "no desktop screenshot (not Windows)";
  const r = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", DESKTOP_SHOT_PS], {
    env: { ...process.env, FR_SHOT: file },
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
  if (r.status === 0 && existsSync(file)) return `desktop screenshot: ${file}`;
  const why = (r.error?.message || powerShellWords(r.stderr ?? "")).trim();
  return `desktop screenshot failed: ${why ? oneLine(why) : `exit ${r.status}`}`;
}

/**
 * Copies the stand-in model into an installed runtime (`<runtime>/testenv/...`, where
 * `fr daemon --provider bench` looks). Refuses a folder that is no runtime. Returns what it
 * copied, relative to the runtime.
 * @param {string} repoRoot
 * @param {string} runtimeDir
 */
export function installStandIn(repoRoot, runtimeDir) {
  const cli = path.join(runtimeDir, "packages", "runtime", "src", "cli", "main.ts");
  if (!existsSync(cli)) throw new Error(`${runtimeDir} is not an installed runtime (no ${cli})`);
  const copied = [];
  for (const part of STAND_IN_PARTS) {
    const segments = part.split("/");
    cpSync(
      path.join(repoRoot, "testenv", ...segments),
      path.join(runtimeDir, "testenv", ...segments),
      {
        recursive: true,
      },
    );
    copied.push(path.join("testenv", ...segments));
  }
  return copied;
}

/**
 * Whether `url` is one of the app's own pages.
 * @param {string} url
 * @param {readonly string[]} [origins]
 */
export function isAppUrl(url, origins = APP_ORIGINS) {
  const s = String(url ?? "");
  return origins.some((o) => s === o || s.startsWith(`${o}/`));
}

/**
 * The shell's hand-offs in its log (apps/desktop/src-tauri/src/windows.rs `handed_to_browser_line`
 * and the refusal, folder.rs `handed_to_file_manager_line`), in order. tauri-plugin-log writes
 * `[date][time][module][LEVEL] message`; the message ends the line.
 * @param {string} text
 * @returns {Array<{ kind: "browser", via: string, target: string } | { kind: "folder", target: string } | { kind: "refused", scheme: string, via: string | null }>}
 */
export function parseHandoffs(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m =
      /handed to the system browser \((link|new window)\): (\S+)(?: \(query not logged\))?$/.exec(
        line,
      );
    if (m) {
      out.push({ kind: "browser", via: m[1], target: m[2] });
      continue;
    }
    m = /handed to the file manager: (.+)$/.exec(line);
    if (m) {
      out.push({ kind: "folder", target: m[1].trim() });
      continue;
    }
    m = /opening (\S+) from the window refused(?: \((link|new window)\))?/.exec(line);
    if (m) out.push({ kind: "refused", scheme: m[1], via: m[2] ?? null });
  }
  return out;
}

/**
 * Two spellings of one folder: on Windows case and `/` versus `\` do not matter; a trailing
 * separator never does.
 * @param {string} a
 * @param {string} b
 * @param {boolean} [windows]
 */
export function sameFolder(a, b, windows = process.platform === "win32") {
  const norm = (p) => {
    let s = String(p ?? "").trim();
    if (windows) s = s.replace(/\//g, "\\").toLowerCase();
    return s.replace(/[\\/]+$/, "");
  };
  return norm(a) !== "" && norm(a) === norm(b);
}

/**
 * Writes the PR link onto a task in the daemon's store (`<home>/data/state.sqlite`, table
 * `task`), the column the Tasks tab's PR link reads. The daemon has no route for it (the PR
 * executor sets it); the window check needs a task with a PR, not a pull request.
 * @param {string} dbFile
 * @param {string} taskId
 * @param {string} prUrl
 * @param {string} nowIso
 */
export async function seedPrUrl(dbFile, taskId, prUrl, nowIso) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbFile);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const r = db
      .prepare(
        'UPDATE "task" SET "pr_url" = ?, "updated_at" = ?, "version" = "version" + 1 WHERE "id" = ?',
      )
      .run(prUrl, nowIso, taskId);
    if (Number(r.changes) !== 1) throw new Error(`no task ${taskId} in ${dbFile}`);
  } finally {
    db.close();
  }
}

/**
 * A page on 127.0.0.1 for the links the window hands to the system browser: it records every
 * request, so the check can see whether the browser really opened the URL.
 * @returns {Promise<{ base: string, hits: Array<{ method: string, path: string, at: string }>, close: () => Promise<void> }>}
 */
export async function startLinkServer() {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({ method: req.method ?? "?", path: req.url ?? "/", at: new Date().toISOString() });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><meta charset=utf-8><title>Forerunner window check</title><p>The system browser opened this page.</p>",
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/**
 * The step summary: one line per check, a skipped check said as such, then any sections (the
 * DevTools diagnostics), one line each.
 * @param {string} title
 * @param {Array<{ name: string, ok: boolean, skipped?: boolean, required?: boolean, detail?: string }>} checks
 * @param {Array<{ title: string, lines: string[] }>} [sections]
 */
export function summaryMarkdown(title, checks, sections = []) {
  const failed = checks.filter((c) => !c.ok && !c.skipped && c.required !== false).length;
  return [
    `### ${title}`,
    "",
    failed ? `**${failed} required check(s) failed.**` : "Every required check passed.",
    "",
    ...checks.map((c) => {
      const state = c.skipped ? "skipped" : c.ok ? "ok" : c.required === false ? "note" : "FAILED";
      return `- ${state}: ${c.name}${c.detail ? ` (${oneLine(c.detail, 600)})` : ""}`;
    }),
    "",
    ...sections.flatMap((s) => [
      `#### ${s.title}`,
      "",
      ...s.lines.map((l) => `- ${oneLine(l, 600)}`),
      "",
    ]),
  ].join("\n");
}

function oneLine(s, max = 300) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A step of the journey that cannot go on; the rest is reported as not reached. */
class Stop extends Error {}

async function until(what, ms, everyMs, fn) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      if (e instanceof Stop) throw e;
      last = e;
    }
    if (Date.now() >= end)
      throw new Error(
        `${what}: not within ${Math.round(ms / 1000)} s${last ? ` (${last.message})` : ""}`,
      );
    await sleep(everyMs);
  }
}

function readDaemonFile(home) {
  const file = path.join(home, "runtime", "daemon.json");
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8"));
}

async function healthy(daemon) {
  const res = await fetch(`${daemon.url}/health`, {
    headers: { authorization: `Bearer ${daemon.token}` },
    signal: AbortSignal.timeout(5_000),
  });
  return res.ok;
}

function apiFor(daemon) {
  return async (method, route, body) => {
    const res = await fetch(`${daemon.url}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${daemon.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  };
}

/** The shell log's bytes from `offset` on (the file only grows during the check). */
function logSince(file, offset) {
  if (!file || !existsSync(file)) return "";
  return readFileSync(file).subarray(offset).toString("utf8");
}

/**
 * What the shell said about links and folders since `offset`: the lines a failed hand-off check
 * shows (a browser that would not open, a refusal).
 */
function shellSaid(file, offset) {
  const lines = logSince(file, offset)
    .split(/\r?\n/)
    .filter((l) => /browser|refused|folder|could not/i.test(l))
    .map((l) => l.replace(/^(\[[^\]]*\])+\s*/, ""));
  return lines.length ? `the shell said: ${lines.slice(-3).join(" | ")}` : `nothing in ${file}`;
}

function logSize(file) {
  return file && existsSync(file) ? statSync(file).size : 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const out = path.resolve(opts.out);
  const home = path.resolve(opts.home);
  mkdirSync(out, { recursive: true });
  const shellMode = !!opts.exe;
  const origins = opts.appOrigin ? [opts.appOrigin.replace(/\/+$/, "")] : APP_ORIGINS;
  const deadline = Date.now() + opts.timeoutMin * 60_000;
  const left = (cap) => Math.max(5_000, Math.min(cap, deadline - Date.now()));
  const checks = [];
  const result = {
    mode: shellMode ? "installed app" : "attached page",
    home,
    checks,
    startedAt: new Date().toISOString(),
  };
  const check = (name, ok, detail = "", extra = {}) => {
    checks.push({ name, ok: !!ok, detail: String(detail ?? ""), ...extra });
    const state = extra.skipped ? "skip" : ok ? "ok  " : extra.required === false ? "note" : "FAIL";
    console.log(`${state} ${name}${detail ? `: ${oneLine(detail, 600)}` : ""}`);
    return !!ok;
  };
  const must = (name, ok, detail = "") => {
    if (!check(name, ok, detail)) throw new Stop(name);
  };
  const skip = (name, why) => check(name, false, why, { skipped: true });
  const shellLog = path.join(home, "logs", "desktop-shell.log");
  const daemonLog = path.join(home, "logs", "daemon-shell.log");
  let app = null;
  let daemon = null;
  let link = null;
  let client = null;
  /** @type {((label: string) => Promise<string>) | null} set once the window's page is driven */
  let shot = null;
  const pageErrors = [];
  /** Extra parts of the step summary (the DevTools diagnostics). */
  const sections = [];
  /** @type {{ shell: number, env: number } | null} the two DevTools ports asked for (--exe) */
  let ports = null;
  const devtools = {};
  if (shellMode) result.devtools = devtools;
  const diagnose = async (label) => {
    const d = await webviewDiagnostics({
      out,
      label,
      ports,
      appPid: app?.pid ?? null,
      identifier: appIdentifier(),
      exeName: path.basename(opts.exe ?? ""),
    });
    devtools[label] = { verdict: d.verdict, lines: d.lines, mechanism: d.mechanism };
    for (const l of d.lines) console.log(`devtools (${label}): ${l}`);
    sections.push({ title: `WebView2 DevTools diagnostics (${label})`, lines: d.lines });
    return d;
  };

  try {
    link = await startLinkServer();
    if (shellMode) {
      // 1-2. The stand-in model in the installed runtime, then the app as a person starts it.
      if (existsSync(path.join(home, "runtime", "daemon.json")))
        throw new Error(`${home} was used before: give a fresh data folder`);
      mkdirSync(home, { recursive: true });
      const runtimeDir = path.resolve(
        opts.runtimeDir ?? path.join(path.dirname(opts.exe), "runtime"),
      );
      result.standIn = installStandIn(REPO, runtimeDir);
      console.log(`stand-in model copied into ${runtimeDir}: ${result.standIn.join(", ")}`);
      // Two DevTools ports, one per way of asking (windowEnv), each checked free first.
      const shellPort = await freePort(opts.cdpPort);
      const envPort = await freePort(opts.cdpPort + 1, { avoid: [shellPort.port] });
      ports = { shell: shellPort.port, env: envPort.port };
      devtools.ports = ports;
      devtools.portNotes = [shellPort.note, envPort.note].filter(Boolean);
      for (const n of devtools.portNotes) console.log(`devtools: ${n}`);
      app = spawn(opts.exe, [], {
        env: windowEnv(process.env, { home, shellPort: ports.shell, envPort: ports.env }),
        stdio: "ignore",
        windowsHide: false,
      });
      result.appPid = app.pid;
      app.on("exit", (code) => console.log(`the app exited (code ${code})`));
    }

    // 3. The daemon and the window's page.
    daemon = await until("the daemon to answer /health", left(300_000), 1_000, async () => {
      if (app && app.exitCode !== null)
        throw new Stop(`the app exited with ${app.exitCode} before its daemon answered`);
      const d = readDaemonFile(home);
      return d && (await healthy(d)) ? d : null;
    }).catch((e) => e);
    if (daemon instanceof Error) {
      check("the app starts its daemon", false, daemon.message);
      throw new Stop("no daemon");
    }
    check("the app starts its daemon", true, daemon.url);
    const api = apiFor(daemon);
    if (shellMode) {
      const said = existsSync(daemonLog) ? readFileSync(daemonLog, "utf8") : "";
      check(
        "the shell started it on the stand-in model (FORERUNNER_DAEMON_PROVIDER)",
        said.includes('the daemon runs on the stand-in model "bench"'),
        said
          .split(/\r?\n/)
          .filter((l) => l.startsWith("[shell]"))
          .slice(-3)
          .join(" | "),
      );
      // The shell's own DevTools switch (devtools.rs), in its log since its start.
      const switched = parseShellDevtools(logSince(shellLog, 0));
      check(
        `the shell turned its windows' DevTools on (${DEVTOOLS_PORT_ENV})`,
        !!switched && "port" in switched && switched.port === ports.shell,
        !switched
          ? `no line about ${DEVTOOLS_PORT_ENV} in ${shellLog}`
          : "port" in switched
            ? `port ${switched.port}: ${switched.args}`
            : switched.refused,
      );
    }
    // The window's page: on either DevTools port with --exe (the one that answers says which
    // way worked), on the given endpoint with --attach.
    const candidates = shellMode
      ? [
          { base: `http://127.0.0.1:${ports.shell}`, via: "shell" },
          { base: `http://127.0.0.1:${ports.env}`, via: "env" },
        ]
      : [{ base: opts.attach, via: "attach" }];
    let seen = [];
    const findPage = async (list) => {
      seen = await Promise.all(
        list.map(async (c) => {
          try {
            return { ...c, targets: await listTargets(c.base, { timeoutMs: 5_000 }) };
          } catch (e) {
            return { ...c, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      for (const s of seen) {
        const t = s.targets?.find((x) => x.type === "page" && isAppUrl(x.url, origins));
        if (t) return { base: s.base, via: s.via, target: t };
      }
      return null;
    };
    let found = await until(
      "the window's page on the DevTools endpoint",
      left(180_000),
      1_000,
      () => findPage(candidates),
    ).catch((e) => e);
    const answeredLast = endpointWords(seen);
    let unreachable = found instanceof Error ? `${found.message}: ${answeredLast}` : "";
    if (found instanceof Error && shellMode) {
      // Before giving up: what a plain connection meets, then what WebView2 did with the switch
      // (Windows), and DevTools wherever the diagnostics found it listening.
      const probes = await Promise.all(
        candidates.map(
          async (c) => `${c.base} ${await tcpProbe("127.0.0.1", Number(new URL(c.base).port))}`,
        ),
      );
      devtools.probes = probes;
      console.log(`devtools: ${probes.join("; ")}`);
      const d = await diagnose("unreachable").catch((e) => ({
        verdict: `diagnostics failed: ${e?.message ?? e}`,
        fallbacks: [],
      }));
      const elsewhere = d.fallbacks.filter((b) => !candidates.some((c) => c.base === b));
      if (elsewhere.length) {
        const again = await findPage(elsewhere.map((base) => ({ base, via: "elsewhere" })));
        if (again) found = again;
      }
      // The original failure first, then the verdict (the summary line is cut at 600
      // characters; every diagnostics line is in the summary's own section too).
      if (found instanceof Error)
        unreachable = `${found.message} | ${d.verdict} | ${probes.join("; ")} | ${answeredLast}`;
    }
    must(
      "the window's page is reachable over DevTools",
      !(found instanceof Error),
      found instanceof Error
        ? unreachable
        : `${found.target.url} at ${found.base}${!shellMode ? "" : found.via === "elsewhere" ? ", a port neither way asked for (found by the diagnostics)" : `, the port asked for by ${viaWords(found.via)}`}`,
    );
    const { target, base: cdpBase } = found;
    if (shellMode) {
      devtools.answeredAt = { base: cdpBase, via: found.via };
      const d = await diagnose("attached").catch((e) => ({
        verdict: `diagnostics failed: ${e?.message ?? e}`,
        mechanism: null,
      }));
      check(
        "which way the DevTools switch reached WebView2",
        !!d.mechanism,
        `DevTools answered at ${cdpBase} (${viaWords(found.via)}); msedgewebview2.exe's command line: ${d.mechanism ? d.mechanism.words : d.verdict}`,
        { required: false },
      );
    }
    const connected = await connectPage(cdpBase, {
      prefer: (t) => t.id === target.id,
      timeoutMs: 30_000,
      waitForTargetMs: 10_000,
    });
    client = connected.client;
    const page = connected.page;
    client.onEvent(({ method, params }) => {
      if (method === "Runtime.exceptionThrown")
        pageErrors.push(
          String(
            params?.exceptionDetails?.exception?.description ??
              params?.exceptionDetails?.text ??
              "exception",
          ).split("\n")[0],
        );
    });
    await forwardPageConsole(client, { timeoutMs: 10_000 });
    await client.send("Page.bringToFront", {}).catch(() => undefined);

    let shotNo = 0;
    shot = async (label) => {
      shotNo += 1;
      const name = `${String(shotNo).padStart(2, "0")}-${slug(label)}`;
      try {
        await sleep(400);
        const r = await client.send(
          "Page.captureScreenshot",
          { format: "png" },
          { timeoutMs: 30_000 },
        );
        writeFileSync(path.join(out, `${name}.png`), Buffer.from(String(r.data), "base64"));
      } catch (e) {
        console.log(`screenshot ${name} failed: ${e.message}`);
      }
      const text = await describePage(page).catch((e) => `(page text unavailable: ${e.message})`);
      writeFileSync(path.join(out, `${name}.txt`), `${text}\n`);
      return text;
    };
    const bodyText = async () =>
      String(await page.evaluate("document.body ? document.body.innerText : ''"));
    const waitText = (what, re, ms) =>
      until(what, ms, 500, async () => (re.test(await bodyText()) ? true : null));

    // Setup: skipped the way a person in a hurry does.
    await waitText("the first screen", /\S/, 60_000);
    await shot("first screen");
    if (/Set up Forerunner/.test(await bodyText())) {
      await page.getByRole("button", { name: "Set up later", exact: true }).first().click();
      await sleep(1_000);
      check(
        "the setup assistant can be left for later",
        !/Set up Forerunner/.test(await bodyText()),
      );
    } else check("the setup assistant can be left for later", true, "not shown");
    await shot("home");

    // New project with a one-line brief.
    const projectName = `${opts.project} ${new Date().toISOString().slice(11, 19)}`;
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.locator('input[name="name"]').fill(projectName);
    await page.locator('textarea[name="brief"]').fill(opts.brief);
    await shot("new project dialog");
    await page.getByTestId("create-project").click();
    const projectId = await until("the project page", 30_000, 500, async () => {
      const m = /\/projects\/([^/?#]+)/.exec(await page.url());
      return m ? decodeURIComponent(m[1]) : null;
    }).catch(() => null);
    must("New project with a one-line brief opens the project", !!projectId, await page.url());
    result.projectId = projectId;
    await shot("project created");

    // The plan card.
    const intake = await until("the plan", left(300_000), 2_000, async () => {
      const s = await api("GET", `/projects/${encodeURIComponent(projectId)}/intake`);
      return s.state === "pending" || s.state === "failed" ? s : null;
    }).catch((e) => ({ state: "timeout", error: e.message }));
    must(
      "planning ends in a plan",
      intake.state === "pending",
      `${intake.state}${intake.error ? `: ${intake.error}` : ""}`,
    );
    await page.getByRole("link", { name: "Inbox" }).first().click();
    const card = page
      .getByTestId("request")
      .filter({ has: page.getByText(`Plan for "${projectName}"`) });
    await card.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const cards = await card.count();
    const tasksOnCard = cards === 1 ? await card.getByTestId("intake-task").count() : 0;
    await shot("inbox plan card");
    must(
      "the Inbox shows the plan card with its tasks",
      cards === 1 && tasksOnCard > 0,
      `${cards} card(s), ${tasksOnCard} task line(s)`,
    );

    // Approve and start: the session runs to its end.
    await card.getByRole("button", { name: "Approve and start", exact: true }).click();
    const approved = await waitText(
      "the approval's words",
      /Plan approved: \d+ tasks? written/,
      30_000,
    )
      .then(() => true)
      .catch(() => false);
    await shot("approved");
    check("Approve and start says the plan was written and work started", approved);
    const session = await until("the session Approve and start began", 60_000, 1_000, async () => {
      const list = await api("GET", `/sessions?projectId=${encodeURIComponent(projectId)}`);
      return (Array.isArray(list) ? list : []).find((s) => s.projectId === projectId) ?? null;
    }).catch(() => null);
    must("a session starts", !!session, session ? session.id : "none in 60 s");
    // Home, then the project's card, as a person goes back to it.
    await page.getByRole("link", { name: "Home", exact: true }).first().click();
    await page
      .getByTestId("project-card")
      .filter({ has: page.getByText(projectName, { exact: true }) })
      .getByTestId("open-project")
      .click();
    await shot("project while the session runs");
    const ended = await until("the session to end", left(900_000), 2_000, async () => {
      const s = await api("GET", `/sessions/${encodeURIComponent(session.id)}`);
      return ["completed", "stopped", "failed", "killed"].includes(s.status) ? s : null;
    }).catch((e) => ({ status: "timeout", summary: e.message }));
    check(
      "the session ends",
      ended.status === "completed",
      `${ended.status}: ${ended.summary ?? ""}`,
    );
    const tasks = await api("GET", `/projects/${encodeURIComponent(projectId)}/tasks`);
    const done = tasks.filter((t) => t.status === "done");
    check(
      "every planned task is done",
      tasks.length > 0 && done.length === tasks.length,
      tasks.map((t) => `${t.title}: ${t.status}`).join("; "),
    );
    await page.getByTestId("tab-summary").click();
    await sleep(1_500);
    await shot("overview after the session");
    await page.getByTestId("tab-tasks").click();
    await sleep(1_500);
    await shot("tasks tab");
    const tasksText = await bodyText();
    check(
      "the Tasks tab shows the finished tasks",
      done.length > 0 && done.every((t) => tasksText.includes(t.title)),
      `${done.length} done`,
    );

    // 4. The shell's hand-offs.
    const handoffSince = async (offset, pick, ms = 15_000) =>
      until(
        "the shell's hand-off line",
        ms,
        500,
        async () => parseHandoffs(logSince(shellLog, offset)).find(pick) ?? null,
      ).catch(() => null);
    // In a browser (--attach) a link opens a new tab, which puts this page in the background,
    // where it stops painting; the shell opens none.
    const backToPage = async () => {
      if (!shellMode) await client.send("Page.bringToFront", {}).catch(() => undefined);
    };
    const stays = async (before, label) => {
      await sleep(1_500);
      const after = await page.url();
      const ok = isAppUrl(after, origins) && after === before;
      check(
        `the window stays on the app's page after ${label}`,
        ok,
        ok ? after : `before ${before}, after ${after}`,
      );
    };

    // The PR link on the Tasks tab (the owner's complaint 1).
    const prTask = done[0] ?? tasks[0];
    const prUrl = `${link.base}/acme/window-check/pull/1`;
    await seedPrUrl(
      path.join(home, "data", "state.sqlite"),
      prTask.id,
      prUrl,
      new Date().toISOString(),
    );
    await page.getByTestId("tab-summary").click();
    await sleep(800);
    await page.getByTestId("tab-tasks").click();
    const prLink = page.getByTestId("pr-link");
    await prLink.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const prShown = (await prLink.count()) === 1;
    must("the Tasks tab shows the task's PR link", prShown, `${await prLink.count()} PR link(s)`);
    await shot("tasks tab with a PR");
    const beforePr = await page.url();
    let offset = logSize(shellLog);
    await prLink.click();
    await backToPage();
    if (shellMode) {
      const h = await handoffSince(offset, (x) => x.kind === "browser" && x.target === prUrl);
      check(
        "clicking PR hands the pull request to the system browser",
        !!h,
        h ? `${h.via}: ${h.target}` : shellSaid(shellLog, offset),
      );
      await stays(beforePr, "the PR click");
      const fetched = await until("the browser to fetch the PR page", 20_000, 500, async () =>
        link.hits.some((x) => x.path === "/acme/window-check/pull/1"),
      ).catch(() => false);
      check(
        "the system browser opened the PR page",
        fetched,
        fetched
          ? "the page was fetched"
          : "no request reached the page (a browser's first run may not load it)",
        { required: false },
      );
    } else skip("clicking PR hands the pull request to the system browser", "no shell (--attach)");
    await shot("after the PR click");

    // A link that asks for a new window (target="_blank", window.open): the new-window path.
    const newWindowUrl = `${link.base}/window-check/new-window`;
    await page.evaluate(injectLinkScript("fr-check-new-window", newWindowUrl, "_blank"));
    offset = logSize(shellLog);
    const beforeNew = await page.url();
    await page.getByTestId("fr-check-new-window").click();
    await backToPage();
    if (shellMode) {
      const h = await handoffSince(
        offset,
        (x) => x.kind === "browser" && x.target === newWindowUrl,
      );
      check(
        'a target="_blank" link goes to the system browser (new window)',
        !!h && h.via === "new window",
        h ? `${h.via}: ${h.target}` : shellSaid(shellLog, offset),
      );
      await stays(beforeNew, "a new-window link");
    } else
      skip('a target="_blank" link goes to the system browser (new window)', "no shell (--attach)");

    // A file: link opens nothing, in no program.
    await page.evaluate(injectLinkScript("fr-check-file", "file:///C:/Windows/win.ini", ""));
    offset = logSize(shellLog);
    const beforeFile = await page.url();
    await page.getByTestId("fr-check-file").click();
    await backToPage();
    await sleep(3_000);
    if (shellMode) {
      const seen = parseHandoffs(logSince(shellLog, offset));
      check(
        "a file: link is handed to no program",
        !seen.some((x) => x.kind !== "refused"),
        seen
          .map((x) => (x.kind === "refused" ? `refused ${x.scheme}` : `${x.kind}: ${x.target}`))
          .join("; ") ||
          "nothing handed off, and no refusal logged (the webview may stop a file: link before the shell sees it)",
      );
      await stays(beforeFile, "a file: link");
    } else skip("a file: link is handed to no program", "no shell (--attach)");
    await page.evaluate(
      "(() => { for (const id of ['fr-check-new-window', 'fr-check-file']) document.getElementById(id)?.remove(); return true; })()",
    );

    // Open folder on the Overview.
    await page.getByTestId("tab-summary").click();
    const folderPath = page.getByTestId("folder-path");
    await folderPath.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const shownFolder =
      (await folderPath.count()) === 1 ? (await folderPath.innerText()).trim() : "";
    check(
      "the Overview shows the project's folder",
      !!shownFolder,
      shownFolder || "no folder on the Overview",
    );
    if (shellMode) {
      const open = page.getByTestId("folder-open");
      const hasOpen = (await open.count()) === 1;
      must("Open folder is on the Overview", hasOpen, hasOpen ? "" : "no Open folder button");
      offset = logSize(shellLog);
      const beforeFolder = await page.url();
      await open.click();
      const h = await handoffSince(offset, (x) => x.kind === "folder");
      check(
        "Open folder hands the project's folder to the file manager",
        !!h && sameFolder(h.target, shownFolder),
        h ? `${h.target} (shown: ${shownFolder})` : shellSaid(shellLog, offset),
      );
      const note = page.getByTestId("folder-note");
      const noteText = (await note.count()) === 1 ? await note.innerText() : "";
      check("Open folder shows no error", !/did not open/i.test(noteText), noteText || "no note");
      await stays(beforeFolder, "Open folder");
    } else
      skip(
        "Open folder hands the project's folder to the file manager",
        "no shell (--attach): a browser has no Open folder",
      );
    await shot("overview after open folder");

    // Settings → Sandbox: the "Get Docker Desktop" link, a link the app itself names.
    await page.getByRole("link", { name: "Settings", exact: true }).first().click();
    const dockerLink = page.getByTestId("sandbox-docker-link");
    await dockerLink.waitFor({ timeout: 30_000 }).catch(() => undefined);
    const sandboxState = await api("GET", "/sandbox")
      .then((s) => s.state)
      .catch(() => "?");
    if ((await dockerLink.count()) === 1) {
      await shot("settings sandbox");
      offset = logSize(shellLog);
      const beforeDocker = await page.url();
      await dockerLink.click();
      await backToPage();
      if (shellMode) {
        const h = await handoffSince(
          offset,
          (x) => x.kind === "browser" && x.target === DOCKER_DESKTOP_URL,
        );
        check(
          '"Get Docker Desktop" hands docker.com to the system browser',
          !!h,
          h ? `${h.via}: ${h.target}` : shellSaid(shellLog, offset),
        );
        await stays(beforeDocker, "Get Docker Desktop");
      } else
        skip('"Get Docker Desktop" hands docker.com to the system browser', "no shell (--attach)");
    } else {
      await shot("settings without the docker link");
      check(
        '"Get Docker Desktop" hands docker.com to the system browser',
        false,
        `no link on Settings → Sandbox (sandbox state ${sandboxState}; it shows only while Docker is not installed)`,
        { required: sandboxState === "not_installed" },
      );
    }
    await shot("end");
    check(
      "the page threw no uncaught error",
      pageErrors.length === 0,
      pageErrors.slice(0, 5).join(" | ") || "none",
      { required: false },
    );
  } catch (e) {
    if (!(e instanceof Stop))
      check(
        "the check ran to its end",
        false,
        e instanceof Error ? (e.stack ?? e.message) : String(e),
      );
    // What the window's page showed at the stop, and on the runner the whole screen too (a
    // dialog of the shell's, a window that never came, are outside the page).
    const label = `stopped: ${e instanceof Stop ? e.message : "an error"}`;
    if (shot) await shot(label).catch((err) => console.log(`no screenshot at the stop: ${err}`));
    if (shellMode) console.log(desktopScreenshot(path.join(out, `99-${slug(label)}-desktop.png`)));
  } finally {
    try {
      client?.close();
    } catch {
      // closed
    }
    if (shellMode) await stopApp(app, daemon);
    await link?.close();
    if (link) result.linkPageRequests = link.hits;
    for (const [from, to] of [
      [shellLog, "desktop-shell.log"],
      [daemonLog, "daemon-shell.log"],
      [path.join(home, "bench", "model-calls.jsonl"), "model-calls.jsonl"],
    ])
      if (existsSync(from)) copyFileSync(from, path.join(out, to));
  }
  result.endedAt = new Date().toISOString();
  writeFileSync(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const title = shellMode
    ? "Desktop window check (installed app, Windows)"
    : "Desktop window check (attached page, no shell)";
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(title, checks, sections));
  const failed = checks.filter((c) => !c.ok && !c.skipped && c.required !== false);
  console.log(
    `${failed.length ? `${failed.length} required check(s) failed` : "every required check passed"}; screenshots, logs and result.json in ${out}`,
  );
  process.exitCode = failed.length ? 1 : 0;
}

/** An extra link at the window's bottom left (the page itself has none of these kinds). */
function injectLinkScript(id, href, target) {
  return `(() => {
    for (const old of document.querySelectorAll("[data-testid=" + ${JSON.stringify(JSON.stringify(id))} + "]")) old.remove();
    const a = document.createElement("a");
    a.id = ${JSON.stringify(id)};
    a.setAttribute("data-testid", ${JSON.stringify(id)});
    a.href = ${JSON.stringify(href)};
    ${target ? `a.target = ${JSON.stringify(target)}; a.rel = "noreferrer";` : ""}
    a.textContent = "window check: " + ${JSON.stringify(id)};
    Object.assign(a.style, { position: "fixed", left: "16px", bottom: "16px", zIndex: "2147483647", background: "#ffeb3b", color: "#000", padding: "8px 12px", font: "16px sans-serif" });
    document.body.appendChild(a);
    return true;
  })()`;
}

/** Quit as the tray's Quit does (POST /shutdown), then end the app's process tree. */
async function stopApp(app, daemon) {
  if (daemon) {
    try {
      await fetch(`${daemon.url}/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      await until(
        "the daemon to stop",
        15_000,
        500,
        async () => !(await healthy(daemon).catch(() => false)),
      );
    } catch (e) {
      console.log(`the daemon did not stop by itself: ${e.message}`);
    }
  }
  if (app && app.exitCode === null && app.pid) {
    if (process.platform === "win32")
      spawnSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    else app.kill();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
