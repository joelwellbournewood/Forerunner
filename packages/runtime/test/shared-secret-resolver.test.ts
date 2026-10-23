import { randomBytes } from "node:crypto";
import { isForerunnerError, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import {
  ensureInstallWrapKey,
  INSTALL_WRAP_KEY_NAME,
  MemoryVault,
  SecretResolver,
  valueEncodings,
  type WrapKeyPair,
} from "@forerunner/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunContext } from "../src/enforcement/hooks.ts";
import {
  applySharedGrantAnswer,
  proposeSharedSecret,
  revokeSharedGrant,
  SHARED_SECRET_AUDIT,
  SHARED_SECRET_CARD_KIND,
  SharedSecretVault,
  StoreSharedSecretService,
} from "../src/secrets/index.ts";
import { budget, harness, issue, secretTool } from "./helpers.ts";

/** A fresh value that can never be mistaken for a real credential or a fixed fixture. */
function freshValue(prefix = "v-"): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

/**
 * Shared secrets on two installs (spec S.13, ADR 0065). Ada's install holds the org deploy
 * token in its own vault and shares it with Bob's agent: the value is wrapped to Bob's
 * install key, the grant waits for Bob's approval, and once active Bob's install resolves
 * `secret:org_deploy_token` by reference through the enforcement hooks, like a local secret:
 * the tool gets the value, the model context keeps the reference, outputs are redacted, no
 * row and no log line carries the value, and nobody else can read it.
 */
const NAME = "org_deploy_token";

interface Install {
  vault: MemoryVault;
  key: WrapKeyPair;
  deviceId: string;
}

let clock: SimulatedClock;
let store: StateStore;
let ada: { id: string };
let bob: { id: string };
let alice: { id: string };
let bobby: { id: string };
let adaPc: Install;
let bobPc: Install;
let service: StoreSharedSecretService;
let value: string;

async function install(
  humanId: string,
  name: string,
  kind: "desktop" | "runner",
): Promise<Install> {
  const vault = new MemoryVault();
  const key = await ensureInstallWrapKey(vault);
  const row = await store.device.register({
    owner_human_id: humanId,
    name,
    platform: "linux",
    public_key: `${name}-identity`,
    kind,
    wrap_public_key: key.publicKey,
  });
  return { vault, key, deviceId: row.id };
}

function resolverFor(i: Install, agentId: string, resolved: string[] = []): SharedSecretVault {
  return new SharedSecretVault({
    local: i.vault,
    source: service,
    agentId,
    install: { deviceId: i.deviceId, privateKey: () => i.key.privateKey },
    onResolved: (info) => {
      resolved.push(info.name);
    },
  });
}

/** Everything in the store a value could leak into, as one string. */
async function storeText(): Promise<string> {
  const parts: unknown[] = [
    await store.secretGrant.list(),
    await store.humanRequest.list(),
    await store.auditLog.list(),
    await store.secretRef.list(),
    await store.device.list(),
  ];
  return JSON.stringify(parts);
}

function expectNoValue(text: string, v: string = value): void {
  for (const enc of valueEncodings(v)) expect(text).not.toContain(enc);
}

beforeEach(async () => {
  clock = new SimulatedClock("2026-10-23T09:00:00.000Z");
  store = await openStore({ url: "sqlite::memory:", clock });
  ada = await store.human.insert({ name: "Ada", email: "ada@example.test" });
  bob = await store.human.insert({ name: "Bob", email: "bob@example.test" });
  alice = await store.agent.insert({ name: "Alice", owner_human_id: ada.id });
  bobby = await store.agent.insert({ name: "Bobby", owner_human_id: bob.id });
  adaPc = await install(ada.id, "ada-pc", "desktop");
  bobPc = await install(bob.id, "bob-pc", "desktop");
  service = new StoreSharedSecretService(store, { clock, installId: "ada-pc" });
  value = freshValue("deploy-");
  await adaPc.vault.set(NAME, value);
});
afterEach(() => store.close());

async function propose() {
  return proposeSharedSecret({
    vault: adaPc.vault,
    service,
    ownerHumanId: ada.id,
    name: NAME,
    agentIds: [bobby.id],
    why: "deploys from Bobby's sessions",
  });
}

async function approveAs(humanId: string, answer: unknown) {
  const [req] = await store.humanRequest.open({ humanId });
  if (!req) throw new Error("no open request");
  return store.transaction(async (tx) => {
    const answered = await tx.humanRequest.answer(req.id, req.version, answer as never, humanId);
    return applySharedGrantAnswer(tx, answered, humanId, { clock });
  });
}

describe("proposing a shared secret", () => {
  it("wraps the value per named agent install, files a pending grant and one high-risk approval card for the other human; nothing is served and no row carries the value", async () => {
    const { grant, requestIds, targets } = await propose();
    expect(targets).toEqual([
      { agentId: bobby.id, deviceId: bobPc.deviceId, deviceName: "bob-pc" },
    ]);
    expect(grant).toMatchObject({
      name: NAME,
      ownerHumanId: ada.id,
      agentIds: [bobby.id],
      requiredHumanIds: [bob.id],
      status: "pending",
      blobCount: 1,
    });
    expect(requestIds).toHaveLength(1);
    const [card] = await store.humanRequest.open({ humanId: bob.id });
    expect(card?.id).toBe(requestIds[0]);
    expect(card).toMatchObject({
      kind: "approval",
      risk: "high",
      blocking: false,
      options: ["approve", "deny"],
    });
    expect(card?.change_card).toMatchObject({
      kind: SHARED_SECRET_CARD_KIND,
      grantId: grant.id,
      name: NAME,
      ownerHumanId: ada.id,
      ownerName: "Ada",
      agentIds: [bobby.id],
      agentNames: ["Bobby"],
    });
    const row = await store.secretGrant.mustGet(grant.id);
    expect(row.blobs.map((b) => [b.agent_id, b.device_id])).toEqual([[bobby.id, bobPc.deviceId]]);
    // Pending: Bob's install is refused like anyone else.
    expect(await service.fetchBlob(NAME, bobby.id, bobPc.deviceId)).toBeNull();
    const audit = await store.auditLog.list({ tool: SHARED_SECRET_AUDIT.proposed });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ human_id: ada.id, allowed: true });
    expect(audit[0]?.input_summary).toContain(NAME);
    expectNoValue(await storeText());
  });

  it("refuses an unknown agent, an agent whose owner has no install with a wrapping key, and a name the owner's vault does not hold", async () => {
    const carol = await store.human.insert({ name: "Carol", email: "carol@example.test" });
    const carolAgent = await store.agent.insert({ name: "Cy", owner_human_id: carol.id });
    const attempt = async (agentIds: string[], name = NAME) => {
      try {
        await proposeSharedSecret({
          vault: adaPc.vault,
          service,
          ownerHumanId: ada.id,
          name,
          agentIds,
        });
      } catch (e) {
        return e;
      }
      throw new Error("expected a refusal");
    };
    expect(isForerunnerError(await attempt(["nobody"]), "not_found")).toBe(true);
    expect(isForerunnerError(await attempt([carolAgent.id]), "validation")).toBe(true);
    expect(isForerunnerError(await attempt([bobby.id], "missing_name"), "not_found")).toBe(true);
    expect(isForerunnerError(await attempt([]), "validation")).toBe(true);
    expect(await store.secretGrant.list()).toEqual([]);
  });
});

describe("resolving a shared secret by reference", () => {
  it("after Bob approves, Bobby's install resolves the reference through the hooks: the tool gets the value, the context keeps the reference, the output is redacted, the audit names the secret only", async () => {
    const { grant } = await propose();
    const active = await approveAs(bob.id, "approve");
    expect(active?.status).toBe("active");
    expect(active?.activated_at).toBe(clock.nowIso());
    // The grant joined the secret_ref table as a shared reference for the named agent.
    expect((await store.secretRef.forAgent(bobby.id)).map((r) => [r.name, r.scope])).toEqual([
      [NAME, "shared"],
    ]);
    expect(await store.secretGrant.activeNamesFor(bobby.id)).toEqual([NAME]);

    const resolved: string[] = [];
    const bobVault = resolverFor(bobPc, bobby.id, resolved);
    const h = harness({ secrets: new SecretResolver(bobVault) });
    const token = issue(h, {
      agentId: bobby.id,
      ownerHumanId: bob.id,
      allowedTools: ["use_secret"],
      grantedSecrets: [NAME],
    });
    const ctx: RunContext = {
      token,
      budget: budget("sess-1", 5_000_000, h.clock),
      signal: new AbortController().signal,
      runDeadlineMs: h.clock.now() + 60_000,
      phase: "work",
      model: "fake-haiku",
      provider: "fake",
      billingSourceId: "bs-1",
      approvals: new Set(),
    };
    const input = { token: `secret:${NAME}` };
    const d = await h.hooks.beforeToolCall(ctx, secretTool, input);
    expect(d.allowed).toBe(true);
    expect((d as { input: { token: string } }).input).toEqual({ token: value });
    // The model-facing input is untouched; only the copy handed to the tool carries the value.
    expect(input.token).toBe(`secret:${NAME}`);
    const out = await h.hooks.afterToolCall(ctx, secretTool, input, { content: `used:${value}` });
    expect(out.content).toBe("used:[REDACTED]");
    expect(resolved).toEqual([NAME]);
    // Nothing cached in the local vault; the install private key is the only local entry.
    expect(await bobPc.vault.list()).toEqual([INSTALL_WRAP_KEY_NAME]);
    expect(await bobPc.vault.has(NAME)).toBe(false);
    const served = await store.auditLog.list({ tool: SHARED_SECRET_AUDIT.served });
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ agent_id: bobby.id, human_id: bob.id, allowed: true });
    expect(served[0]?.input_summary).toContain(NAME);
    expect((await store.secretGrant.mustGet(grant.id)).last_served).toBe(clock.nowIso());
    const hookRows = h.audit.entries.map((e) => JSON.stringify(e)).join("\n");
    expect(hookRows).toContain(`secret:${NAME}`);
    expectNoValue(hookRows);
    expectNoValue(await storeText());
  });

  it("local first: a name in the install's own vault wins and the service is never asked", async () => {
    await propose();
    await approveAs(bob.id, "approve");
    const local = freshValue("local-");
    await bobPc.vault.set(NAME, local);
    const resolved: string[] = [];
    const bobVault = resolverFor(bobPc, bobby.id, resolved);
    expect(await bobVault.get(NAME)).toBe(local);
    expect(resolved).toEqual([]);
    expect(await store.auditLog.list({ tool: SHARED_SECRET_AUDIT.served })).toEqual([]);
    expect(await bobVault.has(NAME)).toBe(true);
    expect(await bobVault.list()).toContain(NAME);
  });

  it("another agent, another install and a token without the name are refused, each before any value moves", async () => {
    await propose();
    await approveAs(bob.id, "approve");
    // Alice (Ada's own agent) is not named: her install resolves nothing by reference.
    const aliceVault = resolverFor(adaPc, alice.id);
    await adaPc.vault.delete(NAME);
    expect(await aliceVault.get(NAME)).toBeNull();
    // Bob's phone-like second install has no blob: nothing for it either, and its key cannot
    // open the PC's blob because the blob is bound to the PC's device id.
    const bobRunner = await install(bob.id, "bob-runner", "runner");
    const runnerVault = resolverFor(bobRunner, bobby.id);
    expect(await runnerVault.get(NAME)).toBeNull();
    const stolen = new SharedSecretVault({
      local: bobRunner.vault,
      source: service,
      agentId: bobby.id,
      install: { deviceId: bobPc.deviceId, privateKey: () => bobRunner.key.privateKey },
    });
    const err = await stolen.get(NAME).catch((e: unknown) => e);
    expect(isForerunnerError(err, "validation")).toBe(true);
    expect((err as { details: { reason: string } }).details.reason).toBe("integrity");
    // The hooks' grantedSecrets rule is unchanged: a token without the name never reaches the vault.
    const h = harness({ secrets: new SecretResolver(resolverFor(bobPc, bobby.id)) });
    const token = issue(h, {
      agentId: bobby.id,
      ownerHumanId: bob.id,
      allowedTools: ["use_secret"],
    });
    const ctx: RunContext = {
      token,
      budget: budget("sess-1", 5_000_000, h.clock),
      signal: new AbortController().signal,
      runDeadlineMs: h.clock.now() + 60_000,
      phase: "work",
      model: "fake-haiku",
      provider: "fake",
      billingSourceId: "bs-1",
      approvals: new Set(),
    };
    await expect(
      h.hooks.beforeToolCall(ctx, secretTool, { token: `secret:${NAME}` }),
    ).rejects.toMatchObject({ code: "secret_not_granted" });
    const refused = await store.auditLog.list({ tool: SHARED_SECRET_AUDIT.refused_serve });
    expect(refused.length).toBeGreaterThanOrEqual(2);
    for (const row of refused) expect(row.allowed).toBe(false);
    expectNoValue(await storeText());
  });

  it("a refusal cancels the grant and drops the blobs; a revoke by the owner ends an active one and the resolver fails from then on", async () => {
    const first = await propose();
    const cancelled = await approveAs(bob.id, "deny");
    expect(cancelled).toMatchObject({ status: "cancelled", blobs: [] });
    expect(await store.secretGrant.activeNamesFor(bobby.id)).toEqual([]);
    expect(await store.auditLog.list({ tool: SHARED_SECRET_AUDIT.refused })).toHaveLength(1);
    expect(await resolverFor(bobPc, bobby.id).get(NAME)).toBeNull();

    const second = await propose();
    expect(second.grant.id).not.toBe(first.grant.id);
    await approveAs(bob.id, "approve");
    const bobVault = resolverFor(bobPc, bobby.id);
    expect(await bobVault.get(NAME)).toBe(value);
    const revoked = await revokeSharedGrant(store, second.grant.id, { clock, by: ada.id });
    expect(revoked).toMatchObject({
      status: "revoked",
      blobs: [],
      ended_reason: "revoked by the owner",
    });
    expect(await bobVault.get(NAME)).toBeNull();
    expect(await store.secretRef.forAgent(bobby.id)).toEqual([]);
    expect(await store.auditLog.list({ tool: SHARED_SECRET_AUDIT.revoked })).toHaveLength(1);
    // A revoke on a pending grant withdraws the open cards.
    const third = await propose();
    await revokeSharedGrant(store, third.grant.id, { clock, by: ada.id });
    expect(await store.humanRequest.open({ humanId: bob.id })).toEqual([]);
    const tools = (await store.auditLog.list()).map((r) => r.tool);
    for (const t of Object.values(SHARED_SECRET_AUDIT)) {
      if (t === SHARED_SECRET_AUDIT.resolved) continue;
      expect(tools, t).toContain(t);
    }
    expectNoValue(await storeText());
  });
});
