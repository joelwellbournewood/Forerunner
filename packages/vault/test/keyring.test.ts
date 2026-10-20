import { randomBytes } from "node:crypto";
import { isForerunnerError, SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  KEYRING_CHUNK_CHARS,
  KEYRING_INDEX_ACCOUNT,
  KeyringVault,
  keyringServiceName,
} from "../src/keyring.ts";
import { caught, FakeKeyringStore, freshValue } from "./helpers.ts";

describe("keyring service names", () => {
  it("uses forerunner, forerunner-<profile> or an explicit service", () => {
    expect(keyringServiceName({})).toBe("forerunner");
    expect(keyringServiceName({ profile: "test-a" })).toBe("forerunner-test-a");
    expect(keyringServiceName({ service: "custom" })).toBe("custom");
    expect(() => keyringServiceName({ profile: "bad profile!" })).toThrow(/profile/);
  });
});

describe("KeyringVault over a fake store", () => {
  const make = (store: FakeKeyringStore, profile = "unit") =>
    new KeyringVault({ profile, entries: store.factory });

  it("round-trips and maintains the index entry for list()", async () => {
    const store = new FakeKeyringStore();
    const vault = make(store);
    expect(vault.backend).toBe("keyring");
    expect(await vault.list()).toEqual([]);
    const a = freshValue();
    const b = freshValue();
    await vault.set("zeta", a);
    await vault.set("alpha", b);
    expect(await vault.get("zeta")).toBe(a);
    expect(await vault.get("missing")).toBeNull();
    expect(await vault.has("alpha")).toBe(true);
    expect(await vault.has("missing")).toBe(false);
    expect(await vault.list()).toEqual(["alpha", "zeta"]);
    expect(store.accounts("forerunner-unit")).toEqual([KEYRING_INDEX_ACCOUNT, "alpha", "zeta"]);
    expect(store.data.get(`forerunner-unit\u0000${KEYRING_INDEX_ACCOUNT}`)).toBe(
      JSON.stringify(["alpha", "zeta"]),
    );
    await vault.set("zeta", b); // replace does not duplicate the index
    expect(await vault.list()).toEqual(["alpha", "zeta"]);
    expect(await vault.delete("zeta")).toBe(true);
    expect(await vault.delete("zeta")).toBe(false);
    expect(await vault.list()).toEqual(["alpha"]);
    expect(store.accounts("forerunner-unit")).toEqual([KEYRING_INDEX_ACCOUNT, "alpha"]);
  });

  it("keeps two profiles apart in the same store", async () => {
    const store = new FakeKeyringStore();
    const a = make(store, "test-a");
    const b = make(store, "test-b");
    await a.set("shared_name", "value-a");
    await b.set("shared_name", "value-b");
    expect(await a.get("shared_name")).toBe("value-a");
    expect(await b.get("shared_name")).toBe("value-b");
    expect(await a.list()).toEqual(["shared_name"]);
  });

  it("chunks values beyond the Windows blob cap and cleans chunks on replace and delete", async () => {
    const store = new FakeKeyringStore();
    store.maxLength = 1280; // Windows Credential Manager: 2560 bytes of UTF-16
    const vault = make(store);
    const big = freshValue().repeat(200); // ~5600 chars
    expect(big.length).toBeGreaterThan(KEYRING_CHUNK_CHARS * 3);
    await vault.set("ssh_key", big);
    expect(await vault.get("ssh_key")).toBe(big);
    const accounts = store.accounts("forerunner-unit");
    expect(accounts).toContain("ssh_key#0");
    expect(accounts.filter((a) => a.startsWith("ssh_key#"))).toHaveLength(
      Math.ceil(big.length / KEYRING_CHUNK_CHARS),
    );
    for (const [, v] of store.data) expect(v.length).toBeLessThanOrEqual(1280);
    expect(await vault.list()).toEqual(["ssh_key"]);

    await vault.set("ssh_key", "short");
    expect(await vault.get("ssh_key")).toBe("short");
    expect(store.accounts("forerunner-unit").filter((a) => a.includes("#"))).toEqual([]);

    await vault.set("ssh_key", big);
    expect(await vault.delete("ssh_key")).toBe(true);
    expect(store.accounts("forerunner-unit")).toEqual([KEYRING_INDEX_ACCOUNT]);
    expect(await vault.get("ssh_key")).toBeNull();
  });

  it("chunks the index itself when many names are stored", async () => {
    const store = new FakeKeyringStore();
    store.maxLength = 1280;
    const vault = make(store);
    const names = Array.from({ length: 60 }, (_, i) => `service${i}.deploy_token_number_${i}`);
    for (const n of names) await vault.set(n, "value-x");
    expect(await vault.list()).toEqual([...names].sort());
    expect(store.accounts("forerunner-unit")).toContain(`${KEYRING_INDEX_ACCOUNT}#0`);
    expect(await vault.delete(names[3] ?? "")).toBe(true);
    expect(await vault.list()).toHaveLength(59);
  });

  it("round-trips a value that looks like a chunk header", async () => {
    const store = new FakeKeyringStore();
    const vault = make(store);
    const tricky = "forerunner-chunked:v1:7";
    await vault.set("odd", tricky);
    expect(await vault.get("odd")).toBe(tricky);
    await vault.delete("odd");
    expect(store.accounts("forerunner-unit")).toEqual([KEYRING_INDEX_ACCOUNT]);
  });

  it("reports an incomplete chunked entry instead of returning a truncated value", async () => {
    const store = new FakeKeyringStore();
    const vault = make(store);
    await vault.set("big", "x".repeat(KEYRING_CHUNK_CHARS * 2 + 1));
    store.data.delete("forerunner-unit\u0000big#1");
    await expect(vault.get("big")).rejects.toSatisfy((e) => isForerunnerError(e, "internal"));
  });

  it("wraps store failures as unavailable without echoing the value", async () => {
    const store = new FakeKeyringStore();
    store.failing = true;
    const vault = make(store);
    const value = freshValue();
    const err = await caught(() => vault.set("k", value));
    expect(isForerunnerError(err, "unavailable")).toBe(true);
    expect((err as Error).message).not.toContain(value);
    expect((err as Error).message).toContain("AccessDenied");
  });

  it("times out a hung keyring operation through the clock", async () => {
    const store = new FakeKeyringStore();
    store.hang = true;
    const clock = new SimulatedClock();
    const vault = new KeyringVault({
      profile: "unit",
      entries: store.factory,
      clock,
      timeoutMs: 500,
    });
    const pending = vault.get("k");
    const settled = pending.then(
      () => "resolved",
      (e: unknown) => e,
    );
    await new Promise((r) => setImmediate(r)); // let the operation register its timer
    expect(clock.pendingTimers()).toBe(1);
    await clock.advance(501);
    const err = await settled;
    expect(isForerunnerError(err, "unavailable")).toBe(true);
    expect((err as Error).message).toMatch(/timed out/);
  });

  it("detect(): available when the probe round-trips, unavailable with a reason otherwise", async () => {
    const store = new FakeKeyringStore();
    const ok = await KeyringVault.detect({ profile: "probe", entries: store.factory });
    expect(ok).toEqual({ available: true, service: "forerunner-probe" });
    expect(store.accounts("forerunner-probe")).toEqual([]); // probe cleaned up
    expect(store.log.some((l) => l.startsWith("set __probe__"))).toBe(true);

    store.failing = true;
    const bad = await KeyringVault.detect({ profile: "probe", entries: store.factory });
    expect(bad.available).toBe(false);
    if (!bad.available) expect(bad.reason).toContain("AccessDenied");

    const broken = await KeyringVault.detect({
      profile: "probe",
      entries: () => {
        throw new Error("binding missing");
      },
    });
    expect(broken.available).toBe(false);
    if (!broken.available) expect(broken.reason).toContain("binding missing");
  });

  it("validates names before touching the store", async () => {
    const store = new FakeKeyringStore();
    const vault = make(store);
    await expect(vault.set("Bad", "x")).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
    await expect(vault.get(KEYRING_INDEX_ACCOUNT)).rejects.toSatisfy((e) =>
      isForerunnerError(e, "validation"),
    );
    expect(store.log).toEqual([]);
  });
});

// Real OS keyring: runs only where a Secret Service / Credential Manager answers the probe.
const profile = `test-${randomBytes(4).toString("hex")}`;
const detection = await KeyringVault.detect({ profile, timeoutMs: 5_000 });
const why = detection.available ? "available" : `unavailable: ${detection.reason}`;

describe(`KeyringVault over the real OS keyring (${why})`, () => {
  const vault = new KeyringVault({ profile, timeoutMs: 5_000 });
  const names = ["github_pat", "big_cert"];

  afterAll(async () => {
    if (!detection.available) return;
    for (const n of names) await vault.delete(n).catch(() => undefined);
  });

  it.skipIf(!detection.available)("round-trips, lists via the index and deletes", async () => {
    const value = freshValue();
    const big = freshValue().repeat(120);
    await vault.set("github_pat", value);
    await vault.set("big_cert", big);
    expect(await vault.get("github_pat")).toBe(value);
    expect(await vault.get("big_cert")).toBe(big);
    expect(await vault.list()).toEqual(["big_cert", "github_pat"]);
    expect(await vault.has("github_pat")).toBe(true);
    expect(await vault.delete("github_pat")).toBe(true);
    expect(await vault.get("github_pat")).toBeNull();
    expect(await vault.delete("big_cert")).toBe(true);
    expect(await vault.list()).toEqual([]);
  });
});
