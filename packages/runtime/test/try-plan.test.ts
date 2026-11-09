import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, run } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import { runMarkerCheck } from "../src/loop/critic.ts";
import {
  CHANGED_SCRIPT_SUFFIX,
  markerChecks,
  projectChecks,
  scriptsBefore,
  untestedFiles,
} from "../src/loop/project-checks.ts";
import { commandsIn, planTries, TRY_FOLDER } from "../src/loop/try-plan.ts";

/**
 * What a task's work is tried as, and which of the project's tests run (ADR 0110; C-1, C-3,
 * L-5): decided from the brief, the criteria, the README and the files the task made, before
 * anything runs. The runs themselves are in `verification.test.ts`.
 */
const folders: string[] = [];
afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fr try plan "));
  folders.push(root);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const WC = `#!/usr/bin/env node
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
console.log(text.split(/\\s+/).filter(Boolean).length);
`;
const SERVER = `const http = require("http");
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }
  if (req.url === "/items") { res.writeHead(200, { "content-type": "application/json" }); return res.end("[]"); }
  res.writeHead(404); res.end("Not found");
}).listen(PORT);
`;

describe("what is tried (C-1)", () => {
  it("a command line tool the criteria name is run with a sample file for its <file>", () => {
    const root = folder({ "wc.js": WC });
    const plan = planTries({
      changedFiles: ["wc.js"],
      root,
      brief: {
        title: "Write wc.js",
        outcome: "A command line tool: node wc.js <file> prints the number of words",
        criteria: ["`node wc.js <file>` prints the number of words in the file"],
      },
    });
    expect(plan.servers).toEqual([]);
    expect(plan.notTried).toEqual([]);
    // The criterion and the outcome name the same command: it is run once.
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      kind: "command",
      target: "node wc.js <file>",
      argv: ["node", "wc.js", `${TRY_FOLDER}/sample-1.txt`],
      source: "an acceptance criterion",
      expectsError: false,
    });
    expect(plan.commands[0]?.samples[0]).toMatchObject({
      path: `${TRY_FOLDER}/sample-1.txt`,
      content: "the quick brown fox\njumps over the lazy dog\n",
      stands: "<file>: a sample text file written for the try (2 lines, 9 words)",
    });
  });

  it("commands are read only where their words end: backticks, a README's code, or a sentence that goes on", () => {
    expect(commandsIn("Run `node greet.js Ada` to greet Ada").map((c) => c.target)).toEqual([
      "node greet.js Ada",
    ]);
    expect(commandsIn("node wc.js <file> prints the count.").map((c) => c.target)).toEqual([
      "node wc.js <file>",
    ]);
    // Where a sentence's command ends is a guess ("Ada" or "Ada prints"?): not run.
    expect(commandsIn("node greet.js Ada prints a greeting")).toEqual([]);
    expect(
      commandsIn("```sh\n$ node wc.js notes.txt\nnpm install\n```").map((c) => c.target),
    ).toEqual(["node wc.js notes.txt"]);
    expect(commandsIn('`echo "a b c" | node wc.js`')[0]).toMatchObject({
      target: 'echo "a b c" | node wc.js',
      stdin: { text: "a b c\n" },
    });
    // Not a command of the work: a test runner, a pipeline the try does not reproduce.
    expect(commandsIn("`python3 -m pytest` and `node --test`")).toEqual([]);
    expect(commandsIn("`node wc.js a.txt > out.txt`")).toEqual([]);
  });

  it("a command at the end of a sentence keeps its placeholder: the full stop is the sentence's, never a file to read from", () => {
    // Before: "<file>." was read as a redirect from a file named "file>.", so the try ran
    // `node wc.js` with a sample on its standard input and showed "node wc.js < file>.".
    const shape = (text: string) =>
      commandsIn(text).map((c) => ({ target: c.target, words: c.words, stdin: c.stdin }));
    for (const text of ["Usage: node wc.js <file>.", "Run it with node wc.js <file>."])
      expect(shape(text)).toEqual([
        { target: "node wc.js <file>", words: ["node", "wc.js", "<file>"], stdin: undefined },
      ]);
    expect(shape("Use python3 cli.py <name>.")).toEqual([
      { target: "python3 cli.py <name>", words: ["python3", "cli.py", "<name>"], stdin: undefined },
    ]);
    // The sentence goes on after a comma: the command ended at its placeholder.
    expect(shape("Count the words with node wc.js <file>, then compare.")).toEqual([
      { target: "node wc.js <file>", words: ["node", "wc.js", "<file>"], stdin: undefined },
    ]);
    // A real redirect at the end of a sentence reads the file the sentence names.
    expect(shape("Run it as node wc.js < notes.txt.")).toEqual([
      {
        target: "node wc.js < notes.txt",
        words: ["node", "wc.js"],
        stdin: { file: "notes.txt" },
      },
    ]);
    // A script written from the folder ("./wc.js") is the same script.
    expect(shape("`node ./wc.js <file>` prints the count")).toEqual([
      { target: "node wc.js <file>", words: ["node", "wc.js", "<file>"], stdin: undefined },
    ]);
  });

  it("a usage line at the end of a sentence runs the tool with a sample for its <file>, as a person would", () => {
    const root = folder({ "wc.js": WC });
    const plan = planTries({
      changedFiles: ["wc.js"],
      root,
      brief: {
        title: "Keep wc.js working",
        outcome: "Usage: node ./wc.js <file>.",
        criteria: ["wc.js keeps working as before: node wc.js <file>."],
      },
    });
    expect(plan.notTried).toEqual([]);
    expect(plan.commands).toHaveLength(1);
    expect(plan.commands[0]).toMatchObject({
      target: "node wc.js <file>",
      argv: ["node", "wc.js", `${TRY_FOLDER}/sample-1.txt`],
      source: "an acceptance criterion",
    });
    expect(plan.commands[0]?.input).toBeUndefined();
  });

  it("a file the folder does not have becomes a sample of that name; an error the brief expects is no problem", () => {
    const root = folder({ "wc.js": WC });
    const plan = planTries({
      changedFiles: ["wc.js"],
      root,
      brief: {
        title: "Write wc.js",
        outcome: "Counts words",
        criteria: [
          "`node wc.js notes.txt` prints 9",
          "`node wc.js` with no file exits with code 1",
        ],
      },
    });
    expect(plan.commands.map((c) => [c.target, c.argv.slice(2), c.expectsError])).toEqual([
      ["node wc.js notes.txt", [`${TRY_FOLDER}/notes.txt`], false],
      ["node wc.js", [], true],
    ]);
  });

  it("a server the task made is started and its routes called: the ones the brief names first", () => {
    const root = folder({ "server.js": SERVER });
    const plan = planTries({
      changedFiles: ["server.js"],
      root,
      brief: {
        title: "Write server.js",
        outcome: 'A tiny HTTP API: node server.js listens on PORT; GET /health answers {"ok":true}',
        criteria: ["GET /health answers 200", "POST /items adds an item"],
      },
    });
    expect(plan.commands).toEqual([]);
    expect(plan.servers).toEqual([
      {
        kind: "server",
        target: "node server.js",
        argv: ["node", "server.js"],
        file: "server.js",
        ports: [3000],
        routes: [
          // The criterion says what it answers: the try's GET is judged against that.
          { path: "/health", documented: true, expect: { status: 200 } },
          { path: "/items", documented: false },
        ],
        skippedRoutes: ["POST /items"],
        source: "the brief",
        expected: true,
      },
    ]);
  });

  it("a route the brief names carries the answer its sentence names: a status, an error, or a call the try cannot make without a token", () => {
    const root = folder({ "server.js": SERVER });
    const plan = planTries({
      changedFiles: ["server.js"],
      root,
      brief: {
        title: "Write server.js",
        outcome: "A members API in server.js",
        criteria: [
          "`node server.js` still answers GET /health with 200",
          "GET /admin answers 401 without a token",
          "GET /nope answers 404; GET /me answers 200 with a valid token",
          "GET /items refuses a request without a key, and GET /list returns the items",
        ],
      },
    });
    expect(plan.servers[0]?.routes).toEqual([
      { path: "/health", documented: true, expect: { status: 200 } },
      { path: "/admin", documented: true, expect: { status: 401 } },
      { path: "/nope", documented: true, expect: { status: 404 } },
      { path: "/me", documented: true, withCredentials: true },
      { path: "/items", documented: true, expect: { error: true } },
    ]);
  });

  it("a server nobody said how to start is started as it is; a library is not started at all", () => {
    const root = folder({
      "src/app.py":
        "from http.server import HTTPServer, BaseHTTPRequestHandler\nHTTPServer(('', 8000), BaseHTTPRequestHandler).serve_forever()\n",
      "src/clamp.js": "export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));\n",
    });
    const plan = planTries({
      changedFiles: ["src/app.py", "src/clamp.js"],
      root,
      brief: { title: "Add the API and clamp", outcome: "", criteria: [] },
    });
    // Nobody asked for it to run: what goes wrong there is told, not held against the task.
    expect(plan.servers.map((s) => [s.target, s.ports, s.source, s.expected])).toEqual([
      ["python3 src/app.py", [8000], "its code", false],
    ]);
    expect(plan.commands).toEqual([]);
    expect(plan.notTried).toEqual([]);
  });

  it("what cannot be tried says why: a tool nobody said how to run, a script that is missing, a web address", () => {
    const root = folder({ "cli.js": WC });
    expect(
      planTries({
        changedFiles: ["cli.js"],
        root,
        brief: { title: "Write cli.js", outcome: "A word counter", criteria: [] },
      }).notTried,
    ).toEqual([
      "cli.js reads its command line, but neither the brief nor a README says how to run it, so it was not tried",
    ]);
    expect(
      planTries({
        changedFiles: ["cli.js"],
        root,
        brief: { title: "x", outcome: "", criteria: ["`node missing.js <file>` prints 3"] },
      }).notTried[0],
    ).toBe("node missing.js <file> was not tried: missing.js is not in the task's folder");
    expect(
      planTries({
        changedFiles: ["cli.js"],
        root,
        brief: { title: "x", outcome: "", criteria: ["`node cli.js <url>` fetches the page"] },
      }).notTried[0],
    ).toBe(
      "node cli.js <url> was not tried: it needs a web address, and the network is off during the try",
    );
  });

  it("a README the task wrote says how to run it: that command is tried", () => {
    const root = folder({
      "cli.js": WC,
      "README.md": "# Words\n\n```\nnode cli.js poem.txt\n```\n",
    });
    const plan = planTries({
      changedFiles: ["cli.js", "README.md"],
      root,
      brief: { title: "Write cli.js", outcome: "A word counter", criteria: [] },
    });
    expect(plan.commands.map((c) => [c.target, c.source])).toEqual([
      ["node cli.js poem.txt", "README.md"],
    ]);
    expect(plan.notTried).toEqual([]);
  });
});

describe("the project's tests whatever the language (C-3)", () => {
  it("Python: pytest, else unittest for unittest tests; Rust: cargo test offline; Go: go test with the proxy off", () => {
    const py = folder({
      "pyproject.toml": '[project]\nname = "calc"\n',
      "tests/test_calc.py":
        "import unittest\nclass T(unittest.TestCase):\n    def test_a(self):\n        pass\n",
    });
    const [m] = markerChecks(py);
    expect(m?.language).toBe("Python");
    expect(m?.candidates.map((c) => c.argv.join(" "))).toEqual([
      "python3 -m pytest -q -p no:cacheprovider",
      "python -m pytest -q -p no:cacheprovider",
      "python3 -m unittest discover -s tests -p test*.py",
      "python -m unittest discover -s tests -p test*.py",
    ]);
    expect(m?.missing).toBe("Python is not installed where the checks run");
    // pytest-style tests need pytest: without it they are not run, and the review says so.
    const pytestOnly = folder({ "test_calc.py": "def test_a():\n    assert 1 + 1 == 2\n" });
    const [p] = markerChecks(pytestOnly);
    expect(p?.candidates.map((c) => c.name)).toEqual(["pytest", "pytest"]);
    expect(p?.missing).toBe("pytest is not installed where the checks run");
    // A package that is not installed is "not run"; the project's own module missing is a failure.
    expect(p?.notRunBecause?.("ModuleNotFoundError: No module named 'requests'", pytestOnly)).toBe(
      "they need the Python package requests, which is not installed where the checks run",
    );
    const own = folder({ "calc.py": "", "test_calc.py": "def test_a():\n    pass\n" });
    expect(markerChecks(own)[0]?.notRunBecause?.("No module named 'calc'", own)).toBeNull();
    const rust = markerChecks(folder({ "Cargo.toml": '[package]\nname = "x"\n' }));
    expect(rust.map((r) => [r.name, r.candidates[0]?.argv.join(" "), r.env])).toEqual([
      ["cargo test", "cargo test --offline", { CARGO_TARGET_DIR: `${TRY_FOLDER}/cargo-target` }],
    ]);
    expect(
      rust[0]?.notRunBecause?.(
        "error: no matching package named `serde` found\nlocation searched: registry `crates-io`",
        "",
      ),
    ).toBe("their dependencies are not on this computer, and the network is off during the checks");
    const go = markerChecks(folder({ "go.mod": "module x\n" }));
    expect(go.map((g) => [g.name, g.candidates[0]?.argv.join(" "), g.env?.GOPROXY])).toEqual([
      ["go test", "go test ./...", "off"],
    ]);
    expect(markerChecks(folder({ "index.html": "<p>hi</p>" }))).toEqual([]);
  });

  it("a test run leaves the folder as the work left it: a lock file it wrote goes, a go.mod it rewrote is put back", async () => {
    // The reviewer's note: `cargo test` writes Cargo.lock, `go test` can rewrite go.mod and
    // go.sum, and the next 'Workspace before' commit or a retry's PR would carry them as the
    // task's work.
    const root = folder({
      "Cargo.toml": '[package]\nname = "calc"\nversion = "0.1.0"\n',
      "src/lib.rs": "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
      "go.mod": "module calc\n\ngo 1.22\n",
    });
    const cargo = markerChecks(root).find((m) => m.name === "cargo test");
    expect(cargo).toBeDefined();
    const ran = await runMarkerCheck(
      cargo as NonNullable<typeof cargo>,
      async (argv) => {
        if (argv[1] === "test") {
          writeFileSync(join(root, "Cargo.lock"), "version = 3\n");
          writeFileSync(
            join(root, "go.mod"),
            "module calc\n\ngo 1.22\n\nrequire example.com/x v1.0.0\n",
          );
        }
        return {
          code: 0,
          signal: null,
          stdout: "test result: ok. 1 passed",
          stderr: "",
          truncated: false,
          timedOut: false,
          durationMs: 5,
        };
      },
      root,
    );
    expect(existsSync(join(root, "Cargo.lock"))).toBe(false);
    expect(readFileSync(join(root, "go.mod"), "utf8")).toBe("module calc\n\ngo 1.22\n");
    expect(ran).toMatchObject({ result: { name: "cargo test", passed: true } });
    const output = "result" in ran ? ran.result.output : "";
    expect(output).toContain("the test run wrote Cargo.lock; removed again");
    expect(output).toContain("the test run changed go.mod; put back as it was");
  });

  it("test files no check runs are told", () => {
    expect(
      untestedFiles(
        folder({ "package.json": '{"scripts":{}}', "test/clamp.test.js": "", "src/clamp.js": "" }),
      ),
    ).toBe(
      "the project has test files (test/clamp.test.js) that no check ran: its package.json names no test script",
    );
    expect(
      untestedFiles(
        folder({ "package.json": '{"scripts":{"test":"node --test"}}', "a.test.js": "" }),
      ),
    ).toBeNull();
  });
});

describe("the scripts that judge the work are the ones before the task (L-5)", () => {
  it("a test script the task changed runs as it was; the new one runs beside it, and the critic is told", () => {
    const root = folder({
      "package.json": JSON.stringify({ scripts: { test: "node --test test/clamp.test.js" } }),
    });
    const c = projectChecks(root, { scripts: { test: "node --test" } });
    expect(c.checks.map((k) => [k.name, k.argv.join(" "), k.required])).toEqual([
      ["test", "npm exec -c node --test", true],
      [`test${CHANGED_SCRIPT_SUFFIX}`, "npm run --silent test", false],
    ]);
    expect(c.notes).toEqual([
      'this task changed the project\'s test script from `node --test` to `node --test test/clamp.test.js`; the check "test" ran it as it was before the task, and "test (as this task changed it)" ran the new one',
    ]);
    // Removed: the old one still judges. Added: it runs, and the critic knows it is new.
    const removed = projectChecks(folder({ "package.json": "{}" }), {
      scripts: { test: "node --test" },
    });
    expect(removed.checks.map((k) => k.argv.join(" "))).toEqual(["npm exec -c node --test"]);
    const added = projectChecks(folder({ "package.json": '{"scripts":{"test":"node --test"}}' }), {
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    });
    expect(added.checks.map((k) => k.argv.join(" "))).toEqual(["npm run --silent test"]);
    expect(added.notes).toEqual(["this task added the project's test script (`node --test`)"]);
  });

  it("the scripts before the task come from the folder's commit before its first run", async () => {
    const root = folder({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) });
    const git = (args: string[]) =>
      run(["git", ...args], {
        cwd: root,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@x.test",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@x.test",
        },
      });
    await git(["init", "-q", "-b", "main"]);
    await git(["add", "-A"]);
    await git(["commit", "-q", "-m", 'Workspace before "Add clamp" (task T-1)']);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "node --test test/clamp.test.js" } }),
    );
    await git(["add", "-A"]);
    // The retry's baseline: it already holds the first attempt's change.
    await git(["commit", "-q", "-m", 'Workspace before "Add clamp" (task T-1)']);
    expect(await scriptsBefore(root, "T-1", run)).toEqual({ scripts: { test: "node --test" } });
    // Git cannot tell for another task's id here (no commit of it, no origin): unknown.
    expect(await scriptsBefore(root, "T-2", run)).toBeNull();
  });
});

describe("w15-review, wave 15", () => {
  /** The tool the real model wrote in live check 2 (research F1): a usage line and exit 1 without a file. */
  const LIVE_WC = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
function main(argv) {
  const file = argv[2];
  if (!file) { console.error('Usage: node wc.js <file>'); return 1; }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { console.error("wc.js: cannot read '" + file + "'"); return 1; }
  console.log(String((text.match(/\\S+/g) || []).length));
  return 0;
}
if (require.main === module) process.exitCode = main(process.argv);
`;
  /** Live check 2's brief and criteria (research F1, model-calls-final.jsonl seq 64). */
  const LIVE_BRIEF = {
    title: "Build wc.js command line word counter",
    outcome:
      "A wc.js file in the project root that, run as node wc.js <file>, prints the word count of the file. Words are runs of non-whitespace characters separated by whitespace. It uses only Node built-ins.",
    criteria: [
      "node wc.js on a file containing 'hello world foo' prints 3",
      "An empty file, or one with only whitespace, prints 0",
      "Words separated by multiple spaces, tabs or newlines are counted correctly",
      "Running with no argument prints a usage message to stderr and exits with code 1",
      "A nonexistent file prints a clear error message to stderr and exits with code 1",
      "No third-party dependencies are used",
    ],
  };

  it("W15-24: a command whose arguments are described in words ('node wc.js on a file containing …') is not run bare", () => {
    expect(commandsIn("node wc.js on a file containing 'hello world foo' prints 3")).toEqual([]);
    for (const text of [
      "node wc.js with a file path prints its count",
      "Run node wc.js against any text file and it prints the count",
      "node wc.js for a file of 3 words prints 3",
    ])
      expect(commandsIn(text).map((c) => c.target)).toEqual([]);
    // A bare run said as one is still a bare run, and its own sentence expects the error.
    expect(
      commandsIn("node wc.js with no arguments prints a usage message").map((c) => c.target),
    ).toEqual(["node wc.js"]);
    expect(commandsIn("node wc.js without a file exits with code 1").map((c) => c.target)).toEqual([
      "node wc.js",
    ]);
    // A command that ends at a verb is the same as before.
    expect(commandsIn("node wc.js <file> prints the count.").map((c) => c.target)).toEqual([
      "node wc.js <file>",
    ]);
  });

  it("W15-24: live check 2's brief and criteria try only `node wc.js <file>`, never a bare `node wc.js`", () => {
    const root = folder({
      "wc.js": LIVE_WC,
      "README.md":
        "# Word count\n\nUsage: `node wc.js <file>`\n\nIt prints the number of words in the file.\n\nTests: `node --test`\n",
    });
    const plan = planTries({ changedFiles: ["wc.js", "README.md"], root, brief: LIVE_BRIEF });
    expect(plan.commands.map((c) => [c.target, c.expectsError])).toEqual([
      ["node wc.js <file>", false],
    ]);
    expect(plan.notTried).toEqual([]);
  });

  it("W15-24: a bare run that another criterion expects to fail ('Running with no argument … exits with code 1') expects an error", () => {
    const root = folder({ "wc.js": LIVE_WC });
    const plan = planTries({
      changedFiles: ["wc.js"],
      root,
      brief: {
        title: "Write wc.js",
        outcome: "Counts the words of a file",
        criteria: [
          "`node wc.js` reads the file named on its command line",
          "Running with no argument prints a usage message to stderr and exits with code 1",
        ],
      },
    });
    expect(plan.commands.map((c) => [c.target, c.argv.slice(2), c.expectsError])).toEqual([
      ["node wc.js", [], true],
    ]);
    // Nothing says a bare run fails: a bare run is judged as any other.
    const plain = planTries({
      changedFiles: ["wc.js"],
      root,
      brief: {
        title: "Write wc.js",
        outcome: "Counts the words of a file",
        criteria: ["`node wc.js` reads the file named on its command line"],
      },
    });
    expect(plain.commands.map((c) => c.expectsError)).toEqual([false]);
    // A run with arguments is never excused by a sentence about a bare one.
    const withArgs = planTries({
      changedFiles: ["wc.js"],
      root,
      brief: {
        title: "Write wc.js",
        outcome: "Counts the words of a file",
        criteria: [
          "`node wc.js <file>` prints the count",
          "Running with no argument exits with code 1",
        ],
      },
    });
    expect(withArgs.commands.map((c) => [c.target, c.expectsError])).toEqual([
      ["node wc.js <file>", false],
    ]);
  });

  it("W15-24: a server whose start is said in words ('node server.js on port 3000') is still started", () => {
    const root = folder({ "server.js": SERVER });
    const plan = planTries({
      changedFiles: ["server.js"],
      root,
      brief: {
        title: "Write server.js",
        outcome: "node server.js on port 3000 answers GET /health",
        criteria: [],
      },
    });
    expect(plan.servers.map((s) => [s.target, s.source, s.expected])).toEqual([
      ["node server.js", "the brief", true],
    ]);
  });

  it("W15-24: a command said with where or how it runs, not what it is given, is tried as before", () => {
    // The fixup's probe: each of these ran on the base and silently stopped running.
    for (const [text, target] of [
      ["Running node hello.js in a terminal prints Hello, world", "node hello.js"],
      ["node hello.js from the command line prints Hello, world", "node hello.js"],
      ["node hello.js on the command line prints Hello, world", "node hello.js"],
      ["node greet.js to print a greeting", "node greet.js"],
      ["node hello.js at the prompt prints the time", "node hello.js"],
      ["node hello.js with Node 22 prints Hello", "node hello.js"],
      ["node app.js by itself exits with code 1", "node app.js"],
      ["node wc.js on its own exits with code 1", "node wc.js"],
      ["node wc.js alone exits with code 1", "node wc.js"],
    ] as const)
      expect(
        commandsIn(text).map((c) => c.target),
        text,
      ).toEqual([target]);
    // What a command is given, said in words, is still not run bare.
    for (const text of [
      "node wc.js on a file containing 'hello world foo' prints 3",
      "node wc.js using a CSV file prints the rows",
      "node greet.js with your name prints a greeting",
      "node wc.js given a text file prints its count",
    ])
      expect(commandsIn(text), text).toEqual([]);
  });

  it("W15-24: a tool that takes no argument is tried from a sentence that says where it runs; a bare run said in words expects its error", () => {
    const hello = folder({ "hello.js": 'console.log("Hello, world");\n', "wc.js": LIVE_WC });
    const plan = planTries({
      changedFiles: ["hello.js", "wc.js"],
      root: hello,
      brief: {
        title: "Write hello.js and wc.js",
        outcome: "Two small command line tools",
        criteria: [
          "Running node hello.js from the command line prints Hello, world",
          "node wc.js on its own exits with code 1",
        ],
      },
    });
    expect(plan.commands.map((c) => [c.target, c.argv.slice(2), c.expectsError])).toEqual([
      ["node hello.js", [], false],
      ["node wc.js", [], true],
    ]);
    expect(plan.notTried).toEqual([]);
  });

  it("W15-24: a tool whose input is only described, and that no written command runs, is told as not tried, never silently left out", () => {
    const root = folder({ "wc.js": LIVE_WC });
    const plan = planTries({
      changedFiles: ["wc.js"],
      root,
      brief: {
        title: "Write wc.js",
        outcome: "Counts the words of a file",
        criteria: ["node wc.js on a file containing 'hello world foo' prints 3"],
      },
    });
    expect(plan.commands).toEqual([]);
    expect(plan.notTried).toEqual([
      "wc.js was not tried: an acceptance criterion says in words what it is given, not the command to run",
    ]);
  });
});

describe("w15-review, wave 15: the checks line is true now", () => {
  it("W15-50: test files with no package.json say there is none to run them; a package.json without a test script says that", () => {
    expect(untestedFiles(folder({ "wc.js": WC, "wc.test.js": "require('node:test')\n" }))).toBe(
      "the project has test files (wc.test.js) that no check ran: there is no package.json to run them",
    );
    expect(
      untestedFiles(
        folder({ "wc.test.js": "require('node:test')\n", "package.json": '{"name":"wc"}' }),
      ),
    ).toBe(
      "the project has test files (wc.test.js) that no check ran: its package.json names no test script",
    );
    expect(
      untestedFiles(
        folder({
          "wc.test.js": "require('node:test')\n",
          "package.json": '{"scripts":{"test":"node --test"}}',
        }),
      ),
    ).toBeNull();
  });
});
