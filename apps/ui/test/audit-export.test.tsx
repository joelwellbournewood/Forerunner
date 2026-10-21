import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countExportRows, createClient, filenameFromDisposition } from "../src/api/client.ts";
import { saveTextFile } from "../src/lib/download.ts";
import { AUDIT_EXPORT } from "./fixtures.ts";
import { createHarness, fetchFromApp, renderApp, testConfig } from "./helpers.tsx";

vi.mock("../src/lib/download.ts", () => ({ saveTextFile: vi.fn(() => true) }));
const saved = vi.mocked(saveTextFile);

/**
 * Spec S.9 in the app: the Performance view carries "Export audit log", which calls
 * `GET /audit/export` on the daemon through the client and hands the body to the browser as a
 * download named by the daemon. Against the fake daemon; the save step is mocked here and
 * tested in `download.test.ts`.
 */
describe("audit export client", () => {
  it("reads the filename from Content-Disposition and counts rows per format", () => {
    expect(filenameFromDisposition('attachment; filename="forerunner-audit-x.jsonl"')).toBe(
      "forerunner-audit-x.jsonl",
    );
    expect(filenameFromDisposition("attachment; filename=plain.csv")).toBe("plain.csv");
    expect(filenameFromDisposition('attachment; filename="../../evil.sh"')).toBe("evil.sh");
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("inline")).toBeNull();
    expect(countExportRows('{"a":1}\n{"a":2}\n', "jsonl")).toBe(2);
    expect(countExportRows("", "jsonl")).toBe(0);
    expect(countExportRows("id,tool\r\n1,x\r\n2,y\r\n", "csv")).toBe(2);
    expect(countExportRows("id,tool\r\n", "csv")).toBe(0);
  });

  it("fetches the export with the bearer token, the filters and the format", async () => {
    const daemon = createHarness().daemon;
    const client = createClient(testConfig("test-token"), fetchFromApp(daemon.app));
    const file = await client.auditExport({ format: "jsonl" });
    expect(file.filename).toMatch(/^forerunner-audit-.*\.jsonl$/);
    expect(file.contentType).toContain("application/x-ndjson");
    expect(file.rows).toBe(AUDIT_EXPORT.length);
    const parsed = file.text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: string; tool: string });
    expect(parsed.map((r) => r.id)).toEqual(AUDIT_EXPORT.map((r) => r.id));

    const csv = await client.auditExport({ format: "csv", sessionId: "sess_1" });
    expect(csv.filename).toMatch(/\.csv$/);
    expect(csv.contentType).toContain("text/csv");
    const lines = csv.text.split("\r\n").filter(Boolean);
    expect(lines[0]?.startsWith("id,occurredAt,")).toBe(true);
    expect(csv.rows).toBe(AUDIT_EXPORT.filter((r) => r.sessionId === "sess_1").length);
    expect(csv.rows).toBeLessThan(AUDIT_EXPORT.length);

    const anonymous = createClient(testConfig(null), fetchFromApp(daemon.app));
    await expect(anonymous.auditExport()).rejects.toMatchObject({ status: 401 });
  });
});

describe("Export audit log on the Performance view", () => {
  beforeEach(() => {
    saved.mockClear();
  });

  it("downloads the daemon's file in the chosen format and reports the row count", async () => {
    renderApp("/performance");
    const panel = await screen.findByTestId("audit-export");
    expect(panel).toHaveTextContent("Audit log");
    const button = within(panel).getByRole("button", { name: "Export audit log" });
    fireEvent.click(button);
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    const first = saved.mock.calls[0]?.[0];
    expect(first?.filename).toMatch(/\.jsonl$/);
    expect(first?.contentType).toContain("application/x-ndjson");
    expect(first?.text.split("\n").filter(Boolean)).toHaveLength(AUDIT_EXPORT.length);
    expect(within(panel).getByTestId("audit-export-status")).toHaveTextContent(
      `Exported ${AUDIT_EXPORT.length} rows to ${first?.filename}`,
    );

    fireEvent.change(within(panel).getByLabelText("Export format"), { target: { value: "csv" } });
    fireEvent.click(button);
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
    const second = saved.mock.calls[1]?.[0];
    expect(second?.filename).toMatch(/\.csv$/);
    expect(second?.text.startsWith("id,occurredAt,")).toBe(true);
  });

  it("says so when the browser cannot save a file and when the daemon lacks the route", async () => {
    saved.mockReturnValueOnce(false);
    renderApp("/performance");
    const panel = await screen.findByTestId("audit-export");
    fireEvent.click(within(panel).getByRole("button", { name: "Export audit log" }));
    await waitFor(() =>
      expect(within(panel).getByTestId("audit-export-status")).toHaveTextContent(
        "cannot save files",
      ),
    );
  });

  it("names the missing route when the daemon has no audit export", async () => {
    renderApp("/performance", createHarness({ missingRoutes: ["/audit/export"] }));
    const panel = await screen.findByTestId("audit-export");
    fireEvent.click(within(panel).getByRole("button", { name: "Export audit log" }));
    await waitFor(() =>
      expect(within(panel).getByTestId("audit-export-status")).toHaveTextContent(
        "GET /audit/export",
      ),
    );
    expect(saved).not.toHaveBeenCalled();
  });
});
