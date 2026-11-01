import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script without types
import { daemonEnv, liveKey } from "./bench/lib.mjs";

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

  const withoutKeys = (): NodeJS.ProcessEnv => {
    const env = { ...process.env, FRBENCH_ROOT: mkdtempSync(join(tmpdir(), "fr-bench-root-")) };
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
});
