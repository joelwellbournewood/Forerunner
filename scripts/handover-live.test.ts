/**
 * scripts/handover-live.ts (V.8): the refusals before anything is written, and the whole path
 * on stand-ins: the non-interactive setup against the fake git host (GitHub API and git smart
 * HTTP on 127.0.0.1) and a local stand-in for the Anthropic models endpoint, the runtime on the
 * fake provider, the repository connected as a source and accepted into a project, the
 * handover settings through the daemon's PUT route, autonomy 2 through `autonomy.set`, the
 * handover job, and a rerun that reuses the project. Every process the runtime spawns is
 * recorded (argv) and every line printed or logged is kept, so no credential value appears in
 * either.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { SUBMIT_REVIEW_TOOL } from "@forerunner/critic";
import { join } from "@forerunner/platform";
import type { ModelRequest } from "@forerunner/runtime";
import {
  FakeGitHost,
  FakeProvider,
  locateHttpBackend,
  type ScriptedReply,
  textReply,
  toolReply,
} from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const spawned: string[][] = [];
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const record = (cmd: unknown, args: unknown) => {
    spawned.push([String(cmd), ...(Array.isArray(args) ? args.map(String) : [])]);
  };
  return {
    ...real,
    spawn: ((cmd: string, args: readonly string[], ...rest: unknown[]) => {
      record(cmd, args);
      return (real.spawn as (...a: unknown[]) => unknown)(cmd, args, ...rest);
    }) as typeof real.spawn,
    execFile: ((cmd: string, args: unknown, ...rest: unknown[]) => {
      record(cmd, args);
      return (real.execFile as (...a: unknown[]) => unknown)(cmd, args, ...rest);
    }) as typeof real.execFile,
  };
});

const { handoverLive, handoverPassed, HOME_MARKER, preflight, RESULT_PREFIX } = await import(
  "./handover-live.ts"
);

const REGISTRY = join(process.cwd(), "evals", "registry");
const temps: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function lines() {
  const out: string[] = [];
  return { out, sink: (l: string) => void out.push(l) };
}
const resultOf = (out: string[]) =>
  out
    .find((l) => l.startsWith(RESULT_PREFIX))
    ?.slice(RESULT_PREFIX.length)
    .trim();

describe("handoverPassed: the exit code's rule", () => {
  const report = (stuck: number) =>
    ({
      stuck: Array.from({ length: stuck }, () => ({ kind: "reread", files: ["README.md"] })),
    }) as never;
  it("is a pass only when the job ran and the report names no stuck place", () => {
    const base = { monthKey: "2026-10", messageId: null, notificationId: null };
    expect(handoverPassed({ ...base, status: "ran", report: report(0) })).toBe(true);
    expect(handoverPassed({ ...base, status: "ran", report: report(1) })).toBe(false);
    expect(handoverPassed({ ...base, status: "ran", report: null })).toBe(false);
    expect(handoverPassed({ ...base, status: "skipped", reason: "x", report: null })).toBe(false);
    expect(handoverPassed({ ...base, status: "failed", reason: "x", report: null })).toBe(false);
  });
});

describe("handover-live refuses before it writes anything", () => {
  it("without FORERUNNER_HOME", async () => {
    const { out, sink } = lines();
    const code = await handoverLive(["--profile", "v8", "--repo", "o/r"], { env: {}, out: sink });
    expect(code).toBe(2);
    expect(out.join("\n")).toMatch(/refused: FORERUNNER_HOME is not set/);
    expect(resultOf(out)).toBe("refused");
  });

  it("without --profile, with the default profile, without --repo", async () => {
    const home = join(tempDir("fr-hl-"), "home");
    const env = { FORERUNNER_HOME: home, HOME: tempDir("fr-hl-user-") };
    for (const [argv, why] of [
      [["--repo", "o/r"], /--profile <name> is required/],
      [["--profile", "default", "--repo", "o/r"], /--profile default/],
      [["--profile", "v8"], /--repo <owner\/name> is required/],
      [["--profile", "v8", "--repo", "not-a-repo"], /--repo must be owner\/name/],
      [["--profile", "v8", "--repo", "o/r", "--budget-usd", "-1"], /--budget-usd/],
    ] as const) {
      const { out, sink } = lines();
      expect(await handoverLive(argv, { env, out: sink })).toBe(2);
      expect(out.join("\n")).toMatch(why);
    }
  });

  it("a home that is not dedicated: in use, the normal install's, or another profile's", async () => {
    const user = tempDir("fr-hl-user-");
    const used = join(tempDir("fr-hl-"), "used");
    mkdirSync(used, { recursive: true });
    writeFileSync(join(used, "something.txt"), "x");
    const p1 = preflight(["--profile", "v8", "--repo", "o/r"], {
      FORERUNNER_HOME: used,
      HOME: user,
    });
    expect(p1.refusals.join("\n")).toMatch(/not empty and was not made by this script/);
    // The normal install's directories (XDG under HOME here) and the user's home itself.
    const p2 = preflight(["--profile", "v8", "--repo", "o/r"], {
      FORERUNNER_HOME: join(user, ".local", "share", "forerunner"),
      HOME: user,
      XDG_DATA_HOME: join(user, ".local", "share"),
    });
    if (process.platform !== "win32")
      expect(p2.refusals.join("\n")).toMatch(/overlaps the normal install/);
    const p3 = preflight(["--profile", "v8", "--repo", "o/r"], {
      FORERUNNER_HOME: user,
      HOME: user,
    });
    expect(p3.refusals.join("\n")).toMatch(/home directory|overlaps/);
    const mine = join(tempDir("fr-hl-"), "mine");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, HOME_MARKER), JSON.stringify({ profile: "other" }));
    const p4 = preflight(["--profile", "v8", "--repo", "o/r"], {
      FORERUNNER_HOME: mine,
      HOME: user,
    });
    expect(p4.refusals.join("\n")).toMatch(/belongs to profile other/);
    // A store or human of another install.
    const p5 = preflight(["--profile", "v8", "--repo", "o/r"], {
      FORERUNNER_HOME: join(tempDir("fr-hl-"), "h"),
      HOME: user,
      FORERUNNER_STATE_URL: "postgres://x@y/z",
    });
    expect(p5.refusals.join("\n")).toMatch(/FORERUNNER_STATE_URL is set/);
  });

  it("an unknown option (a token passed as an argument) is refused without echoing it", async () => {
    const { out, sink } = lines();
    // Token-shaped at run time only, so the repository's secret scan has nothing to flag.
    const value = ["ghp", "ThisMustNeverBePrinted0123456789abcd"].join("_");
    const code = await handoverLive(["--profile", "v8", "--repo", "o/r", "--github-token", value], {
      env: { FORERUNNER_HOME: join(tempDir("fr-hl-"), "h") },
      out: sink,
    });
    expect(code).toBe(2);
    expect(out.join("\n")).not.toContain(value);
    expect(out.join("\n")).not.toContain("github-token");
  });
});

// ---------------------------------------------------------------------------------------
// The whole path on stand-ins

/** Files read so far by the model in this conversation (its read_file calls). */
function toolPaths(req: ModelRequest, tool: string): Set<string> {
  const out = new Set<string>();
  for (const m of req.messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const b of m.content) {
      const block = b as { type?: string; name?: string; input?: { path?: unknown } };
      if (block.type === "tool_use" && block.name === tool && typeof block.input?.path === "string")
        out.add(block.input.path);
    }
  }
  return out;
}
const hasTool = (req: ModelRequest, name: string) => (req.tools ?? []).some((t) => t.name === name);
const lastIsToolResult = (req: ModelRequest) => {
  const last = req.messages.at(-1);
  return (
    !!last &&
    Array.isArray(last.content) &&
    last.content.some((b) => (b as { type?: string }).type === "tool_result")
  );
};

const RUNBOOK = "# Runbook\n\nHow to run the checks: `node --test`.\n";

/**
 * The fresh agent's specialist reads README.md and docs/runbook.md once each, writes the
 * runbook with the seeded line, reports; the critic accepts. The job dates the seeded line, so
 * the write's content is taken from the brief when the write entry matches (the matcher fills
 * the entry's body in before the fake answers with it); nothing here knows the date.
 */
function passingScript(): ScriptedReply[] {
  const onCoder = (req: ModelRequest) => hasTool(req, "write_file");
  const reads = ["README.md", "docs/runbook.md"];
  const write: ScriptedReply = {
    reply: { text: "Writing the runbook." },
    times: Number.POSITIVE_INFINITY,
  };
  write.when = (req) => {
    if (
      !onCoder(req) ||
      !reads.every((p) => toolPaths(req, "read_file").has(p)) ||
      toolPaths(req, "write_file").has("docs/runbook.md")
    )
      return false;
    const m = /ends with the line: (Handover check [0-9-]+: [^"\\]*?alone\.)/.exec(
      JSON.stringify(req.messages),
    );
    write.reply = {
      text: "Writing the runbook.",
      toolCalls: [
        {
          name: "write_file",
          input: { path: "docs/runbook.md", content: `${RUNBOOK}\n${m?.[1] ?? "no line"}\n` },
        },
      ],
    };
    return true;
  };
  return [
    ...reads.map((path, i) =>
      toolReply("read_file", { path }, `Reading ${path}.`, {
        when: (req) =>
          onCoder(req) &&
          !toolPaths(req, "read_file").has(path) &&
          reads.slice(0, i).every((p) => toolPaths(req, "read_file").has(p)),
        times: Number.POSITIVE_INFINITY,
      }),
    ),
    write,
    textReply("Done: docs/runbook.md ends with the handover line; nothing else changed.", {
      when: (req) => onCoder(req) && toolPaths(req, "write_file").has("docs/runbook.md"),
      times: Number.POSITIVE_INFINITY,
    }),
    toolReply(
      SUBMIT_REVIEW_TOOL,
      {
        grade: 92,
        confidence: "high",
        verdict: "accept",
        summary: "The runbook ends with the line; nothing else changed.",
        findings: [],
        criteria: [],
        checks_run: [],
      },
      "Reviewing.",
      {
        when: (req) => hasTool(req, SUBMIT_REVIEW_TOOL) && !lastIsToolResult(req),
        times: Number.POSITIVE_INFINITY,
      },
    ),
    textReply("Rationale recorded.", {
      when: (req) => hasTool(req, SUBMIT_REVIEW_TOOL) && lastIsToolResult(req),
      times: Number.POSITIVE_INFINITY,
    }),
  ];
}

const gitBackend = await locateHttpBackend();

describe.skipIf(!gitBackend)("handover-live on the fake git host and the fake provider", () => {
  let host: FakeGitHost;
  let models: Server;
  let modelsBase = "";
  let home = "";
  let githubToken = "";
  const anthropicKey = `sk-ant-api03-${"k".repeat(40)}Xy9`;
  const vault = new MemoryVault();
  const logged: string[] = [];
  const env = () => ({
    FORERUNNER_HOME: home,
    HOME: tempDir("fr-hl-user-"),
    PATH: process.env.PATH,
    FORERUNNER_GITHUB_TOKEN: githubToken,
    FORERUNNER_ANTHROPIC_KEY: anthropicKey,
    FORERUNNER_GITHUB_API: host.baseUrl,
    FORERUNNER_ANTHROPIC_API: modelsBase,
    FORERUNNER_REGISTRY_DIR: REGISTRY,
  });

  beforeAll(async () => {
    const root = tempDir("fr-hl-world-");
    home = join(root, "install");
    host = await FakeGitHost.start({ rootDir: join(root, "host") });
    host.createUser({ login: "octo", name: "Octo", email: "octo@example.test" });
    await host.createRepo({
      owner: "octo",
      name: "widget",
      private: true,
      defaultBranch: "main",
      initialFiles: {
        "README.md": "# widget\n\nDocs: docs/runbook.md says how the checks run.\n",
        "docs/runbook.md": RUNBOOK,
      },
    });
    // A fine-grained token on the one repository: contents and pull requests write.
    githubToken = host.createToken({
      owner: "octo",
      kind: "fine_grained",
      repos: ["octo/widget"],
      permissions: { contents: "write", pull_requests: "write", issues: "write", metadata: "read" },
    }).token;
    models = createServer((req, res) => {
      const ok = req.headers["x-api-key"] === anthropicKey && req.url?.startsWith("/v1/models");
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          ok ? { data: [{ id: "claude-haiku-test" }, { id: "claude-sonnet-test" }] } : {},
        ),
      );
    });
    await new Promise<void>((r) => models.listen(0, "127.0.0.1", r));
    const addr = models.address();
    modelsBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    for (const level of ["log", "warn", "error", "info"] as const)
      vi.spyOn(console, level).mockImplementation((...a: unknown[]) => {
        logged.push(a.map(String).join(" "));
      });
  }, 120_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await host?.stop();
    await new Promise<void>((r) => (models ? models.close(() => r()) : r()));
  });

  const deps = (provider: FakeProvider, sink: (l: string) => void) => ({
    env: env(),
    out: sink,
    openVault: async () => vault,
    compose: {
      provider,
      registryDir: REGISTRY,
      sandboxDetection: {
        engine: "none" as const,
        reason: "test: no engine",
        checkedAt: new Date(0).toISOString(),
      },
      data: { gitRemoteBase: host.baseUrl },
    },
  });

  let projectId = "";

  it("dry run: setup, source, project, settings and autonomy 2; the job does not run", async () => {
    const { out, sink } = lines();
    const provider = new FakeProvider({ replies: [], onNoMatch: "throw", latency: "none" });
    const code = await handoverLive(
      ["--profile", "v8-test", "--repo", "octo/widget", "--dry-run"],
      deps(provider, sink),
    );
    const text = out.join("\n");
    expect(code, text).toBe(0);
    expect(resultOf(out)).toBe("dry-run");
    expect(text).toMatch(/Source: \S+ github_repo octo\/widget \(connected\)/);
    const m = /Project: (\S+) \(.*created from octo\/widget\)/.exec(text);
    expect(m, text).not.toBeNull();
    projectId = m?.[1] ?? "";
    expect(text).toMatch(/Settings: handover enabled, budget USD 5 /);
    expect(text).toMatch(/Autonomy: /);
    expect(text).toMatch(/the handover job was not run/);
    // Accepting the repository scaffolds the standard doc set: a pull request on the host.
    expect(text).toMatch(
      /the standard doc set scaffold opened http:\/\/127\.0\.0\.1:\d+\/octo\/widget\/pull\/1/,
    );
    expect(provider.calls).toHaveLength(0);
    expect(await vault.list()).toEqual(
      expect.arrayContaining(["github_token", "anthropic_api_key"]),
    );
  }, 120_000);

  it("the full run at autonomy 2 reuses the project, runs the job and passes with exit 0", async () => {
    const { out, sink } = lines();
    const provider = new FakeProvider({
      replies: passingScript(),
      onNoMatch: "echo",
      latency: "none",
    });
    const code = await handoverLive(
      ["--profile", "v8-test", "--repo", "octo/widget", "--budget-usd", "3"],
      deps(provider, sink),
    );
    const text = out.join("\n");
    expect(text).toContain(`Project: ${projectId} (reused`);
    expect(text).toMatch(/Settings: handover enabled, budget USD 3 /);
    expect(text).toMatch(/^Handover test \d{4}-\d{2}-\d{2} on widget/m);
    // The fresh agent made the change: the seeded task is done and its pull request is open.
    expect(text).toMatch(/^Session \S+ completed: 1 done, 0 need you, 0 failed; task done \(http/m);
    const pr = /^PR: (http:\/\/127\.0\.0\.1:\d+\/octo\/widget\/pull\/(\d+))$/m.exec(text);
    expect(pr, text).not.toBeNull();
    expect(text).toMatch(
      /^Cost \(cost ledger\): session \S+ USD 0\.\d{4} \(CHF \d+\.\d{4}, [1-9]\d* entries\)/m,
    );
    // At autonomy 2 (the level the V.8 run uses) the session's merge step is refused by the
    // hooks after the critic accepts (ADR 0062: level 2 leaves the merge to a human). With the
    // change made and its PR there, that refusal is no stuck place (ADR 0060 amendment), so
    // the report says the agent got stuck nowhere and the script passes.
    expect(text).toMatch(/^The agent got stuck nowhere: no stuck place, no docs task\.$/m);
    expect(text).not.toMatch(/stuck place:/);
    expect(resultOf(out), text).toBe("passed");
    expect(code).toBe(0);
    // On the host: the scaffold PR from accepting the project (dry run) and the handover PR.
    const res = await fetch(`${host.baseUrl}/repos/octo/widget/pulls?state=all`, {
      headers: { authorization: `Bearer ${githubToken}` },
    });
    const pulls = (await res.json()) as { number: number; title: string; state: string }[];
    expect(pulls.map((p) => p.title)).toEqual(
      expect.arrayContaining(["docs: scaffold the standard project doc set"]),
    );
    // The handover PR is open: the merge was refused, never done behind the human's back.
    expect(pulls.find((p) => String(p.number) === pr?.[2])?.state).toBe("open");
  }, 180_000);

  it("a run where the agent gets stuck exits 1 with the stuck places and a docs task", async () => {
    const { out, sink } = lines();
    const provider = new FakeProvider({
      replies: [
        textReply("I could not find where the docs are.", { times: Number.POSITIVE_INFINITY }),
      ],
      latency: "none",
    });
    const code = await handoverLive(
      ["--profile", "v8-test", "--repo", "octo/widget"],
      deps(provider, sink),
    );
    const text = out.join("\n");
    expect(text).toContain(`Project: ${projectId} (reused`);
    expect(resultOf(out), text).toBe("stuck");
    expect(code).toBe(1);
    expect(text).toMatch(/stuck place/);
    expect(text).toMatch(/Docs task filed: /);
  }, 180_000);

  it("no credential value in any printed or logged line, nor in the argv of a spawned process", () => {
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned.some((a) => a[0]?.endsWith("git") || a[0] === "git")).toBe(true);
    for (const secret of [githubToken, anthropicKey]) {
      expect(secret.length).toBeGreaterThan(20);
      for (const argv of spawned) expect(argv.join(" ")).not.toContain(secret);
      for (const l of logged) expect(l).not.toContain(secret);
    }
  });
});
