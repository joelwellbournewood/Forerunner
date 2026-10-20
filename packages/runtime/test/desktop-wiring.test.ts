import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { desktop } from "@forerunner/capabilities";
import {
  appDirs,
  ForerunnerError,
  join,
  Logger,
  type LogRecord,
  SimulatedClock,
} from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolExecutionContext, ToolSpec } from "../src/agent/tools.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import {
  DESKTOP_ALLOWLIST_READ_TOOL,
  GuardedAllowlistStore,
  UnavailableDesktopAdapter,
} from "../src/wiring/desktop-ports.ts";

/**
 * The daemon's side of the desktop allowlist file (ADR 0039): a hand-edited
 * `<config>/desktop-allowlist.json` that does not read is a `validation` error naming the file
 * on the routes and on every desktop tool call, audited as `desktop_allowlist.read`, never
 * `internal` carrying the parser's message; the next read picks up a fixed file without a
 * restart. No adapter (a machine without a desktop), `sqlite::memory:`, memory vault,
 * SimulatedClock, no provider, no network.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;
const str = (v: unknown): string => String(v);

describe("the desktop allowlist file in the daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let file = "";
  const logs: LogRecord[] = [];
  let stopLogs = () => {};
  const clock = new SimulatedClock("2026-10-20T08:00:00Z");
  // The parser quotes a snippet of the document in its message; it must reach nothing.
  const marker = ["ALLOWLIST", "MARKER", "4c2e"].join("-"); // not-a-secret
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const put = (path: string, body: unknown) =>
    req(path, { method: "PUT", body: JSON.stringify(body) });
  const readRows = () =>
    rt.store.auditLog.list({ tool: DESKTOP_ALLOWLIST_READ_TOOL } as never, { limit: 50 });
  const ctx = (): ToolExecutionContext => ({
    runId: "run-allowlist-1",
    sessionId: "session-allowlist-1",
    agentId: rt.agent.id,
    humanId: rt.human.id,
    allowedPaths: [],
    signal: new AbortController().signal,
  });
  const rejection = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-desktop-allowlist-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    file = join(dirs.config, desktop.DESKTOP_ALLOWLIST_FILE);
    writeFileSync(file, `${marker} is not json\n`);
    stopLogs = Logger.addSink((r) => logs.push(r));
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      startServices: false,
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      // A machine without a desktop: detection found nothing usable.
      desktop: {
        detect: async () => ({
          platform: "linux",
          displayServer: "none",
          adapter: null,
          found: {},
          missing: ["DISPLAY"],
          notes: ["test: no desktop"],
        }),
      },
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    stopLogs();
    await rt?.close();
  });

  it("composes the guarded file store over <config>/desktop-allowlist.json and the unavailable adapter", async () => {
    expect(rt.desktop.allowlist).toBeInstanceOf(GuardedAllowlistStore);
    expect((rt.desktop.allowlist as GuardedAllowlistStore).file).toBe(file);
    expect(rt.desktop.controller.status().adapter).toBe("linux");
    expect(await json(await req("/desktop/status"))).toMatchObject({
      detection: { available: false, missing: ["DISPLAY"] },
    });
    expect(new UnavailableDesktopAdapter({ platform: "linux", missing: [] }).platform).toBe(
      "linux",
    );
  });

  it("a file that is not JSON: the routes answer `validation` naming the file, not the parser's message", async () => {
    const got = await req(`/desktop/allowlist/${rt.human.id}`);
    expect(got.status).toBe(400);
    const body = (await json(got)).error as Json;
    expect(body).toMatchObject({ code: "validation", details: { file } });
    expect(str(body.message)).toContain(desktop.DESKTOP_ALLOWLIST_FILE);
    expect(str(body.message)).toContain("is not valid JSON");
    expect(str(body.message)).not.toContain(marker);
    // A write reads the file first and refuses the same way: the file is fixed by hand.
    const set = await put(`/desktop/allowlist/${rt.human.id}`, { entries: ["code"] });
    expect(set.status).toBe(400);
    expect(((await json(set)).error as Json).code).toBe("validation");
    expect(readFileSync(file, "utf8")).toContain(marker);
    const rows = await readRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ allowed: false, human_id: rt.human.id, input_summary: file });
    expect(str(rows[0]?.denied_reason)).toMatch(/^validation: /);
  });

  it("every desktop tool call is refused with the same code before the gate decides, and the snippet reaches neither the error, the audit log nor the log", async () => {
    // The desktop tools carry the gate-only `beforeCall` the hooks run before `execute`.
    const tool = rt.toolsForRun().get("desktop_list_windows") as
      | (ToolSpec & { beforeCall(input: unknown, ctx: ToolExecutionContext): Promise<void> })
      | undefined;
    if (!tool) throw new Error("desktop_list_windows is not registered");
    const before = (await readRows()).length;
    for (const attempt of [tool.beforeCall({}, ctx()), tool.execute({}, ctx())]) {
      const e = await rejection(attempt);
      expect(e).toBeInstanceOf(ForerunnerError);
      expect((e as ForerunnerError).code).toBe("validation");
      expect((e as ForerunnerError).message).toContain(desktop.DESKTOP_ALLOWLIST_FILE);
      expect((e as ForerunnerError).message).not.toContain(marker);
    }
    const rows = await readRows();
    expect(rows.length).toBe(before + 2);
    const everything = `${JSON.stringify(rows)}\n${JSON.stringify(logs)}`;
    expect(everything).not.toContain(marker);
    expect(logs.some((l) => /desktop allowlist unreadable/.test(l.msg))).toBe(true);
  });

  it("a fixed file reads at the next call without a restart; a bad entry in a write is the body's error, never blamed on the file", async () => {
    writeFileSync(file, `${JSON.stringify({ [rt.human.id]: ["code"] })}\n`);
    expect(await json(await req(`/desktop/allowlist/${rt.human.id}`))).toEqual({
      humanId: rt.human.id,
      entries: [{ app: "code" }],
    });
    const before = (await readRows()).length;
    const bad = await put(`/desktop/allowlist/${rt.human.id}`, { entries: [""] });
    expect(bad.status).toBe(400);
    expect(str(((await json(bad)).error as Json).message)).not.toContain(
      desktop.DESKTOP_ALLOWLIST_FILE,
    );
    expect((await readRows()).length).toBe(before);
    // A file that parses but is not an allowlist is the same `validation` on a read.
    writeFileSync(file, `${JSON.stringify({ [rt.human.id]: [{ note: "no app" }] })}\n`);
    const shape = await req(`/desktop/allowlist/${rt.human.id}`);
    expect(shape.status).toBe(400);
    expect(str(((await json(shape)).error as Json).message)).toContain(
      "does not hold a valid allowlist",
    );
    expect((await readRows()).length).toBe(before + 1);
  });
});
