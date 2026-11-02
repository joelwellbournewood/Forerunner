import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  APP_ORIGINS,
  appIdentifier,
  asArray,
  collectWebviewDiagnostics,
  DEVTOOLS_PORT_ENV,
  DOCKER_DESKTOP_URL,
  desktopScreenshot,
  devtoolsVerdict,
  diagnoseWebview,
  diagnosisLines,
  encodePowerShell,
  endpointWords,
  fallbackEndpoints,
  freePort,
  installStandIn,
  isAppUrl,
  parseArgs,
  parseExcludedPortRanges,
  parseHandoffs,
  parseShellDevtools,
  parseSwitches,
  powerShellReport,
  powerShellWords,
  REPO,
  runCaptured,
  sameFolder,
  seedPrUrl,
  startLinkServer,
  summaryMarkdown,
  switchMechanism,
  tcpProbe,
  userDataClues,
  viaWords,
  WEBVIEW_DIAG_PS,
  WEBVIEW2_DISABLED_FEATURES,
  WRY_AUTOPLAY_POLICY,
  windowEnv,
  // @ts-expect-error plain JS module
} from "./desktop-window-check.mjs";

/**
 * The pure parts of the desktop window check (scripts/desktop-window-check.mjs, phase F2): the
 * app's environment, the stand-in model's copy into an installed runtime, the shell's log lines
 * it reads back, and the PR link it writes into the store. The check itself runs only on a
 * Windows runner with the installed MSI (desktop.yml, job "window").
 */
const temps: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fr-window-check-"));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const shellSource = (file: string) =>
  readFileSync(join(REPO, "apps", "desktop", "src-tauri", "src", file), "utf8");

describe("the window check's job (desktop.yml)", () => {
  it("installs the MSI the build job uploads and runs this script on it", () => {
    const yml = readFileSync(join(REPO, ".github", "workflows", "desktop.yml"), "utf8");
    const job = yml.slice(yml.indexOf("\n  window:"));
    expect(job).toContain("needs: build");
    expect(job).toContain("runs-on: windows-latest");
    // The build job uploads `desktop-${{ matrix.os }}`; the window job downloads Windows's.
    expect(yml).toContain(["name: desktop-$", "{{ matrix.os }}"].join(""));
    expect(job).toContain("name: desktop-windows-latest");
    expect(job).toContain("node scripts/desktop-window-check.mjs --exe");
    // A change to the script or to the stand-in it copies runs the workflow.
    expect(yml).toContain('"scripts/desktop-window-check.*"');
    expect(yml).toContain('"testenv/src/bench/**"');
  });
});

describe("the window check's options", () => {
  it("needs the installed app or a page to attach to, a data folder and an output folder", () => {
    const o = parseArgs([
      "--exe",
      "C:\\Program Files\\Forerunner\\f.exe",
      "--home",
      "h",
      "--out",
      "o",
    ]);
    expect(o).toMatchObject({
      exe: "C:\\Program Files\\Forerunner\\f.exe",
      attach: null,
      home: "h",
      out: "o",
      cdpPort: 9333,
      timeoutMin: 20,
    });
    expect(parseArgs(["--attach", "http://127.0.0.1:9", "--home", "h", "--out", "o"]).attach).toBe(
      "http://127.0.0.1:9",
    );
    expect(() => parseArgs(["--home", "h", "--out", "o"])).toThrow(/either --exe/);
    expect(() => parseArgs(["--exe", "a", "--attach", "b", "--home", "h", "--out", "o"])).toThrow(
      /either --exe/,
    );
    expect(() => parseArgs(["--exe", "a", "--out", "o"])).toThrow(/--home/);
    expect(() => parseArgs(["--exe", "a", "--home", "h"])).toThrow(/--out/);
    expect(() => parseArgs(["--exe", "a", "--home", "h", "--out", "o", "--cdp-port", "x"])).toThrow(
      /whole number/,
    );
    expect(() => parseArgs(["--exe", "a", "--home", "h", "--out", "o", "--fast"])).toThrow(
      /unknown argument --fast/,
    );
  });
});

describe("the installed app's environment", () => {
  it("names the stand-in model, DevTools both ways on two ports and a fresh data folder, and passes no credential", () => {
    const env = windowEnv(
      {
        PATH: "C:\\Windows",
        ANTHROPIC_API_KEY: "sk-ant-not-passed",
        GITHUB_TOKEN: "ghs_not_passed",
        FORERUNNER_HOME: "C:\\elsewhere",
        FORERUNNER_RUNNER_IMAGE: "x",
        FORERUNNER_WEBVIEW_DEVTOOLS_PORT: "1",
      },
      { home: "D:\\fr window\\Zürich home", shellPort: 9444, envPort: 9445 },
    );
    expect(env).toEqual({
      PATH: "C:\\Windows",
      FORERUNNER_HOME: "D:\\fr window\\Zürich home",
      FORERUNNER_DAEMON_PROVIDER: "bench",
      FORERUNNER_VAULT_BACKEND: "file",
      FORERUNNER_SANDBOX_ENGINE: "podman",
      FORERUNNER_BENCH_DELAY_MS: "100",
      // The shell's own switch (devtools.rs) on one port ...
      FORERUNNER_WEBVIEW_DEVTOOLS_PORT: "9444",
      // ... and WebView2's variable on the next, so the port that answers says which worked.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
        "--remote-debugging-port=9445 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --enable-logging",
    });
    // wry's own list (the variable may replace the app's arguments) plus occlusion tracking,
    // which could stop painting the window once the system browser covers it.
    expect(WEBVIEW2_DISABLED_FEATURES).toEqual([
      "msWebOOUI",
      "msPdfOOUI",
      "msSmartScreenProtection",
      "CalculateNativeWinOcclusion",
    ]);
    // ... and the rest of wry's default, so a spoken alert plays without a click as it does in
    // the shipped app, whichever way's arguments the window got.
    expect(WRY_AUTOPLAY_POLICY).toBe("--autoplay-policy=no-user-gesture-required");
  });

  it("uses the variable and the provider name the shell forwards (supervisor.rs)", () => {
    const rust = shellSource("supervisor.rs");
    expect(rust).toContain('pub const DAEMON_PROVIDER_ENV: &str = "FORERUNNER_DAEMON_PROVIDER";');
    expect(rust).toMatch(/pub const DAEMON_PROVIDERS: \[&str; \d\] = \[[^\]]*"bench"/);
  });

  it("uses the shell's DevTools variable, and the shell repeats the same wry default (devtools.rs)", () => {
    const rust = shellSource("devtools.rs");
    expect(rust).toContain(`pub const DEVTOOLS_PORT_ENV: &str = "${DEVTOOLS_PORT_ENV}";`);
    expect(rust).toContain(`pub const WRY_AUTOPLAY_POLICY: &str = "${WRY_AUTOPLAY_POLICY}";`);
    const list = (name: string) =>
      [
        ...(
          new RegExp(`pub const ${name}: \\[&str; \\d\\] = \\[([^\\]]*)\\]`).exec(rust)?.[1] ?? ""
        ).matchAll(/"([^"]+)"/g),
      ].map((m) => m[1]);
    // wry's own list, then occlusion tracking: the variable's list, in the same order.
    expect([...list("WRY_DISABLED_FEATURES"), ...list("DRIVEN_WINDOW_DISABLED_FEATURES")]).toEqual([
      ...WEBVIEW2_DISABLED_FEATURES,
    ]);
    // The check's --cdp-port stays inside what the shell accepts, the next port too.
    expect(() =>
      parseArgs(["--exe", "a", "--home", "h", "--out", "o", "--cdp-port", "1023"]),
    ).toThrow(/1024 to 65534/);
    expect(() =>
      parseArgs(["--exe", "a", "--home", "h", "--out", "o", "--cdp-port", "65535"]),
    ).toThrow(/1024 to 65534/);
    expect(
      parseArgs(["--exe", "a", "--home", "h", "--out", "o", "--cdp-port", "65534"]).cdpPort,
    ).toBe(65534);
  });

  it("reads the shell's words about the switch as tauri-plugin-log writes them", () => {
    const rust = shellSource("devtools.rs");
    expect(rust).toContain('pub const DEVTOOLS_ON: &str = "WebView2 DevTools on port";');
    const log = [
      "[2026-11-02][10:13:00][forerunner_desktop_lib][INFO] Forerunner desktop shell 1.0.4 on windows",
      "[2026-11-02][10:13:00][forerunner_desktop_lib][WARN] WebView2 DevTools on port 9333 for every window (FORERUNNER_WEBVIEW_DEVTOOLS_PORT, development and CI only): --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --remote-debugging-port=9333",
    ].join("\r\n");
    expect(parseShellDevtools(log)).toEqual({
      port: 9333,
      args: "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --remote-debugging-port=9333",
    });
    expect(
      parseShellDevtools(
        '[2026-11-02][10:13:00][forerunner_desktop_lib][WARN] FORERUNNER_WEBVIEW_DEVTOOLS_PORT="80" ignored: it may only name a port from 1024 to 65535; the windows open without DevTools',
      ),
    ).toEqual({
      refused:
        'FORERUNNER_WEBVIEW_DEVTOOLS_PORT="80" ignored: it may only name a port from 1024 to 65535; the windows open without DevTools',
    });
    expect(parseShellDevtools("[x][INFO] nothing about it")).toBeNull();
  });

  it("reads the identifier WebView2's data folder is named after", () => {
    const conf = JSON.parse(
      readFileSync(join(REPO, "apps", "desktop", "src-tauri", "tauri.conf.json"), "utf8"),
    );
    expect(appIdentifier()).toBe(conf.identifier);
    expect(appIdentifier()).toBe("app.forerunner.desktop");
  });
});

describe("the DevTools ports", () => {
  it("keeps the preferred port when it can be bound, and moves away from one that cannot", async () => {
    const probe = await freePort(0);
    const preferred = probe.port;
    expect(await freePort(preferred)).toEqual({ port: preferred, note: null });
    const holder = createNetServer();
    await new Promise<void>((resolve) => holder.listen(preferred, "127.0.0.1", () => resolve()));
    try {
      const moved = await freePort(preferred);
      expect(moved.port).not.toBe(preferred);
      expect(moved.port).toBeGreaterThanOrEqual(1024);
      expect(moved.note).toMatch(
        new RegExp(`^port ${preferred} could not be used \\(EADDRINUSE\\); ${moved.port} instead$`),
      );
      // A port the other switch has is never handed out twice.
      const other = await freePort(moved.port, { avoid: [moved.port] });
      expect(other.port).not.toBe(moved.port);
      expect(other.note).toContain("the other switch has it");
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it("says what a plain connection meets: accepted or refused", async () => {
    const server = createNetServer((s) => s.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    expect(await tcpProbe("127.0.0.1", port)).toBe("a connection was accepted");
    await new Promise((resolve) => server.close(resolve));
    expect(await tcpProbe("127.0.0.1", port)).toBe("refused (ECONNREFUSED)");
  });

  it("names what each endpoint answered on the last try", () => {
    expect(
      endpointWords([
        { base: "http://127.0.0.1:9333", error: "GET http://127.0.0.1:9333/json: fetch failed" },
        {
          base: "http://127.0.0.1:9334",
          targets: [{ type: "page", url: "http://frshell.localhost/splash" }],
        },
        { base: "http://127.0.0.1:9335", targets: [] },
      ]),
    ).toBe(
      "http://127.0.0.1:9333: GET http://127.0.0.1:9333/json: fetch failed; http://127.0.0.1:9334 answered with 1 target(s): page http://frshell.localhost/splash; http://127.0.0.1:9335 answered with 0 target(s)",
    );
    expect(viaWords("shell")).toBe("the shell's switch (FORERUNNER_WEBVIEW_DEVTOOLS_PORT)");
    expect(viaWords("env")).toBe("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
  });
});

/** A WebView2 browser process's command line as Win32_Process reports it on the runner. */
const EXE = String.raw`"C:\Program Files (x86)\Microsoft\EdgeWebView\Application\142.0.3595.65\msedgewebview2.exe"`;
const UDD = String.raw`C:\Users\runneradmin\AppData\Local\app.forerunner.desktop\EBWebView`;
const browserLine = (args: string) =>
  `${EXE} --embedded-browser-webview=1 --webview-exe-name=Forerunner.exe --webview-exe-version=1.0.4 --user-data-dir="${UDD}" --noerrdialogs --embedded-browser-webview-dpi-awareness=2 ${args} --lang=en-US --mojo-named-platform-channel-pipe=3272.8840.1517262455`;
const APP_ARGS =
  "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --remote-debugging-port=9333";
const ENV_ARGS =
  "--remote-debugging-port=9334 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --enable-logging";
const PORTS = { shell: 9333, env: 9334 };
const CTX = {
  ports: PORTS,
  appPid: 3272,
  identifier: "app.forerunner.desktop",
  exeName: "Forerunner.exe",
};
function raw(args: string, extra: Record<string, unknown> = {}) {
  return {
    processes: [
      { pid: 5100, parent: 3272, path: EXE.slice(1, -1), commandLine: browserLine(args) },
      {
        pid: 5120,
        parent: 5100,
        path: EXE.slice(1, -1),
        commandLine: `${EXE} --type=renderer --noerrdialogs --user-data-dir="${UDD}" --webview-exe-name=Forerunner.exe --lang=en-US`,
      },
    ],
    listening: [],
    onPorts: [],
    policies: [],
    runtime: [
      {
        source:
          "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
        version: "142.0.3595.65",
      },
    ],
    excludedPorts: [
      "",
      "Protocol tcp Port Exclusion Ranges",
      "",
      "Start Port    End Port",
      "----------    --------",
      "      5357        5357",
      "     50000       50059     *",
      "",
      "* - Administered port exclusions.",
    ],
    ...extra,
  };
}

describe("what WebView2 did with the DevTools switch (Windows diagnostics)", () => {
  it("reads a Chromium command line's switches, quoted values and all", () => {
    expect(parseSwitches(browserLine(`${APP_ARGS} ${ENV_ARGS}`))).toEqual(
      expect.arrayContaining([
        { name: "user-data-dir", value: UDD },
        { name: "webview-exe-name", value: "Forerunner.exe" },
        { name: "remote-debugging-port", value: "9333" },
        { name: "remote-debugging-port", value: "9334" },
        { name: "enable-logging", value: null },
      ]),
    );
    // The exe's own path (spaces, no switch) is no switch.
    expect(parseSwitches(EXE)).toEqual([]);
    expect(parseSwitches("")).toEqual([]);
    expect(parseSwitches('a --X-Y="b c" --z=')).toEqual([
      { name: "x-y", value: "b c" },
      { name: "z", value: "" },
    ]);
  });

  it("tells which way the switch came from the ports on the command line", () => {
    expect(switchMechanism([9333, 9334], PORTS)).toMatchObject({ via: "both", effective: 9334 });
    expect(switchMechanism([9333], PORTS)).toMatchObject({ via: "shell", effective: 9333 });
    expect(switchMechanism([9334], PORTS)).toMatchObject({ via: "env", effective: 9334 });
    expect(switchMechanism([9222], PORTS)).toMatchObject({ via: "other", effective: 9222 });
    expect(switchMechanism([], PORTS)).toMatchObject({ via: "none", effective: null });
    expect(switchMechanism([9333], PORTS).words).toContain(
      "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS (port 9334) is not on it",
    );
  });

  it("reads a list in each form Windows PowerShell's ConvertTo-Json writes one", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]);
    expect(asArray(null)).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
    expect(asArray({ value: ["a", "b"], Count: 2 })).toEqual(["a", "b"]);
    const d = diagnoseWebview(
      {
        processes: { value: raw(APP_ARGS).processes, Count: 2 },
        excludedPorts: { value: ["      9333        9333"], Count: 1 },
      },
      CTX,
    );
    expect(d.ours).toHaveLength(1);
    expect(d.excluded).toEqual([{ port: 9333, range: { start: 9333, end: 9333 } }]);
  });

  it("reads the ranges Windows keeps from programs (netsh)", () => {
    expect(parseExcludedPortRanges(raw("").excludedPorts as string[])).toEqual([
      { start: 5357, end: 5357 },
      { start: 50000, end: 50059 },
    ]);
    expect(parseExcludedPortRanges("")).toEqual([]);
  });

  it("the switch never reached msedgewebview2.exe", () => {
    const d = diagnoseWebview(
      raw(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required",
      ),
      CTX,
    );
    expect(d.processCount).toBe(2);
    expect(d.browsers).toHaveLength(1);
    expect(d.ours.map((b: { pid: number }) => b.pid)).toEqual([5100]);
    expect(d.ours[0].userDataDir).toBe(UDD);
    // wry's default only (its autoplay policy too, which both ways repeat and so cannot tell
    // them apart): both ways' arguments were dropped whole.
    expect(devtoolsVerdict(d)).toBe(
      "the switch never reached msedgewebview2.exe: neither FORERUNNER_WEBVIEW_DEVTOOLS_PORT (the shell's) nor WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is on its command line; nor did the rest of either way's arguments (--enable-logging, CalculateNativeWinOcclusion), so they were dropped whole",
    );
    // The rest arrived without the port: the port switch alone was removed.
    const stripped = diagnoseWebview(
      raw(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --autoplay-policy=no-user-gesture-required --enable-logging",
      ),
      CTX,
    );
    expect(devtoolsVerdict(stripped)).toContain(
      "is on its command line; the variable's --enable-logging and CalculateNativeWinOcclusion in --disable-features did arrive, so the port switch alone was removed",
    );
    expect(diagnosisLines(stripped, {})).toContain(
      "the check's other arguments on it: the variable's --enable-logging, CalculateNativeWinOcclusion in --disable-features",
    );
    const lines = diagnosisLines(d, {});
    expect(lines).toContain(
      "the check's other arguments on it: none (no --enable-logging, no CalculateNativeWinOcclusion)",
    );
    expect(lines[0]).toBe(
      "msedgewebview2.exe: 2 process(es), 1 browser process(es), 1 of this app",
    );
    expect(lines).toContain(
      "the DevTools switch on its command line: neither: no --remote-debugging-port on its command line",
    );
    expect(lines).toContain("it listens on no TCP port");
    expect(lines).toContain("port 9333: no socket");
    expect(lines).toContain(
      "policies: none under Software\\Policies\\Microsoft\\Edge that bear on DevTools or browser arguments",
    );
    expect(lines).toContain("WebView2 runtime: 142.0.3595.65");
    expect(lines.at(-1)).toMatch(/^verdict: the switch never reached/);
  });

  it("both ways reached it and it listens on the last port", () => {
    const d = diagnoseWebview(
      raw(`${APP_ARGS} ${ENV_ARGS}`, {
        listening: [{ pid: 5100, address: "127.0.0.1", port: 9334 }],
      }),
      CTX,
    );
    expect(d.ours[0].mechanism.via).toBe("both");
    expect(devtoolsVerdict(d)).toBe(
      "msedgewebview2.exe listens on 127.0.0.1:9334 (the switch came by both)",
    );
    expect(fallbackEndpoints(d, {})).toEqual(["http://127.0.0.1:9334"]);
  });

  it("it reached it but nothing listens: a policy, a reserved port and the browser's log say why", () => {
    const d = diagnoseWebview(
      raw(ENV_ARGS, {
        policies: {
          key: "HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge",
          name: "DeveloperToolsAvailability",
          value: "2",
        },
        onPorts: { port: 9334, pid: 4, owner: "System", address: "0.0.0.0", state: "Listen" },
        excludedPorts: ["      9300        9399"],
      }),
      CTX,
    );
    // PowerShell writes one object where a list has one entry: read as a list all the same.
    expect(d.policies).toHaveLength(1);
    const clues = {
      5100: {
        activePort: null,
        activePortText: null,
        logFile: `${UDD}\\chrome_debug.log`,
        logLines: [
          "[1102/101300.123:ERROR:devtools_http_handler.cc(304)] Cannot start http server for devtools.",
        ],
      },
    };
    const verdict = devtoolsVerdict(d, clues);
    expect(verdict).toContain(
      "the switch reached msedgewebview2.exe (port 9334, by env) but no DevTools server listens",
    );
    expect(verdict).toContain(
      "policy HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Microsoft\\Edge\\DeveloperToolsAvailability = 2",
    );
    expect(verdict).toContain("port 9334 is held by System (pid 4, Listen)");
    expect(verdict).toContain("port 9334 is in a range Windows keeps from programs (9300-9399)");
    expect(verdict).toContain("Cannot start http server for devtools.");
    const lines = diagnosisLines(d, clues);
    expect(lines).toContain(
      "no DevToolsActivePort in its data folder (no DevTools server started)",
    );
    expect(lines).toContain("port 9334: System pid 4 Listen on 0.0.0.0");
    expect(lines).toContain("port 9333 is in an excluded range (9300-9399)");
    // Without a log: says whether the variable's --enable-logging was on its command line.
    expect(
      devtoolsVerdict(diagnoseWebview(raw(APP_ARGS), CTX), {
        5100: { activePort: null, activePortText: null, logFile: null, logLines: [] },
      }),
    ).toContain("no log (the variable's --enable-logging is not on it)");
  });

  it("DevTools opened somewhere not asked for: the diagnostics name it and give endpoints to try", () => {
    const d = diagnoseWebview(
      raw(APP_ARGS, {
        listening: [
          { pid: 5100, address: "::1", port: 9333 },
          { pid: 5120, address: "127.0.0.1", port: 51000 },
        ],
      }),
      CTX,
    );
    expect(devtoolsVerdict(d)).toBe(
      "msedgewebview2.exe listens on ::1:9333 (the switch came by shell)",
    );
    const clues = {
      5100: {
        activePort: 51234,
        activePortText: "51234\n/devtools/browser/x",
        logFile: null,
        logLines: [],
      },
    };
    expect(fallbackEndpoints(d, clues)).toEqual([
      "http://[::1]:9333",
      "http://127.0.0.1:51000",
      "http://127.0.0.1:51234",
    ]);
    const elsewhere = diagnoseWebview(
      raw(APP_ARGS, { listening: [{ pid: 5100, address: "127.0.0.1", port: 51000 }] }),
      CTX,
    );
    expect(devtoolsVerdict(elsewhere)).toBe(
      "the switch reached msedgewebview2.exe (port 9333, by shell) but DevTools opened elsewhere: 127.0.0.1:51000",
    );
  });

  it("finds this app's browser by its parent, its data folder or its exe name, and no other's", () => {
    const other = {
      pid: 7000,
      parent: 6000,
      path: "x",
      commandLine: `${EXE} --embedded-browser-webview=1 --webview-exe-name=SearchHost.exe --user-data-dir="C:\\Users\\runneradmin\\AppData\\Local\\Packages\\Search\\EBWebView" --remote-debugging-port=9333`,
    };
    const d = diagnoseWebview({ processes: other }, CTX);
    expect(d.ours).toEqual([]);
    expect(devtoolsVerdict(d)).toBe(
      "no msedgewebview2.exe browser process of this app (1 of other programs)",
    );
    expect(devtoolsVerdict(diagnoseWebview({}, CTX))).toBe(
      "no msedgewebview2.exe browser process at all: the window has no WebView2 browser",
    );
    // Not the app's child (a browser started earlier), but its data folder: still this app's.
    const byFolder = diagnoseWebview(
      { processes: [{ pid: 1, parent: 2, path: "x", commandLine: browserLine("") }] },
      { ...CTX, appPid: 99 },
    );
    expect(byFolder.ours).toHaveLength(1);
  });

  it("reads DevToolsActivePort and the browser's log from its data folder", () => {
    const dir = tempDir();
    expect(userDataClues(dir)).toEqual({
      activePort: null,
      activePortText: null,
      logFile: null,
      logLines: [],
    });
    writeFileSync(join(dir, "DevToolsActivePort"), "9334\n/devtools/browser/0b3d\n");
    writeFileSync(
      join(dir, "chrome_debug.log"),
      [
        "[1102/101300.100:INFO:CONSOLE(1)] unrelated",
        "[1102/101300.123:ERROR:devtools_http_handler.cc(304)] Cannot start http server for devtools.",
        "[1102/101300.200:WARNING:policy_loader.cc(1)] something about policies",
      ].join("\r\n"),
    );
    expect(userDataClues(dir)).toEqual({
      activePort: 9334,
      activePortText: "9334\n/devtools/browser/0b3d",
      logFile: join(dir, "chrome_debug.log"),
      logLines: [
        "[1102/101300.123:ERROR:devtools_http_handler.cc(304)] Cannot start http server for devtools.",
        "[1102/101300.200:WARNING:policy_loader.cc(1)] something about policies",
      ],
    });
    expect(userDataClues(null).activePort).toBeNull();
  });
});

describe("the Windows diagnostics' PowerShell", () => {
  type Call = {
    cmd: string;
    args: string[];
    opts: { env: Record<string, string>; timeoutMs: number };
  };
  it("is a fixed script given only the ports and the output file, in environment variables", async () => {
    const file = join(tempDir(), "devtools unreachable.raw.json");
    const calls: Call[] = [];
    const run = async (cmd: string, args: string[], opts: Call["opts"]) => {
      calls.push({ cmd, args, opts });
      writeFileSync(opts.env.FR_DIAG_OUT as string, `\uFEFF${JSON.stringify(raw(APP_ARGS))}`);
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    };
    const r = await collectWebviewDiagnostics(file, [9333, 9334], { platform: "win32", run });
    expect(r.ok).toBe(true);
    expect(r.raw.processes).toHaveLength(2);
    expect(calls).toHaveLength(1);
    const [c] = calls as [Call];
    expect(c.cmd).toBe("powershell.exe");
    expect(c.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
    expect(Buffer.from(c.args[3] as string, "base64").toString("utf16le")).toBe(WEBVIEW_DIAG_PS);
    expect(c.args[3]).toBe(encodePowerShell(WEBVIEW_DIAG_PS));
    expect(c.opts.env.FR_DEVTOOLS_PORTS).toBe("9333,9334");
    expect(c.opts.env.FR_DIAG_OUT).toBe(file);
    expect(c.opts.timeoutMs).toBe(90_000);
    // The script reads nothing but those two variables, and holds no port or path of this run.
    const vars = [...WEBVIEW_DIAG_PS.matchAll(/\$env:(\w+)/g)].map((m) => m[1]);
    expect(new Set(vars)).toEqual(new Set(["FR_DEVTOOLS_PORTS", "FR_DIAG_OUT"]));
    expect(WEBVIEW_DIAG_PS).not.toContain("9333");
    expect(WEBVIEW_DIAG_PS).not.toContain("`");
    for (const part of [
      "Win32_Process",
      "msedgewebview2.exe",
      "Get-NetTCPConnection -State Listen -OwningProcess",
      "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge",
      "HKCU:\\SOFTWARE\\Policies\\Microsoft\\Edge",
      "'WebView2'",
      "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
      "excludedportrange",
      "ConvertTo-Json -InputObject $out -Depth 6",
    ])
      expect(WEBVIEW_DIAG_PS).toContain(part);
  });

  it("says why there are none: not Windows, a time-out, PowerShell's words, bad ports", async () => {
    const calls: unknown[] = [];
    const never = async (...a: unknown[]) => {
      calls.push(a);
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    };
    const file = join(tempDir(), "d.json");
    expect(
      await collectWebviewDiagnostics(file, [9333, 9334], { platform: "linux", run: never }),
    ).toEqual({
      ok: false,
      why: "not Windows",
    });
    expect(
      await collectWebviewDiagnostics(file, [9333, Number.NaN], { platform: "win32", run: never }),
    ).toMatchObject({ ok: false, why: "not ports: 9333,NaN" });
    expect(calls).toEqual([]);
    const slow = async () => ({ status: null, stdout: "half", stderr: "", timedOut: true });
    expect(
      await collectWebviewDiagnostics(file, [9333, 9334], {
        platform: "win32",
        run: slow,
        timeoutMs: 5_000,
      }),
    ).toEqual({
      ok: false,
      why: "PowerShell did not finish within 5 s",
      output: { status: null, timedOut: true, stdout: "half", stderr: "" },
    });
    const refused = async () => ({
      status: 1,
      stdout: "",
      stderr: "Get-CimInstance : Access denied\r\n",
      timedOut: false,
    });
    expect(
      await collectWebviewDiagnostics(file, [9333, 9334], { platform: "win32", run: refused }),
    ).toEqual({
      ok: false,
      why: "PowerShell exit 1: Get-CimInstance : Access denied",
      output: {
        status: 1,
        timedOut: false,
        stdout: "",
        stderr: "Get-CimInstance : Access denied\r\n",
      },
    });
    // Nothing on stderr: what it wrote on stdout.
    const quiet = async () => ({ status: 1, stdout: "a word\r\n", stderr: "", timedOut: false });
    expect(
      (await collectWebviewDiagnostics(file, [9333, 9334], { platform: "win32", run: quiet })).why,
    ).toBe("PowerShell exit 1: a word");
    const garbled = async (_c: string, _a: string[], o: { env: Record<string, string> }) => {
      writeFileSync(o.env.FR_DIAG_OUT as string, "not json");
      return { status: 0, stdout: "", stderr: "", timedOut: false };
    };
    expect(
      (
        await collectWebviewDiagnostics(join(tempDir(), "g.json"), [9333, 9334], {
          platform: "win32",
          run: garbled,
        })
      ).why,
    ).toMatch(/^its output is not JSON/);
  });

  /**
   * Windows PowerShell 5.1 started with -EncodedCommand and its output redirected writes its
   * error stream as CLIXML: the header, a progress record, then one <S S="Error"> per line, with
   * line breaks and other characters escaped. Cut at a few hundred characters, that is mostly
   * header.
   */
  const CLIXML = [
    "#< CLIXML",
    '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj>' +
      '<S S="Error">At line:4 char:12_x000D__x000A_</S>' +
      '<S S="Error">+ $ports = @($env:FR_DEVTOOLS_PORTS -split &apos;,&apos; | Where-Object { $_ -match ..._x000D__x000A_</S>' +
      '<S S="Error">+            ~_x000D__x000A_</S>' +
      '<S S="Error">Missing closing &apos;)&apos; in expression &lt;here&gt; &amp; _x005F_x0041_ _x00FC_._x000D__x000A_</S>' +
      '<S S="Error">    + CategoryInfo          : ParserError: (:) [], ParentContainsErrorRecordException_x000D__x000A_</S>' +
      '<S S="Error">    + FullyQualifiedErrorId : MissingEndParenthesisInExpression_x000D__x000A_</S>' +
      '<S S="Error"> _x000D__x000A_</S></Objs>',
  ].join("\r\n");

  it("reads Windows PowerShell's errors written as CLIXML, and keeps all it said for the artifact", async () => {
    const words = powerShellWords(CLIXML);
    expect(words).toContain(
      "At line:4 char:12\r\n+ $ports = @($env:FR_DEVTOOLS_PORTS -split ',' | Where-Object",
    );
    // Entities and _xHHHH_ escapes undone, an escaped underscore kept as written.
    expect(words).toContain("Missing closing ')' in expression <here> & _x0041_ ü.\r\n");
    expect(words).toContain("FullyQualifiedErrorId : MissingEndParenthesisInExpression");
    for (const noise of ["CLIXML", "<Objs", "<S ", "Preparing modules", "_x000D_"])
      expect(words).not.toContain(noise);
    // Plain text, and CLIXML without an error record, stay as they came.
    expect(powerShellWords("Get-CimInstance : Access denied\r\n")).toBe(
      "Get-CimInstance : Access denied\r\n",
    );
    expect(powerShellWords("")).toBe("");
    const progressOnly = `#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress" RefId="0"></Obj></Objs>`;
    expect(powerShellWords(progressOnly)).toBe(progressOnly);
    // Text before the header is kept in front of the errors.
    expect(powerShellWords(`warning first\r\n${CLIXML}`)).toMatch(/^warning first\r\nAt line:4/);

    const failed = async () => ({ status: 1, stdout: "", stderr: CLIXML, timedOut: false });
    const r = await collectWebviewDiagnostics(join(tempDir(), "x.json"), [9333, 9334], {
      platform: "win32",
      run: failed,
    });
    expect(r.ok).toBe(false);
    // The error itself, not the XML header, and long enough to hold the parser's reason.
    expect(r.why).toMatch(/^PowerShell exit 1: At line:4 char:12 \+ \$ports = /);
    expect(r.why).toContain("Missing closing ')' in expression");
    expect(r.why).toContain("MissingEndParenthesisInExpression");
    expect(r.why).not.toContain("CLIXML");
    // Everything it wrote, as it came, for devtools-<label>.ps.txt in the artifact.
    expect(r.output).toEqual({ status: 1, timedOut: false, stdout: "", stderr: CLIXML });
    const text = powerShellReport(r.output);
    expect(text).toContain("exit: 1\n");
    expect(text).toContain("timed out: no\n");
    expect(text).toContain("--- stdout ---\n(nothing)\n");
    expect(text).toContain(`--- stderr ---\n${CLIXML}\n`);
    expect(text).toContain("--- stderr, the errors as text ---\nAt line:4 char:12");
    expect(powerShellReport({ status: null, timedOut: true, stdout: "half", stderr: "" })).toBe(
      "exit: none\ntimed out: yes\n--- stdout ---\nhalf\n--- stderr ---\n(nothing)\n",
    );
  });

  it("runs a program with an argv array and gives up at its time limit", async () => {
    const ok = await runCaptured(process.execPath, ["-e", "process.stdout.write('hi')"], {
      env: process.env,
      timeoutMs: 20_000,
    });
    expect(ok).toMatchObject({ status: 0, stdout: "hi", timedOut: false });
    const started = Date.now();
    const slow = await runCaptured(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      env: process.env,
      timeoutMs: 500,
    });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
    const missing = await runCaptured(join(tempDir(), "no such program"), [], {
      env: process.env,
      timeoutMs: 5_000,
    });
    expect(missing.status).toBeNull();
    expect(missing.error).toBeTruthy();
  });
});

describe("the stand-in model in an installed runtime", () => {
  it("lands where `fr daemon --provider bench` looks for it", () => {
    const runtime = tempDir();
    const cli = join(runtime, "packages", "runtime", "src", "cli", "main.ts");
    mkdirSync(join(runtime, "packages", "runtime", "src", "cli"), { recursive: true });
    writeFileSync(cli, "// the installed CLI\n");
    const copied = installStandIn(REPO, runtime);
    expect(copied).toEqual([
      join("testenv", "package.json"),
      join("testenv", "src", "bench"),
      join("testenv", "src", "provider"),
    ]);
    // main.ts's BENCH_ENTRY, resolved from the installed CLI's own place.
    const main = readFileSync(join(REPO, "packages", "runtime", "src", "cli", "main.ts"), "utf8");
    const rel = /const BENCH_ENTRY = new URL\("([^"]+)", import\.meta\.url\)/.exec(main)?.[1];
    expect(rel).toBeTruthy();
    const entry = fileURLToPath(new URL(rel as string, pathToFileURL(cli)));
    expect(existsSync(entry)).toBe(true);
    expect(existsSync(join(runtime, "testenv", "src", "provider", "fake-provider.ts"))).toBe(true);
    expect(JSON.parse(readFileSync(join(runtime, "testenv", "package.json"), "utf8")).type).toBe(
      "module",
    );
  });

  it("refuses a folder that is no installed runtime", () => {
    expect(() => installStandIn(REPO, tempDir())).toThrow(/is not an installed runtime/);
  });
});

describe("the shell's hand-offs in its log", () => {
  it("reads the lines the shell writes (tauri-plugin-log format, CRLF on Windows)", () => {
    const log = [
      "[2026-11-02][08:01:02][forerunner_desktop_lib::actions][INFO] the daemon is up at http://127.0.0.1:50000 (version 1.0.4)",
      "[2026-11-02][08:03:04][forerunner_desktop_lib::windows][INFO] handed to the system browser (link): http://127.0.0.1:4100/acme/window-check/pull/1",
      "[2026-11-02][08:03:09][forerunner_desktop_lib::windows][INFO] handed to the system browser (new window): https://example.org/a%20b (query not logged)",
      "[2026-11-02][08:03:12][forerunner_desktop_lib::windows][WARN] opening file from the window refused (link)",
      "[2026-11-02][08:03:20][forerunner_desktop_lib::folder][INFO] handed to the file manager: C:\\Users\\runneradmin\\fr window\\Zürich home\\data\\projects\\p1\\workspace",
      "[2026-11-02][08:03:30][forerunner_desktop_lib::windows][WARN] could not open https://example.org/x in the browser: no handler",
    ].join("\r\n");
    expect(parseHandoffs(log)).toEqual([
      {
        kind: "browser",
        via: "link",
        target: "http://127.0.0.1:4100/acme/window-check/pull/1",
      },
      { kind: "browser", via: "new window", target: "https://example.org/a%20b" },
      { kind: "refused", scheme: "file", via: "link" },
      {
        kind: "folder",
        target: "C:\\Users\\runneradmin\\fr window\\Zürich home\\data\\projects\\p1\\workspace",
      },
    ]);
    expect(parseHandoffs("")).toEqual([]);
  });

  it("reads the words the shell writes (windows.rs and folder.rs)", () => {
    expect(shellSource("windows.rs")).toContain(
      'pub const HANDED_TO_BROWSER: &str = "handed to the system browser";',
    );
    expect(shellSource("windows.rs")).toContain('"opening {} from the window refused ({})"');
    expect(shellSource("folder.rs")).toContain(
      'pub const HANDED_TO_FILE_MANAGER: &str = "handed to the file manager";',
    );
    // The exact line the shell's own test pins (windows.rs, a_hand_off_to_the_browser_is_logged...).
    expect(
      parseHandoffs("handed to the system browser (link): http://127.0.0.1:4100/acme/site/pull/1"),
    ).toEqual([{ kind: "browser", via: "link", target: "http://127.0.0.1:4100/acme/site/pull/1" }]);
  });

  it("knows the app's own pages and compares folders as Windows does", () => {
    expect(isAppUrl("http://tauri.localhost/projects/p1/tasks")).toBe(true);
    expect(isAppUrl("tauri://localhost")).toBe(true);
    expect(isAppUrl("http://tauri.localhost.evil.example/")).toBe(false);
    expect(isAppUrl("http://127.0.0.1:4100/acme/window-check/pull/1")).toBe(false);
    expect(isAppUrl("http://127.0.0.1:1871/inbox", ["http://127.0.0.1:1871"])).toBe(true);
    expect(APP_ORIGINS).toContain("http://tauri.localhost");
    expect(sameFolder("C:\\Users\\A\\Work\\", "c:/users/a/work", true)).toBe(true);
    expect(sameFolder("C:\\Users\\A\\Work", "C:\\Users\\A\\Other", true)).toBe(false);
    expect(sameFolder("/home/a/Work/", "/home/a/Work", false)).toBe(true);
    expect(sameFolder("/home/a/Work", "/home/a/work", false)).toBe(false);
    expect(sameFolder("", "", true)).toBe(false);
  });

  it("clicks the Docker link the Settings card shows (readiness-types.ts)", () => {
    const words = readFileSync(
      join(REPO, "packages", "runtime", "src", "sandbox", "readiness-types.ts"),
      "utf8",
    );
    expect(words).toContain(`export const DOCKER_DESKTOP_URL = "${DOCKER_DESKTOP_URL}";`);
  });
});

describe("the PR link written into the store", () => {
  it("sets the task's pr_url, bumps its version and refuses a task that is not there", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const file = join(tempDir(), "state.sqlite");
    const db = new DatabaseSync(file);
    db.exec(
      'CREATE TABLE "task" ("id" TEXT PRIMARY KEY, "updated_at" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "pr_url" TEXT)',
    );
    db.prepare('INSERT INTO "task" ("id", "updated_at") VALUES (?, ?)').run(
      "t1",
      "2026-11-01T00:00:00Z",
    );
    db.close();
    await seedPrUrl(
      file,
      "t1",
      "http://127.0.0.1:4100/acme/window-check/pull/1",
      "2026-11-02T08:00:00Z",
    );
    const check = new DatabaseSync(file);
    expect(
      check
        .prepare('SELECT "pr_url", "updated_at", "version" FROM "task" WHERE "id" = ?')
        .get("t1"),
    ).toEqual({
      pr_url: "http://127.0.0.1:4100/acme/window-check/pull/1",
      updated_at: "2026-11-02T08:00:00Z",
      version: 2,
    });
    check.close();
    await expect(seedPrUrl(file, "nope", "http://x", "2026-11-02T08:00:00Z")).rejects.toThrow(
      /no task nope/,
    );
  });

  it("writes the column the Tasks tab's PR link reads (task.pr_url)", () => {
    const schema = readFileSync(join(REPO, "packages", "state", "src", "schema.ts"), "utf8");
    expect(schema).toContain('text("pr_url"');
    const views = readFileSync(
      join(REPO, "packages", "runtime", "src", "daemon", "views.ts"),
      "utf8",
    );
    expect(views).toContain("prUrl: t.pr_url");
  });
});

describe("the page the system browser opens", () => {
  it("records every request on 127.0.0.1", async () => {
    const link = await startLinkServer();
    try {
      expect(link.base).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${link.base}/acme/window-check/pull/1`);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("The system browser opened this page.");
      expect(link.hits.map((h: { path: string }) => h.path)).toEqual(["/acme/window-check/pull/1"]);
    } finally {
      await link.close();
    }
  });
});

describe("the screen where the journey stopped (Windows runner)", () => {
  type Call = { cmd: string; args: string[]; opts: { env: Record<string, string> } };
  it("is copied by Windows PowerShell into the file the check names, the path never in the script", () => {
    const dir = join(tempDir(), "fr window");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "99-stopped-desktop.png");
    const calls: Call[] = [];
    const run = (cmd: string, args: string[], opts: Call["opts"]) => {
      calls.push({ cmd, args, opts });
      writeFileSync(opts.env.FR_SHOT as string, "png");
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(desktopScreenshot(file, { platform: "win32", run })).toBe(`desktop screenshot: ${file}`);
    expect(calls).toHaveLength(1);
    const [c] = calls as [Call];
    expect(c.cmd).toBe("powershell.exe");
    expect(c.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(c.args[3]).toContain("CopyFromScreen");
    expect(c.args[3]).toContain("$env:FR_SHOT");
    expect(c.args[3]).not.toContain(file);
    expect(c.opts.env.FR_SHOT).toBe(file);
  });

  it("says why there is none: not Windows, or PowerShell's own words", () => {
    const calls: unknown[] = [];
    const never = (...a: unknown[]) => {
      calls.push(a);
      return { status: 0, stdout: "", stderr: "" };
    };
    expect(desktopScreenshot(join(tempDir(), "a.png"), { platform: "linux", run: never })).toBe(
      "no desktop screenshot (not Windows)",
    );
    expect(calls).toEqual([]);
    const refused = () => ({ status: 1, stdout: "", stderr: "Add-Type : no desktop\r\n" });
    expect(desktopScreenshot(join(tempDir(), "b.png"), { platform: "win32", run: refused })).toBe(
      "desktop screenshot failed: Add-Type : no desktop",
    );
    // Errors written as CLIXML are read as text.
    const clixml = () => ({
      status: 1,
      stdout: "",
      stderr:
        '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Exception calling &quot;CopyFromScreen&quot;: The handle is invalid_x000D__x000A_</S></Objs>',
    });
    expect(desktopScreenshot(join(tempDir(), "d.png"), { platform: "win32", run: clixml })).toBe(
      'desktop screenshot failed: Exception calling "CopyFromScreen": The handle is invalid',
    );
    // A zero exit that left no file is no screenshot either.
    const empty = () => ({ status: 0, stdout: "", stderr: "" });
    expect(desktopScreenshot(join(tempDir(), "c.png"), { platform: "win32", run: empty })).toBe(
      "desktop screenshot failed: exit 0",
    );
  });
});

describe("the step summary", () => {
  it("says which required checks failed and marks skipped checks and notes", () => {
    const md = summaryMarkdown("Window", [
      { name: "a", ok: true },
      { name: "b", ok: false, detail: "no line" },
      { name: "c", ok: false, skipped: true, detail: "no shell" },
      { name: "d", ok: false, required: false, detail: "not fetched" },
    ]);
    expect(md).toContain("**1 required check(s) failed.**");
    expect(md).toContain("- ok: a");
    expect(md).toContain("- FAILED: b (no line)");
    expect(md).toContain("- skipped: c (no shell)");
    expect(md).toContain("- note: d (not fetched)");
    expect(summaryMarkdown("W", [{ name: "a", ok: true }])).toContain(
      "Every required check passed.",
    );
  });

  it("adds the DevTools diagnostics after the checks, one line each", () => {
    const md = summaryMarkdown(
      "Window",
      [
        {
          name: "the window's page is reachable over DevTools",
          ok: false,
          detail: "not within 180 s",
        },
      ],
      [
        {
          title: "WebView2 DevTools diagnostics (unreachable)",
          lines: ["verdict: the switch never\nreached it"],
        },
      ],
    );
    expect(md).toContain(
      "- FAILED: the window's page is reachable over DevTools (not within 180 s)",
    );
    expect(md).toContain("#### WebView2 DevTools diagnostics (unreachable)");
    expect(md).toContain("- verdict: the switch never reached it");
    expect(md.indexOf("- FAILED")).toBeLessThan(md.indexOf("#### WebView2"));
  });
});
