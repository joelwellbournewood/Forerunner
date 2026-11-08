import { SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { RouterTaskBilling, seedBillingSources, waitingOf } from "../src/wiring/billing-pick.ts";

// Credential-shaped fixture, built by concatenation so no scanner sees a key.
const API_KEY = ["sk-ant-api03-", "limits", "0".repeat(40)].join(""); // not-a-secret

/**
 * R-limitsrmw (leftovers of wave 7): a billing source's `limits` were read and written back
 * whole (rest, refuse, noteWait, takeReady, credentialSaved), so two writes landing together
 * lost one of them: a waiting entry (its rows went back to plain Ready, with no automatic start)
 * or `restingUntil` (one more refused call). The store here holds every read of the row until
 * two have been made, so both writers work from the same copy, as two writes landing at the
 * same moment do.
 */
async function world() {
  const clock = new SimulatedClock("2026-11-08T09:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = await store.human.insert({
    name: "J",
    email: "",
    timezone: "UTC",
    notify_prefs: {},
    default_autonomy: 2,
    monthly_cap_usd_micro: 1,
    locale: "en",
  });
  const vault = new MemoryVault({ [SECRET_NAMES.anthropic]: API_KEY });
  const rows = await seedBillingSources({ store, vault, humanId: human.id });
  const key = rows.find((r) => r.kind === "api_key");
  if (!key) throw new Error("no api_key row");
  // Every read of a billing source (one row, or the list) waits until two reads were made.
  let reads = 0;
  let release: () => void = () => {};
  const bothRead = new Promise<void>((r) => {
    release = r;
  });
  const held = async <T>(read: Promise<T>): Promise<T> => {
    const v = await read;
    reads++;
    if (reads === 2) release();
    if (reads <= 2) await bothRead;
    return v;
  };
  const billingSource = new Proxy(store.billingSource, {
    get(target, prop, receiver) {
      if (prop === "get") return (id: string) => held(target.get(id));
      if (prop === "list")
        return (...args: Parameters<typeof target.list>) => held(target.list(...args));
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const raced = { ...store, billingSource } as StateStore;
  const billing = new RouterTaskBilling({ store: raced, vault, clock, humanId: human.id });
  return { store, billing, key };
}

describe("a billing source's limits are written with a version check (R-limitsrmw)", () => {
  it("a wait noted while the source starts to rest keeps both the waiting entry and the rest", async () => {
    const { store, billing, key } = await world();
    await Promise.all([
      billing.noteWait(key.id, "proj-a", "alice"),
      billing.rest(key.id, undefined, "the API key's usage limit"),
    ]);
    const row = await store.billingSource.mustGet(key.id);
    expect(waitingOf(row.limits).map((w) => w.projectId)).toEqual(["proj-a"]);
    expect(typeof row.limits.restingUntil).toBe("string");
    await store.close();
  });

  it("a wait noted while the waits are taken is either started or kept, never lost", async () => {
    const { store, billing, key } = await world();
    // proj-a already waits; the source serves again, so takeReady starts it.
    await store.billingSource.patch(key.id, {
      limits: {
        ...(await store.billingSource.mustGet(key.id)).limits,
        waiting: [{ projectId: "proj-a", agentId: "alice", since: "2026-11-08T08:00:00Z" }],
      },
    });
    const [started] = await Promise.all([
      billing.takeReady(),
      billing.noteWait(key.id, "proj-b", "alice"),
    ]);
    const row = await store.billingSource.mustGet(key.id);
    const kept = waitingOf(row.limits).map((w) => w.projectId);
    const all = [...started.map((s) => s.projectId), ...kept].sort();
    // Before: proj-b's entry was written over by takeReady's copy, and nothing started it.
    expect(all).toEqual(["proj-a", "proj-b"]);
    await store.close();
  });
});
