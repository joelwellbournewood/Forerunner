import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { ContextManager, HEADROOM_REPROBE_MS } from "../src/context/manager.ts";
import { ContextOriginals } from "../src/context/originals.ts";
import { type ContextSettings, DEFAULT_CONTEXT_SETTINGS } from "../src/context/pipeline.ts";
import { FakeHeadroom } from "./context-helpers.ts";

type Policy = ContextSettings["compression"];

function manager(headroom: FakeHeadroom, policy: Policy, clock = new SimulatedClock()) {
  const notices: { sessionId: string; notice: string | null }[] = [];
  const m = new ContextManager({
    clock,
    headroom,
    settingsFor: async () => ({ ...DEFAULT_CONTEXT_SETTINGS, compression: policy }),
    onNotice: (sessionId, sel) => notices.push({ sessionId, notice: sel.notice }),
  });
  return { m, notices, clock };
}

describe("ContextManager", () => {
  it("probes once per session when the project asks for Headroom and turns the /stats delta into saved tokens", async () => {
    const headroom = new FakeHeadroom("healthy", { p1: 1000 });
    const { m, notices } = manager(headroom, "headroom");
    const ctx = await m.forSession("s1", "p1");
    expect(ctx.selection).toMatchObject({
      policy: "headroom",
      mode: "headroom",
      headroomUsed: true,
    });
    expect(ctx.headroomBaseline).toBe(1000);
    expect(headroom.probes).toBe(1);
    expect(await m.forSession("s1", "p1")).toBe(ctx);
    expect(headroom.probes).toBe(1);
    expect(notices).toEqual([]);
    ctx.pipeline.compressToolResult(`${"same\n".repeat(40)}end`, "run_command");
    headroom.saved.p1 = 1800;
    const end = await m.endSession("s1");
    expect(end?.headroomSavedTokens).toBe(800);
    expect(end?.compression.saved).toBeGreaterThan(0);
    expect(end?.compression.transforms).toContain("logs");
    expect(end?.selection.headroomUsed).toBe(true);
    expect(await m.endSession("s1")).toBeNull();
    expect(m.get("s1")).toBeUndefined();
  });

  it("re-probes every 60 s on the session's clock, without a task starting, and degrades to native with a notice when the proxy dies", async () => {
    const headroom = new FakeHeadroom("healthy", { p1: 5 });
    const { m, notices, clock } = manager(headroom, "headroom");
    const ctx = await m.forSession("s1", "p1");
    expect(ctx.sdkEnv).toEqual({
      ANTHROPIC_BASE_URL: headroom.url,
      ANTHROPIC_CUSTOM_HEADERS: "X-Headroom-Project: p1",
    });
    expect(clock.pendingTimers()).toBe(1);
    await clock.advance(HEADROOM_REPROBE_MS - 1);
    expect(headroom.probes).toBe(1);
    headroom.status = "not_running";
    // Nothing calls forSession: a long task would never do so, the timer must.
    await clock.advance(1);
    expect(headroom.probes).toBe(2);
    expect(ctx.selection.mode).toBe("native");
    expect(ctx.selection.headroomUsed).toBe(false);
    expect(ctx.selection.notice).toContain("not running");
    expect(ctx.sdkEnv).toBeNull();
    expect(notices).toEqual([{ sessionId: "s1", notice: ctx.selection.notice }]);
    expect(await m.forSession("s1", "p1")).toBe(ctx);
    // It keeps probing; a proxy that comes back is used again, without a second notice.
    headroom.status = "healthy";
    await clock.advance(HEADROOM_REPROBE_MS);
    expect(headroom.probes).toBe(3);
    expect(ctx.selection.headroomUsed).toBe(true);
    expect(ctx.sdkEnv).not.toBeNull();
    expect(notices).toHaveLength(1);
    // Ending the session cancels the timer: no probe runs for a session that is gone.
    headroom.status = "not_running";
    expect((await m.endSession("s1"))?.headroomSavedTokens).toBe(0);
    expect(clock.pendingTimers()).toBe(0);
    await clock.advance(HEADROOM_REPROBE_MS * 3);
    expect(headroom.probes).toBe(3);
    expect(notices).toHaveLength(1);
  });

  it("close() stops every scheduled re-probe; native sessions never schedule one", async () => {
    const headroom = new FakeHeadroom("healthy", {});
    const { m, clock } = manager(headroom, "headroom");
    await m.forSession("s1", "p1");
    await m.forSession("s2", "p1");
    expect(clock.pendingTimers()).toBe(2);
    m.close();
    expect(clock.pendingTimers()).toBe(0);
    await clock.advance(HEADROOM_REPROBE_MS);
    expect(headroom.probes).toBe(2);
    const native = manager(new FakeHeadroom("healthy", {}), "native");
    await native.m.forSession("s3", "p1");
    expect(native.clock.pendingTimers()).toBe(0);
  });

  it("never probes for native or off, reports the unavailable proxy once, and survives a broken settings lookup", async () => {
    const headroom = new FakeHeadroom("not_installed");
    const native = manager(headroom, "native");
    const ctx = await native.m.forSession("s1", "p1");
    expect(ctx.selection).toEqual({
      policy: "native",
      mode: "native",
      headroomUsed: false,
      headroom: null,
      notice: null,
    });
    expect(ctx.headroomBaseline).toBeNull();
    expect(headroom.probes).toBe(0);
    expect((await native.m.endSession("s1"))?.headroomSavedTokens).toBe(0);

    const asked = manager(headroom, "headroom");
    const c2 = await asked.m.forSession("s2", "p1");
    expect(c2.selection.notice).toContain("not installed");
    expect(asked.notices).toHaveLength(1);
    await asked.m.forSession("s2", "p1");
    expect(asked.notices).toHaveLength(1);

    const broken = new ContextManager({
      clock: new SimulatedClock(),
      headroom,
      settingsFor: async () => {
        throw new Error("store down");
      },
    });
    expect((await broken.forSession("s3", undefined)).settings).toEqual(DEFAULT_CONTEXT_SETTINGS);
    expect((await new ContextManager({ clock: new SimulatedClock() }).probe()).status).toBe(
      "disabled",
    );
  });

  it("stores the original of every changed block after redact(), under the hash the marker names, and prunes by age", async () => {
    const base = mkdtempSync(join(tmpdir(), "fr-context-originals-"));
    try {
      const clock = new SimulatedClock("2026-10-20T10:00:00Z");
      const m = new ContextManager({
        clock,
        settingsFor: async () => ({ ...DEFAULT_CONTEXT_SETTINGS, maxToolResultTokens: 400 }),
        originalsDir: base,
      });
      const ctx = await m.forSession("sess 1/x", "p1");
      expect(ctx.originals?.dir).toBe(join(base, "sess-1-x"));
      const token = ["ghp_", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join(""); // not-a-secret
      const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(60)}`);
      lines[120] = `token=${token}`;
      const big = lines.join("\n");
      const run = ctx.pipeline.beginRun();
      const r = run.compressToolResult(big, "run_command");
      expect(r.record.transforms).toContain("truncate");
      expect(r.record.original).toMatch(/^[0-9a-f]{12}$/);
      const hash = r.record.original ?? "";
      // The marker names the stored original, and it resolves.
      expect(r.text).toContain(`; original ${hash}]`);
      expect(ctx.originals?.list()).toEqual([hash]);
      const stored = ctx.originals?.read(hash) ?? "";
      expect(stored).not.toContain(token);
      expect(stored).toContain("token=[REDACTED]");
      expect(stored.split("\n")).toHaveLength(200);
      expect(stored).toContain("line 199 ");
      expect(m.originalsFor("sess 1/x")?.read(hash)).toBe(stored);
      expect(ctx.originals?.read("000000000000")).toBeNull();
      // An unchanged block stores nothing; the same block again is one file.
      expect(run.compressToolResult("tiny", "echo").record.original).toBeNull();
      run.compressToolResult(big, "run_command");
      expect(ctx.originals?.list()).toEqual([hash]);
      await m.endSession("sess 1/x");

      // Pruning: a session older than the max age goes, a fresh one stays.
      const old = join(base, "old-session");
      mkdirSync(old, { recursive: true });
      writeFileSync(join(old, "abc.txt"), "x", "utf8");
      const ago = new Date(clock.now() - 31 * 24 * 3_600_000);
      utimesSync(join(old, "abc.txt"), ago, ago);
      const fresh = new Date(clock.now());
      utimesSync(join(base, "sess-1-x", `${hash}.txt`), fresh, fresh);
      const again = new ContextManager({ clock, originalsDir: base });
      expect(readdirSync(base).sort()).toEqual(["sess-1-x"]);
      again.originalsFor("sess-1-x");
      new ContextOriginals(base).remove("sess 1/x");
      expect(readdirSync(base)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("without a store nothing is written and no marker names an original", async () => {
    const m = new ContextManager({
      clock: new SimulatedClock(),
      settingsFor: async () => ({ ...DEFAULT_CONTEXT_SETTINGS, maxToolResultTokens: 400 }),
    });
    const ctx = await m.forSession("s1", "p1");
    expect(ctx.originals).toBeNull();
    const big = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n");
    const r = ctx.pipeline.compressToolResult(big, "run_command");
    expect(r.record.transforms).toContain("truncate");
    expect(r.record.original).toBeNull();
    expect(r.text).not.toContain("original ");
    expect(m.originalsFor("s1")).toBeNull();
  });
});
