import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { requestViews } from "../src/daemon/views.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { RouterTaskBilling, seedBillingSources } from "../src/wiring/billing-pick.ts";
import { removeHomes } from "./helpers.ts";

/**
 * C5-left-5 (d1109-cred-screens, run C): the refused card's closed line says what became of the
 * waiting work only when work waited. Before, every closed refused card read 'A new one is saved;
 * the work that waited for it goes on.', also when TR-10 closed it because another credential
 * took the waiting work while the key stays refused (nothing was saved), and when a new key was
 * saved with nothing waiting.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const KEY = ["sk-ant-api03-", "closedline", "7".repeat(40)].join(""); // not-a-secret
const OAUTH = ["sk-ant-oat01-", "closedline", "8".repeat(40)].join(""); // not-a-secret
const WHY = '401 {"type":"error","error":{"type":"authentication_error"}}';

async function world() {
  const home = mkdtempSync(join(tmpdir(), "fr-refused-closed-"));
  homes.push(home);
  const clock = new SimulatedClock("2026-11-16T09:00:00Z");
  const vault = new MemoryVault({
    [SECRET_NAMES.anthropic]: KEY,
    [SECRET_NAMES.anthropicOauth]: OAUTH,
  });
  const store: StateStore = await openStore({ url: `sqlite:${join(home, "s.sqlite")}`, clock });
  const human = await store.human.insert({
    name: "J",
    email: "",
    timezone: "Europe/Zurich",
    notify_prefs: { credential_policy: "key_then_subscription" },
    default_autonomy: 2,
    monthly_cap_usd_micro: 0,
    locale: "en",
  });
  const rows = await seedBillingSources({ store, vault, humanId: human.id });
  const keyId = rows.find((r) => r.kind === "api_key")?.id ?? "";
  const project = await store.project.insert({ name: "P", goal: "g", autonomy_level: 2 });
  const billing = new RouterTaskBilling({ store, vault, clock, humanId: human.id });
  const closedLine = async () => {
    const cards = (await store.humanRequest.list({} as never, { limit: 50 })).filter(
      (r) => (r.change_card as { key?: unknown } | null)?.key === "credential:refused",
    );
    const views = await requestViews(store, cards);
    return views.map((v) => [v.status, v.outcome]);
  };
  return { store, vault, human, keyId, project, billing, closedLine };
}

describe("d1109-cred-screens, run C: the refused card's closed line (C5-left-5)", () => {
  it("another credential took the waiting work while the key stays refused: no 'A new one is saved'", async () => {
    const w = await world();
    await w.billing.refuse(w.keyId, WHY);
    await w.billing.noteWait(w.keyId, w.project.id, "agent");
    await w.billing.takeReady(async () => true);
    expect(await w.closedLine()).toEqual([
      ["withdrawn", "Closed: the work that waited for it goes on with your Claude subscription."],
    ]);
    await w.store.close();
  });

  it("a new key saved while work waited: the work goes on; saved with nothing waiting: one sentence", async () => {
    const a = await world();
    await a.billing.refuse(a.keyId, WHY);
    await a.billing.noteWait(a.keyId, a.project.id, "agent");
    await a.billing.credentialSaved("api_key");
    expect(await a.closedLine()).toEqual([
      ["withdrawn", "A new one is saved; the work that waited for it goes on."],
    ]);
    await a.store.close();

    const b = await world();
    await b.billing.refuse(b.keyId, WHY);
    await b.billing.credentialSaved("api_key");
    expect(await b.closedLine()).toEqual([["withdrawn", "A new key is saved."]]);
    await b.store.close();
  });
});
