#!/usr/bin/env node
// Starts the runtime the desktop installers carry (ADR 0092) the way the shell does (`install.rs`,
// `from_bundled`: its own node, tsx, the CLI, cwd and TSX_TSCONFIG_PATH set to the payload) in
// an empty FORERUNNER_HOME, waits for daemon.json, and checks that the daemon answers
// `GET /health` with the payload's version, `GET /me` with `desktopDeviceId` and `GET /setup`
// with the assistant open, with the registry seeded into the data folder. Then stops it. CI runs it on Windows and Linux after `tauri build`,
// so a payload that cannot start never reaches an installer.
//
// Usage: node scripts/runtime-payload-smoke.mjs [payload dir]
//        (default apps/desktop/src-tauri/runtime)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(
  process.argv[2] ?? path.join(repo, "apps", "desktop", "src-tauri", "runtime"),
);
const manifest = JSON.parse(readFileSync(path.join(dir, "runtime.json"), "utf8"));
const node = path.join(dir, "node", process.platform === "win32" ? "node.exe" : "node");
const home = mkdtempSync(path.join(tmpdir(), "fr-payload-smoke-"));
const daemonFile = path.join(home, "runtime", "daemon.json");
const START_MS = 180_000;

// A clean environment: nothing from the checkout or the runner's credentials leaks in.
const env = {
  PATH: process.env.PATH ?? "",
  SystemRoot: process.env.SystemRoot ?? "",
  TEMP: process.env.TEMP ?? tmpdir(),
  TMP: process.env.TMP ?? tmpdir(),
  HOME: home,
  USERPROFILE: home,
  FORERUNNER_HOME: home,
  FORERUNNER_VAULT_BACKEND: "file",
  TSX_TSCONFIG_PATH: path.join(dir, "tsconfig.json"),
};
const child = spawn(
  node,
  [
    path.join(dir, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(dir, ...manifest.entry.split("/")),
    "daemon",
  ],
  { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
child.stdout.on("data", (d) => {
  output += d;
});
child.stderr.on("data", (d) => {
  output += d;
});
let exited = null;
child.on("exit", (code, signal) => {
  exited = code ?? signal;
});

function stop() {
  try {
    const pid = existsSync(daemonFile) ? JSON.parse(readFileSync(daemonFile, "utf8")).pid : null;
    if (pid) process.kill(pid);
  } catch {
    // already gone
  }
  child.kill();
}

async function main() {
  const started = Date.now();
  while (!existsSync(daemonFile)) {
    if (exited !== null)
      throw new Error(`the daemon exited (${exited}) before it wrote daemon.json`);
    if (Date.now() - started > START_MS) throw new Error("no daemon.json within 180 s");
    await new Promise((r) => setTimeout(r, 500));
  }
  const { url, token } = JSON.parse(readFileSync(daemonFile, "utf8"));
  const get = async (p) => {
    const res = await fetch(`${url}${p}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GET ${p}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  let health;
  for (;;) {
    try {
      health = await get("/health");
      break;
    } catch (e) {
      if (Date.now() - started > START_MS) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (health.version !== manifest.version) {
    throw new Error(`/health says ${health.version}, the payload is ${manifest.version}`);
  }
  const me = await get("/me");
  if (typeof me.desktopDeviceId !== "string") throw new Error("/me has no desktopDeviceId");
  // The installed runtime's registry is a writable copy in the data folder (ADR 0092).
  if (!existsSync(path.join(home, "data", "registry", ".bundled.json"))) {
    throw new Error("the registry was not seeded into the data folder");
  }
  const setup = await get("/setup");
  if (setup.showAssistant !== true)
    throw new Error("/setup does not open the assistant on a fresh install");
  console.log(
    `payload ${manifest.version} (${manifest.platform}-${manifest.arch}, node ${manifest.node}) answered /health, /me and /setup after ${Math.round((Date.now() - started) / 1000)} s`,
  );
}

main().then(
  () => {
    stop();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  },
  (e) => {
    stop();
    console.error(`runtime payload smoke failed: ${e instanceof Error ? e.message : e}`);
    console.error(output.slice(-4000));
    process.exitCode = 1;
  },
);
