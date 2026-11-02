#!/usr/bin/env node
// A full-review task in the real Docker sandbox, end to end (phase F2; docs/maintainers/
// testing.md, "The Docker sandbox check"). The owner's PC runs Docker, so a task at risk tier 2
// (a full review) runs in the container there; nobody had run that path through the daemon:
// packages/runtime/test/sandbox.integration.test.ts covers only the adapter.
//
// What it does, with the real daemon on the stand-in model (`--provider bench`) and the real
// Docker engine:
//   1. checks Docker runs Linux containers and has the sandbox image (forerunner-runner:local,
//      built from services/cloud-runner/Dockerfile; the daemon's default for a source checkout);
//   2. records the engine's events for sandbox containers (`docker events`, label
//      forerunner.sandbox=1) for the whole run;
//   3. starts the daemon on a fresh home, asks it to check the sandbox and expects "ready";
//   4. creates a project without a repository (it works in its folder, U-037) and one task at
//      risk tier 2 for the coder: "Write src/greet.js";
//   5. starts a session the way Start does (POST /sessions) and waits for it to end;
//   6. asserts: the task is done; a container from the sandbox image was started for that task
//      and the task's command ran in it (`docker exec`, the coder's `node --check`); the critic
//      reviewed the task and accepted it; src/greet.js landed in the project folder and is valid
//      JavaScript; and afterwards no container or network of that task is left.
// The result (every check) is <out>/result.json, the step summary on GitHub and the exit code
// (1 when a check failed). The daemon log, the engine's events and the model-call log are
// copied to <out>.
//
// Usage: node scripts/sandbox-full-review.mjs [--out <dir>] [--home <dir>] [--image <ref>]
//          [--timeout-min <n>]
// Needs `pnpm install` (the daemon runs from this checkout under tsx) and Docker.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonFetch, killTree, startDaemon, stopDaemon } from "./bench/lib.mjs";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The image the daemon uses in a source checkout (packages/runtime/src/sandbox/image.ts). */
export const DEFAULT_IMAGE = "forerunner-runner:local";
/** The label every sandbox container and network carries (sandbox/container.ts). */
export const SANDBOX_LABEL = "forerunner.sandbox=1";
export const TASK_LABEL = "forerunner.task";
/** The file the task names: the stand-in coder writes it and checks it with `node --check`. */
export const TASK_FILE = "src/greet.js";

/** The one task: a full review (risk tier 2), for the coder, naming the file it writes. */
export const FULL_REVIEW_TASK = Object.freeze({
  title: `Write ${TASK_FILE}`,
  outcome: `${TASK_FILE} exports greet(name), which returns a greeting for that name`,
  acceptanceCriteria: [`${TASK_FILE} exists`, `node --check ${TASK_FILE} passes`],
  riskTier: 2,
  specialist: "coder",
});

/**
 * `--out`, `--home`, `--image`, `--timeout-min`; unknown arguments are refused.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const out = { out: null, home: null, image: DEFAULT_IMAGE, timeoutMin: 15 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--out") out.out = value();
    else if (a === "--home") out.home = value();
    else if (a === "--image") out.image = value();
    else if (a === "--timeout-min") {
      const n = Number(value());
      if (!Number.isFinite(n) || n <= 0) throw new Error("--timeout-min needs a positive number");
      out.timeoutMin = n;
    } else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

/**
 * The engine's events as `docker events --format "{{json .}}"` prints them, one JSON object a
 * line; lines that are not JSON objects are left out.
 * @param {string} text
 */
export function parseDockerEvents(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e === "object") out.push(e);
    } catch {
      // a line cut by the stop
    }
  }
  return out;
}

/**
 * What the engine did for one task: the containers (and networks) labelled with its id, the
 * image they ran, whether one started, the commands executed in it (`exec_start: <argv>`, the
 * command after the colon) with their exit codes (`exec_die`), and whether each container was
 * destroyed again.
 * @param {Array<Record<string, any>>} events
 * @param {string} taskId
 */
export function taskSandboxEvidence(events, taskId) {
  const mine = events.filter((e) => e?.Actor?.Attributes?.[TASK_LABEL] === taskId);
  const containers = new Map();
  const networks = new Set();
  const execs = [];
  const execExits = [];
  for (const e of mine) {
    const attrs = e.Actor?.Attributes ?? {};
    const action = String(e.Action ?? e.status ?? "");
    if (e.Type === "network") {
      networks.add(attrs.name ?? e.Actor?.ID ?? "?");
      continue;
    }
    if (e.Type !== "container") continue;
    const id = String(e.Actor?.ID ?? e.id ?? "?");
    const c = containers.get(id) ?? {
      id,
      name: attrs.name ?? null,
      image: attrs.image ?? null,
      actions: [],
    };
    c.actions.push(action.split(":")[0]);
    containers.set(id, c);
    const exec = /^exec_start: (.+)$/.exec(action);
    if (exec) execs.push(exec[1].trim());
    if (action === "exec_die") execExits.push(Number(attrs.exitCode));
  }
  const list = [...containers.values()];
  return {
    containers: list,
    networks: [...networks],
    images: [...new Set(list.map((c) => c.image).filter(Boolean))],
    started: list.some((c) => c.actions.includes("start")),
    execs,
    execExits,
    allDestroyed: list.length > 0 && list.every((c) => c.actions.includes("destroy")),
  };
}

/**
 * The tiers the critic reviewed one task at, from the stand-in's model-call log
 * (`<home>/bench/model-calls.jsonl`, one JSON line per call; a critic call is labelled
 * `critic tier <n> on task <id>` by the critic service).
 * @param {string} text
 * @param {string} taskId
 */
export function criticTiers(text, taskId) {
  const tiers = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let call;
    try {
      call = JSON.parse(line);
    } catch {
      continue;
    }
    const m = /^critic tier (\d) on task (\S+)$/.exec(String(call?.label ?? ""));
    if (call?.role === "critic" && m && m[2] === taskId) tiers.push(Number(m[1]));
  }
  return tiers;
}

/**
 * The step summary: how many checks failed, then one line per check.
 * @param {string} title
 * @param {Array<{ name: string, ok: boolean, detail?: string }>} checks
 */
export function summaryMarkdown(title, checks) {
  const failed = checks.filter((c) => !c.ok).length;
  return [
    `### ${title}`,
    "",
    failed
      ? `**${failed} of ${checks.length} checks failed.**`
      : `All ${checks.length} checks passed.`,
    "",
    ...checks.map(
      (c) => `- ${c.ok ? "ok" : "FAILED"}: ${c.name}${c.detail ? ` (${oneLine(c.detail)})` : ""}`,
    ),
    "",
  ].join("\n");
}

function oneLine(s) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args, timeout = 60_000) {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}`.trim(), err: `${r.stderr ?? ""}`.trim() };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function until(what, ms, everyMs, fn) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(
    `${what}: not within ${Math.round(ms / 1000)} s${last ? ` (${last.message})` : ""}`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const out = path.resolve(opts.out ?? path.join(tmpdir(), "fr-sandbox-check"));
  const home = path.resolve(opts.home ?? path.join(out, "home"));
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(out, { recursive: true });
  const deadline = Date.now() + opts.timeoutMin * 60_000;
  const left = () => Math.max(5_000, deadline - Date.now());
  const checks = [];
  const result = { image: opts.image, home, startedAt: new Date().toISOString(), checks };
  const check = (name, ok, detail = "") => {
    checks.push({ name, ok: !!ok, detail: String(detail ?? "") });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${oneLine(detail)}` : ""}`);
    return !!ok;
  };
  let stopEvents = () => {};

  // 1. Docker with Linux containers and the image.
  const info = docker(["info", "--format", "{{.ServerVersion}}|{{.OSType}}"]);
  const [version, osType] = info.out.split("|");
  if (
    !check(
      "Docker runs Linux containers",
      info.code === 0 && osType === "linux",
      info.code === 0 ? `Docker ${version}, ${osType}` : info.err,
    )
  )
    return finish();
  const img = docker(["image", "inspect", "--format", "{{.Id}}", opts.image]);
  if (
    !check(
      `the sandbox image ${opts.image} is on this machine`,
      img.code === 0,
      img.code === 0
        ? img.out.slice(0, 19)
        : `${img.err} (build it: docker build -t ${DEFAULT_IMAGE} -f services/cloud-runner/Dockerfile .)`,
    )
  )
    return finish();

  // 2. The engine's events for sandbox containers, from now on.
  const eventsFile = path.join(out, "docker-events.jsonl");
  writeFileSync(eventsFile, "");
  const events = spawn(
    "docker",
    ["events", "--filter", `label=${SANDBOX_LABEL}`, "--format", "{{json .}}"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  events.stdout.on("data", (d) => appendFileSync(eventsFile, d));
  stopEvents = () => {
    if (events.exitCode === null) events.kill();
  };
  process.on("exit", stopEvents);

  // 3. The daemon on the stand-in model, the sandbox ready.
  const dir = path.join(out, "bench");
  mkdirSync(dir, { recursive: true });
  const port = await freePort();
  const extra = {
    FORERUNNER_SANDBOX_ENGINE: "docker",
    FORERUNNER_RUNNER_IMAGE: opts.image,
    FORERUNNER_BENCH_DELAY_MS: "50",
  };
  const started = await startDaemon({ dir, home, provider: "bench", port, extra });
  const bench = {
    daemonUrl: started.url,
    token: started.token,
    pids: { daemon: started.pid },
    daemonNodePid: started.nodePid,
  };
  result.daemon = { url: started.url, pid: started.pid };
  const api = async (method, route, body) => {
    const r = await daemonFetch(bench, method, route, body);
    if (r.status >= 400)
      throw new Error(`${method} ${route} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`);
    return r.body;
  };
  try {
    await journey();
  } catch (e) {
    check(
      "the check ran to its end",
      false,
      e instanceof Error ? (e.stack ?? e.message) : String(e),
    );
  } finally {
    result.stopped = await stopDaemon(bench).catch((e) => `stop failed: ${e.message}`);
    await killTree(started.pid).catch(() => undefined);
    for (const [from, to] of [
      [path.join(dir, "daemon.log"), "daemon.log"],
      [path.join(home, "bench", "model-calls.jsonl"), "model-calls.jsonl"],
    ])
      if (existsSync(from)) copyFileSync(from, path.join(out, to));
  }
  return finish();

  async function journey() {
    const sandbox = await until("the sandbox to be ready", 60_000, 2_000, async () => {
      const s = await api("POST", "/sandbox/check", {});
      result.sandbox = { state: s.state, headline: s.headline, image: s.image };
      return s.state === "ready" ? s : null;
    }).catch((e) => e);
    if (
      !check(
        "the daemon finds the Docker sandbox ready",
        !(sandbox instanceof Error),
        sandbox instanceof Error
          ? `${sandbox.message}; last state ${result.sandbox?.state}: ${result.sandbox?.headline ?? ""}`
          : `${sandbox.state}, image ${sandbox.image}`,
      )
    )
      return;
    const health = await api("GET", "/health");
    check(
      "/health says task commands run in the container",
      health?.sandbox?.kind === "container" && health?.sandbox?.available === true,
      JSON.stringify(health?.sandbox ?? null),
    );

    // 4. A project without a repository and one full-review task.
    const project = await api("POST", "/projects", {
      name: "Sandbox check",
      goal: "A greeting module, built and checked in the Docker sandbox",
    });
    result.projectId = project.id;
    const task = await api(
      "POST",
      `/projects/${encodeURIComponent(project.id)}/tasks`,
      FULL_REVIEW_TASK,
    );
    result.taskId = task.id;
    check(
      "the task is a full review (risk tier 2)",
      task.riskTier === 2,
      `tier ${task.riskTier}, ${task.status}`,
    );

    // 5. A session, as Start does.
    const me = await api("GET", "/me");
    const start = await api("POST", "/sessions", {
      agentId: me.agent.id,
      projectId: project.id,
      trigger: "manual",
      reason: "the sandbox check (scripts/sandbox-full-review.mjs)",
    });
    const sessionId = await until("the session to start", 60_000, 1_000, async () => {
      if (start.session?.id) return start.session.id;
      const list = await api("GET", `/sessions?projectId=${encodeURIComponent(project.id)}`);
      return (Array.isArray(list) ? list : []).find((s) => s.projectId === project.id)?.id ?? null;
    });
    result.sessionId = sessionId;
    const ended = await until("the session to end", left(), 2_000, async () => {
      const s = await api("GET", `/sessions/${encodeURIComponent(sessionId)}`);
      return ["completed", "stopped", "failed", "killed"].includes(s.status) ? s : null;
    }).catch((e) => e);
    if (ended instanceof Error) check("the session ends", false, ended.message);
    else
      check(
        "the session ends",
        ended.status === "completed",
        `${ended.status}: ${ended.summary ?? ""}`,
      );

    // 6. What happened to the task.
    const detail = await api("GET", `/tasks/${encodeURIComponent(task.id)}`);
    result.task = {
      status: detail.task.status,
      display: detail.task.display?.label ?? null,
      runs: detail.runs.map((r) => ({
        kind: r.kind,
        specialist: r.specialist,
        outcome: r.outcome,
        files: r.files,
      })),
      review: detail.review,
    };
    check(
      "the task is done",
      detail.task.status === "done",
      `${detail.task.status} (${detail.task.display?.label ?? "?"})`,
    );
    const work = detail.runs.find(
      (r) => r.kind === "work" && r.specialist === FULL_REVIEW_TASK.specialist,
    );
    check(
      "the coder's run finished and changed the file",
      !!work && work.files.includes(TASK_FILE),
      work ? `${work.outcome}; files: ${work.files.join(", ")}` : "no work run",
    );
    const review = detail.runs.find((r) => r.kind === "review" && r.specialist === "critic");
    check(
      "the critic reviewed the task",
      !!review,
      review ? review.outcome : detail.runs.map((r) => `${r.kind}:${r.specialist}`).join(", "),
    );
    check(
      "the critic accepted it",
      /accept/i.test(detail.review?.verdict ?? ""),
      detail.review ? `${detail.review.verdict}: ${detail.review.summary}` : "no review",
    );
    const calls = path.join(home, "bench", "model-calls.jsonl");
    const tiers = criticTiers(existsSync(calls) ? readFileSync(calls, "utf8") : "", task.id);
    check(
      "the critic's review was a full review (tier 2)",
      tiers.length > 0 && tiers.every((t) => t >= 2),
      tiers.length ? `critic calls at tier ${tiers.join(", ")}` : "no critic call for the task",
    );

    // The engine's side: give the event stream a moment to flush the teardown.
    await sleep(2_000);
    const evidence = taskSandboxEvidence(
      parseDockerEvents(readFileSync(eventsFile, "utf8")),
      task.id,
    );
    result.engine = evidence;
    check(
      "a sandbox container was started for the task",
      evidence.started,
      evidence.containers.map((c) => `${c.name} [${c.actions.join(" ")}]`).join("; ") ||
        "no event with the task's label",
    );
    check(
      `the container ran the sandbox image ${opts.image}`,
      evidence.images.length > 0 && evidence.images.every((i) => i === opts.image),
      evidence.images.join(", ") || "no image",
    );
    check(
      "the task's command ran inside the container (docker exec)",
      evidence.execs.some((c) => c.includes("node") && c.includes(TASK_FILE)),
      evidence.execs.join(" | ") || "no exec",
    );
    check(
      "the command in the container succeeded (exit 0)",
      evidence.execExits.length > 0 && evidence.execExits.every((c) => c === 0),
      evidence.execExits.length ? `exit ${evidence.execExits.join(", ")}` : "no exec ended",
    );
    check(
      "the container was removed after the run",
      evidence.allDestroyed,
      evidence.containers.map((c) => `${c.name}: ${c.actions.join(" ")}`).join("; "),
    );
    const left1 = docker([
      "ps",
      "-a",
      "--filter",
      `label=${TASK_LABEL}=${task.id}`,
      "--format",
      "{{.Names}}",
    ]);
    const left2 = docker([
      "network",
      "ls",
      "--filter",
      `label=${TASK_LABEL}=${task.id}`,
      "--format",
      "{{.Name}}",
    ]);
    check(
      "no container or network of the task is left",
      left1.code === 0 && !left1.out && left2.code === 0 && !left2.out,
      `${left1.out || "no container"}; ${left2.out || "no network"}`,
    );

    // The work landed in the project's folder (U-037), as this user.
    const file = path.join(
      home,
      "data",
      "projects",
      project.id,
      "workspace",
      ...TASK_FILE.split("/"),
    );
    result.file = file;
    const there = existsSync(file);
    const text = there ? readFileSync(file, "utf8") : "";
    check(
      `${TASK_FILE} is in the project folder`,
      there && text.trim().length > 0,
      there ? `${text.length} characters` : `${file} is missing`,
    );
    // No check of who owns the file: the daemon writes the coder's files on the host
    // (ContainerSandbox.writeFile), so it is this user's whatever user the container ran as.
    // The container only runs `node --check`, which writes nothing; its `--user` is pinned by
    // packages/runtime/test/sandbox-factory.test.ts and the adapter's integration test.
    const node = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    check(
      `${TASK_FILE} is valid JavaScript (node --check on the host)`,
      node.status === 0,
      node.stderr.trim(),
    );
  }

  function finish() {
    stopEvents();
    result.endedAt = new Date().toISOString();
    writeFileSync(path.join(out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    const md = summaryMarkdown("Full-review task in the Docker sandbox (Linux)", checks);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    const failed = checks.filter((c) => !c.ok).length;
    console.log(
      `${checks.length - failed}/${checks.length} checks passed; result in ${path.join(out, "result.json")}`,
    );
    process.exitCode = failed || checks.length === 0 ? 1 : 0;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
