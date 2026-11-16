import { describe, expect, it } from "vitest";
import { CREDENTIAL_KEY_REPLACED, settingSpec, settingsSet } from "../src/commands/settings.ts";
import type { ExecuteResult } from "../src/index.ts";
import { world } from "./helpers.ts";

/**
 * d1109-cred-engine CE-13 (ADR 0120): "Which Claude does the work" (credential_policy) in the
 * commands: a change that moves more money without the person asks their yes, one that moves
 * less acts at once, an agent is refused, the tool definition the chat model reads lists the five
 * presets and neither older key, and the older keys answer that they were replaced.
 */
const reason = (r: ExecuteResult) => (r.status === "refused" ? r.reason : "");
const prefsOf = async (w: Awaited<ReturnType<typeof world>>) =>
  (await w.store.human.mustGet(w.ctx().humanId)).notify_prefs as Record<string, unknown>;

describe("d1109-cred-engine, run C: credential_policy (CE-13)", () => {
  it("from the default to 'then the API key' by the person asks a yes with what it does, and stores nothing until then", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "settings.set",
      params: { key: "credential_policy", value: "subscription_then_key" },
      ctx: w.ctx({ source: "ui" }),
    });
    expect(r.status).toBe("pending");
    expect(JSON.stringify(r)).toContain(
      "When your subscription runs out, work goes on with your API key at once, at a cost per use.",
    );
    expect((await prefsOf(w)).credential_policy).toBeUndefined();
  });

  it("an agent is refused in one sentence, and nothing changes", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "settings.set",
      params: { key: "credential_policy", value: "subscription_then_key" },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id } }),
    });
    expect(r.status).toBe("refused");
    expect(reason(r)).toBe("Only you can change which Claude does the work.");
    expect((await prefsOf(w)).credential_policy).toBeUndefined();
  });

  it("from 'then the API key' to 'then ask me' acts at once with one Changes row and an Undo; an Undo that widens asks the same yes", async () => {
    const w = await world();
    await w.store.human.patch(w.ctx().humanId, {
      notify_prefs: { credential_policy: "subscription_then_key" } as never,
    });
    const r = await w.executor.execute({
      name: "settings.set",
      params: { key: "credential_policy", value: "subscription_then_ask" },
      ctx: w.ctx({ source: "ui" }),
    });
    expect(r.status).toBe("done");
    expect((await prefsOf(w)).credential_policy).toBe("subscription_then_ask");
    const rows = await w.store.changeLog.list({ human_id: w.ctx().humanId } as never, {
      limit: 10,
    });
    expect(rows.map((c) => c.sentence)).toContain(
      "Set which Claude does the work from Subscription first, then the API key to Subscription first, then ask me: when your subscription runs out, you are asked first before your API key does any work. Undo.",
    );
    // The Undo puts 'then the API key' back: it moves more money, so it asks the person's yes.
    const risk = await settingsSet.undoRisk?.(
      { key: "credential_policy", value: "subscription_then_ask" },
      { key: "credential_policy", project_id: null, value: "subscription_then_key" },
      { key: "credential_policy", project_id: null, value: "subscription_then_ask" },
      w.ctx(),
    );
    expect(risk).toBe("medium");
    const narrows = settingSpec("credential_policy").narrows;
    expect(narrows?.("subscription_then_wait", "key_only")).toBe(true);
    expect(narrows?.("key_then_subscription", "subscription_then_ask")).toBe(false);
  });

  it("settings_set's definition names credential_policy with its five values and neither older key", () => {
    const lines = settingsSet.description.split("\n");
    expect(lines.at(-1)).toBe(
      '- credential_policy (for the person): Which of the person\'s Claude credentials does the work, for every call, and what happens when the first one stops: subscription_then_wait (the default), subscription_then_ask, subscription_then_key, key_then_subscription or key_only. Only the person sets it. Value: "subscription_then_wait" | "subscription_then_ask" | "subscription_then_key" | "key_then_subscription" | "key_only".',
    );
    expect(lines.some((l) => l.startsWith("- billing_order "))).toBe(false);
    expect(lines.some((l) => l.startsWith("- mid_session_limit "))).toBe(false);
  });

  it("once credential_policy is stored, billing_order and mid_session_limit (and an Undo of their old rows) answer that they were replaced", async () => {
    const w = await world();
    const old = await w.executor.execute({
      name: "settings.set",
      params: { key: "billing_order", value: ["api_key", "subscription"] },
      ctx: w.ctx({ source: "ui" }),
    });
    expect(old.status).toBe("done");
    await w.store.human.patch(w.ctx().humanId, {
      notify_prefs: {
        ...(await prefsOf(w)),
        credential_policy: "subscription_then_wait",
      } as never,
    });
    for (const [key, value] of [
      ["billing_order", ["subscription", "api_key"]],
      ["mid_session_limit", "use_other"],
    ] as const) {
      const r = await w.executor.execute({
        name: "settings.set",
        params: { key, value },
        ctx: w.ctx({ source: "ui" }),
      });
      expect(r.status, key).toBe("refused");
      expect(reason(r)).toBe(CREDENTIAL_KEY_REPLACED);
    }
    expect(CREDENTIAL_KEY_REPLACED).toBe(
      'This was replaced by "Which Claude does the work"; change it there.',
    );
    const blocked = await settingsSet.undoBlocked?.(
      { key: "billing_order", value: ["api_key", "subscription"] },
      { key: "billing_order", project_id: null, value: null },
      { key: "billing_order", project_id: null, value: ["api_key", "subscription"] },
      w.ctx(),
    );
    expect(blocked).toBe(CREDENTIAL_KEY_REPLACED);
  });
});
