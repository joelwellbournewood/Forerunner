import { isForerunnerError, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DAILY_SEND_CAP,
  DEFAULT_PER_EMAIL_CAP_CHF_MICRO,
  DEFAULT_PER_RECIPIENT_DAILY_CAP,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_SIGNATURE_TEXT,
  EMAIL_EXTENSION_KIND,
  EmailSettingsStore,
  effectivePerEmailCapUsdMicro,
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
