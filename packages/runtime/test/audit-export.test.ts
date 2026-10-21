import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import {
  type AuditFilter,
  type AuditLogRow,
  type ListOptions,
  openStore,
  type StateStore,
  silenceSqliteExperimentalWarning,
} from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DAEMON_ROUTES } from "../src/daemon/api-types.ts";
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_PAGE_SIZE,
  AUDIT_EXPORT_ROUTE,
  type AuditExportRecord,
  auditExportFilename,
  auditExportPages,
  auditExportRecord,
  auditScopeFor,
  createAuditRoutes,
  csvCell,
  csvHeader,
  csvLine,
  jsonlLine,
  parseAuditExportQuery,
  rowInScope,
  writeAuditExport,
} from "../src/daemon/audit-export.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

silenceSqliteExperimentalWarning();

/**
 * Spec S.9: the audit log is exportable. The export module pages through
 * `store.auditLog.list` (never the whole log at once), writes JSON lines or CSV with the
 * summaries as stored (redacted at write time; no raw parameters), and scopes the rows to
 * the human and their agents. The daemon mounts it at `GET /audit/export` behind the bearer
 * token; the CLI and the state service share the same functions.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const START = "2026-10-20T08:00:00.000Z";

function row(over: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: "row-1",
    created_at: START,
    updated_at: START,
    author_agent: null,
    author_human: null,
    version: 1,
    session_id: null,
    run_id: null,
    agent_id: "agent-a",
    human_id: "human-a",
    tool: "read_file",
    input_summary: '{"path":"README.md"}',
    result_summary: "42 lines",
    allowed: true,
    denied_reason: null,
    cost_usd_micro: 0,
    occurred_at: START,
    token_id: "tok-1",
    ...over,
  };
}

/** A paging source that records every call and serves slices of a fixed list. */
function pagedSource(rows: AuditLogRow[]) {
  const calls: ListOptions[] = [];
  return {
    calls,
    list: async (_filter: AuditFilter, opts: ListOptions = {}) => {
      calls.push(opts);
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? rows.length;
      return rows.slice(offset, offset + limit);
    },
  };
}

interface Seeded {
  store: StateStore;
  clock: SimulatedClock;
  humanA: string;
  humanB: string;
  agentA: string;
  agentB: string;
  /** Rows in the order the export must produce them for human A. */
  expectedForA: string[];
}

/**
 * Two humans with one agent each. Human A's export: three tool calls of agent A (one in
 * session s1, spread over three hours), one row naming only human A (a settings change)
 * and, on the daemon, one install-level row with no owner; never agent B's two rows.
 */
async function seedStore(): Promise<Seeded> {
  const clock = new SimulatedClock(START);
  const store = await openStore({ url: "sqlite::memory:", clock });
  const humanA = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
  const humanB = (await store.human.insert({ name: "Bob", email: "bob@example.test" })).id;
  const agentA = (
    await store.agent.insert({ name: "Alice", owner_human_id: humanA, kind: "principal" })
  ).id;
  const agentB = (
    await store.agent.insert({ name: "Bobby", owner_human_id: humanB, kind: "principal" })
  ).id;
  const at = (hours: number) => new Date(Date.parse(START) + hours * 3_600_000).toISOString();
  const a1 = await store.auditLog.append({
    agent_id: agentA,
    human_id: humanA,
    session_id: "s1",
    run_id: "r1",
    tool: "read_file",
    input_summary: '{"path":"README.md"}',
    result_summary: "42 lines",
    allowed: true,
    occurred_at: at(0),
    token_id: "tok-a",
  });
  const unowned = await store.auditLog.append({
    tool: "update.health_check",
    input_summary: "1.1.0",
    result_summary: "healthy",
    allowed: true,
    occurred_at: at(0.5),
  });
  const b1 = await store.auditLog.append({
    agent_id: agentB,
    human_id: humanB,
    session_id: "s9",
    tool: "run_command",
    input_summary: "ls",
    result_summary: "ok",
    allowed: true,
    occurred_at: at(0.75),
  });
  const a2 = await store.auditLog.append({
    agent_id: agentA,
    human_id: humanA,
    session_id: "s1",
    run_id: "r1",
    tool: "write_file",
    input_summary: '{"path":"notes.md","text":"=SUM(A1:A3), a \\"quoted\\" line"}',
    result_summary: "",
    allowed: false,
    denied_reason: "path_not_allowed: outside the worktree",
    occurred_at: at(1),
    token_id: "tok-a",
  });
  const humanOnly = await store.auditLog.append({
    human_id: humanA,
    tool: "notifications.prefs",
    input_summary: "quietHours",
    result_summary: "changed",
    allowed: true,
    occurred_at: at(1.5),
  });
  const b2 = await store.auditLog.append({
    agent_id: agentB,
    human_id: humanB,
    tool: "read_file",
    input_summary: "x",
    result_summary: "y",
    allowed: true,
    occurred_at: at(1.75),
  });
  const a3 = await store.auditLog.append({
    agent_id: agentA,
    human_id: humanA,
    session_id: "s2",
    run_id: "r2",
    tool: "web_fetch",
    input_summary: "https://example.test/page",
    result_summary: "200, 12 kB",
    allowed: true,
    cost_usd_micro: 1_250,
    occurred_at: at(2),
    token_id: "tok-a2",
  });
  void b1;
  void b2;
  return {
    store,
    clock,
    humanA,
    humanB,
    agentA,
    agentB,
    expectedForA: [a1.id, unowned.id, a2.id, humanOnly.id, a3.id],
  };
}

const parseJsonl = (text: string): AuditExportRecord[] =>
  text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditExportRecord);

const csvLines = (text: string): string[] => text.split("\r\n").filter((l) => l.length > 0);

describe("audit export: serialisation", () => {
  it("writes CSV cells per RFC 4180 and neutralises spreadsheet formulas", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(1_250)).toBe("1250");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    // A cell a spreadsheet would evaluate gets a leading apostrophe (CSV injection).
    expect(csvCell("=SUM(A1:A3)")).toBe("'=SUM(A1:A3)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-rf /")).toBe("'-rf /");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tx")).toBe("'\tx");
    // Guard first, then quoting: a formula with a comma is both prefixed and quoted.
    expect(csvCell("=1,2")).toBe('"\'=1,2"');
  });

  it("maps a row to the export record with camelCase keys and nothing beyond the stored summaries", () => {
    const r = auditExportRecord(row({ cost_usd_micro: 7, allowed: false, denied_reason: "no" }));
    expect(r).toEqual({
      id: "row-1",
      occurredAt: START,
      agentId: "agent-a",
      humanId: "human-a",
      sessionId: null,
      runId: null,
      tokenId: "tok-1",
      tool: "read_file",
      allowed: false,
      deniedReason: "no",
      costUsdMicro: 7,
      inputSummary: '{"path":"README.md"}',
      resultSummary: "42 lines",
      recordedAt: START,
    });
    expect(Object.keys(r)).toEqual([...AUDIT_EXPORT_COLUMNS]);
    const line = jsonlLine(r);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(JSON.parse(line)).toEqual(r);
    expect(csvHeader()).toBe(`${AUDIT_EXPORT_COLUMNS.join(",")}\r\n`);
    const cells = csvLine(r).replace(/\r\n$/, "").split(",");
    expect(cells).toHaveLength(AUDIT_EXPORT_COLUMNS.length);
    expect(cells[AUDIT_EXPORT_COLUMNS.indexOf("tool")]).toBe("read_file");
    expect(cells[AUDIT_EXPORT_COLUMNS.indexOf("allowed")]).toBe("false");
  });

  it("names the file after the clock and the format", () => {
    expect(auditExportFilename("jsonl", "2026-10-20T08:05:09.123Z")).toBe(
      "forerunner-audit-20261020T080509Z.jsonl",
    );
    expect(auditExportFilename("csv", "2026-10-20T08:05:09.000Z")).toBe(
      "forerunner-audit-20261020T080509Z.csv",
    );
  });
});

describe("audit export: query", () => {
  it("defaults to JSON lines, normalises the window and drops blank values", () => {
    expect(parseAuditExportQuery({})).toEqual({ format: "jsonl" });
    expect(
      parseAuditExportQuery({
        agentId: " a1 ",
        sessionId: "",
        from: "2026-10-20T08:00:00Z",
        to: "2026-10-21",
        format: "csv",
      }),
    ).toEqual({
      agentId: "a1",
      from: "2026-10-20T08:00:00.000Z",
      to: "2026-10-21T00:00:00.000Z",
      format: "csv",
    });
  });

  it("refuses a bad format, a bad timestamp and an inverted window as validation errors", () => {
    const fails = (q: Record<string, string | undefined>, hint: string) => {
      try {
        parseAuditExportQuery(q);
      } catch (e) {
        expect(isForerunnerError(e) && e.code === "validation", hint).toBe(true);
        expect(String((e as Error).message)).toContain(hint);
        return;
      }
      throw new Error(`accepted ${JSON.stringify(q)}`);
    };
    fails({ format: "xml" }, "format");
    fails({ from: "yesterday" }, "from");
    fails({ to: "soon" }, "to");
    fails({ from: "2026-10-21T00:00:00Z", to: "2026-10-20T00:00:00Z" }, "from");
    fails({ agentId: "x".repeat(201) }, "agentId");
  });
});

describe("audit export: paging and scope", () => {
  it("pages with limit and offset until a short page and never asks for the whole log", async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row({ id: `r${n}` }));
    const source = pagedSource(rows);
    const pages: string[][] = [];
    for await (const page of auditExportPages(source, {}, 2)) pages.push(page.map((r) => r.id));
    expect(pages).toEqual([["r1", "r2"], ["r3", "r4"], ["r5"]]);
    expect(source.calls).toEqual([
      { limit: 2, offset: 0 },
      { limit: 2, offset: 2 },
      { limit: 2, offset: 4 },
    ]);
    // An exact multiple needs one more (empty) read to know the log ended; nothing empty is yielded.
    const even = pagedSource(rows.slice(0, 4));
    const got: number[] = [];
    for await (const page of auditExportPages(even, {}, 2)) got.push(page.length);
    expect(got).toEqual([2, 2]);
    expect(even.calls).toHaveLength(3);
    // The default page size is the limit the routes and the CLI run with.
    const dflt = pagedSource([row()]);
    for await (const _ of auditExportPages(dflt, {})) {
      // drain
    }
    expect(dflt.calls[0]).toEqual({ limit: AUDIT_EXPORT_PAGE_SIZE, offset: 0 });
  });

  it("keeps a human's rows and their agents' rows; install-level rows only when asked", () => {
    const scope = { humanId: "human-a", agentIds: new Set(["agent-a"]), includeUnowned: false };
    expect(rowInScope(row(), scope)).toBe(true);
    expect(rowInScope(row({ human_id: null }), scope)).toBe(true);
    expect(rowInScope(row({ agent_id: null }), scope)).toBe(true);
    expect(rowInScope(row({ agent_id: "agent-b", human_id: "human-b" }), scope)).toBe(false);
    expect(rowInScope(row({ agent_id: "agent-b", human_id: null }), scope)).toBe(false);
    expect(rowInScope(row({ agent_id: null, human_id: null }), scope)).toBe(false);
    expect(
      rowInScope(row({ agent_id: null, human_id: null }), { ...scope, includeUnowned: true }),
    ).toBe(true);
    expect(rowInScope(row({ agent_id: "agent-b", human_id: "human-b" }), undefined)).toBe(true);
  });

  it("writes every in-scope row across pages in one pass and reports the count", async () => {
    const rows = [
      row({ id: "a", agent_id: "agent-a" }),
      row({ id: "b", agent_id: "agent-b", human_id: "human-b" }),
      row({ id: "c", agent_id: null, human_id: null }),
      row({ id: "d", agent_id: "agent-a" }),
    ];
    const chunks: string[] = [];
    const sink = { write: (t: string) => void chunks.push(t) };
    const result = await writeAuditExport(pagedSource(rows), sink, {
      format: "csv",
      filter: {},
      scope: { humanId: "human-a", agentIds: new Set(["agent-a"]), includeUnowned: false },
      pageSize: 3,
    });
    expect(result).toEqual({ rows: 2 });
    const lines = csvLines(chunks.join(""));
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.join(","));
    expect(lines.slice(1).map((l) => l.split(",")[0])).toEqual(["a", "d"]);
  });
});

describe("audit export: the route over a sqlite store", () => {
  let s: Seeded;
  afterEach(async () => {
    await s?.store.close();
  });

  const app = (over: { humanId?: string; pageSize?: number } = {}) =>
    createAuditRoutes({
      store: s.store,
      clock: s.clock,
      humanId: () => over.humanId ?? s.humanA,
      ...(over.pageSize !== undefined ? { pageSize: over.pageSize } : {}),
    });
  const get = (a: ReturnType<typeof createAuditRoutes>, query = "") =>
    a.request(`/audit/export${query}`);

  it("streams the human's rows as JSON lines in time order with the download headers", async () => {
    s = await seedStore();
    expect(AUDIT_EXPORT_ROUTE).toBe("GET /audit/export");
    const res = await get(app());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="forerunner-audit-20261020T080000Z.jsonl"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const records = parseJsonl(await res.text());
    expect(records.map((r) => r.id)).toEqual(s.expectedForA);
    const denied = records.find((r) => r.tool === "write_file");
    expect(denied).toMatchObject({
      agentId: s.agentA,
      humanId: s.humanA,
      sessionId: "s1",
      runId: "r1",
      allowed: false,
      deniedReason: "path_not_allowed: outside the worktree",
      costUsdMicro: 0,
      tokenId: "tok-a",
    });
    // The stored summary is exported as is: nothing about the raw parameters beyond it.
    expect(denied?.inputSummary).toBe(
      '{"path":"notes.md","text":"=SUM(A1:A3), a \\"quoted\\" line"}',
    );
    for (const r of records) expect(Object.keys(r)).toEqual([...AUDIT_EXPORT_COLUMNS]);
    expect(records.find((r) => r.tool === "web_fetch")?.costUsdMicro).toBe(1_250);
    expect(records.some((r) => r.agentId === s.agentB)).toBe(false);
  });

  it("writes CSV with the header, quoting and the formula guard", async () => {
    s = await seedStore();
    const res = await get(app(), "?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="forerunner-audit-20261020T080000Z.csv"',
    );
    const lines = csvLines(await res.text());
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.join(","));
    expect(lines).toHaveLength(1 + s.expectedForA.length);
    const denied = lines.find((l) => l.includes("write_file"));
    expect(denied).toContain(
      '"{""path"":""notes.md"",""text"":""=SUM(A1:A3), a \\""quoted\\"" line""}"',
    );
    expect(denied).toContain("path_not_allowed: outside the worktree");
  });

  it("filters by agent, session and window; another human's agent is not found", async () => {
    s = await seedStore();
    const ids = async (query: string) =>
      parseJsonl(await (await get(app(), query)).text()).map((r) => r.id);
    expect(await ids(`?agentId=${s.agentA}`)).toEqual([
      s.expectedForA[0],
      s.expectedForA[2],
      s.expectedForA[4],
    ]);
    expect(await ids("?sessionId=s1")).toEqual([s.expectedForA[0], s.expectedForA[2]]);
    expect(await ids("?sessionId=s9")).toEqual([]);
    expect(await ids("?from=2026-10-20T09:00:00Z")).toEqual([
      s.expectedForA[2],
      s.expectedForA[3],
      s.expectedForA[4],
    ]);
    expect(await ids("?from=2026-10-20T08:30:00Z&to=2026-10-20T09:30:00Z")).toEqual([
      s.expectedForA[1],
      s.expectedForA[2],
    ]);
    // `to` is exclusive.
    expect(await ids("?to=2026-10-20T10:00:00Z")).toEqual(s.expectedForA.slice(0, 4));
    const other = await get(app(), `?agentId=${s.agentB}`);
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ code: "not_found" });
    expect((await get(app(), "?agentId=nobody")).status).toBe(404);
    // The same store seen as human B: B's two rows (plus the install-level row), never A's.
    const asB = parseJsonl(await (await get(app({ humanId: s.humanB }))).text());
    expect(asB.map((r) => r.tool)).toEqual(["update.health_check", "run_command", "read_file"]);
    expect(asB.every((r) => r.agentId === s.agentB || r.agentId === null)).toBe(true);
  });

  it("answers 400 for a bad format, timestamp or window before anything streams", async () => {
    s = await seedStore();
    for (const q of [
      "?format=xml",
      "?from=yesterday",
      "?to=never",
      "?from=2026-10-21T00:00:00Z&to=2026-10-20T00:00:00Z",
    ]) {
      const res = await get(app(), q);
      expect(res.status, q).toBe(400);
      expect(await res.json(), q).toMatchObject({ code: "validation" });
    }
  });

  it("reads the log in pages of the configured size", async () => {
    s = await seedStore();
    const list = vi.spyOn(s.store.auditLog, "list");
    const res = await get(app({ pageSize: 2 }));
    expect(parseJsonl(await res.text()).map((r) => r.id)).toEqual(s.expectedForA);
    // Seven rows in the table, pages of two: four reads, each bounded by the page size.
    expect(list).toHaveBeenCalledTimes(4);
    expect(list.mock.calls.map((c) => c[1])).toEqual([
      { limit: 2, offset: 0 },
      { limit: 2, offset: 2 },
      { limit: 2, offset: 4 },
      { limit: 2, offset: 6 },
    ]);
  });

  it("auditScopeFor lists the human's agents and refuses a foreign agent id as not found", async () => {
    s = await seedStore();
    const scope = await auditScopeFor(s.store, s.humanA, undefined, true);
    expect([...scope.agentIds]).toEqual([s.agentA]);
    expect(scope).toMatchObject({ humanId: s.humanA, includeUnowned: true });
    await expect(auditScopeFor(s.store, s.humanA, s.agentB, true)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("audit export: mounted on the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const clock = new SimulatedClock(START);
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    app.request(path, {
      ...init,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    });

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-audit-export-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Hello." }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  it("is in the route table, needs the bearer token and exports the install's rows only", async () => {
    expect(DAEMON_ROUTES.auditExport.startsWith(AUDIT_EXPORT_ROUTE)).toBe(true);
    const other = await rt.store.human.insert({ name: "Bob", email: "bob@example.test" });
    const otherAgent = await rt.store.agent.insert({
      name: "Bobby",
      owner_human_id: other.id,
      kind: "principal",
    });
    await rt.store.auditLog.append({
      agent_id: rt.agent.id,
      human_id: rt.human.id,
      session_id: "s-mine",
      tool: "read_file",
      input_summary: "README.md",
      result_summary: "ok",
      allowed: true,
    });
    await rt.store.auditLog.append({
      agent_id: otherAgent.id,
      human_id: other.id,
      tool: "read_file",
      input_summary: "secret-plan.md",
      result_summary: "ok",
      allowed: true,
    });
    expect((await req("/audit/export", {}, false)).status).toBe(401);
    expect(
      (await app.request("/audit/export", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    // The SSE query-token exception does not cover the export.
    expect((await app.request(`/audit/export?token=${token}`)).status).toBe(401);
    const res = await req("/audit/export", { headers: { origin: "http://localhost:5173" } });
    expect(res.status).toBe(200);
    // The shells run from another origin: the filename header must be readable there.
    expect(res.headers.get("access-control-expose-headers")).toContain("Content-Disposition");
    const records = parseJsonl(await res.text());
    const mine = records.filter((r) => r.agentId !== null);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.agentId === rt.agent.id)).toBe(true);
    expect(records.some((r) => r.inputSummary === "secret-plan.md")).toBe(false);
    expect((await req(`/audit/export?agentId=${otherAgent.id}`)).status).toBe(404);
    const csv = await req(`/audit/export?format=csv&sessionId=s-mine`);
    expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(csvLines(await csv.text())).toHaveLength(2);
  });
});
