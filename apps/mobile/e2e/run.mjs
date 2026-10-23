#!/usr/bin/env node
/**
 * Android emulator smoke for the Forerunner app (spec R, phase 5 gate, scenario 9).
 *
 * What it does, in order (README.md next to this file lists the same steps by hand):
 *   1. finds `adb` (ANDROID_HOME / ANDROID_SDK_ROOT / PATH) and an attached device or
 *      emulator; when none is attached and an AVD exists (`--avd <name>` or FR_ANDROID_AVD,
 *      else the first `emulator -list-avds` entry) it boots one headless and waits for
 *      `sys.boot_completed`;
 *   2. builds the debug APK through the Tauri CLI (`--build` always; by default when no
 *      *debug* APK exists under gen/android/app/build/outputs/apk, so a release build left
 *      by the workflow's artefact step does not stand in for it; `--no-build` never builds);
 *   3. starts the fake shared state service (apps/ui/test/fake-state-service.ts, the real
 *      request-signature checks) on the host and makes it reachable from the device as
 *      http://127.0.0.1:<port> through `adb reverse`;
 *   4. installs and launches the app, forwards the WebView's DevTools socket
 *      (`localabstract:webview_devtools_remote_<pid>`, debug builds only) and drives the
 *      page over raw CDP on its page target (`cdp.mjs`, ADR 0054: `GET /json/list`, then
 *      `Runtime.evaluate` and `Input.*` over the page's WebSocket; the Android WebView
 *      refuses browser-level CDP, so Playwright's `connectOverCDP` cannot attach): pair by
 *      code, approve a request, refuse a high-risk answer without a biometric assertion, the
 *      scenario-9 sentence -> ONE change card -> confirm -> the fake records project.switch +
 *      budget.set + session.start and the simulated PC starts the session, the change log
 *      shows the entry and Undo sends the inverse plan. From the attach on, the page's console
 *      messages and uncaught exceptions are printed here as `webview: [level] ...` lines
 *      (`forwardPageConsole`: `Runtime.enable`, `Runtime.consoleAPICalled`,
 *      `Runtime.exceptionThrown` on the same page session).
 *
 * Skips are visible: without adb, a device, an AVD, or (with `--no-build`) a debug APK, the
 * script prints `SKIP: <reason>` and exits 0 after cleaning up; with FR_ANDROID_REQUIRE=1
 * (CI's emulator job) every skip is a failure, the release-APK one included, so CI cannot go
 * green on install-and-launch alone. A release APK has WebView debugging off and can never
 * carry the smoke.
 *
 * No shell strings: every external program runs from an argv array. Nothing here is specific
 * to a host, an org or a user path; the SDK comes from the environment.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectPage, describeFailure } from "./cdp.mjs";
import { forwardPageConsole } from "./webview-console.mjs";

// The runner's one clock (Node-only tooling, ADR 0054): every wait here and the CDP driver's
// polls read it.
const now = () => Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(here, "..");
const repoRoot = resolve(mobileDir, "..", "..");
const uiDir = join(repoRoot, "apps", "ui");
const apkRoot = join(mobileDir, "src-tauri", "gen", "android", "app", "build", "outputs", "apk");
const APP_ID = "app.forerunner.mobile";
const ACTIVITY = `${APP_ID}/.MainActivity`;
const SENTENCE =
  "switch to the game, give it 15 francs until tomorrow and start a session on my PC";
// Per click, fill or CDP request (the waits in smoke() carry --timeout); Playwright's default was the same.
const ACTION_TIMEOUT_MS = 30_000;

const args = parseArgs(process.argv.slice(2));
const require_ = (fromDir) => createRequire(join(fromDir, "package.json"));
const required = process.env.FR_ANDROID_REQUIRE === "1";
const cleanups = [];

function parseArgs(argv) {
  const out = {
    build: null,
    avd: process.env.FR_ANDROID_AVD ?? null,
    apk: null,
    keep: false,
    timeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--build") out.build = true;
    else if (a === "--no-build") out.build = false;
    else if (a === "--keep") out.keep = true;
    else if (a === "--avd") out.avd = argv[++i] ?? null;
    else if (a === "--apk") out.apk = argv[++i] ?? null;
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i] ?? out.timeoutMs);
    else if (a === "--help" || a === "-h") {
      console.log(
        "usage: node apps/mobile/e2e/run.mjs [--build|--no-build] [--avd NAME] [--apk FILE] [--keep] [--timeout MS]",
      );
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/** A visible skip; `main`'s handler runs the cleanups first and turns it into a failure under FR_ANDROID_REQUIRE=1. */
class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.name = "Skip";
  }
}

function skip(reason) {
  throw new Skip(reason);
}

async function cleanup() {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      await fn();
    } catch {
      // best effort
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", opts.quiet ? "pipe" : "inherit"],
    timeout: opts.timeout ?? 120_000,
    cwd: opts.cwd,
    env: opts.env ?? process.env,
  });
}

function exe(name) {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function sdkRoot() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
}

function findTool(dir, name) {
  const root = sdkRoot();
  if (root) {
    const candidate = join(root, dir, exe(name));
    if (existsSync(candidate)) return candidate;
  }
  try {
    run(name, ["-h"], { quiet: true, timeout: 10_000 });
    return name;
  } catch (e) {
    // `adb -h` exits 1 but still proves the binary runs; a missing binary throws ENOENT.
    if (e && e.code !== "ENOENT") return name;
    return null;
  }
}

function listDevices(adb) {
  const out = run(adb, ["devices"], { quiet: true });
  return out
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0]);
}

async function waitForBoot(adb, timeoutMs) {
  run(adb, ["wait-for-device"], { timeout: timeoutMs });
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    const prop = run(adb, ["shell", "getprop", "sys.boot_completed"], { quiet: true }).trim();
    if (prop === "1") return;
    await sleep(2000);
  }
  throw new Error("device did not finish booting in time");
}

async function ensureDevice(adb) {
  const attached = listDevices(adb);
  if (attached.length > 0) return { serial: attached[0], booted: false };
  const emulator = findTool("emulator", "emulator");
  if (!emulator) skip("no device attached and no Android emulator binary found");
  let avd = args.avd;
  if (!avd) {
    const avds = run(emulator, ["-list-avds"], { quiet: true })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("INFO"));
    avd = avds[0] ?? null;
  }
  if (!avd) skip("no device attached and no AVD to boot (avdmanager create avd ...)");
  console.log(`booting emulator ${avd} (headless)`);
  const child = spawn(
    emulator,
    ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-gpu", "swiftshader_indirect"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
  cleanups.push(() => {
    try {
      run(adb, ["emu", "kill"], { quiet: true, timeout: 10_000 });
    } catch {
      // already gone
    }
  });
  await waitForBoot(adb, 300_000);
  const serial = listDevices(adb)[0];
  if (!serial) throw new Error("the emulator booted but adb lists no device");
  return { serial, booted: true };
}

function findApk(root) {
  if (!existsSync(root)) return null;
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.apk$/i.test(entry)) found.push(p);
    }
  };
  walk(root);
  const score = (p) => {
    const s = p.toLowerCase();
    let n = 0;
    if (s.includes("debug")) n += 4;
    if (s.includes("x86_64")) n += 2;
    if (s.includes("universal")) n += 1;
    return n;
  };
  found.sort((a, b) => score(b) - score(a));
  return found[0] ?? null;
}

function isDebugApk(p) {
  return /debug/i.test(p);
}

function buildApk() {
  const tauriCli = require_(mobileDir).resolve("@tauri-apps/cli/tauri.js");
  const target = process.env.FR_ANDROID_TARGET || "x86_64";
  console.log(`building the debug APK for ${target} through the Tauri CLI`);
  run(
    process.execPath,
    [tauriCli, "android", "build", "--apk", "--debug", "--target", target, "--ci"],
    { cwd: mobileDir, timeout: 60 * 60 * 1000 },
  );
}

async function startFakeService(port, adminToken) {
  const tsxCli = require_(repoRoot).resolve("tsx/cli");
  const fake = join(uiDir, "test", "fake-state-service.ts");
  const child = spawn(process.execPath, [tsxCli, fake], {
    cwd: uiDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      FAKE_STATE_PORT: String(port),
      FAKE_STATE_ADMIN_TOKEN: adminToken,
      FAKE_STATE_PC_MS: process.env.FR_STATE_PC_MS || "300",
    },
  });
  cleanups.push(() => child.kill("SIGTERM"));
  const url = `http://127.0.0.1:${port}`;
  const t0 = now();
  while (now() - t0 < 60_000) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return url;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error("the fake state service did not answer /health");
}

function freePort() {
  const script =
    "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})";
  return Number(run(process.execPath, ["-e", script], { quiet: true }).trim());
}

function randomToken() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function admin(url, token, method, path, body) {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

async function findDevtoolsSocket(adb, timeoutMs) {
  const t0 = now();
  while (now() - t0 < timeoutMs) {
    let pid = "";
    try {
      pid = run(adb, ["shell", "pidof", APP_ID], { quiet: true }).trim();
    } catch {
      pid = "";
    }
    if (pid) {
      const unix = run(adb, ["shell", "cat", "/proc/net/unix"], { quiet: true });
      const m = new RegExp(`@(webview_devtools_remote_${pid})\\b`).exec(unix);
      if (m) return m[1];
    }
    await sleep(1000);
  }
  return null;
}

function assert(condition, message) {
  if (!condition) throw new Error(`smoke assertion failed: ${message}`);
}

async function smoke(page, stateUrl, adminToken, timeoutMs) {
  const calls = () => admin(stateUrl, adminToken, "GET", "/__test/calls");
  const state = () => admin(stateUrl, adminToken, "GET", "/__test/state");
  await admin(stateUrl, adminToken, "POST", "/__test/reset");

  // 1. Pairing by code (the URL is typed too: the shell got no deep link in this run).
  await page.getByRole("heading", { name: "Pair this phone" }).waitFor({ timeout: timeoutMs });
  const pairing = await admin(stateUrl, adminToken, "POST", "/__test/pair", {
    humanId: "human_j",
    kind: "phone",
  });
  await page.getByTestId("m-pair-url").fill(stateUrl);
  await page.getByTestId("m-pair-code").fill(pairing.code);
  await page.getByTestId("m-pair-name").fill("Emulator phone");
  await page.getByTestId("m-pair-submit").click();
  await page.getByRole("heading", { name: "Projects" }).waitFor({ timeout: timeoutMs });
  const paired = await state();
  assert(paired.devices.length === 1, "one device paired");
  assert(paired.devices[0].name === "Emulator phone", "device name from the form");
  console.log("PASS: pairing by code");

  // 2. Approve a request; the answer is signed by the shell's key.
  await page.getByTestId("m-nav").getByText("Inbox").click();
  const first = page.getByTestId("m-request").first();
  await first.waitFor({ timeout: timeoutMs });
  assert((await first.getAttribute("data-request-id")) === "req_merge", "blocking request first");
  await first.getByRole("button", { name: "Approve" }).click();
  await page
    .getByTestId("m-blocking-count")
    .getByText("0 blocking")
    .waitFor({ timeout: timeoutMs });
  const approve = (await calls()).find((c) => c.path === "/requests/req_merge/answer");
  assert(approve?.signed === true && approve.biometric === false, "approval signed, no biometric");
  console.log("PASS: approve a request (signed)");

  // 3. High risk without a biometric assertion is refused on the phone, nothing is sent.
  const high = page.getByTestId("m-request").filter({ has: page.getByTestId("m-request-high") });
  await high.getByRole("button", { name: "Confirm" }).click();
  await high.getByTestId("m-request-error").waitFor({ timeout: timeoutMs });
  const errorText = await high.getByTestId("m-request-error").innerText();
  assert(/biometric/i.test(errorText), `high-risk refusal names the biometric step: ${errorText}`);
  assert(
    (await calls()).filter((c) => c.path === "/requests/req_cap/answer").length === 0,
    "no high-risk answer left the phone",
  );
  console.log(
    `PASS: high-risk answer needs the platform prompt (not enrolled: refused: ${errorText.trim()})`,
  );

  // 4. Scenario 9: one sentence, ONE card, confirm, the PC starts, the log shows it with Undo.
  await page.getByTestId("m-nav").getByText("Remote").click();
  await page.getByTestId("m-say").fill(SENTENCE);
  await page.getByTestId("m-say-submit").click();
  const card = page.getByTestId("m-card");
  await card.waitFor({ timeout: timeoutMs });
  assert((await card.count()) === 1, "exactly one change card");
  assert((await card.getAttribute("data-parts")) === "3", "three parts on the card");
  assert(
    (await calls()).filter((c) => c.path === "/remote/commands").length === 0,
    "nothing sent before confirm",
  );
  await page.getByTestId("m-confirm").click();
  await page
    .locator('[data-testid="m-result"][data-status="done"]')
    .waitFor({ timeout: timeoutMs });
  const sent = (await calls()).filter((c) => c.path === "/remote/commands");
  assert(sent.length === 1, "one remote command for the whole plan");
  const names = sent[0].body.params.plan.map((c) => c.name).join(",");
  assert(names === "project.switch,budget.set,session.start", `plan order: ${names}`);
  assert(sent[0].signed === true, "remote command signed");
  const after = await state();
  assert(after.sessions[0]?.status === "running", "the simulated PC started the session");
  assert(after.sessions[0]?.projectId === "proj_game", "session on the game");
  console.log("PASS: scenario 9 (one card, confirm, PC started)");

  await page.getByRole("link", { name: "Change log" }).click();
  const entry = page.getByTestId("m-change-entry");
  await entry.first().waitFor({ timeout: timeoutMs });
  assert((await entry.count()) === 1, "one change log entry");
  const entryId = await entry.first().getAttribute("data-entry-id");
  await entry.first().getByTestId("m-change-undo").click();
  await page
    .locator(`[data-entry-id="${entryId}"][data-status="undone"]`)
    .waitFor({ timeout: timeoutMs });
  const all = (await calls()).filter((c) => c.path === "/remote/commands");
  assert(all.length === 2, "undo sent a second remote command");
  const undoNames = all[1].body.params.plan.map((c) => c.name).join(",");
  assert(undoNames === "session.stop,budget.set,project.switch", `inverse plan: ${undoNames}`);
  const t0 = now();
  for (;;) {
    const s = await state();
    if (s.sessions[0]?.status === "killed") break;
    if (now() - t0 > timeoutMs) throw new Error("undo did not stop the session");
    await sleep(500);
  }
  console.log("PASS: change log entry with Undo; the inverse plan stopped the session");
}

async function main() {
  const adb = findTool("platform-tools", "adb");
  if (!adb) skip("adb not found (set ANDROID_HOME or put platform-tools on PATH)");
  const { serial, booted } = await ensureDevice(adb);
  console.log(`device ${serial}${booted ? " (booted by this run)" : ""}`);
  process.env.ANDROID_SERIAL = serial;

  let apk = args.apk ?? findApk(apkRoot);
  // The smoke needs WebView debugging, which only a debug APK has: a release APK alone (what
  // the workflow's artefact step leaves behind) triggers a debug build unless --no-build.
  const wantBuild =
    args.build === true || (args.build === null && !args.apk && (!apk || !isDebugApk(apk)));
  if (wantBuild) {
    if (apk && !isDebugApk(apk))
      console.log(`only a release APK found (${apk}); building a debug one`);
    buildApk();
    apk = args.apk ?? findApk(apkRoot);
  }
  if (!apk) throw new Error(`no APK under ${apkRoot}; build it or pass --apk`);
  console.log(`apk ${apk}${isDebugApk(apk) ? "" : " (release: no WebView debugging)"}`);

  const port = freePort();
  const adminToken = randomToken();
  const stateUrl = await startFakeService(port, adminToken);
  run(adb, ["reverse", `tcp:${port}`, `tcp:${port}`]);
  cleanups.push(() => {
    try {
      run(adb, ["reverse", "--remove", `tcp:${port}`], { quiet: true, timeout: 10_000 });
    } catch {
      // gone with the device
    }
  });

  run(adb, ["install", "-r", "-t", apk], { timeout: 300_000 });
  if (!args.keep) {
    cleanups.push(() => {
      try {
        run(adb, ["uninstall", APP_ID], { quiet: true, timeout: 60_000 });
      } catch {
        // already gone
      }
    });
  }
  run(adb, ["shell", "am", "start", "-n", ACTIVITY]);
  const t0 = now();
  let launched = false;
  while (now() - t0 < 60_000) {
    const windows = run(adb, ["shell", "dumpsys", "window", "windows"], { quiet: true });
    if (windows.includes(APP_ID)) {
      launched = true;
      break;
    }
    await sleep(2000);
  }
  if (!launched) throw new Error("the app window did not appear within 60 s");
  console.log("PASS: installed and launched");

  const socket = await findDevtoolsSocket(adb, 30_000);
  if (!socket) {
    if (!isDebugApk(apk)) {
      skip(
        "release APK has WebView debugging off, so the scenario-9 smoke cannot run; drop --no-build (or pass --build) for a debug APK",
      );
    }
    throw new Error("WebView DevTools socket not found; is this a debug build?");
  }
  const devtoolsPort = freePort();
  run(adb, ["forward", `tcp:${devtoolsPort}`, `localabstract:${socket}`]);
  cleanups.push(() => {
    try {
      run(adb, ["forward", "--remove", `tcp:${devtoolsPort}`], { quiet: true, timeout: 10_000 });
    } catch {
      // gone with the device
    }
  });
  // Raw CDP on the page target (cdp.mjs, ADR 0054): the WebView lists its page on
  // /json/list and answers Runtime.evaluate and Input.* on that page's socket; it refuses the
  // browser-level commands Playwright's connectOverCDP starts with (run 7).
  const { client, page, target } = await connectPage(`http://127.0.0.1:${devtoolsPort}`, {
    prefer: (t) => /forerunner/i.test(String(t.title)) || /tauri\.localhost/i.test(String(t.url)),
    waitForTargetMs: 30_000,
    timeoutMs: ACTION_TIMEOUT_MS,
    now,
  });
  cleanups.push(() => client.close());
  console.log(`PASS: attached to the WebView page ${target.url} (${target.title})`);
  // The page's console and uncaught exceptions on this run's stdout (`webview:` lines), over
  // the same page session: a failing step then shows what the app said (android.yml run
  // 39952987240 failed scenario 3 with no page output at all).
  const forwarding = await forwardPageConsole(client);
  cleanups.push(() => forwarding.stop());
  if (forwarding.enabled) console.log("forwarding the WebView console as webview: lines");
  await smoke(page, stateUrl, adminToken, args.timeoutMs);
  console.log("PASS: Android emulator smoke complete");
}

main()
  .then(async () => {
    await cleanup();
    process.exit(0);
  })
  .catch(async (error) => {
    await cleanup();
    if (error instanceof Skip) {
      if (required) {
        console.error(`FAIL: ${error.message} (FR_ANDROID_REQUIRE=1)`);
        process.exit(1);
      }
      console.log(`SKIP: ${error.message}`);
      process.exit(0);
    }
    // A CdpError's stable code and details (the element in the way, the protocol method) go
    // into the log with the message.
    console.error(describeFailure(error));
    process.exit(1);
  });
