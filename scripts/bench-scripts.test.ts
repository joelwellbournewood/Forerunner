import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { projectNameFor } from "./bench/journeys/names.cjs";
import {
  agentsDone,
  allDone,
  pageLinks,
  pageParts,
  planCardTasks,
  replyNamesTask,
  runnableTasks,
  titlesMissing,
  workFiles,
  // @ts-expect-error plain JS module
} from "./bench/journeys/smoke-checks.cjs";
// @ts-expect-error plain JS module
import { daemonArgv, daemonEnv, liveKey, setupEnv, supervisedArgv } from "./bench/lib.mjs";

/**
 * The bench scripts with a real model (scripts/bench/README.md; the live run of 2026-11-01): what
 * the model calls cost by kind for the live helper's spend cap, the daemon's environment, and a
 * live start that fails at once and says why instead of waiting.
 */
const BENCH = join(import.meta.dirname, "bench");
const node = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, args, { encoding: "utf8", env, timeout: 110_000 });

describe("bench: calls.mjs", () => {
  const log = () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-bench-calls-"));
    const file = join(dir, "model-calls.jsonl");
    const line = (role: string, model: string, usd: number | null) =>
      JSON.stringify({ role, model, usd, reply: { text: "" } });
    writeFileSync(
      file,
      `${[
        line("intake", "claude-sonnet-5-5", 0.063592),
        line("intake", "claude-sonnet-5-5", 0.056163),
        line("specialist", "claude-sonnet-5-5", 0.02),
        line("critic", "claude-sonnet-5-5", 0.019),
        line("chat", "claude-haiku-5-5", 0.0007),
        line("chat", "fake-haiku", null),
      ].join("\n")}\n`,
    );
    return file;
  };

  it("prints calls and USD by kind, and the calls without a price", () => {
    const r = node([join(BENCH, "calls.mjs"), "--log", log()]);
    expect(r.status).toBe(0);
    const out = r.stdout.split("\n");
    expect(out[0]).toBe("model calls: 6 calls, USD 0.159 (1 without a price)");
    expect(out[1]).toMatch(/^ {2}intake +2 calls {2}USD 0\.120 {2}\(claude-sonnet-5-5\)$/);
    expect(out[2]).toMatch(/^ {2}specialist +1 call {3}USD 0\.020/);
    expect(out[3]).toMatch(/^ {2}critic +1 call {3}USD 0\.019/);
    expect(out[4]).toMatch(/^ {2}chat +2 calls {2}USD 0\.001 {2}\(claude-haiku-5-5, fake-haiku\)$/);
    expect(out[5]).toBe("  without a price: fake-haiku x1");
  });

  it("--cap says what is left, and at the cap says so and exits 3", () => {
    const file = log();
    const under = node([join(BENCH, "calls.mjs"), "--log", file, "--cap", "2"]);
    expect(under.status).toBe(0);
    expect(under.stdout).toContain("cap USD 2.000: USD 1.841 left");
    const over = node([join(BENCH, "calls.mjs"), "--log", file, "--cap", "0.1"]);
    expect(over.status).toBe(3);
    expect(over.stdout).toContain("OVER the cap of USD 0.100 by USD 0.059");
    const json = node([join(BENCH, "calls.mjs"), "--log", file, "--json"]);
    expect(JSON.parse(json.stdout).byKind.intake).toEqual({
      calls: 2,
      usd: expect.closeTo(0.119755, 6),
      models: ["claude-sonnet-5-5"],
    });
  });
});

describe("bench: the daemon's environment and a live start", () => {
  // Built in parts so the secret scan does not take the test value for a key (not-a-secret).
  const KEY = ["sk-ant-api03-", "bench", "7".repeat(40)].join("");

  it("the vault is a file in the bench's home; the key reaches bench-live only, as ANTHROPIC_API_KEY", () => {
    const saved = { ...process.env };
    try {
      delete process.env.ANTHROPIC_API_KEY;
      process.env.FORERUNNER_ANTHROPIC_KEY = KEY;
      process.env.GITHUB_TOKEN = "gh-from-the-environment";
      expect(liveKey()).toBe(KEY);
      const live = daemonEnv({ home: "/h", provider: "bench-live", extra: {} });
      expect(live.ANTHROPIC_API_KEY).toBe(KEY);
      expect(live.FORERUNNER_ANTHROPIC_KEY).toBeUndefined();
      expect(live.FORERUNNER_VAULT_BACKEND).toBe("file");
      expect(live.GITHUB_TOKEN).toBeUndefined();
      const stand = daemonEnv({ home: "/h", provider: "bench", extra: {} });
      expect(stand.ANTHROPIC_API_KEY).toBeUndefined();
      expect(stand.FORERUNNER_HOME).toBe("/h");
      expect(stand.FORERUNNER_VAULT_BACKEND).toBe("file");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("fr setup gets the key and the --env API base, so a live start can be dry-run against a local stand-in of the API", () => {
    const saved = { ...process.env };
    try {
      process.env.ANTHROPIC_API_KEY = KEY;
      process.env.ANTHROPIC_BASE_URL = "https://proxy.example.test";
      process.env.FORERUNNER_ANTHROPIC_API = "https://from-the-shell.example.test";
      // The live helper's dry run: the daemon's provider and setup's key check both go to the stub.
      const stub = setupEnv({
        home: "/h",
        extra: { FORERUNNER_BENCH_LIVE_API: "http://127.0.0.1:9" },
      });
      expect(stub.FORERUNNER_ANTHROPIC_KEY).toBe(KEY);
      expect(stub.FORERUNNER_ANTHROPIC_API).toBe("http://127.0.0.1:9");
      expect(stub.ANTHROPIC_API_KEY).toBeUndefined();
      expect(stub.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(stub.FORERUNNER_HOME).toBe("/h");
      expect(stub.FORERUNNER_VAULT_BACKEND).toBe("file");
      // Named on its own, setup's base wins; with neither, setup checks the key with Anthropic
      // (the shell's own FORERUNNER_* never reach it).
      expect(
        setupEnv({ home: "/h", extra: { FORERUNNER_ANTHROPIC_API: "http://127.0.0.1:8" } })
          .FORERUNNER_ANTHROPIC_API,
      ).toBe("http://127.0.0.1:8");
      expect(setupEnv({ home: "/h", extra: {} }).FORERUNNER_ANTHROPIC_API).toBeUndefined();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  const withoutKeys = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FRBENCH_ROOT: mkdtempSync(join(tmpdir(), "fr-bench-root-")),
    };
    delete env.ANTHROPIC_API_KEY;
    delete env.FORERUNNER_ANTHROPIC_KEY;
    return env;
  };

  it("start.mjs --provider bench-live without a key ends at once with the reason, nothing started", () => {
    const r = node(
      [
        join(BENCH, "start.mjs"),
        "--name",
        "nokey",
        "--daemon-port",
        "1",
        "--ui-port",
        "2",
        "--provider",
        "bench-live",
      ],
      withoutKeys(),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "--provider bench-live needs ANTHROPIC_API_KEY (or FORERUNNER_ANTHROPIC_KEY) in the environment",
    );
    expect(r.stderr).toContain("Nothing was started.");
  });

  it("a daemon that exits during its start ends the wait at once with its log (before: 120 s)", () => {
    const env = withoutKeys();
    const home = mkdtempSync(join(tmpdir(), "fr-bench-home-"));
    // The daemon itself refuses bench-live without a key and exits; the start says so.
    const script = `import(${JSON.stringify(pathToFileURL(join(BENCH, "lib.mjs")).href)}).then((m) => m.startDaemon({ dir: ${JSON.stringify(home)}, home: ${JSON.stringify(home)}, provider: "bench-live", port: 0, extra: {} }))`;
    const r = node(["--input-type=module", "-e", script], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the daemon exited during its start");
    expect(r.stderr).toContain("needs ANTHROPIC_API_KEY");
  }, 120_000);

  it("--githost: the stand-in for GitHub serves an empty and a seeded repository with its token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-bench-githost-"));
    // startGithost waits for the JSON; the server stays up until it is ended.
    const script = `import(${JSON.stringify(pathToFileURL(join(BENCH, "lib.mjs")).href)}).then(async (m) => { const g = await m.startGithost({ dir: ${JSON.stringify(dir)}, port: 0 }); console.log(JSON.stringify(g)); })`;
    const r = node(["--input-type=module", "-e", script]);
    expect(r.status, r.stderr).toBe(0);
    const g = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}") as {
      pid: number;
      url: string;
      token: string;
      repos: string[];
    };
    try {
      expect(g.repos).toEqual(["bench/empty", "bench/seeded"]);
      const get = (path: string) =>
        fetch(`${g.url}${path}`, { headers: { authorization: `Bearer ${g.token}` } });
      const empty = await get("/repos/bench/empty/branches");
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual([]);
      const seeded = (await (await get("/repos/bench/seeded/branches")).json()) as {
        name: string;
      }[];
      expect(seeded.map((b) => b.name)).toEqual(["main"]);
    } finally {
      try {
        process.kill(-g.pid, "SIGTERM");
      } catch {
        process.kill(g.pid, "SIGTERM");
      }
    }
  }, 120_000);
});

/**
 * The smoke journey's checks hold for a real model (the live run of 2026-11-01: 4 of 14 checks
 * passed, and the failures were the bench's: it looked for the stand-in's task titles, file
 * names and "[stand-in model]" in the chat reply, and passed "every planned task is done" on 0
 * of 0 tasks). These are what the live plan, files and reply looked like.
 */
/**
 * Finishing setup with a new credential restarts the daemon (`POST /setup/finish`: restart.json
 * and exit 86, packages/runtime/src/daemon/restart.ts); the desktop shell starts it again. The
 * bench had nothing that did, so the daemon stayed gone and the UI "not connected" (gh1, live2
 * #13). A stand-in daemon here writes daemon.json and answers /health as the real one does.
 */
describe("bench: the supervisor starts the daemon again when it asks to restart (exit 86), as the desktop shell does", () => {
  const SUPERVISE = join(BENCH, "supervise.mjs");
  const FAKE = [
    'import { createServer } from "node:http";',
    'import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";',
    // Every file is given by the test (the paths are built with @forerunner/platform there).
    "const [mode, runtime, countFile, daemonFile, restartFile] = process.argv.slice(2);",
    "mkdirSync(runtime, { recursive: true });",
    'const n = (existsSync(countFile) ? Number(readFileSync(countFile, "utf8")) : 0) + 1;',
    "writeFileSync(countFile, String(n));",
    "console.log('stand-in daemon: start ' + n);",
    "const askRestart = () => writeFileSync(restartFile, JSON.stringify({ schema: 1, reason: 'setup', targetVersion: '1.0.4', fromVersion: '1.0.4', pid: process.pid, exitCode: 86 }));",
    "const server = createServer((req, res) => { res.writeHead(200); res.end('ok'); });",
    'server.listen(0, "127.0.0.1", () => {',
    "  const url = 'http://127.0.0.1:' + server.address().port;",
    "  writeFileSync(daemonFile, JSON.stringify({ url, token: 'token-' + n, pid: process.pid }));",
    "  if (mode === 'restart' && n === 1) { askRestart(); setTimeout(() => process.exit(86), 100); }",
    "  else if (mode === 'restart') {",
    "    // Up again: it quits once bench.json names this start's token (the supervisor wrote it).",
    "    setInterval(() => { try { if (JSON.parse(readFileSync(process.env.TEST_BENCH_FILE, 'utf8')).token === 'token-' + n) process.exit(0); } catch {} }, 100);",
    "  }",
    "  else if (mode === 'again') { askRestart(); setTimeout(() => process.exit(86), 100); }",
    "  else if (mode === 'no-request') setTimeout(() => process.exit(86), 100);",
    "  else setTimeout(() => process.exit(3), 100);",
    "});",
  ].join("\n");
  const supervised = (mode: string) => {
    const dir = mkdtempSync(join(tmpdir(), "fr-bench-supervise-"));
    const home = join(dir, "home");
    const benchFile = join(dir, "bench.json");
    const daemon = join(dir, "stand-in-daemon.mjs");
    writeFileSync(daemon, FAKE);
    writeFileSync(
      benchFile,
      JSON.stringify({ name: "sup", token: "token-0", daemonUrl: "http://old", restarts: [] }),
    );
    const runtime = join(home, "runtime");
    const files = [
      runtime,
      join(runtime, "starts"),
      join(runtime, "daemon.json"),
      join(runtime, "restart.json"),
    ];
    const r = spawnSync(
      process.execPath,
      [
        SUPERVISE,
        "--home",
        home,
        "--bench",
        benchFile,
        "--",
        process.execPath,
        daemon,
        mode,
        ...files,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TEST_BENCH_FILE: benchFile },
        timeout: 60_000,
      },
    );
    const starts = Number(readFileSync(join(runtime, "starts"), "utf8"));
    return { r, out: `${r.stdout}${r.stderr}`, starts, home, benchFile };
  };

  it("exit 86 with a restart request: started again, the request removed, bench.json gets the new token and pid", () => {
    const { r, out, starts, home, benchFile } = supervised("restart");
    expect(r.status, out).toBe(0);
    expect(starts).toBe(2);
    expect(out).toMatch(
      /=== bench supervisor .*: the daemon exited with 86 and asked for a restart \(setup\); starting it again, as the desktop shell does/,
    );
    expect(out).toMatch(
      /=== bench supervisor .*: the daemon is back at http:\/\/127\.0\.0\.1:\d+ \(pid \d+\); bench\.json has its new token/,
    );
    expect(out).toMatch(/the daemon exited with 0; not started again/);
    const b = JSON.parse(readFileSync(benchFile, "utf8"));
    expect(b).toMatchObject({ name: "sup", token: "token-2" });
    expect(b.daemonUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(b.daemonNodePid).toBeGreaterThan(0);
    expect(b.restarts).toEqual([
      expect.objectContaining({ by: "supervisor", reason: "setup", hard: false }),
    ]);
    // The desktop shell removes the request once it acted on it; so does the supervisor.
    expect(() => readFileSync(join(home, "runtime", "restart.json"))).toThrow();
  }, 90_000);

  it("any other exit, or 86 without a request, ends it with the daemon's code; a daemon that keeps asking is started again once", () => {
    const plain = supervised("crash");
    expect(plain.r.status).toBe(3);
    expect(plain.starts).toBe(1);
    expect(plain.out).toMatch(/the daemon exited with 3; not started again/);
    const bare = supervised("no-request");
    expect(bare.r.status).toBe(86);
    expect(bare.starts).toBe(1);
    expect(bare.out).toMatch(
      /the daemon exited with 86 without a restart request; not started again/,
    );
    const again = supervised("again");
    expect(again.r.status).toBe(86);
    expect(again.starts).toBe(2);
    expect(again.out).toMatch(
      /asked for a restart \(setup\) 2 times in a row without staying up; not started again/,
    );
    expect(JSON.parse(readFileSync(again.benchFile, "utf8")).token).toBe("token-0");
  }, 90_000);

  it("start.mjs and restart-daemon.mjs run the daemon under it (lib.mjs startDaemon)", () => {
    const argv = supervisedArgv("bench", 48103, { home: "/h", benchFile: "/b/bench.json" });
    expect(argv.slice(1, 7)).toEqual([SUPERVISE, "--home", "/h", "--bench", "/b/bench.json", "--"]);
    expect(argv.slice(7)).toEqual(daemonArgv("bench", 48103));
    expect(readFileSync(join(BENCH, "lib.mjs"), "utf8")).toMatch(
      /spawnLogged\(\s*supervisedArgv\(/,
    );
  });
});

describe("bench: the intake journey names the project after the brief (live B, 2026-11-02)", () => {
  const at = new Date("2026-11-02T16:45:30.000Z");

  it("without --project the name is the brief's first words and the time, not 'Quote page'", () => {
    expect(projectNameFor("A todo list", at)).toBe("A todo list 16:45:30");
    expect(projectNameFor("  A todo list.\nWith due dates", at)).toBe("A todo list 16:45:30");
    // A long brief is cut at a word, at most 40 characters before the time.
    const long = projectNameFor(
      "A small web app that tracks the books I read and lends to friends",
      at,
    );
    expect(long).toBe("A small web app that tracks the books I 16:45:30");
    expect(long.length).toBeLessThanOrEqual(49);
    expect(projectNameFor("", at)).toBe("Project 16:45:30");
  });

  it("intake.cjs uses it when --project is not given", () => {
    const script = readFileSync(join(BENCH, "journeys", "intake.cjs"), "utf8");
    expect(script).toContain('const PROJECT = opt("--project", projectNameFor(BRIEF));');
    expect(script).not.toMatch(/`Quote page \$\{/);
  });
});

describe("bench: the smoke journey's checks on structure and states", () => {
  type T = {
    id: string;
    title: string;
    status: string;
    dependsOn?: string[];
    display?: { key: string; label: string };
  };
  const done = { key: "done", label: "Done" };
  const LIVE: T[] = [
    { id: "a", title: "Build the quote page", status: "done", display: done },
    {
      id: "b",
      title: "Test the pick logic and page rendering",
      status: "done",
      dependsOn: ["a"],
      display: done,
    },
    {
      id: "c",
      title: "Human decisions: hosting, repository, quote source",
      status: "needs_human",
      display: { key: "answer", label: "Needs your answer" },
    },
    {
      id: "d",
      title: "Publish the page and write the runbook",
      status: "ready",
      dependsOn: ["c"],
      display: { key: "waiting", label: 'Waiting for "Human decisions: hosting, repository,…"' },
    },
  ];

  it("every planned task is done fails on 0 of 0 tasks, and says how many", () => {
    expect(allDone([])).toEqual({ ok: false, detail: "0/0 done" });
    expect(allDone(LIVE).ok).toBe(false);
    expect(allDone(LIVE.slice(0, 2))).toEqual({ ok: true, detail: "2/2 done" });
  });

  it("the agents' work is done when the rest waits on the person, also through what it waits for", () => {
    const r = agentsDone(LIVE);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("2/4 done; waiting on you or Docker:");
    expect(r.detail).toContain('"Publish the page and write the runbook"');
    expect(agentsDone([]).ok).toBe(false);
    // A ready task nobody holds is not done work.
    const ready = { key: "ready", label: "Ready" };
    const left: T[] = [
      ...LIVE.slice(0, 2),
      { id: "e", title: "Write the README", status: "ready", display: ready },
    ];
    expect(agentsDone(left).ok).toBe(false);
    expect(agentsDone(left).detail).toContain('not done: "Write the README": Ready');
  });

  /**
   * The review of 2026-11-02 walked live mode against the real intake replies: the first task
   * ended needing the person's decision, the others waited on it or on the person's own task, and
   * none was done. The journey's loop asked "is the agents' work done?", which needs a task done,
   * so it pressed Start; Start was disabled ("Nothing can run: … needs your answer"), the click
   * threw after 30 s and the files and chat checks never ran.
   */
  it("nothing is left for a session when every open task waits on the person, also with none done", () => {
    const ready = { key: "ready", label: "Ready" };
    const HELD: T[] = [
      {
        id: "a",
        title: "Build the quote page",
        status: "needs_human",
        display: { key: "answer", label: "Needs your decision" },
      },
      {
        id: "b",
        title: "Test the pick logic and page rendering",
        status: "ready",
        dependsOn: ["a"],
        display: { key: "waiting", label: 'Waiting for "Build the quote page"' },
      },
      LIVE[2] as T,
      LIVE[3] as T,
    ];
    expect(runnableTasks(HELD)).toEqual([]);
    // The check itself stays as it was: nothing the agents could do was done.
    expect(agentsDone(HELD).ok).toBe(false);
    expect(runnableTasks(LIVE)).toEqual([]);
    expect(runnableTasks([])).toEqual([]);
    // A ready task nobody holds, or one running, is left for a session.
    const free: T = { id: "e", title: "Write the README", status: "ready", display: ready };
    const running: T = {
      id: "r",
      title: "Style the page",
      status: "in_progress",
      display: { key: "running", label: "Running" },
    };
    expect(runnableTasks([...HELD, free, running]).map((t: T) => t.title)).toEqual([
      "Write the README",
      "Style the page",
    ]);
    // Stuck on a failed task, waiting for Docker, failed, a draft or cancelled: no session runs it.
    const none: T[] = [
      {
        id: "s",
        title: "Check the page",
        status: "ready",
        dependsOn: ["f"],
        display: { key: "stuck", label: 'Stuck: "Build" failed' },
      },
      { id: "f", title: "Build", status: "failed", display: { key: "failed", label: "Failed" } },
      {
        id: "k",
        title: "Publish",
        status: "ready",
        display: { key: "docker", label: "Waiting for Docker" },
      },
      { id: "d", title: "Draft", status: "draft", display: { key: "draft", label: "Draft" } },
      {
        id: "c",
        title: "Old",
        status: "cancelled",
        display: { key: "cancelled", label: "Cancelled" },
      },
    ];
    expect(runnableTasks(none)).toEqual([]);
  });

  it("the plan card's task count and titles, whatever the titles are", () => {
    const card = [
      'Plan for "Quote page": 4 tasks',
      "Build the quote page · coder · about CHF 0.64",
      "Test the pick logic and page rendering · tester",
      "Human decisions: hosting, repository, quote source · you",
      "Publish the page and write the runbook · ops-deploy · Needs Docker",
    ].join("\n");
    expect(planCardTasks(card, "Quote page")).toBe(4);
    expect(planCardTasks('Plan for "Quote page": 1 task', "Quote page")).toBe(1);
    expect(planCardTasks("Nothing waits on you.", "Quote page")).toBeNull();
    expect(
      titlesMissing(
        card,
        LIVE.map((t) => t.title),
      ),
    ).toEqual([]);
    expect(titlesMissing(card, ["Write the FAQ"])).toEqual(["Write the FAQ"]);
  });

  it("a chat reply names a task by its title, as a real reply or the stand-in's does", () => {
    const titles = LIVE.map((t) => t.title);
    const real =
      'The last session did "Build the quote page" and "Test the pick logic and page rendering"; "Human decisions" needs your answers.';
    expect(replyNamesTask(real, titles)).toBe("Build the quote page");
    expect(replyNamesTask("[stand-in model] I was given a task list.", titles)).toBeNull();
    expect(replyNamesTask('First task: "Build the quote page": Done.', titles)).toBe(
      "Build the quote page",
    );
  });

  it("the files the work wrote and what the page links, whatever their names", () => {
    const files = [
      ".git/HEAD",
      ".forerunner/project.json",
      "docs/overview.md",
      "index.html",
      "style.css",
      "quotes.js",
      "app.js",
      "test/pick.test.js",
    ];
    const written = workFiles(files);
    expect(written).toEqual([
      "index.html",
      "style.css",
      "quotes.js",
      "app.js",
      "test/pick.test.js",
    ]);
    const html =
      '<link rel="stylesheet" href="style.css"><script src="quotes.js"></script><script src="app.js"></script>';
    expect(pageLinks(html, written)).toEqual({ css: ["style.css"], js: ["quotes.js", "app.js"] });
  });

  it("the page's stylesheet and script: written files it links, or inline; a link to a file not written shows", () => {
    const written = ["index.html", "style.css", "quotes.js", "app.js"];
    expect(
      pageParts(
        '<link rel="stylesheet" href="style.css"><script src="quotes.js"></script><script src="./app.js"></script>',
        written,
      ),
    ).toEqual({ css: ["style.css"], js: ["quotes.js", "app.js"], missing: [] });
    // A real coder may keep it in one file, as "plain HTML, CSS and JavaScript" allows.
    expect(
      pageParts("<style>body { margin: 0 }</style><p id=q></p><script>const quotes = []</script>", [
        "index.html",
      ]),
    ).toEqual({ css: ["inline <style>"], js: ["inline <script>"], missing: [] });
    // A page that links what was never written, next to a CDN script (not a project file).
    expect(
      pageParts(
        '<link rel="stylesheet" href="css/main.css"><script src="https://cdn.example.test/x.js"></script><script src="main.js"></script>',
        ["index.html"],
      ),
    ).toEqual({ css: [], js: [], missing: ["css/main.css", "main.js"] });
  });
});

describe("w8-two-homes, wave 8: the bench recorder writes no daemon token (L4i-left-54)", () => {
  // The UI puts the daemon token in the query of its streams (apps/ui/src/api/client.ts), so a
  // "Failed to load resource" after a daemon restart carries the old token in its text and its
  // location's URL; the recorder wrote console lines raw into steps/problems.jsonl.
  const recorder = createRequire(import.meta.url)("./bench/recorder.cjs") as {
    redactRecord: (rec: unknown, tokens: string[]) => unknown;
    recordProblem: (name: string, rec: unknown, afterStep?: string | null) => void;
  };
  const OLD = "fr-bench-token-old-0123456789";
  const NEW = "fr-bench-token-new-9876543210";

  it("a console line's text and location, a page error's stack and a body lose ?token= and every known token", () => {
    const out = JSON.stringify(
      recorder.redactRecord(
        {
          kind: "console",
          text: `Failed to load resource: net::ERR_CONNECTION_REFUSED http://127.0.0.1:49260/events?token=${OLD}`,
          location: { url: `http://127.0.0.1:49260/events?token=${OLD}&x=1`, lineNumber: 0 },
          stack: [`at http://127.0.0.1:2860/assets/index.js (token ${NEW})`],
          body: `{"message":"bad token ${NEW}"}`,
        },
        [OLD, NEW],
      ),
    );
    expect(out).not.toContain(OLD);
    expect(out).not.toContain(NEW);
    expect(out).toContain("/events?token=[REDACTED]&x=1");
  });

  it("across a daemon restart: an old page's line with the old token is written without it", () => {
    const root = mkdtempSync(join(tmpdir(), "fr-bench-redact-"));
    const prev = process.env.FRBENCH_ROOT;
    process.env.FRBENCH_ROOT = root;
    try {
      const benchDir = join(root, "ada");
      mkdirSync(benchDir, { recursive: true });
      const benchFile = join(benchDir, "bench.json");
      writeFileSync(benchFile, JSON.stringify({ name: "ada", token: OLD }));
      recorder.recordProblem("ada", { kind: "http", status: 500, url: "/projects" });
      // The daemon restarted: bench.json names the new token; the old page still says the old.
      writeFileSync(benchFile, JSON.stringify({ name: "ada", token: NEW }));
      recorder.recordProblem("ada", {
        kind: "console",
        text: `Failed to load resource: the server responded with a status of 401 (${OLD})`,
        location: { url: `http://127.0.0.1:49260/events?token=${OLD}` },
      });
      recorder.recordProblem("ada", { kind: "console", text: `stream with token ${NEW}` });
      const written = readFileSync(join(benchDir, "steps", "problems.jsonl"), "utf8");
      expect(written.trim().split("\n")).toHaveLength(3);
      expect(written).not.toContain(OLD);
      expect(written).not.toContain(NEW);
    } finally {
      if (prev === undefined) delete process.env.FRBENCH_ROOT;
      else process.env.FRBENCH_ROOT = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("w8-two-homes, wave 8: two people's benches on one GitHub (W8-homes-3, -4, -5)", () => {
  const checks = createRequire(import.meta.url)("./bench/journeys/two-people-checks.cjs") as {
    STEPS: {
      n: number;
      walked?: boolean;
      checks: { id: string; known?: boolean; owner?: string }[];
    }[];
    allChecks: () => { id: string; step: number; known: boolean; owner?: string }[];
    privateOnGithub: (text: string) => string[];
    summarize: (c: { id: string; ok: boolean; known?: boolean; owner?: string }[]) => unknown;
  };
  // The wave 8 areas a known gap can belong to (wave8-plan.json): a gap with no owner would
  // never lose its mark.
  const AREAS = [
    "w8-shared-repo",
    "w8-repo-guide",
    "w8-status-read",
    "w8-status-write",
    "w8-github-feed",
    "w8-issue-host",
  ];

  it("the journey names the 16 steps in order; each known gap names its area; an unwalked step holds only known gaps", () => {
    expect(checks.STEPS.map((s) => s.n)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    const all = checks.allChecks();
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
    for (const c of all.filter((c) => c.known)) expect(AREAS, c.id).toContain(c.owner);
    for (const s of checks.STEPS.filter((s) => s.walked === false))
      expect(
        s.checks.every((c) => c.known),
        `step ${s.n}`,
      ).toBe(true);
    // The checks this area is built to pass are not marked known (W8-homes-5).
    const byId = new Map(all.map((c) => [c.id, c]));
    for (const id of [
      "install-ids-differ",
      "together-same-id",
      "press-writes-nothing",
      "own-prs-only",
      "no-write-to-other",
      "cut-only-bob",
      "restart-keeps-together",
    ])
      expect(byId.get(id)?.known, id).toBe(false);
  });

  it("text bound for GitHub: a money figure, an email address and an @mention are found; a noreply address is not", () => {
    expect(checks.privateOnGithub("Spent CHF 3.20 so far")).toEqual(["a money figure"]);
    expect(checks.privateOnGithub("costs $4")).toEqual(["a money figure"]);
    expect(checks.privateOnGithub("ask ada@example.com")).toEqual(["an email address"]);
    expect(checks.privateOnGithub("thanks @bob for the review")).toEqual(["an @mention"]);
    expect(checks.privateOnGithub("Co-authored-by: Ada <1+ada@users.noreply.github.com>")).toEqual(
      [],
    );
    expect(checks.privateOnGithub("Adds the contact page (2 files)")).toEqual([]);
  });

  it("the summary: a failing known gap is not a failure; a passing known gap is named so its mark goes", () => {
    expect(
      checks.summarize([
        { id: "a", ok: true },
        { id: "b", ok: false },
        { id: "c", ok: false, known: true, owner: "w8-status-read" },
        { id: "d", ok: true, known: true, owner: "w8-github-feed" },
      ]),
    ).toEqual({
      checks: 4,
      passed: 2,
      failed: ["b"],
      known: ["c (w8-status-read)"],
      knownPassing: ["d"],
      ok: false,
    });
    expect(checks.summarize([{ id: "c", ok: false, known: true, owner: "x" }])).toMatchObject({
      ok: true,
    });
  });

  it("start.mjs refuses GitHub options that do not fit, before it starts anything", () => {
    const root = mkdtempSync(join(tmpdir(), "fr-bench-flags-"));
    try {
      const env = { ...process.env, FRBENCH_ROOT: root };
      const cases: [string[], string][] = [
        [["--githost", "3", "--githost-shared", "ada"], "pick one"],
        [["--githost-shared"], "needs the other bench's name"],
        [["--githost-shared", "bob"], "names this bench itself"],
        [["--users", "ada,bob"], "--users shapes the stand-in"],
        [["--org", "team"], "--org shapes the stand-in"],
        [["--githost-user", "bob"], "--githost-user <login> needs"],
      ];
      for (const [extra, words] of cases) {
        const r = node(
          [
            join(BENCH, "start.mjs"),
            "--name",
            "bob",
            "--daemon-port",
            "1",
            "--ui-port",
            "2",
            ...extra,
          ],
          env,
        );
        expect(r.status, extra.join(" ")).toBe(1);
        expect(r.stderr, extra.join(" ")).toContain(words);
      }
      // Nothing was started: no bench.json was written.
      expect(existsSync(join(root, "bob", "bench.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cut.mjs: GitHub off for one bench refuses its connections while the other bench still reaches GitHub; on again, it answers", async () => {
    const root = mkdtempSync(join(tmpdir(), "fr-bench-cut-"));
    const github = createHttpServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => github.listen(0, "127.0.0.1", () => r()));
    const target = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
    const proxies: ChildProcess[] = [];
    const env = { ...process.env, FRBENCH_ROOT: root };
    try {
      const urls = new Map<string, string>();
      for (const name of ["ada", "bob"]) {
        const dir = join(root, name);
        mkdirSync(dir, { recursive: true });
        const port = await freePortHere();
        const child = spawn(
          process.execPath,
          [
            join(BENCH, "github-proxy.mjs"),
            "--port",
            String(port),
            "--target",
            target,
            "--dir",
            dir,
          ],
          { stdio: "ignore" },
        );
        proxies.push(child);
        writeFileSync(
          join(dir, "bench.json"),
          JSON.stringify({ name, pids: { githubProxy: child.pid } }),
        );
        urls.set(name, `http://127.0.0.1:${port}`);
        await waitUntil(() => proxyState(dir) === "on");
      }
      const reach = (name: string) =>
        fetch(urls.get(name) as string, { signal: AbortSignal.timeout(3000) }).then(
          (r) => r.status,
          () => "refused",
        );
      expect(await reach("ada")).toBe(200);
      expect(await reach("bob")).toBe(200);

      const off = await nodeAsync([join(BENCH, "cut.mjs"), "bob", "github", "off"], env);
      expect(off.code, off.err).toBe(0);
      expect(off.out).toContain("GitHub unreachable for this home only");
      expect(await reach("bob")).toBe("refused");
      expect(await reach("ada")).toBe(200);

      const on = await nodeAsync([join(BENCH, "cut.mjs"), "bob", "github", "on"], env);
      expect(on.code, on.err).toBe(0);
      expect(await reach("bob")).toBe(200);
    } finally {
      for (const p of proxies) p.kill("SIGTERM");
      await new Promise<void>((r) => github.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("stop.mjs --clean: with every recorded process gone it removes the home, logs and stand-in data, keeps steps/ and bench.json, and keeps a home outside the bench root", () => {
    const root = mkdtempSync(join(tmpdir(), "fr-bench-clean-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "fr-bench-home-elsewhere-"));
    try {
      const env = { ...process.env, FRBENCH_ROOT: root };
      const dir = join(root, "ada");
      for (const sub of ["home/data", "githost/team", "steps", "profile"])
        mkdirSync(join(dir, sub), { recursive: true });
      for (const f of ["daemon.log", "ui.log", "githost.json", "github-proxy.json", "steps/01.png"])
        writeFileSync(join(dir, f), "x");
      writeFileSync(
        join(dir, "bench.json"),
        JSON.stringify({ name: "ada", home: join(dir, "home"), pids: {} }),
      );
      const r = node([join(BENCH, "stop.mjs"), "--name", "ada", "--clean"], env);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("cleaned: no process left");
      expect(readdirSync(dir).sort()).toEqual(["bench.json", "steps"]);
      expect(readdirSync(join(dir, "steps"))).toEqual(["01.png"]);

      const other = join(root, "bob");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(elsewhere, "keep.txt"), "mine");
      writeFileSync(
        join(other, "bench.json"),
        JSON.stringify({ name: "bob", home: elsewhere, pids: {} }),
      );
      const kept = node([join(BENCH, "stop.mjs"), "--name", "bob", "--clean"], env);
      expect(kept.status, kept.stderr).toBe(0);
      expect(kept.stdout).toContain("kept the home");
      expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("mine");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("stop.mjs --clean removes nothing while a recorded process still runs, and says which", async () => {
    const root = mkdtempSync(join(tmpdir(), "fr-bench-clean-alive-"));
    // A process this test started, recorded under a label stop.mjs does not end.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    try {
      const env = { ...process.env, FRBENCH_ROOT: root };
      const dir = join(root, "ada");
      mkdirSync(join(dir, "home"), { recursive: true });
      writeFileSync(join(dir, "daemon.log"), "x");
      writeFileSync(
        join(dir, "bench.json"),
        JSON.stringify({ name: "ada", home: join(dir, "home"), pids: { helper: child.pid } }),
      );
      const r = await nodeAsync([join(BENCH, "stop.mjs"), "--name", "ada", "--clean"], env);
      expect(r.code).toBe(1);
      expect(r.out).toContain(`not cleaned: still running helper ${child.pid}`);
      expect(readdirSync(dir).sort()).toEqual(["bench.json", "daemon.log", "home"]);
    } finally {
      child.kill("SIGTERM");
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function proxyState(dir: string): string | null {
  try {
    return JSON.parse(readFileSync(join(dir, "github-proxy.json"), "utf8")).state ?? null;
  } catch {
    return null;
  }
}

async function waitUntil(check: () => boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

function freePortHere(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** A node script run without blocking this process (the test's own servers keep answering). */
function nodeAsync(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}
