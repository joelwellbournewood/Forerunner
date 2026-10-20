import { randomBytes } from "node:crypto";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { EncryptedFileVault } from "@forerunner/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  answerUnlockChallenge,
  autoUnlockUntilOf,
  keyEncodings,
  RunnerVaultUnlock,
  shouldAutoAnswer,
  UNLOCK_AUDIT_TOOLS,
  UNLOCK_CARD_KIND,
  type UnlockChallengeCard,
} from "../src/vault-unlock.ts";
import { captureLogs, flush, seedWorld, tempHome, waitFor } from "./helpers.ts";

/**
 * The unlock protocol end to end against the real encrypted file vault and an in-memory
 * store: challenge, device answer, refusals (wrong key, stale challenge, tampered answer,
 * expiry, deny), the auto-unlock window (reuse of the cached key, forgetting at the end) and
 * the guarantee that the key never reaches a log line or a store row.
 */
const SCRYPT = { N: 1024, r: 8, p: 1 };
const POLL = 500;

interface World {
  clock: SimulatedClock;
  store: StateStore;
  humanId: string;
  agentId: string;
  vault: EncryptedFileVault;
  key: Buffer;
  unlock: RunnerVaultUnlock;
  forgotten: string[];
}

async function world(opts: { policy?: "ask" | "window"; ttlMs?: number } = {}): Promise<World> {
  const clock = new SimulatedClock("2026-03-02T22:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const seed = await seedWorld(store);
  const home = tempHome("fr-unlock-");
  const path = join(home, "vault.runner.json");
  const key = randomBytes(32);
  // The human's device created the blob; the runner only ever holds the file.
  const creator = await EncryptedFileVault.open({ path, key, scrypt: SCRYPT });
  await creator.set("anthropic_api_key", ["sk", "ant", "not", "real"].join("-")); // not-a-secret
  creator.lock();
  const vault = new EncryptedFileVault({ path });
  expect(vault.locked).toBe(true);
  const forgotten: string[] = [];
  const unlock = new RunnerVaultUnlock({
    vault,
    store: () => store,
    clock,
    humanId: seed.human.id,
    runnerId: "runner-test",
    agentId: seed.agent.id,
    policy: opts.policy ?? "window",
    challengeTtlMs: opts.ttlMs ?? 60_000,
    pollMs: POLL,
    timeoutMs: 10 * 60_000,
    tickMs: 1_000,
    onForget: (reason) => forgotten.push(reason),
  });
  return {
    clock,
    store,
    humanId: seed.human.id,
    agentId: seed.agent.id,
    vault,
    key,
    unlock,
    forgotten,
  };
}

/** The open challenge, waiting (wall clock) for the runner's async key derivation to finish. */
async function openRequest(w: World, notId?: string) {
  await flush();
  const row = await waitFor(async () => {
    const rows = await w.store.humanRequest.open({ humanId: w.humanId });
    return rows.find((r) => r.id !== notId);
  });
  expect(row.kind).toBe("credential");
  expect(row.risk).toBe("high");
  expect(row.blocking).toBe(true);
  const card = row.change_card as unknown as UnlockChallengeCard;
  expect(card.kind).toBe(UNLOCK_CARD_KIND);
  return { row, card };
}

async function answer(w: World, rowId: string, body: unknown) {
  const row = await w.store.humanRequest.mustGet(rowId);
  await w.store.humanRequest.answer(rowId, row.version, body as never, w.humanId);
  await w.clock.advance(POLL);
}

async function auditTools(w: World) {
  const rows = await w.store.auditLog.list({ humanId: w.humanId });
  return rows.map((r) => ({
    tool: r.tool,
    allowed: r.allowed,
    result: JSON.parse(r.result_summary) as Record<string, unknown>,
  }));
}

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  w.unlock.stop();
  await w.store.close();
});

describe("vault unlock: the challenge and the device's answer", () => {
  it("files a one-time challenge, accepts the key wrapped to it and unlocks; the key never touches logs or the store", async () => {
    const { lines } = await captureLogs(async () => {
      const pending = w.unlock.ensureUnlocked("runner start");
      const { row, card } = await openRequest(w);
      expect(card.runnerId).toBe("runner-test");
      expect(Buffer.from(card.runnerPublicKey, "base64")).toHaveLength(32);
      expect(Buffer.from(card.nonce, "base64")).toHaveLength(32);
      expect(Date.parse(card.expiresAt)).toBe(w.clock.now() + 60_000);
      const reply = answerUnlockChallenge(card, w.key, { now: w.clock.now() });
      await answer(w, row.id, reply);
      const outcome = await pending;
      expect(outcome).toMatchObject({ via: "human", requestId: row.id, unlockedUntil: null });
    });
    expect(w.vault.locked).toBe(false);
    expect(await w.vault.get("anthropic_api_key")).toContain("not-real");
    // No window: no cached copy; the unlock lasts for the process lifetime.
    expect(w.unlock.state).toMatchObject({ locked: false, cachedKey: false, unlockedUntil: null });
    const tools = (await auditTools(w)).map((a) => a.tool);
    expect(tools).toEqual([UNLOCK_AUDIT_TOOLS.requested, UNLOCK_AUDIT_TOOLS.granted]);

    // The key, in any encoding, is in no log line, no audit row and no human_request row.
    const everything = [
      ...lines,
      ...(await w.store.auditLog.list({})).map((r) => `${r.input_summary} ${r.result_summary}`),
      ...(await w.store.humanRequest.list({})).map((r) => JSON.stringify(r)),
    ].join("\n");
    for (const enc of keyEncodings(w.key)) expect(everything).not.toContain(enc);
    expect(everything).not.toContain("not-real");
    // Already unlocked: no second request.
    expect(await w.unlock.ensureUnlocked("again")).toMatchObject({ via: "already" });
    expect(await w.store.humanRequest.list({})).toHaveLength(1);
  });

  it("refuses a wrong key and a tampered answer, files a fresh challenge, then accepts the right key", async () => {
    const pending = w.unlock.ensureUnlocked("runner start");
    const first = await openRequest(w);
    // Wrong key: unwraps fine, the vault's check value rejects it.
    await answer(w, first.row.id, answerUnlockChallenge(first.card, randomBytes(32)));
    const second = await openRequest(w, first.row.id);
    expect(w.vault.locked).toBe(true);
    expect(second.row.id).not.toBe(first.row.id);
    expect(second.card.challengeId).not.toBe(first.card.challengeId);
    // Tampered ciphertext: AEAD fails.
    const tampered = answerUnlockChallenge(second.card, w.key);
    const ct = Buffer.from(tampered.ciphertext, "base64");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    await answer(w, second.row.id, { ...tampered, ciphertext: ct.toString("base64") });
    const third = await openRequest(w, second.row.id);
    expect(w.vault.locked).toBe(true);
    await answer(w, third.row.id, answerUnlockChallenge(third.card, w.key));
    expect(await pending).toMatchObject({ via: "human", requestId: third.row.id });
    expect(w.vault.locked).toBe(false);
    const refusals = (await auditTools(w)).filter((a) => a.tool === UNLOCK_AUDIT_TOOLS.refused);
    expect(refusals.map((r) => r.result.refusal)).toEqual(["wrong_key", "unwrap_failed"]);
    expect(w.unlock.state.refusals).toBe(2);
  });

  it("refuses an answer to another challenge (stale) and gives up after the attempts", async () => {
    const pending = w.unlock.ensureUnlocked("runner start");
    pending.catch(() => undefined);
    const first = await openRequest(w);
    const staleReply = answerUnlockChallenge(first.card, w.key);
    // Replay-style: a correct wrap for challenge one presented to challenges two and three.
    await answer(w, first.row.id, answerUnlockChallenge(first.card, randomBytes(32)));
    const second = await openRequest(w, first.row.id);
    await answer(w, second.row.id, staleReply);
    const third = await openRequest(w, second.row.id);
    await answer(w, third.row.id, staleReply);
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(w.vault.locked).toBe(true);
    const refusals = (await auditTools(w)).filter((a) => a.tool === UNLOCK_AUDIT_TOOLS.refused);
    expect(refusals.map((r) => r.result.refusal)).toEqual([
      "wrong_key",
      "stale_challenge",
      "stale_challenge",
    ]);
  });

  it("withdraws an expired challenge and the device refuses to answer one", async () => {
    const pending = w.unlock.ensureUnlocked("runner start");
    const first = await openRequest(w);
    expect(() =>
      answerUnlockChallenge(first.card, w.key, { now: Date.parse(first.card.expiresAt) }),
    ).toThrow(/expired/);
    await w.clock.advance(60_000);
    const second = await openRequest(w, first.row.id);
    expect((await w.store.humanRequest.mustGet(first.row.id)).status).toBe("withdrawn");
    expect(second.row.id).not.toBe(first.row.id);
    await answer(w, second.row.id, answerUnlockChallenge(second.card, w.key));
    expect(await pending).toMatchObject({ via: "human", requestId: second.row.id });
  });

  it("a plain deny ends the flow without a new challenge", async () => {
    const pending = w.unlock.ensureUnlocked("runner start");
    pending.catch(() => undefined);
    const { row } = await openRequest(w);
    await answer(w, row.id, "deny");
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(await w.store.humanRequest.list({})).toHaveLength(1);
    expect(w.vault.locked).toBe(true);
  });
});

describe("vault unlock: the auto-unlock window", () => {
  it("reuses the cached key until the window ends, then forgets it and asks again", async () => {
    const until = new Date(w.clock.now() + 2 * 60 * 60_000).toISOString();
    await w.store.human.patch(w.humanId, {
      notify_prefs: { cloud_runner: { auto_unlock_until: until } },
    });
    expect(autoUnlockUntilOf({ cloud_runner: { auto_unlock_until: until } })).toBe(
      Date.parse(until),
    );
    expect(shouldAutoAnswer({ cloud_runner: { auto_unlock_until: until } }, w.clock.now())).toBe(
      true,
    );
    const pending = w.unlock.ensureUnlocked("runner start");
    const { row, card } = await openRequest(w);
    await answer(w, row.id, answerUnlockChallenge(card, w.key));
    expect(await pending).toMatchObject({ via: "human", unlockedUntil: until });
    expect(w.unlock.state).toMatchObject({ locked: false, cachedKey: true, unlockedUntil: until });

    // An idle lock inside the window: re-unlocked from the cache, no new request.
    w.unlock.lock("idle");
    expect(w.vault.locked).toBe(true);
    expect(await w.unlock.ensureUnlocked("session")).toMatchObject({ via: "cached" });
    expect(w.vault.locked).toBe(false);
    expect(await w.store.humanRequest.list({})).toHaveLength(1);

    // The window ends: the tick forgets the key and locks the vault.
    w.unlock.start();
    await w.clock.advance(2 * 60 * 60_000 + 1_000);
    expect(w.vault.locked).toBe(true);
    expect(w.unlock.state).toMatchObject({ locked: true, cachedKey: false, unlockedUntil: null });
    expect(w.forgotten).toEqual(["auto-unlock window ended"]);
    const locked = (await auditTools(w)).filter((a) => a.tool === UNLOCK_AUDIT_TOOLS.locked);
    expect(locked).toHaveLength(1);

    // The next need asks the human again.
    const again = w.unlock.ensureUnlocked("session");
    const second = await openRequest(w, row.id);
    expect(second.row.id).not.toBe(row.id);
    await answer(w, second.row.id, answerUnlockChallenge(second.card, w.key));
    expect(await again).toMatchObject({ via: "human", unlockedUntil: null });
    expect(w.unlock.state.cachedKey).toBe(false);
  });

  it("a shortened or cleared window locks at the tick; policy ask ignores windows", async () => {
    const until = new Date(w.clock.now() + 60 * 60_000).toISOString();
    await w.store.human.patch(w.humanId, {
      notify_prefs: { cloud_runner: { auto_unlock_until: until } },
    });
    const pending = w.unlock.ensureUnlocked("runner start");
    const { row, card } = await openRequest(w);
    await answer(w, row.id, answerUnlockChallenge(card, w.key));
    await pending;
    expect(w.unlock.state.cachedKey).toBe(true);
    await w.store.human.patch(w.humanId, { notify_prefs: {} });
    await w.unlock.checkWindow();
    expect(w.vault.locked).toBe(true);
    expect(w.unlock.state.cachedKey).toBe(false);

    const ask = await world({ policy: "ask" });
    try {
      await ask.store.human.patch(ask.humanId, {
        notify_prefs: { cloud_runner: { auto_unlock_until: until } },
      });
      const p = ask.unlock.ensureUnlocked("runner start");
      const r = await openRequest(ask);
      await answer(ask, r.row.id, answerUnlockChallenge(r.card, ask.key));
      expect(await p).toMatchObject({ via: "human", unlockedUntil: null });
      expect(ask.unlock.state.cachedKey).toBe(false);
    } finally {
      await ask.store.close();
    }
  });

  it("the device can set the window with its answer; an absurd window is refused", async () => {
    const pending = w.unlock.ensureUnlocked("runner start");
    const { row, card } = await openRequest(w);
    const until = new Date(w.clock.now() + 8 * 60 * 60_000).toISOString();
    await answer(w, row.id, answerUnlockChallenge(card, w.key, { autoUnlockUntil: until }));
    expect(await pending).toMatchObject({ via: "human", unlockedUntil: until });
    const human = await w.store.human.mustGet(w.humanId);
    expect(autoUnlockUntilOf(human.notify_prefs)).toBe(Date.parse(until));
    expect(w.unlock.state.cachedKey).toBe(true);

    const other = await world();
    try {
      const p = other.unlock.ensureUnlocked("runner start");
      const r = await openRequest(other);
      const farAway = new Date(other.clock.now() + 30 * 24 * 60 * 60_000).toISOString();
      await answer(
        other,
        r.row.id,
        answerUnlockChallenge(r.card, other.key, { autoUnlockUntil: farAway }),
      );
      expect(await p).toMatchObject({ via: "human", unlockedUntil: null });
      expect(autoUnlockUntilOf((await other.store.human.mustGet(other.humanId)).notify_prefs)).toBe(
        null,
      );
      const refused = (await auditTools(other)).filter(
        (a) => a.tool === UNLOCK_AUDIT_TOOLS.refused,
      );
      expect(refused.map((r) => r.result.refusal)).toEqual(["bad_window"]);
    } finally {
      await other.store.close();
    }
  });
});
