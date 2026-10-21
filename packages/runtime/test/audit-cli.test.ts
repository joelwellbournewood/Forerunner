import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, silenceSqliteExperimentalWarning } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/main.ts";
import { AUDIT_EXPORT_COLUMNS, type AuditExportRecord } from "../src/daemon/audit-export.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";

silenceSqliteExperimentalWarning();

/**
 * `fr audit export` (spec S.9): writes the install's human's audit rows to a file as JSON
 * lines or CSV through the same export module as the daemon route, prints the row count,
 * composes the runtime without its background services, and never overwrites a file unless
 * told to. In process through `buildProgram()` with a composed stand-in over a sqlite store.
 */
const START = "2026-10-20T08:00:00.000Z";

describe("fr audit export", () => {
  let store: StateStore;
  let home: string;
  let humanA: string;
  let agentA: string;
  let agentB: string;
  let lines: string[];
  let composeCalls: Record<string, unknown>[];
  const clock = new SimulatedClock(START);

  beforeEach(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
    home = mkdtempSync(join(tmpdir(), "fr-audit-cli-"));
    humanA = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
    const humanB = (await store.human.insert({ name: "Bob", email: "bob@example.test" })).id;
    agentA = (
      await store.agent.insert({ name: "Alice", owner_human_id: humanA, kind: "principal" })
    ).id;
    agentB = (
      await store.agent.insert({ name: "Bobby", owner_human_id: humanB, kind: "principal" })
    ).id;
    const at = (m: number) => new Date(Date.parse(START) + m * 60_000).toISOString();
    await store.auditLog.append({
      agent_id: agentA,
      human_id: humanA,
      session_id: "s1",
      tool: "read_file",
      input_summary: "README.md",
      result_summary: "ok",
      allowed: true,
      occurred_at: at(0),
    });
    await store.auditLog.append({
      agent_id: agentB,
      human_id: humanB,
      tool: "run_command",
      input_summary: "ls",
      result_summary: "ok",
      allowed: true,
      occurred_at: at(1),
    });
    await store.auditLog.append({
      agent_id: agentA,
      human_id: humanA,
      session_id: "s2",
      tool: "write_file",
      input_summary: "notes.md",
      result_summary: "",
      allowed: false,
      denied_reason: "approval_required: human denied write_file",
      occurred_at: at(2),
    });
    await store.auditLog.append({
      tool: "update.health_check",
      input_summary: "1.1.0",
      result_summary: "healthy",
      allowed: true,
      occurred_at: at(3),
    });
    lines = [];
    composeCalls = [];
  });
  afterEach(async () => {
    await store.close();
  });

  function program(cwd = home) {
    const rt = {
      store,
      clock,
      human: { id: humanA, name: "Ada", timezone: "UTC" },
      agent: { id: agentA, name: "Alice" },
      close: async () => undefined,
    } as unknown as RuntimeApp;
    const p = buildProgram({
      env: { FORERUNNER_HOME: home },
      compose: async (o) => {
        composeCalls.push(o);
        return rt;
      },
      out: (l) => lines.push(l),
      cwd: () => cwd,
    });
    p.exitOverride();
    return p;
  }
  const fr = (...args: string[]) => program().parseAsync(["node", "fr", ...args]);
  const parseJsonl = (path: string): AuditExportRecord[] =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditExportRecord);

  it("is registered as `fr audit export` with the documented flags", () => {
    const p = program();
    const audit = p.commands.find((c) => c.name() === "audit");
    expect(audit).toBeDefined();
    const exp = audit?.commands.find((c) => c.name() === "export");
    expect(exp).toBeDefined();
    const flags = exp?.options.map((o) => o.long) ?? [];
    expect(flags).toEqual(
      expect.arrayContaining([
        "--agent",
        "--session",
        "--from",
        "--to",
        "--format",
        "--out",
        "--force",
      ]),
    );
    expect(p.helpInformation()).toContain("audit");
  });

  it("writes the human's rows as JSON lines, prints the count and composes without services", async () => {
    const out = join(home, "exports", "log.jsonl");
    await fr("audit", "export", "--out", out);
    expect(existsSync(out)).toBe(true);
    const records = parseJsonl(out);
    // Alice's two calls and the install-level row; never Bob's agent.
    expect(records.map((r) => r.tool)).toEqual(["read_file", "write_file", "update.health_check"]);
    expect(records[1]).toMatchObject({
      agentId: agentA,
      humanId: humanA,
      sessionId: "s2",
      allowed: false,
      deniedReason: "approval_required: human denied write_file",
    });
    expect(lines).toEqual([`3 rows written to ${out} (jsonl)`]);
    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]).toMatchObject({ startServices: false });
  });

  it("writes CSV with the header, applies the filters and names a default file after the clock", async () => {
    await fr("audit", "export", "--format", "csv", "--session", "s2");
    const expected = join(home, "forerunner-audit-20261020T080000Z.csv");
    expect(existsSync(expected)).toBe(true);
    const text = readFileSync(expected, "utf8");
    const rows = text.split("\r\n").filter((l) => l.length > 0);
    expect(rows[0]).toBe(AUDIT_EXPORT_COLUMNS.join(","));
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("write_file");
    expect(lines).toEqual([`1 row written to ${expected} (csv)`]);

    lines.length = 0;
    const windowed = join(home, "window.jsonl");
    await fr(
      "audit",
      "export",
      "--agent",
      agentA,
      "--from",
      "2026-10-20T08:01:00Z",
      "--to",
      "2026-10-20T08:03:00Z",
      "--out",
      windowed,
    );
    expect(parseJsonl(windowed).map((r) => r.tool)).toEqual(["write_file"]);
    expect(lines[0]).toContain("1 row written");
  });

  it("refuses another human's agent, a bad flag before composing, and an existing file without --force", async () => {
    const out = join(home, "x.jsonl");
    await expect(fr("audit", "export", "--agent", agentB, "--out", out)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(existsSync(out)).toBe(false);
    composeCalls.length = 0;
    await expect(fr("audit", "export", "--format", "xml", "--out", out)).rejects.toMatchObject({
      code: "validation",
    });
    await expect(fr("audit", "export", "--from", "yesterday", "--out", out)).rejects.toMatchObject({
      code: "validation",
    });
    expect(composeCalls).toHaveLength(0);
    expect(existsSync(out)).toBe(false);

    writeFileSync(out, "keep me\n");
    await expect(fr("audit", "export", "--out", out)).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("--force"),
    });
    expect(readFileSync(out, "utf8")).toBe("keep me\n");
    await fr("audit", "export", "--out", out, "--force");
    expect(parseJsonl(out)).toHaveLength(3);
  });
});
