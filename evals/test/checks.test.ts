import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deepEqual, describeCheck, jsonPointer, runCheck } from "../src/checks.ts";
import { CheckSchema, type EvalCheck } from "../src/types.ts";

let dir: string;
const clock = new SimulatedClock();
const ctx = () => ({
  outputDir: dir,
  finalText: "Final: all criteria met. Ran node --test (exit 0).",
  clock,
});

function check(input: unknown): EvalCheck {
  return CheckSchema.parse(input);
}

beforeAll(() => {
  dir = mkdtempSync(join(os.tmpdir(), "fr-checks-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "a.ts"),
    "export const answer = 42;\r\nexport function clamp() {}\r\n",
    "utf8",
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node --test" },
      list: [1, { k: "v" }],
      "a/b": 1,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "bad.json"), "{ not json", "utf8");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("checks", () => {
  it("file_exists: present and absent", async () => {
    expect((await runCheck(check({ kind: "file_exists", path: "src/a.ts" }), ctx())).status).toBe(
      "pass",
    );
    expect(
      (await runCheck(check({ kind: "file_exists", path: "src/missing.ts" }), ctx())).status,
    ).toBe("fail");
    expect(
      (
        await runCheck(
          check({ kind: "file_exists", path: "src/missing.ts", expect: "absent" }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    const r = await runCheck(
      check({ kind: "file_exists", path: "src/a.ts", expect: "absent" }),
      ctx(),
    );
    expect(r.status).toBe("fail");
    expect(r.evidence).toBe("src/a.ts: present (expected absent)");
  });

  it("file_contains: files (CRLF-normalised) and the final text", async () => {
    expect(
      (
        await runCheck(
          check({ kind: "file_contains", path: "src/a.ts", text: "answer = 42;\nexport" }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await runCheck(
          check({ kind: "file_contains", path: "src/a.ts", text: "answer = 43" }),
          ctx(),
        )
      ).status,
    ).toBe("fail");
    expect(
      (
        await runCheck(
          check({ kind: "file_contains", path: "src/a.ts", text: "answer = 43", expect: "absent" }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect((await runCheck(check({ kind: "file_contains", text: "exit 0" }), ctx())).status).toBe(
      "pass",
    );
    const missing = await runCheck(
      check({ kind: "file_contains", path: "nope.txt", text: "x" }),
      ctx(),
    );
    expect(missing.status).toBe("fail");
    expect(missing.evidence).toMatch(/nope\.txt is missing/);
    expect(
      (
        await runCheck(
          check({ kind: "file_contains", path: "nope.txt", text: "x", expect: "absent" }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
  });

  it("regex: match, no_match, flags, final text and invalid patterns", async () => {
    expect(
      (
        await runCheck(
          check({ kind: "regex", path: "src/a.ts", pattern: "^export function clamp", flags: "m" }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await runCheck(
          check({ kind: "regex", path: "src/a.ts", pattern: "^export function clamp" }),
          ctx(),
        )
      ).status,
    ).toBe("fail");
    expect(
      (
        await runCheck(
          check({ kind: "regex", path: "src/a.ts", pattern: "ANSWER", flags: "i" }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await runCheck(
          check({ kind: "regex", path: "src/a.ts", pattern: "todo", expect: "no_match" }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await runCheck(
          check({ kind: "regex", path: "src/a.ts", pattern: "answer", expect: "no_match" }),
          ctx(),
        )
      ).status,
    ).toBe("fail");
    expect((await runCheck(check({ kind: "regex", pattern: "exit \\d" }), ctx())).status).toBe(
      "pass",
    );
    const invalid = await runCheck(
      check({ kind: "regex", path: "src/a.ts", pattern: "(unclosed" }),
      ctx(),
    );
    expect(invalid.status).toBe("error");
    expect(invalid.evidence).toMatch(/invalid pattern/);
    expect(() => check({ kind: "regex", pattern: "(?i)x", flags: "x" })).toThrow();
  });

  it("json_path: pointer lookup, equals, exists:false, missing and invalid files", async () => {
    expect(
      (
        await runCheck(
          check({
            kind: "json_path",
            path: "package.json",
            pointer: "/scripts/test",
            equals: "node --test",
          }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await runCheck(
          check({
            kind: "json_path",
            path: "package.json",
            pointer: "/scripts/test",
            equals: "vitest",
          }),
          ctx(),
        )
      ).status,
    ).toBe("fail");
    expect(
      (
        await runCheck(
          check({ kind: "json_path", path: "package.json", pointer: "/list/1/k", equals: "v" }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await runCheck(
          check({ kind: "json_path", path: "package.json", pointer: "/a~1b", equals: 1 }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await runCheck(
          check({ kind: "json_path", path: "package.json", pointer: "/scripts/lint" }),
          ctx(),
        )
      ).status,
    ).toBe("fail");
    expect(
      (
        await runCheck(
          check({
            kind: "json_path",
            path: "package.json",
            pointer: "/scripts/lint",
            exists: false,
          }),
          ctx(),
        )
      ).status,
    ).toBe("pass");
    expect(
      (
        await runCheck(
          check({ kind: "json_path", path: "package.json", pointer: "", equals: { name: "x" } }),
          ctx(),
        )
      ).status,
    ).toBe("fail");
    expect(
      (await runCheck(check({ kind: "json_path", path: "bad.json", pointer: "/x" }), ctx()))
        .evidence,
    ).toMatch(/not valid JSON/);
    expect(
      (await runCheck(check({ kind: "json_path", path: "none.json", pointer: "/x" }), ctx()))
        .status,
    ).toBe("fail");
    expect(jsonPointer({ a: [10, 20] }, "/a/1")).toEqual({ found: true, value: 20 });
    expect(jsonPointer({ a: [10, 20] }, "/a/2")).toEqual({ found: false });
    expect(jsonPointer({ a: [10, 20] }, "/a/x")).toEqual({ found: false });
    expect(jsonPointer(5, "/a")).toEqual({ found: false });
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });

  it("command_exit0: runs argv arrays through the platform runner, in the task directory", async () => {
    const ok = await runCheck(
      check({
        kind: "command_exit0",
        argv: ["node", "-e", "process.exit(process.cwd() === process.argv[1] ? 0 : 1)", dir],
      }),
      ctx(),
    );
    expect(ok.status).toBe("pass");
    expect(ok.evidence).toMatch(/exit 0/);
    const bad = await runCheck(
      check({
        kind: "command_exit0",
        argv: ["node", "-e", "console.error('boom'); process.exit(3)"],
      }),
      ctx(),
    );
    expect(bad.status).toBe("fail");
    expect(bad.evidence).toMatch(/exit 3/);
    expect(bad.detail).toMatch(/boom/);
    const sub = await runCheck(
      check({
        kind: "command_exit0",
        argv: ["node", "-e", "process.exit(require('node:fs').existsSync('a.ts') ? 0 : 1)"],
        cwd: "src",
      }),
      ctx(),
    );
    expect(sub.status).toBe("pass");
    const injected = await runCheck(check({ kind: "command_exit0", argv: ["whatever"] }), {
      ...ctx(),
      run: async () => ({
        code: null,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: false,
        timedOut: true,
        durationMs: 5,
      }),
    });
    expect(injected.status).toBe("fail");
    expect(injected.evidence).toMatch(/timeout/);
  });

  it("rubric: reports needs_model with the criteria", async () => {
    const r = await runCheck(
      check({ kind: "rubric", criteria: ["cites the fixture", "states uncertainty"] }),
      ctx(),
    );
    expect(r.status).toBe("needs_model");
    expect(r.evidence).toMatch(/2 criteria/);
    expect(r.detail).toBe("cites the fixture\nstates uncertainty");
  });

  it("refuses paths that escape the task directory and never throws", async () => {
    const r = await runCheck(
      { kind: "file_exists", path: "../outside", expect: "present" } as EvalCheck,
      ctx(),
    );
    expect(r.status).toBe("error");
    expect(r.evidence).toMatch(/escapes the task directory/);
    expect(() => check({ kind: "file_exists", path: "../outside" })).toThrow();
    expect(() => check({ kind: "file_exists", path: "C:/x" })).toThrow();
    expect(() => check({ kind: "file_exists", path: "a\\b" })).toThrow();
  });

  it("describes every kind for reports", () => {
    expect(describeCheck(check({ kind: "file_exists", path: "a" }))).toBe("a is present");
    expect(describeCheck(check({ kind: "file_contains", text: "x", expect: "absent" }))).toBe(
      'final text does not contain "x"',
    );
    expect(describeCheck(check({ kind: "regex", path: "a", pattern: "b", flags: "i" }))).toBe(
      "a matches /b/i",
    );
    expect(describeCheck(check({ kind: "command_exit0", argv: ["node", "-v"] }))).toBe(
      "node -v exits 0",
    );
    expect(
      describeCheck(check({ kind: "json_path", path: "p.json", pointer: "/a", equals: 1 })),
    ).toBe("p.json /a equals 1");
    expect(
      describeCheck(check({ kind: "json_path", path: "p.json", pointer: "/a", exists: false })),
    ).toBe("p.json /a is absent");
    expect(describeCheck(check({ kind: "rubric", criteria: ["one criterion"] }))).toBe(
      "rubric: 1 criteria",
    );
    expect(
      describeCheck(check({ kind: "rubric", criteria: ["one criterion"], label: "custom" })),
    ).toBe("custom");
  });
});
