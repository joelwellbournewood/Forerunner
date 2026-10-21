import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_PAGE_SIZE,
  type AuditExportRecord,
} from "@forerunner/runtime/daemon/audit-export";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeviceClient, type Harness, harness, json } from "./helpers.ts";

/**
 * Spec S.9 on the state service: `GET /audit/export` gives a device the audit rows of its
 * own human and that human's agents, streamed in pages as JSON lines or CSV; another human's
 * agent is not found, another human's id is forbidden, and the runtime (admin) sees the
 * whole log. SQLite in memory, simulated clock, through the signed device client.
 */
const parseJsonl = (text: string): AuditExportRecord[] =>
  text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditExportRecord);
const csvLines = (text: string): string[] => text.split("\r\n").filter((l) => l.length > 0);

interface Rows {
  aliceRead: string;
  aliceDenied: string;
  adaOnly: string;
  bobby: string;
  unowned: string;
}

describe("state service audit export", () => {
  let h: Harness;
  let phone: DeviceClient;
  let rows: Rows;
  const at = (h: Harness, minutes: number) =>
    new Date(h.clock.now() + minutes * 60_000).toISOString();

  beforeEach(async () => {
    h = await harness();
    phone = await h.pairDevice(h.seed.ada.id);
    const aliceRead = await h.store.auditLog.append({
      agent_id: h.seed.alice.id,
      human_id: h.seed.ada.id,
      session_id: h.seed.session.id,
      run_id: "r1",
      tool: "read_file",
      input_summary: '{"path":"README.md"}',
      result_summary: "12 lines",
      allowed: true,
      occurred_at: at(h, 0),
      token_id: "tok-1",
    });
    const unowned = await h.store.auditLog.append({
      tool: "update.health_check",
      input_summary: "1.1.0",
      result_summary: "healthy",
      allowed: true,
      occurred_at: at(h, 1),
    });
    const bobby = await h.store.auditLog.append({
      agent_id: h.seed.bobAgent.id,
      human_id: h.seed.bob.id,
      tool: "run_command",
      input_summary: "cat plan.md",
      result_summary: "ok",
      allowed: true,
      occurred_at: at(h, 2),
    });
    const aliceDenied = await h.store.auditLog.append({
      agent_id: h.seed.alice.id,
      human_id: h.seed.ada.id,
      session_id: h.seed.session.id,
      run_id: "r1",
      tool: "write_file",
      input_summary: '{"path":"/etc/hosts"}',
      result_summary: "",
      allowed: false,
      denied_reason: "path_not_allowed: outside the worktree",
      occurred_at: at(h, 3),
      token_id: "tok-1",
    });
    const adaOnly = await h.store.auditLog.append({
      human_id: h.seed.ada.id,
      tool: "notifications.prefs",
      input_summary: "quietHours",
      result_summary: "changed",
      allowed: true,
      occurred_at: at(h, 4),
    });
    rows = {
      aliceRead: aliceRead.id,
      aliceDenied: aliceDenied.id,
      adaOnly: adaOnly.id,
      bobby: bobby.id,
      unowned: unowned.id,
    };
  });
  afterEach(() => h.close());

  it("gives a device its human's rows and their agents' rows only, as JSON lines", async () => {
    const res = await phone.get("/audit/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="forerunner-audit-20260301T090000Z.jsonl"',
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const records = parseJsonl(await res.text());
    expect(records.map((r) => r.id)).toEqual([rows.aliceRead, rows.aliceDenied, rows.adaOnly]);
    for (const r of records) expect(Object.keys(r)).toEqual([...AUDIT_EXPORT_COLUMNS]);
    expect(records[1]).toMatchObject({
      agentId: h.seed.alice.id,
      humanId: h.seed.ada.id,
      sessionId: h.seed.session.id,
      tool: "write_file",
      allowed: false,
      deniedReason: "path_not_allowed: outside the worktree",
      inputSummary: '{"path":"/etc/hosts"}',
    });
    // Install-level rows of some runtime are not a phone's business; Bob's rows never are.
    expect(records.some((r) => r.id === rows.unowned || r.id === rows.bobby)).toBe(false);
  });

  it("writes CSV with the header and the formula guard", async () => {
    await h.store.auditLog.append({
      agent_id: h.seed.alice.id,
      human_id: h.seed.ada.id,
      tool: "write_file",
      input_summary: "=HYPERLINK(x)",
      result_summary: 'a "quoted", cell',
      allowed: true,
      occurred_at: at(h, 5),
    });
    const res = await phone.get("/audit/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain(".csv");
    const lines = csvLines(await res.text());
    expect(lines[0]).toBe(AUDIT_EXPORT_COLUMNS.join(","));
    expect(lines).toHaveLength(5);
    expect(lines[4]).toContain("'=HYPERLINK(x)");
    expect(lines[4]).toContain('"a ""quoted"", cell"');
  });

  it("filters by agent, session and window", async () => {
    const ids = async (query: string) =>
      parseJsonl(await (await phone.get(`/audit/export${query}`)).text()).map((r) => r.id);
    expect(await ids(`?agentId=${h.seed.alice.id}`)).toEqual([rows.aliceRead, rows.aliceDenied]);
    expect(await ids(`?sessionId=${h.seed.session.id}`)).toEqual([
      rows.aliceRead,
      rows.aliceDenied,
    ]);
    expect(await ids(`?from=${encodeURIComponent(at(h, 3))}`)).toEqual([
      rows.aliceDenied,
      rows.adaOnly,
    ]);
    // `to` is exclusive.
    expect(
      await ids(`?from=${encodeURIComponent(at(h, 0))}&to=${encodeURIComponent(at(h, 3))}`),
    ).toEqual([rows.aliceRead]);
  });

  it("refuses another human's agent as not found and another human's id as forbidden", async () => {
    const other = await phone.get(`/audit/export?agentId=${h.seed.bobAgent.id}`);
    expect(other.status).toBe(404);
    expect(await json(other)).toMatchObject({ code: "not_found" });
    const missing = await phone.get("/audit/export?agentId=nobody");
    expect(missing.status).toBe(404);
    const human = await phone.get(`/audit/export?humanId=${h.seed.bob.id}`);
    expect(human.status).toBe(403);
    expect(await json(human)).toMatchObject({ code: "forbidden" });
    // Naming its own human is fine.
    const own = await phone.get(`/audit/export?humanId=${h.seed.ada.id}`);
    expect(own.status).toBe(200);
    expect(parseJsonl(await own.text())).toHaveLength(3);
  });

  it("needs a token; the read scope every device holds is enough; a bad format or window is 400", async () => {
    expect((await h.anonymous.get("/audit/export")).status).toBe(401);
    expect(
      (await h.anonymous.get("/audit/export", { headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
    // `resolveScopes` grants `read` to every pairing; the narrowest device can still export.
    const narrow = await h.pairDevice(h.seed.ada.id, "web", ["read"]);
    const res = await narrow.get("/audit/export");
    expect(res.status).toBe(200);
    expect(parseJsonl(await res.text())).toHaveLength(3);
    for (const q of [
      "?format=xml",
      "?from=yesterday",
      "?from=2026-03-02T00:00:00Z&to=2026-03-01T00:00:00Z",
    ]) {
      const res = await phone.get(`/audit/export${q}`);
      expect(res.status, q).toBe(400);
      expect(await json(res), q).toMatchObject({ code: "validation" });
    }
  });

  it("gives the runtime (admin) the whole log, or one human's rows when it names one", async () => {
    const all = parseJsonl(await (await h.admin.get("/audit/export")).text());
    expect(all.map((r) => r.id)).toEqual([
      rows.aliceRead,
      rows.unowned,
      rows.bobby,
      rows.aliceDenied,
      rows.adaOnly,
    ]);
    const bobs = parseJsonl(
      await (await h.admin.get(`/audit/export?humanId=${h.seed.bob.id}`)).text(),
    );
    expect(bobs.map((r) => r.id)).toEqual([rows.bobby]);
    const bobby = parseJsonl(
      await (await h.admin.get(`/audit/export?agentId=${h.seed.bobAgent.id}`)).text(),
    );
    expect(bobby.map((r) => r.id)).toEqual([rows.bobby]);
    // An admin naming a human and an agent that is not theirs gets the same not-found answer.
    expect(
      (await h.admin.get(`/audit/export?humanId=${h.seed.bob.id}&agentId=${h.seed.alice.id}`))
        .status,
    ).toBe(404);
  });

  it("streams a log longer than one page through several bounded reads", async () => {
    const extra = AUDIT_EXPORT_PAGE_SIZE * 2 + 3;
    for (let i = 0; i < extra; i++) {
      await h.store.auditLog.append({
        agent_id: h.seed.alice.id,
        human_id: h.seed.ada.id,
        session_id: "bulk",
        tool: "read_file",
        input_summary: `file-${i}.md`,
        result_summary: "ok",
        allowed: true,
        occurred_at: at(h, 10 + i),
      });
    }
    const list = vi.spyOn(h.store.auditLog, "list");
    const records = parseJsonl(await (await phone.get("/audit/export?sessionId=bulk")).text());
    expect(records).toHaveLength(extra);
    expect(records[0]?.inputSummary).toBe("file-0.md");
    expect(records[extra - 1]?.inputSummary).toBe(`file-${extra - 1}.md`);
    // 1003 rows in pages of 500: three reads, every one capped at the page size.
    expect(list).toHaveBeenCalledTimes(3);
    for (const call of list.mock.calls) expect(call[1]?.limit).toBe(AUDIT_EXPORT_PAGE_SIZE);
    expect(list.mock.calls.map((c) => c[1]?.offset)).toEqual([0, 500, 1000]);
  }, 60_000);
});
