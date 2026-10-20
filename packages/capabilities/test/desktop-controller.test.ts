import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isForerunnerError, isInside, join, SimulatedClock } from "@forerunner/platform";
import { KillSwitch, MemoryAudit, type ToolExecutionContext } from "@forerunner/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { FakeDesktopAdapter } from "../src/desktop/adapters/fake.ts";
import { FakeDesktopApprovals } from "../src/desktop/approvals.ts";
import { DesktopController } from "../src/desktop/controller.ts";
import { isDesktopDenial } from "../src/desktop/gate.ts";
import { RecordingIndicator } from "../src/desktop/indicator.ts";
import type { DesktopRunBinding, WindowInfo } from "../src/desktop/types.ts";

const code: WindowInfo = {
  id: "0x1",
  title: "main.ts - Code",
  exe: "code",
  windowClass: "code.Code",
};
const bank: WindowInfo = {
  id: "0x2",
  title: "Bank",
  exe: "firefox",
  windowClass: "Navigator.firefox",
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(
  opts: Partial<DesktopRunBinding> & {
    active?: WindowInfo | null;
    approvals?: FakeDesktopApprovals;
  } = {},
) {
  const { active, approvals, ...binding } = opts;
  const clock = new SimulatedClock();
  const audit = new MemoryAudit();
  const trace: string[] = [];
  const adapter = new FakeDesktopAdapter({
    windows: [code, bank],
    active: active === undefined ? code : active,
    onCall: (c) => trace.push(`adapter:${c.method}`),
  });
  const indicator = new RecordingIndicator((e) => trace.push(`indicator:${e.type}`));
  const kill = new KillSwitch();
  const dir = mkdtempSync(join(tmpdir(), "fr-desktop-ctl-"));
  dirs.push(dir);
  const controller = new DesktopController({
    adapter,
    binding: async () => ({
      enabled: true,
      autonomy: 3,
      allowlist: ["code"],
      tokenId: "tok1",
      ...binding,
    }),
    indicator,
    audit,
    clock,
    kill,
    screenshotDir: () => join(dir, "shots"),
    indicatorIdleMs: 1000,
    ...(approvals ? { approvals } : {}),
  });
  return { controller, adapter, indicator, audit, clock, kill, trace, dir };
}

const ctx = (over: Partial<ToolExecutionContext> = {}): ToolExecutionContext => ({
  runId: "r1",
  sessionId: "s1",
  agentId: "alice",
  humanId: "h1",
  allowedPaths: [],
  signal: new AbortController().signal,
  ...over,
});

const tick = () => new Promise<void>((r) => setImmediate(r));
const actions = (adapter: FakeDesktopAdapter) =>
  adapter.calls
    .filter((c) => !["listWindows", "activeWindow"].includes(c.method))
    .map((c) => c.method);
const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("DesktopController", () => {
  it("turns the indicator on before the first action and off after the last one", async () => {
    const w = world();
    await w.controller.focus(ctx(), "code");
    await w.controller.typeText(ctx(), "hello");
    expect(w.trace).toEqual([
      "adapter:listWindows",
      "indicator:on",
      "adapter:focus",
      "adapter:activeWindow",
      "adapter:typeText",
    ]);
    expect(w.indicator.events[0]?.reason).toMatchObject({
      agentId: "alice",
      runId: "r1",
      app: "code",
    });
    expect(w.controller.status().indicatorOn).toBe(true);
    await w.clock.advance(999);
    expect(w.controller.status().indicatorOn).toBe(true);
    await w.clock.advance(1);
    expect(w.trace.at(-1)).toBe("indicator:off");
    expect(w.indicator.events.map((e) => e.type)).toEqual(["on", "off"]);
    // Next action turns it on again.
    await w.controller.pressKey(ctx(), "Return");
    expect(w.indicator.events.map((e) => e.type)).toEqual(["on", "off", "on"]);
  });

  it("endRun turns the indicator off at once when nothing else is active", async () => {
    const w = world();
    await w.controller.typeText(ctx(), "x");
    expect(w.indicator.isOn).toBe(true);
    await w.controller.endRun("r1");
    expect(w.indicator.isOn).toBe(false);
    await w.clock.advance(5000);
    expect(w.indicator.events.map((e) => e.type)).toEqual(["on", "off"]);
  });

  it("revoke turns the indicator off and refuses until resume", async () => {
    const w = world();
    await w.controller.typeText(ctx(), "x");
    const report = await w.controller.revoke("panel toggle");
    expect(report).toEqual({ reason: "panel toggle", interrupted: 0, dropped: 0 });
    expect(w.indicator.events.map((e) => e.type)).toEqual(["on", "off"]);
    const e = await caught(w.controller.typeText(ctx(), "y"));
    expect(isDesktopDenial(e, "revoked")).toBe(true);
    expect(actions(w.adapter)).toEqual(["typeText"]);
    expect(w.controller.status()).toMatchObject({ revoked: true, revokedReason: "panel toggle" });
    w.controller.resume();
    await w.controller.typeText(ctx(), "y");
    expect(actions(w.adapter)).toEqual(["typeText", "typeText"]);
  });

  it("a live revoke interrupts the in-flight action and drops the queued one", async () => {
    const w = world();
    w.adapter.hold();
    const first = w.controller.typeText(ctx(), "slow");
    const second = w.controller.pressKey(ctx({ runId: "r2" }), "Return");
    await tick();
    await tick();
    expect(w.controller.status()).toMatchObject({ inFlight: 1, queued: 1, indicatorOn: true });
    expect(w.adapter.held).toBe(1);
    const report = await w.controller.revoke("kill from the panel");
    expect(report).toEqual({ reason: "kill from the panel", interrupted: 1, dropped: 1 });
    const e1 = await caught(first);
    const e2 = await caught(second);
    expect(isDesktopDenial(e1, "revoked")).toBe(true);
    expect(isDesktopDenial(e2, "revoked")).toBe(true);
    expect(actions(w.adapter)).toEqual(["typeText"]);
    expect(w.indicator.events.map((e) => e.type)).toEqual(["on", "off"]);
    expect(w.controller.status()).toMatchObject({ inFlight: 0, queued: 0, indicatorOn: false });
    const denied = w.audit.entries.filter((a) => !a.allowed);
    expect(denied.map((a) => [a.tool, a.runId]).sort()).toEqual([
      ["desktop_key", "r2"],
      ["desktop_type", "r1"],
    ]);
    for (const a of denied) expect(a.deniedReason).toMatch(/revoked/);
  });

  it("the kill switch interrupts the action and the frozen state blocks the next one", async () => {
    const w = world();
    w.controller.attachKillSwitch(w.kill);
    w.adapter.hold();
    const p = w.controller.typeText(ctx(), "slow");
    await tick();
    await tick();
    await w.kill.stop("all");
    const e = await caught(p);
    expect(isForerunnerError(e, "killed")).toBe(true);
    expect(w.indicator.isOn).toBe(false);
    expect(w.controller.status().revoked).toBe(false);
    const next = await caught(w.controller.typeText(ctx(), "again"));
    expect(isDesktopDenial(next, "killed")).toBe(true);
    w.kill.resume();
    w.adapter.release();
    await w.controller.typeText(ctx(), "again");
    expect(actions(w.adapter)).toEqual(["typeText", "typeText"]);
  });

  it("disabling the capability in the extensions registry revokes live; enabling resumes", async () => {
    const w = world();
    const listeners: Array<(e: { type: string; name: string }) => void> = [];
    w.controller.attachExtensionRegistry({
      onEvent: (l) => {
        listeners.push(l);
        return () => undefined;
      },
    });
    await w.controller.typeText(ctx(), "x");
    for (const l of listeners) l({ type: "extension.disabled", name: "browser" });
    await tick();
    expect(w.controller.status().revoked).toBe(false);
    for (const l of listeners) l({ type: "extension.disabled", name: "desktop-control" });
    await tick();
    expect(w.controller.status()).toMatchObject({ revoked: true, indicatorOn: false });
    expect(isDesktopDenial(await caught(w.controller.typeText(ctx(), "y")), "revoked")).toBe(true);
    for (const l of listeners) l({ type: "extension.enabled", name: "desktop-control" });
    await w.controller.typeText(ctx(), "y");
    expect(actions(w.adapter)).toEqual(["typeText", "typeText"]);
  });

  it("gate matrix: disabled, autonomy 2, app not allowed and killed never reach the adapter", async () => {
    for (const [name, opts, reason] of [
      ["disabled", { enabled: false }, "disabled"],
      ["autonomy 2", { autonomy: 2 }, "autonomy"],
      ["app not allowed", { active: bank }, "app_not_allowed"],
    ] as const) {
      const w = world(opts);
      const e = await caught(w.controller.typeText(ctx(), "x"));
      expect(isDesktopDenial(e, reason), name).toBe(true);
      expect(actions(w.adapter), name).toEqual([]);
      expect(w.indicator.events, name).toEqual([]);
      expect(w.audit.entries).toHaveLength(1);
      expect(w.audit.entries[0]).toMatchObject({
        tool: "desktop_type",
        allowed: false,
        tokenId: "tok1",
      });
      expect(w.audit.entries[0]?.deniedReason).toContain(
        reason === "autonomy"
          ? "autonomy_insufficient"
          : reason === "disabled"
            ? "tool_not_allowed"
            : "not on the desktop allowlist",
      );
      if (reason !== "app_not_allowed") expect(w.adapter.calls, name).toEqual([]);
    }
    const killed = world();
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    expect(
      isDesktopDenial(
        await caught(killed.controller.click(ctx({ signal: ac.signal }), 1, 2)),
        "killed",
      ),
    ).toBe(true);
    expect(killed.adapter.calls).toEqual([]);
    const frozen = world();
    await frozen.kill.stop({ agentId: "alice" });
    expect(isDesktopDenial(await caught(frozen.controller.screenshot(ctx())), "killed")).toBe(true);
    expect(frozen.adapter.calls).toEqual([]);
  });

  it("typing refuses when the active window moved to an application outside the allowlist", async () => {
    const w = world();
    await w.controller.focus(ctx(), "code");
    w.adapter.active = bank; // the human alt-tabbed to the bank
    const e = await caught(w.controller.typeText(ctx(), "password"));
    expect(isDesktopDenial(e, "app_not_allowed")).toBe(true);
    expect(actions(w.adapter)).toEqual(["focus"]);
    const nothing = world({ active: null });
    expect(
      isDesktopDenial(await caught(nothing.controller.pressKey(ctx(), "Return")), "no_target"),
    ).toBe(true);
  });

  it("focus refuses an application outside the allowlist and an unknown one", async () => {
    const w = world();
    expect(
      isDesktopDenial(await caught(w.controller.focus(ctx(), "firefox")), "app_not_allowed"),
    ).toBe(true);
    expect(isDesktopDenial(await caught(w.controller.focus(ctx(), "gimp")), "no_target")).toBe(
      true,
    );
    expect(actions(w.adapter)).toEqual([]);
  });

  it("a human approval allows an app for the session through the port", async () => {
    const approvals = new FakeDesktopApprovals("approved");
    const w = world({ active: bank, approvals });
    await w.controller.typeText(ctx(), "x");
    await w.controller.pressKey(ctx(), "Return");
    expect(approvals.requests).toHaveLength(1);
    expect(actions(w.adapter)).toEqual(["typeText", "pressKey"]);
  });

  it("screenshots land under the sandbox dir, are logged with their path, and stay out of the result unless allowed and asked", async () => {
    const w = world();
    const r = await w.controller.screenshot(ctx(), { label: "after save" });
    expect(isInside(join(w.dir, "shots"), r.path)).toBe(true);
    expect(r.path.endsWith("-r1-1-after-save.png")).toBe(true);
    expect(existsSync(r.path)).toBe(true);
    expect(r.bytes).toBe(readFileSync(r.path).length);
    expect(r.window).toMatchObject({ exe: "code" });
    expect(r.image).toBeUndefined();
    expect(w.adapter.calls.at(-1)).toEqual({ method: "screenshot", args: [r.path, "0x1"] });
    const row = w.audit.entries.at(-1);
    expect(row).toMatchObject({ tool: "desktop_screenshot", allowed: true, tokenId: "tok1" });
    expect(row?.resultSummary).toContain(r.path);
    // Asked, but the token does not allow it: withheld and said so.
    const withheld = await w.controller.screenshot(ctx(), { includeInContext: true });
    expect(withheld.image).toBeUndefined();
    expect(w.audit.entries.at(-1)?.resultSummary).toMatch(/withheld/);
    // Allowed and asked.
    const allowed = world({ screenshotsToModel: true });
    const shot = await allowed.controller.screenshot(ctx(), { includeInContext: true });
    expect(shot.image?.mediaType).toBe("image/png");
    expect(Buffer.from(shot.image?.base64 ?? "", "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const notAsked = await allowed.controller.screenshot(ctx());
    expect(notAsked.image).toBeUndefined();
  });

  it("every action appends an audit row with who, what and the token id", async () => {
    const w = world();
    await w.controller.listWindows(ctx());
    await w.controller.focus(ctx(), "code");
    await w.controller.typeText(ctx(), "hello world");
    await w.controller.pressKey(ctx(), "ctrl+s");
    await w.controller.click(ctx(), 10, 20, "right");
    await w.controller.screenshot(ctx());
    expect(w.audit.entries.map((a) => a.tool)).toEqual([
      "desktop_list_windows",
      "desktop_focus",
      "desktop_type",
      "desktop_key",
      "desktop_click",
      "desktop_screenshot",
    ]);
    for (const a of w.audit.entries) {
      expect(a).toMatchObject({
        sessionId: "s1",
        runId: "r1",
        agentId: "alice",
        humanId: "h1",
        allowed: true,
        tokenId: "tok1",
        costUsdMicro: 0,
      });
      expect(a.occurredAt).toBe(w.clock.nowIso());
    }
    expect(w.audit.entries[2]?.inputSummary).toBe("type 11 chars into the active window");
    expect(w.audit.entries[2]?.inputSummary).not.toContain("hello");
    expect(w.audit.entries[4]?.inputSummary).toBe("right click at 10,20");
    expect(w.controller.status().actions).toBe(6);
  });

  it("list_windows names allowed windows only and counts the rest", async () => {
    const w = world();
    const r = await w.controller.listWindows(ctx());
    expect(r.windows.map((x) => x.exe)).toEqual(["code"]);
    expect(r.hidden).toBe(1);
    expect(w.audit.entries[0]?.resultSummary).toBe(
      "1 allowed window(s), 1 of other applications hidden",
    );
  });

  it("actions are serialised: the second waits for the first", async () => {
    const w = world();
    w.adapter.hold();
    const first = w.controller.typeText(ctx(), "a");
    const second = w.controller.pressKey(ctx(), "Return");
    await tick();
    await tick();
    expect(actions(w.adapter)).toEqual(["typeText"]);
    expect(w.controller.status()).toMatchObject({ inFlight: 1, queued: 1 });
    w.adapter.release();
    await first;
    await second;
    expect(actions(w.adapter)).toEqual(["typeText", "pressKey"]);
    expect(w.indicator.events.map((e) => e.type)).toEqual(["on"]);
    await w.clock.advance(1000);
    expect(w.indicator.events.map((e) => e.type)).toEqual(["on", "off"]);
  });
});
