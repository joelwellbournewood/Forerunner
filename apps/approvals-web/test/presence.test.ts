import { describe, expect, it } from "vitest";
import type { DeviceView, RemoteCommandView, SessionView } from "../src/api/types.ts";
import { pcPresence } from "../src/lib/presence.ts";

const now = Date.parse("2026-10-20T12:00:00.000Z");
const iso = (ms: number) => new Date(now + ms).toISOString();

function device(overrides: Partial<DeviceView>): DeviceView {
  return {
    id: "d",
    ownerHumanId: "h1",
    name: "PC",
    platform: "linux",
    kind: "desktop",
    publicKey: "",
    lastSeen: iso(-1000),
    revoked: false,
    revokedAt: null,
    pairedAt: iso(-10_000),
    version: 1,
    ...overrides,
  };
}

function session(overrides: Partial<SessionView>): SessionView {
  return {
    id: "s",
    agentId: "a",
    agentName: "A",
    projectId: "p",
    trigger: "manual",
    status: "running",
    startedAt: iso(-5000),
    endedAt: null,
    budgetCap: { usdMicro: 0, chfMicro: 0 },
    spent: { usdMicro: 0, chfMicro: 0 },
    stepCap: 10,
    steps: 1,
    currentTask: null,
    summary: "",
    handoff: null,
    runner: "pc",
    ...overrides,
  };
}

function command(overrides: Partial<RemoteCommandView>): RemoteCommandView {
  return {
    id: "c",
    deviceId: "d",
    target: "pc",
    targetDeviceId: null,
    command: "kill",
    params: {},
    status: "done",
    pickedUpAt: iso(-1000),
    result: null,
    createdAt: iso(-2000),
    updatedAt: iso(-1000),
    version: 2,
    ...overrides,
  };
}

describe("pcPresence", () => {
  it("is offline with no signal and says so", () => {
    const p = pcPresence({ devices: [], sessions: [], commands: [], now });
    expect(p.pcOnline).toBe(false);
    expect(p.cloudActive).toBe(false);
    expect(p.reason).toMatch(/No PC is online/);
  });

  it("counts a recently seen desktop device but not a stale, revoked or phone one", () => {
    expect(pcPresence({ devices: [device({})], sessions: [], commands: [], now }).pcOnline).toBe(
      true,
    );
    expect(
      pcPresence({
        devices: [device({ lastSeen: iso(-6 * 60_000) })],
        sessions: [],
        commands: [],
        now,
      }).pcOnline,
    ).toBe(false);
    expect(
      pcPresence({ devices: [device({ revoked: true })], sessions: [], commands: [], now })
        .pcOnline,
    ).toBe(false);
    expect(
      pcPresence({ devices: [device({ kind: "phone" })], sessions: [], commands: [], now })
        .pcOnline,
    ).toBe(false);
    expect(
      pcPresence({ devices: [device({ lastSeen: null })], sessions: [], commands: [], now })
        .pcOnline,
    ).toBe(false);
  });

  it("counts a live pc session and a recently touched command; cloud sessions set cloudActive", () => {
    expect(pcPresence({ devices: [], sessions: [session({})], commands: [], now }).pcOnline).toBe(
      true,
    );
    expect(
      pcPresence({ devices: [], sessions: [session({ status: "completed" })], commands: [], now })
        .pcOnline,
    ).toBe(false);
    expect(pcPresence({ devices: [], sessions: [], commands: [command({})], now }).pcOnline).toBe(
      true,
    );
    expect(
      pcPresence({ devices: [], sessions: [], commands: [command({ status: "pending" })], now })
        .pcOnline,
    ).toBe(false);
    expect(
      pcPresence({
        devices: [],
        sessions: [],
        commands: [command({ updatedAt: iso(-3600_000) })],
        now,
      }).pcOnline,
    ).toBe(false);
    const cloud = pcPresence({
      devices: [],
      sessions: [session({ runner: "cloud" })],
      commands: [],
      now,
    });
    expect(cloud.cloudActive).toBe(true);
    expect(cloud.pcOnline).toBe(false);
  });
});
