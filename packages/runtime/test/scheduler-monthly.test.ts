/**
 * The monthly schedule kind (spec H.7 "monthly", P.15 "monthly"): a day of the month plus a
 * local time in the human's zone, fired once per month however often the scheduler ticks or
 * restarts, clamped to the last day of a shorter month, deferred by quiet hours like every
 * other non-manual trigger, and re-read from the settings before every tick.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import {
  fileFiredKeys,
  localParts,
  memoryFiredKeys,
  type Schedule,
  Scheduler,
  type StartRequest,
} from "../src/session/triggers.ts";

const TZ = "Europe/Zurich";
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function monthly(over: Partial<Schedule> = {}): Schedule {
  return {
    id: "m",
    agentId: "job",
    kind: "monthly",
    dayOfMonth: 1,
    time: "06:00",
    timezone: TZ,
    enabled: true,
    ...over,
  };
}

describe("scheduler: monthly kind", () => {
  it("localParts names the day, the month and the month's length in the zone", () => {
    // 2026-11-01T00:30 CET is still 2026-10-31 23:30 UTC.
    const lp = localParts(new Date("2026-10-31T23:30:00Z").getTime(), TZ);
    expect(lp).toMatchObject({
      day: 1,
      monthKey: "2026-11",
      daysInMonth: 30,
      dayKey: "2026-11-01",
    });
    expect(localParts(new Date("2027-02-10T12:00:00Z").getTime(), TZ).daysInMonth).toBe(28);
    expect(localParts(new Date("2028-02-10T12:00:00Z").getTime(), TZ).daysInMonth).toBe(29);
  });

  it("fires once per month at the local day and time, across month boundaries", async () => {
    const clock = new SimulatedClock("2026-10-31T23:00:00Z"); // 2026-11-01 00:00 CET
    const started: StartRequest[] = [];
    const s = new Scheduler({ clock, start: async (req) => void started.push(req) });
    s.add(monthly());
    await s.tick();
    expect(started).toHaveLength(0);
    await clock.advance(5 * 3_600_000 + 59 * 60_000); // 05:59
    await s.tick();
    expect(started).toHaveLength(0);
    await clock.advance(2 * 60_000); // 06:01
    await s.tick();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      agentId: "job",
      trigger: "schedule",
      reason: `monthly on day 1 at 06:00 ${TZ}`,
    });
    // The rest of the day and the month: nothing more.
    await s.tick();
    await clock.advance(24 * 3_600_000);
    await s.tick();
    await clock.set(new Date("2026-11-20T12:00:00Z").getTime());
    await s.tick();
    expect(started).toHaveLength(1);
    // December: before the time no, at the time yes, then once.
    await clock.set(new Date("2026-12-01T04:30:00Z").getTime()); // 05:30 CET
    await s.tick();
    expect(started).toHaveLength(1);
    await clock.set(new Date("2026-12-01T05:00:00Z").getTime()); // 06:00 CET
    await s.tick();
    await s.tick();
    expect(started).toHaveLength(2);
  });

  it("a day past the end of a shorter month fires on its last day", async () => {
    const clock = new SimulatedClock("2026-11-29T12:00:00Z");
    const started: string[] = [];
    const s = new Scheduler({ clock, start: async (req) => void started.push(req.reason) });
    s.add(monthly({ dayOfMonth: 31 }));
    await s.tick();
    expect(started).toHaveLength(0);
    await clock.set(new Date("2026-11-30T05:00:00Z").getTime()); // Nov 30, 06:00 CET
    await s.tick();
    expect(started).toEqual([`monthly on day 31 at 06:00 ${TZ}`]);
    // February 2027 has 28 days.
    await clock.set(new Date("2027-02-27T12:00:00Z").getTime());
    await s.tick();
    expect(started).toHaveLength(1);
    await clock.set(new Date("2027-02-28T05:00:00Z").getTime());
    await s.tick();
    expect(started).toHaveLength(2);
    // A disabled schedule never fires.
    s.add(monthly({ id: "off", enabled: false }));
    await clock.set(new Date("2027-03-31T12:00:00Z").getTime());
    await s.tick();
    expect(started).toHaveLength(3);
  });

  it("a schedule added after its day fires once that month, then waits for the next", async () => {
    const clock = new SimulatedClock("2026-11-15T12:00:00Z");
    const started: string[] = [];
    const s = new Scheduler({ clock, start: async (req) => void started.push(req.reason) });
    s.add(monthly());
    await s.tick();
    await s.tick();
    expect(started).toHaveLength(1);
    await clock.set(new Date("2026-11-30T12:00:00Z").getTime());
    await s.tick();
    expect(started).toHaveLength(1);
  });

  it("the fired keys survive a restart: a new scheduler on the same store does not fire again this month", async () => {
    const dir = mkdtempSync(join(os.tmpdir(), "fr-sched-"));
    temps.push(dir);
    const file = join(dir, "scheduler-fired.json");
    const clock = new SimulatedClock("2026-11-01T07:00:00Z");
    const started: string[] = [];
    const first = new Scheduler({
      clock,
      start: async (req) => void started.push(req.reason),
      fired: fileFiredKeys(file),
    });
    first.add(monthly());
    first.add({
      id: "d",
      agentId: "alice",
      kind: "daily",
      time: "06:00",
      timezone: TZ,
      enabled: true,
    });
    await first.tick();
    expect(started).toEqual([`monthly on day 1 at 06:00 ${TZ}`, `daily at 06:00 ${TZ}`]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ m: "2026-11", d: "2026-11-01" });
    // The daemon restarts an hour later: the same month and day are already recorded.
    await clock.advance(3_600_000);
    const second = new Scheduler({
      clock,
      start: async (req) => void started.push(req.reason),
      fired: fileFiredKeys(file),
    });
    second.add(monthly());
    second.add({
      id: "d",
      agentId: "alice",
      kind: "daily",
      time: "06:00",
      timezone: TZ,
      enabled: true,
    });
    await second.tick();
    expect(started).toHaveLength(2);
    // Next month on the restarted scheduler: fires and records.
    await clock.set(new Date("2026-12-01T07:00:00Z").getTime());
    await second.tick();
    expect(started).toHaveLength(4);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ m: "2026-12", d: "2026-12-01" });
    // A store whose file is unreadable is treated as empty, never fatal.
    const bad = fileFiredKeys(join(dir, "missing", "x.json"));
    expect(bad.get("m")).toBeUndefined();
    bad.set("m", "2026-12");
    expect(bad.get("m")).toBe("2026-12");
    expect(memoryFiredKeys().get("m")).toBeUndefined();
  });

  it("quiet hours defer the monthly run; the drain runs it once when they end", async () => {
    const clock = new SimulatedClock("2026-11-01T06:30:00Z");
    const started: string[] = [];
    let quiet = true;
    const s = new Scheduler({
      clock,
      start: async (req) => void started.push(req.reason),
      isQuietHours: () => quiet,
    });
    s.add(monthly());
    await s.tick();
    expect(started).toHaveLength(0);
    expect(s.pendingFor("job")?.reason).toBe(`monthly on day 1 at 06:00 ${TZ}`);
    expect(s.log.at(-1)).toMatchObject({ result: "deferred", detail: "quiet hours" });
    await s.tick(); // still quiet: nothing starts, the one request stays pending
    expect(started).toHaveLength(0);
    expect(s.pendingFor("job")).toBeDefined();
    quiet = false;
    await clock.advance(3_600_000);
    await s.tick();
    expect(started).toEqual([`monthly on day 1 at 06:00 ${TZ}`]);
    await s.tick();
    expect(started).toHaveLength(1);
  });

  it("refresh runs before every tick so a settings change adds or drops a schedule", async () => {
    const clock = new SimulatedClock("2026-11-01T07:00:00Z");
    const started: string[] = [];
    let enabled = false;
    let refreshes = 0;
    const s = new Scheduler({
      clock,
      start: async (req) => void started.push(req.reason),
      refresh: async (scheduler) => {
        refreshes++;
        if (enabled) scheduler.add(monthly());
        else scheduler.remove("m");
      },
    });
    await s.tick();
    expect(refreshes).toBe(1);
    expect(started).toHaveLength(0);
    enabled = true;
    await s.tick();
    expect(s.list().map((x) => x.id)).toEqual(["m"]);
    expect(started).toHaveLength(1);
    enabled = false;
    await clock.set(new Date("2026-12-01T07:00:00Z").getTime());
    await s.tick();
    expect(s.list()).toEqual([]);
    expect(started).toHaveLength(1);
    // A refresh that throws is logged, never fatal to the tick.
    const t = new Scheduler({
      clock,
      start: async () => undefined,
      refresh: async () => {
        throw new Error("settings unreadable");
      },
    });
    t.add(monthly({ id: "x" }));
    await expect(t.tick()).resolves.toBeUndefined();
  });
});
