import { isForerunnerError, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMMANDS_NEED_SENDING_MODE,
  DEFAULT_DAILY_SEND_CAP,
  DEFAULT_PER_EMAIL_CAP_CHF_MICRO,
  DEFAULT_PER_RECIPIENT_DAILY_CAP,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SIGNATURE_TEXT,
  EMAIL_EXTENSION_KIND,
  EMAIL_SETTINGS_TOOL,
  type EmailCommandsSwitchedOff,
  EmailSettingsStore,
  effectivePerEmailCapUsdMicro,
  emailCommandsActive,
  emailExtensionName,
  mergeEmailConfig,
} from "../src/email/index.ts";

let store: StateStore;
let settings: EmailSettingsStore;
const clock = new SimulatedClock("2026-03-02T10:00:00.000Z");

beforeEach(async () => {
  store = await openStore({ url: "sqlite::memory:", clock });
  settings = new EmailSettingsStore(store.extension, clock);
});

afterEach(async () => {
  await store.close();
});

describe("EmailSettingsStore", () => {
  it("creates the extension row with the spec defaults on first read and keeps the marker", async () => {
    const config = await settings.get("agent-1");
    expect(config.settings.mode).toBe("off");
    expect(config.settings.dailySendCap).toBe(DEFAULT_DAILY_SEND_CAP);
    expect(config.settings.perRecipientDailyCap).toBe(DEFAULT_PER_RECIPIENT_DAILY_CAP);
    expect(config.settings.signature).toEqual({ enabled: true, text: DEFAULT_SIGNATURE_TEXT });
    expect(config.settings.paused).toBe(false);
    expect(config.settings.dailyDigest).toBe(false);
    expect(config.commands.enabled).toBe(false);
    expect(config.commands.marker).toMatch(/^\[FR-[a-z2-9]{4}\]$/);
    expect(config.commands.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(config.commands.perEmailCapChfMicro).toBe(DEFAULT_PER_EMAIL_CAP_CHF_MICRO);
    expect(config.commands.dailyTaskCap).toBe(10);
    expect(config.commands.autonomyLevel).toBe(2);
    const again = await settings.get("agent-1");
    expect(again.commands.marker).toBe(config.commands.marker);
    const row = await store.extension.byName(EMAIL_EXTENSION_KIND, emailExtensionName("agent-1"));
    expect(row?.enabled).toBe(false);
    expect(row?.config).toMatchObject({ settings: { mode: "off" } });
  });

  it("updates by merging, validates, and reflects the mode in the row's enabled flag", async () => {
    const next = await settings.update("agent-1", {
      settings: { mode: "allowlist", allowlist: { addresses: ["Client@Example.test"] } },
      commands: { enabled: true, registeredHumanAddress: "J@Example.test" },
    });
    expect(next.settings.mode).toBe("allowlist");
    expect(next.settings.allowlist.addresses).toEqual(["client@example.test"]);
    expect(next.settings.dailySendCap).toBe(DEFAULT_DAILY_SEND_CAP);
    expect(next.commands.registeredHumanAddress).toBe("j@example.test");
    const row = await store.extension.byName(EMAIL_EXTENSION_KIND, emailExtensionName("agent-1"));
    expect(row?.enabled).toBe(true);
    expect(row?.permissions).toEqual(["email:allowlist", "email-commands"]);
  });

  it("refuses a mailbox credential value: only secret references are stored", async () => {
    await expect(
      settings.update("agent-1", {
        settings: {
          mailbox: {
            address: "alice@example.test",
            imap: { host: "imap.example.test", user: "alice", passwordRef: "hunter22x" },
            smtp: null,
          },
        },
      }),
    ).rejects.toSatisfy((e: unknown) => isForerunnerError(e, "validation"));
    const ok = await settings.update("agent-1", {
      settings: {
        mailbox: {
          address: "alice@example.test",
          imap: { host: "imap.example.test", user: "alice", passwordRef: "secret:alice_imap" },
          smtp: { host: "smtp.example.test", user: "alice", passwordRef: "secret:alice_smtp" },
        },
      },
    });
    expect(ok.settings.mailbox?.imap?.port).toBe(993);
    expect(ok.settings.mailbox?.smtp?.port).toBe(587);
    expect(JSON.stringify(ok)).not.toContain("hunter22x");
  });

  it("rejects unknown modes, bad markers and out-of-range levels", () => {
    const base = mergeEmailConfig(
      { settings: { mode: "off" } as never, commands: {} as never },
      {},
    );
    expect(() => mergeEmailConfig(base, { settings: { mode: "yolo" as never } })).toThrow(
      /invalid email settings/,
    );
    expect(() => mergeEmailConfig(base, { commands: { marker: "no-brackets" } })).toThrow(/marker/);
    expect(() => mergeEmailConfig(base, { commands: { autonomyLevel: 5 } })).toThrow(
      /autonomyLevel/,
    );
    expect(() => mergeEmailConfig(base, { settings: { dailySendCap: -1 } })).toThrow(
      /dailySendCap/,
    );
  });

  it("rotates the marker, pauses, and adds allowlisted recipients without duplicates", async () => {
    const before = (await settings.get("agent-1")).commands.marker;
    const rotated = await settings.rotateMarker("agent-1");
    expect(rotated).not.toBe(before);
    expect(rotated).toMatch(/^\[FR-[a-z2-9]{4}\]$/);
    expect((await settings.get("agent-1")).commands.marker).toBe(rotated);

    expect((await settings.setPaused("agent-1", true)).settings.paused).toBe(true);
    expect((await settings.setPaused("agent-1", false)).settings.paused).toBe(false);

    await settings.addAllowlisted("agent-1", { address: "a@x.test" });
    await settings.addAllowlisted("agent-1", { address: "A@x.test", domain: "*.partner.test" });
    const config = await settings.get("agent-1");
    expect(config.settings.allowlist.addresses).toEqual(["a@x.test"]);
    expect(config.settings.allowlist.domains).toEqual(["*.partner.test"]);
  });

  it("derives the per-email cap from CHF 5 at the day's rate unless a USD cap is set", async () => {
    const config = await settings.get("agent-1");
    expect(effectivePerEmailCapUsdMicro(config.commands, 0.8)).toBe(6_250_000);
    const explicit = await settings.update("agent-1", { commands: { perEmailCapUsdMicro: 1_000 } });
    expect(effectivePerEmailCapUsdMicro(explicit.commands, 0.8)).toBe(1_000);
  });
});

/**
 * ADR 0081: email commands cannot be on at sending mode off. The store every writer goes
 * through (daemon routes, the settings page, the runner) refuses turning them on at off with a
 * plain message, turns them off with an audit row and a listener call when the mode goes to
 * off, and a row stored before the rule is treated as commands off.
 */
describe("EmailSettingsStore: email commands need a sending mode other than off (ADR 0081)", () => {
  const OWNER = "j@example.test";
  let audited: EmailSettingsStore;
  let events: EmailCommandsSwitchedOff[];

  beforeEach(() => {
    audited = new EmailSettingsStore(store.extension, clock, { audit: store.auditLog });
    events = [];
    audited.onCommandsSwitchedOff((e) => {
      events.push(e);
    });
  });

  const settingsRows = async () =>
    (await store.auditLog.list({ agentId: "agent-1", tool: EMAIL_SETTINGS_TOOL })).map((r) => ({
      allowed: r.allowed,
      human: r.human_id,
      input: JSON.parse(r.input_summary) as Record<string, unknown>,
      result: JSON.parse(r.result_summary ?? "null") as Record<string, unknown>,
    }));

  it("refuses turning commands on at mode off with the plain message, and nothing is written", async () => {
    const before = await audited.get("agent-1");
    expect(before.settings.mode).toBe("off");
    const err = await audited
      .update("agent-1", { commands: { enabled: true, registeredHumanAddress: OWNER } })
      .catch((e: unknown) => e);
    expect(isForerunnerError(err) && err.code).toBe("validation");
    expect((err as Error).message).toBe(COMMANDS_NEED_SENDING_MODE);
    expect((err as { details?: unknown }).details).toMatchObject({
      reason: "commands_need_sending_mode",
      issues: ["commands.enabled"],
    });
    expect(COMMANDS_NEED_SENDING_MODE).toMatch(/sending mode other than off/);
    const after = await audited.get("agent-1");
    expect(after.commands.enabled).toBe(false);
    expect(after.commands.registeredHumanAddress).toBeNull();
    // Mode off and commands on in one write from a mode-off row: refused the same way.
    await expect(
      audited.update("agent-1", { settings: { mode: "off" }, commands: { enabled: true } }),
    ).rejects.toMatchObject({ code: "validation", message: COMMANDS_NEED_SENDING_MODE });
    expect(events).toEqual([]);
    expect(await settingsRows()).toEqual([]);
  });

  it("accepts commands with any other mode, read only included (replies to the owner go out there)", async () => {
    for (const mode of ["read_only", "draft_only", "allowlist", "full_discretion"] as const) {
      const next = await audited.update("agent-1", {
        settings: { mode },
        commands: { enabled: true, registeredHumanAddress: OWNER },
      });
      expect(next.commands.enabled, mode).toBe(true);
      expect(emailCommandsActive(next), mode).toBe(true);
    }
    expect(events).toEqual([]);
  });

  it("switching the mode to off turns commands off in the same write, with an audit row and the owner told", async () => {
    await audited.update("agent-1", {
      settings: { mode: "read_only" },
      commands: { enabled: true, registeredHumanAddress: OWNER },
    });
    await clock.advance(1000);
    const next = await audited.update(
      "agent-1",
      { settings: { mode: "off" } },
      { authorHuman: "human-j" },
    );
    expect(next.settings.mode).toBe("off");
    expect(next.commands.enabled).toBe(false);
    // The other command settings survive, so turning commands on again later is one switch.
    expect(next.commands.registeredHumanAddress).toBe(OWNER);
    const stored = await audited.get("agent-1");
    expect(stored.commands.enabled).toBe(false);
    const row = await store.extension.byName(EMAIL_EXTENSION_KIND, emailExtensionName("agent-1"));
    expect(row?.enabled).toBe(false);
    expect(await settingsRows()).toEqual([
      {
        allowed: true,
        human: "human-j",
        input: {
          action: "commands_switched_off",
          reason: "mode_off",
          modeBefore: "read_only",
          modeAfter: "off",
        },
        result: { status: "commands_off", reason: "mode_off" },
      },
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: "agent-1",
      byHuman: "human-j",
      modeBefore: "read_only",
      at: clock.nowIso(),
    });
    expect(events[0]?.message).toMatch(/Email commands were turned off because the sending mode/);
    // The page sending its whole form (mode off, commands still ticked) is the same switch.
    await audited.update("agent-1", {
      settings: { mode: "allowlist" },
      commands: { enabled: true },
    });
    const again = await audited.update("agent-1", {
      settings: { mode: "off" },
      commands: { enabled: true },
    });
    expect(again.commands.enabled).toBe(false);
    expect(events).toHaveLength(2);
    expect(events[1]?.modeBefore).toBe("allowlist");
    // A write at mode off with commands already off records nothing more.
    await audited.setPaused("agent-1", true);
    expect(events).toHaveLength(2);
    expect(await settingsRows()).toHaveLength(2);
  });

  it("a row stored before the rule (commands on at mode off) is not in force and the next write turns it off", async () => {
    await audited.get("agent-1");
    const row = await store.extension.byName(EMAIL_EXTENSION_KIND, emailExtensionName("agent-1"));
    if (!row) throw new Error("row missing");
    const config = row.config as {
      settings: Record<string, unknown>;
      commands: Record<string, unknown>;
    };
    await store.extension.update(row.id, row.version, {
      config: {
        settings: { ...config.settings, mode: "off" },
        commands: { ...config.commands, enabled: true, registeredHumanAddress: OWNER },
      },
    });
    const legacy = await audited.get("agent-1");
    expect(legacy.commands.enabled).toBe(true);
    expect(emailCommandsActive(legacy)).toBe(false);
    // Re-asserting commands on over such a row is refused like a fresh switch-on.
    await expect(audited.update("agent-1", { commands: { enabled: true } })).rejects.toMatchObject({
      code: "validation",
    });
    const next = await audited.setPaused("agent-1", false);
    expect(next.commands.enabled).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0]?.modeBefore).toBe("off");
    expect((await settingsRows())[0]?.input).toMatchObject({ action: "commands_switched_off" });
  });

  it("a failing audit store or listener never undoes the switch-off", async () => {
    const failing = new EmailSettingsStore(store.extension, clock, {
      audit: {
        append: async () => {
          throw new Error("audit store down");
        },
      },
    });
    const off = failing.onCommandsSwitchedOff(() => {
      throw new Error("listener broke");
    });
    await failing.update("agent-1", {
      settings: { mode: "full_discretion" },
      commands: { enabled: true, registeredHumanAddress: OWNER },
    });
    const next = await failing.update("agent-1", { settings: { mode: "off" } });
    expect(next.commands.enabled).toBe(false);
    expect((await failing.get("agent-1")).commands.enabled).toBe(false);
    off();
  });
});
