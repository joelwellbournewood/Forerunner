import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { daemonEnv, liveKey, setupEnv } from "./bench/lib.mjs";

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
