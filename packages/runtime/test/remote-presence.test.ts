import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESKTOP_DEVICE_FILE_NAME,
  DesktopPresence,
  registerDesktopDevice,
} from "../src/remote/index.ts";

/**
 * The daemon's `desktop` device row and its heartbeat (ADR 0033 item 9, ADR 0041): registered
 * once per install (the identity file under the config dir, else by name, else fresh) and
 * refreshed on the configured interval so the cloud runner's PC-wins rule sees a working PC.
 */
let store: StateStore;
let clock: SimulatedClock;
let humanId: string;
let dirs: ReturnType<typeof appDirs>;

beforeEach(async () => {
  clock = new SimulatedClock("2026-10-20T08:00:00Z");
  store = await openStore({ url: "sqlite::memory:", clock });
  humanId = (await store.human.insert({ name: "J", email: "j@example.test" })).id;
  dirs = appDirs({ env: { FORERUNNER_HOME: mkdtempSync(join(tmpdir(), "fr-presence-")) } });
});
afterEach(async () => {
  await store.close();
});

describe("registerDesktopDevice", () => {
  it("registers one desktop row per install and reuses it through the identity file", async () => {
    const first = await registerDesktopDevice({
      store,
      dirs,
      humanId,
      name: "J's PC",
      platform: "linux",
    });
    expect(first).toMatchObject({ kind: "desktop", owner_human_id: humanId, name: "J's PC" });
    const file = join(dirs.config, DESKTOP_DEVICE_FILE_NAME);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      kind: "desktop",
      publicKey: first.public_key,
    });
    const again = await registerDesktopDevice({
      store,
      dirs,
      humanId,
      name: "renamed",
      platform: "linux",
    });
    expect(again.id).toBe(first.id);
    expect(await store.device.list({ kind: "desktop" })).toHaveLength(1);
  });

  it("finds the row by name when the identity file is missing or stale, else registers a fresh one", async () => {
    const existing = await store.device.register({
      owner_human_id: humanId,
      name: "J's PC",
      platform: "linux",
      public_key: ["pk-", "E".repeat(40)].join(""), // not-a-secret
      kind: "desktop",
    });
    mkdirSync(dirs.config, { recursive: true });
    writeFileSync(
      join(dirs.config, DESKTOP_DEVICE_FILE_NAME),
      JSON.stringify({ kind: "desktop", publicKey: "stale" }),
    );
    const byName = await registerDesktopDevice({
      store,
      dirs,
      humanId,
      name: "J's PC",
      platform: "linux",
    });
    expect(byName.id).toBe(existing.id);
    // A revoked row is never reused: a fresh one takes its place.
    await store.device.revoke(existing.id, (await store.device.mustGet(existing.id)).version);
    const fresh = await registerDesktopDevice({
      store,
      dirs,
      humanId,
      name: "J's PC",
      platform: "linux",
    });
    expect(fresh.id).not.toBe(existing.id);
    expect(fresh.revoked).toBe(false);
    // Another human's row under the same key is never adopted.
    const other = (await store.human.insert({ name: "B", email: "b@example.test" })).id;
    const theirs = await registerDesktopDevice({
      store,
      dirs,
      humanId: other,
      name: "J's PC",
      platform: "linux",
    });
    expect(theirs.id).not.toBe(fresh.id);
    expect(theirs.owner_human_id).toBe(other);
  });
});

describe("DesktopPresence", () => {
  it("stamps last_seen at start and on every interval, and stops with the daemon", async () => {
    const device = await registerDesktopDevice({
      store,
      dirs,
      humanId,
      name: "PC",
      platform: "windows",
    });
    expect(device.last_seen).toBeNull();
    const presence = new DesktopPresence({ store, clock, deviceId: device.id, intervalMs: 60_000 });
    presence.start();
    await new Promise((r) => setImmediate(r));
    expect((await store.device.mustGet(device.id)).last_seen).toBe("2026-10-20T08:00:00.000Z");
    expect(presence.stats).toMatchObject({ beats: 1, running: true });
    await clock.advance(59_999);
    expect((await store.device.mustGet(device.id)).last_seen).toBe("2026-10-20T08:00:00.000Z");
    await clock.advance(1);
    expect((await store.device.mustGet(device.id)).last_seen).toBe("2026-10-20T08:01:00.000Z");
    await clock.advance(120_000);
    expect((await store.device.mustGet(device.id)).last_seen).toBe("2026-10-20T08:03:00.000Z");
    expect(presence.stats.beats).toBe(4);
    presence.stop();
    await clock.advance(600_000);
    expect((await store.device.mustGet(device.id)).last_seen).toBe("2026-10-20T08:03:00.000Z");
    expect(presence.stats).toMatchObject({ beats: 4, running: false });
  });
});
