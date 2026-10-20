import { existsSync, readFileSync, statSync } from "node:fs";
import {
  type Clock,
  errorMessage,
  fromPosix,
  isInside,
  join,
  normalizeNewlines,
  type RunResult,
  run as runProcess,
  systemClock,
} from "@forerunner/platform";
import type { CheckResult, EvalCheck } from "./types.ts";

/** What a check may look at. */
export interface CheckContext {
  /** The task directory after the specialist (and grader files) wrote into it. */
  outputDir: string;
  /** The specialist's final message. */
  finalText: string;
  clock?: Clock;
  /** Injected process runner (platform.run by default). */
  run?: (argv: readonly string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;
}

export type CheckRunner = (check: EvalCheck, ctx: CheckContext) => Promise<CheckResult>;

export function describeCheck(check: EvalCheck): string {
  if (check.label) return check.label;
  switch (check.kind) {
    case "file_exists":
      return `${check.path} is ${check.expect}`;
    case "file_contains":
      return `${check.path ?? "final text"} ${check.expect === "present" ? "contains" : "does not contain"} ${JSON.stringify(check.text)}`;
    case "regex":
      return `${check.path ?? "final text"} ${check.expect === "match" ? "matches" : "does not match"} /${check.pattern}/${check.flags}`;
    case "command_exit0":
      return `${check.argv.join(" ")} exits 0`;
    case "json_path":
      return `${check.path} ${check.pointer || "/"} ${check.exists ? (check.equals !== undefined ? `equals ${JSON.stringify(check.equals)}` : "exists") : "is absent"}`;
    case "rubric":
      return `rubric: ${check.criteria.length} criteria`;
  }
}

/** RFC 6901 JSON pointer lookup. "" resolves to the whole document. */
export function jsonPointer(doc: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: doc };
  let cur: unknown = doc;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9]\d*)$/.test(key)) return { found: false };
      const idx = Number(key);
      if (idx >= cur.length) return { found: false };
      cur = cur[idx];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.hasOwn(cur, key)) return { found: false };
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as Record<string, unknown>).sort();
    const kb = Object.keys(b as Record<string, unknown>).sort();
    if (!deepEqual(ka, kb)) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function resolveInside(outputDir: string, rel: string): string {
  const abs = join(outputDir, fromPosix(rel));
  if (!isInside(outputDir, abs)) throw new Error(`path escapes the task directory: ${rel}`);
  return abs;
}

function readTarget(
  ctx: CheckContext,
  path: string | undefined,
): { ok: true; text: string } | { ok: false; why: string } {
  if (path === undefined) return { ok: true, text: ctx.finalText };
  const abs = resolveInside(ctx.outputDir, path);
  if (!existsSync(abs) || !statSync(abs).isFile()) return { ok: false, why: `${path} is missing` };
  return { ok: true, text: normalizeNewlines(readFileSync(abs, "utf8")) };
}

const tail = (s: string, n = 1200): string => (s.length > n ? `...${s.slice(-n)}` : s);

/** Run one check. Never throws: problems become status "error" with the message as evidence. */
export const runCheck: CheckRunner = async (check, ctx): Promise<CheckResult> => {
  const clock = ctx.clock ?? systemClock;
  const t0 = clock.monotonic();
  const label = describeCheck(check);
  const done = (status: CheckResult["status"], evidence: string, detail?: string): CheckResult => ({
    kind: check.kind,
    label,
    status,
    evidence,
    ...(detail !== undefined ? { detail } : {}),
    durationMs: Math.max(0, Math.round(clock.monotonic() - t0)),
  });
  try {
    switch (check.kind) {
      case "file_exists": {
        const abs = resolveInside(ctx.outputDir, check.path);
        const present = existsSync(abs);
        const ok = check.expect === "present" ? present : !present;
        return done(
          ok ? "pass" : "fail",
          `${check.path}: ${present ? "present" : "absent"} (expected ${check.expect})`,
        );
      }
      case "file_contains": {
        const t = readTarget(ctx, check.path);
        if (!t.ok) return done(check.expect === "absent" ? "pass" : "fail", t.why);
        const found = t.text.includes(normalizeNewlines(check.text));
        const ok = check.expect === "present" ? found : !found;
        return done(
          ok ? "pass" : "fail",
          `${check.path ?? "final text"}: ${JSON.stringify(check.text)} ${found ? "found" : "not found"} (expected ${check.expect})`,
        );
      }
      case "regex": {
        const t = readTarget(ctx, check.path);
        if (!t.ok) return done(check.expect === "no_match" ? "pass" : "fail", t.why);
        let re: RegExp;
        try {
          re = new RegExp(check.pattern, check.flags.replace("g", ""));
        } catch (e) {
          return done("error", `invalid pattern /${check.pattern}/: ${errorMessage(e)}`);
        }
        const m = re.exec(t.text);
        const ok = check.expect === "match" ? m !== null : m === null;
        return done(
          ok ? "pass" : "fail",
          `${check.path ?? "final text"}: /${check.pattern}/ ${m ? `matched ${JSON.stringify(m[0].slice(0, 80))}` : "did not match"} (expected ${check.expect})`,
        );
      }
      case "command_exit0": {
        const cwd = check.cwd ? resolveInside(ctx.outputDir, check.cwd) : ctx.outputDir;
        const exec = ctx.run ?? ((argv, o) => runProcess(argv, { ...o, allowFailure: true }));
        const r = await exec(check.argv, { cwd, timeoutMs: check.timeoutMs });
        const ok = r.code === 0 && !r.timedOut;
        const output = tail(`${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim());
        return done(
          ok ? "pass" : "fail",
          `${check.argv.join(" ")} -> ${r.timedOut ? "timeout" : `exit ${r.code}`} in ${r.durationMs} ms`,
          output,
        );
      }
      case "json_path": {
        const t = readTarget(ctx, check.path);
        if (!t.ok) return done("fail", t.why);
        let doc: unknown;
        try {
          doc = JSON.parse(t.text);
        } catch (e) {
          return done("fail", `${check.path} is not valid JSON: ${errorMessage(e)}`);
        }
        const r = jsonPointer(doc, check.pointer);
        if (!check.exists) {
          return done(
            r.found ? "fail" : "pass",
            `${check.path} ${check.pointer}: ${r.found ? "present" : "absent"} (expected absent)`,
          );
        }
        if (!r.found) return done("fail", `${check.path} ${check.pointer}: not found`);
        if (check.equals !== undefined && !deepEqual(r.value, check.equals)) {
          return done(
            "fail",
            `${check.path} ${check.pointer}: ${JSON.stringify(r.value)} != ${JSON.stringify(check.equals)}`,
          );
        }
        return done(
          "pass",
          `${check.path} ${check.pointer}: ${JSON.stringify(r.value)?.slice(0, 120)}`,
        );
      }
      case "rubric":
        return done(
          "needs_model",
          `rubric with ${check.criteria.length} criteria awaits the critic (threshold ${check.passThreshold})`,
          check.criteria.join("\n"),
        );
    }
  } catch (e) {
    return done("error", `${label}: ${errorMessage(e)}`);
  }
};
