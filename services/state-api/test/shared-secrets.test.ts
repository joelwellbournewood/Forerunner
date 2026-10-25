import { randomBytes } from "node:crypto";
import {
  HttpSharedSecretService,
  proposeSharedSecret,
  SHARED_SECRET_AUDIT,
  SHARED_SECRET_CARD_KIND,
  SharedSecretVault,
} from "@forerunner/runtime/secrets/index";
import type { DeviceRow } from "@forerunner/state";
import {
  ensureInstallWrapKey,
  MemoryVault,
  valueEncodings,
  type WrapKeyPair,
  wrapSecret,
} from "@forerunner/vault";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_TOKEN, type DeviceClient, type Harness, harness, json } from "./helpers.ts";

/**
 * Shared secrets through the state service, on two profiles with two humans (spec S.13, ADR
 * 0065). Ada's install holds the org deploy token; she shares it with Bob's agent. The
 * service never sees the value: it stores the copy wrapped to Bob's install, shows Bob the
 * standard approval card, activates the grant with his signed, biometric yes, serves the
 * wrapped copy to Bob's install for Bob's agent only, cancels on a refusal and ends on a
 * revoke. Every row and response is checked for the value in every encoding.
 */
const NAME = "org_deploy_token";

interface Install {
  vault: MemoryVault;
  key: WrapKeyPair;
  device: DeviceRow;
  service: HttpSharedSecretService;
}

function freshValue(prefix = "v-"): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

let h: Harness;
let adaPc: Install;
let bobPc: Install;
let bobPhone: DeviceClient;
let adaPhone: DeviceClient;
let value: string;
/** Every response body the test saw, for the leak check. */
const bodies: string[] = [];

async function install(humanId: string, name: string, existing?: DeviceRow): Promise<Install> {
  const vault = new MemoryVault();
  const key = await ensureInstallWrapKey(vault);
  const device = existing
    ? await h.store.device.patch(existing.id, { wrap_public_key: key.publicKey })
    : await h.store.device.register({
        owner_human_id: humanId,
        name,
        platform: "linux",
        public_key: `${name}-identity`,
        kind: "desktop",
        wrap_public_key: key.publicKey,
      });
  const service = new HttpSharedSecretService({
    baseUrl: "http://state.test",
    token: ADMIN_TOKEN,
    installId: name,
    fetch: async (url, init) => {
      const res = await h.app.request(String(url), init);
      bodies.push(await res.clone().text());
      return res;
    },
  });
  return { vault, key, device, service };
}

function resolverFor(i: Install, agentId: string): SharedSecretVault {
  return new SharedSecretVault({
    local: i.vault,
    source: i.service,
    agentId,
    install: { deviceId: i.device.id, privateKey: () => i.key.privateKey },
  });
}

async function propose(why = "deploys from Bobby's sessions") {
  return proposeSharedSecret({
    vault: adaPc.vault,
    service: adaPc.service,
    ownerHumanId: h.seed.ada.id,
    name: NAME,
    agentIds: [h.seed.bobAgent.id],
    why,
  });
}

async function bobCard() {
  const inbox = await json<{ requests: { id: string; version: number; changeCard: unknown }[] }>(
    await bobPhone.get(`/inbox?humanId=${h.seed.bob.id}`),
  );
  const card = inbox.requests.find(
    (r) => (r.changeCard as { kind?: string } | null)?.kind === SHARED_SECRET_CARD_KIND,
  );
  if (!card) throw new Error("no shared-secret card in Bob's inbox");
  return card;
}

async function everything(): Promise<string> {
  return JSON.stringify([
    await h.store.secretGrant.list(),
    await h.store.humanRequest.list(),
    await h.store.auditLog.list(),
    await h.store.secretRef.list(),
    await h.store.decision.list(),
    bodies,
  ]);
}

function expectNoValue(text: string, v: string = value): void {
  for (const enc of valueEncodings(v)) expect(text).not.toContain(enc);
}

beforeEach(async () => {
  h = await harness();
  bodies.length = 0;
  adaPc = await install(h.seed.ada.id, "ada-pc", await h.store.device.mustGet(h.seed.desktop.id));
  bobPc = await install(h.seed.bob.id, "bob-pc");
  bobPhone = await h.pairDevice(h.seed.bob.id);
  adaPhone = await h.pairDevice(h.seed.ada.id);
  value = freshValue("deploy-");
  await adaPc.vault.set(NAME, value);
});
afterEach(() => h.close());

describe("shared secrets through the state service", () => {
  it("wrap targets: the installs of the named agents' owners with a key; phones are never targets; devices get 403", async () => {
    const res = await h.admin.get(
      `/secrets/wrap-keys?agentIds=${h.seed.bobAgent.id},${h.seed.alice.id}`,
    );
    expect(res.status).toBe(200);
    const { targets } = await json<{
      targets: { agentId: string; deviceId: string; wrapPublicKey: string }[];
    }>(res);
    expect(targets.map((t) => [t.agentId, t.deviceId, t.wrapPublicKey])).toEqual([
      [h.seed.bobAgent.id, bobPc.device.id, bobPc.key.publicKey],
      [h.seed.alice.id, adaPc.device.id, adaPc.key.publicKey],
    ]);
    expect((await bobPhone.get(`/secrets/wrap-keys?agentIds=${h.seed.bobAgent.id}`)).status).toBe(
      403,
    );
    expect((await h.admin.get("/secrets/wrap-keys?agentIds=nobody")).status).toBe(404);
    expect((await h.admin.get("/secrets/wrap-keys")).status).toBe(400);
  });

  it("propose: the value arrives wrapped per install, the grant is pending, Bob's inbox shows the standard card, nothing is served until he approves", async () => {
    const { grant, requestIds } = await propose();
    expect(grant).toMatchObject({
      name: NAME,
      ownerHumanId: h.seed.ada.id,
      agentIds: [h.seed.bobAgent.id],
      requiredHumanIds: [h.seed.bob.id],
      approvedHumanIds: [],
      status: "pending",
      blobCount: 1,
    });
    expect(requestIds).toHaveLength(1);
    const card = await bobCard();
    expect(card.id).toBe(requestIds[0]);
    expect(card.changeCard).toMatchObject({
      kind: SHARED_SECRET_CARD_KIND,
      grantId: grant.id,
      name: NAME,
      ownerName: "Ada",
      agentNames: ["Bobby"],
    });
    // Ada's inbox has no card: the owner approved by proposing.
    const adaInbox = await json<{ requests: unknown[] }>(
      await adaPhone.get(`/inbox?humanId=${h.seed.ada.id}`),
    );
    expect(adaInbox.requests).toEqual([]);
    // Both humans see the grant; a third does not.
    for (const phone of [adaPhone, bobPhone]) {
      const list = await json<{ grants: { id: string }[] }>(await phone.get("/secrets/shared"));
      expect(list.grants.map((g) => g.id)).toEqual([grant.id]);
      expect((await phone.get(`/secrets/shared/${grant.id}`)).status).toBe(200);
    }
    const carol = await h.store.human.insert({ name: "Carol", email: "carol@example.test" });
    const carolPhone = await h.pairDevice(carol.id);
    expect(
      (await json<{ grants: unknown[] }>(await carolPhone.get("/secrets/shared"))).grants,
    ).toEqual([]);
    expect((await carolPhone.get(`/secrets/shared/${grant.id}`)).status).toBe(404);
    // Pending: Bob's install gets nothing yet.
    const blob = await h.admin.get(
      `/secrets/shared/blob?name=${NAME}&agentId=${h.seed.bobAgent.id}&deviceId=${bobPc.device.id}`,
      { headers: { "x-forerunner-install": "bob-pc" } },
    );
    expect(blob.status).toBe(403);
    expect((await json(blob)).code).toBe("secret_not_granted");
    expect(await resolverFor(bobPc, h.seed.bobAgent.id).get(NAME)).toBeNull();
    const proposed = await h.store.auditLog.list({ tool: SHARED_SECRET_AUDIT.proposed });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.input_summary).toContain("ada-pc");
    expectNoValue(await everything());
  });

  it("validation: a device never proposes; a blob for an install that is not the agent's, a malformed blob, a bad name and an unknown agent are refused", async () => {
    const good = wrapSecret(value, bobPc.key.publicKey, {
      name: NAME,
      ownerHumanId: h.seed.ada.id,
      agentId: h.seed.bobAgent.id,
      deviceId: bobPc.device.id,
    });
    const base = {
      ownerHumanId: h.seed.ada.id,
      name: NAME,
      agentIds: [h.seed.bobAgent.id],
      blobs: [{ agentId: h.seed.bobAgent.id, deviceId: bobPc.device.id, blob: good }],
    };
    expect((await adaPhone.post("/secrets/shared", base)).status).toBe(403);
    const wrongInstall = { ...base, blobs: [{ ...base.blobs[0], deviceId: adaPc.device.id }] };
    expect((await h.admin.post("/secrets/shared", wrongInstall)).status).toBe(400);
    const malformed = { ...base, blobs: [{ ...base.blobs[0], blob: { v: 1, iv: "x" } }] };
    expect((await h.admin.post("/secrets/shared", malformed)).status).toBe(400);
    expect((await h.admin.post("/secrets/shared", { ...base, name: "Bad Name" })).status).toBe(400);
    expect((await h.admin.post("/secrets/shared", { ...base, agentIds: ["nobody"] })).status).toBe(
      404,
    );
    const missingCopy = { ...base, agentIds: [h.seed.bobAgent.id, h.seed.alice.id] };
    expect((await h.admin.post("/secrets/shared", missingCopy)).status).toBe(400);
    expect(await h.store.secretGrant.list()).toEqual([]);
    expectNoValue(await everything());
  });

  it("approval: Bob's unsigned or non-biometric answer is refused; his signed biometric yes activates the grant; the blob is served only to Bob's install for Bob's agent, and Bob's install resolves the value by reference", async () => {
    const { grant } = await propose();
    const card = await bobCard();
    const unsigned = await bobPhone.post(
      `/requests/${card.id}/answer`,
      { version: card.version, answer: "approve" },
      { unsigned: true },
    );
    expect(unsigned.status).toBe(401);
    const noBiometric = await bobPhone.post(`/requests/${card.id}/answer`, {
      version: card.version,
      answer: "approve",
    });
    expect(noBiometric.status).toBe(403);
    expect((await json(noBiometric)).code).toBe("biometric_required");
    expect((await h.store.secretGrant.mustGet(grant.id)).status).toBe("pending");
    // Ada's phone cannot answer Bob's card.
    expect(
      (
        await adaPhone.post(
          `/requests/${card.id}/answer`,
          { version: card.version, answer: "approve" },
          { biometric: true },
        )
      ).status,
    ).toBe(403);

    const yes = await bobPhone.post(
      `/requests/${card.id}/answer`,
      { version: card.version, answer: "approve" },
      { biometric: true },
    );
    expect(yes.status).toBe(200);
    const active = await json<{
      grant: { status: string; approvedHumanIds: string[]; activatedAt: string };
    }>(await bobPhone.get(`/secrets/shared/${grant.id}`));
    expect(active.grant).toMatchObject({
      status: "active",
      approvedHumanIds: [h.seed.bob.id],
      activatedAt: h.clock.nowIso(),
    });
    // The grant joined secret_ref as a shared reference for Bobby.
    expect(
      (await h.store.secretRef.forAgent(h.seed.bobAgent.id)).map((r) => [r.name, r.scope]),
    ).toEqual([[NAME, "shared"]]);

    // Served: Bob's install, Bob's agent.
    const served = await h.admin.get(
      `/secrets/shared/blob?name=${NAME}&agentId=${h.seed.bobAgent.id}&deviceId=${bobPc.device.id}`,
      { headers: { "x-forerunner-install": "bob-pc" } },
    );
    expect(served.status).toBe(200);
    const body = await json<{
      grantId: string;
      ownerHumanId: string;
      agentId: string;
      deviceId: string;
      blob: { v: number };
    }>(served);
    expect(body).toMatchObject({
      grantId: grant.id,
      ownerHumanId: h.seed.ada.id,
      agentId: h.seed.bobAgent.id,
      deviceId: bobPc.device.id,
    });
    expect(body.blob.v).toBe(1);
    // Refused: Ada's agent (not named), Ada's install for Bob's agent, an unknown install, a phone.
    const refusals = [
      `name=${NAME}&agentId=${h.seed.alice.id}&deviceId=${adaPc.device.id}`,
      `name=${NAME}&agentId=${h.seed.bobAgent.id}&deviceId=${adaPc.device.id}`,
      `name=${NAME}&agentId=${h.seed.bobAgent.id}&deviceId=${bobPhone.deviceId}`,
      `name=other_name&agentId=${h.seed.bobAgent.id}&deviceId=${bobPc.device.id}`,
    ];
    for (const q of refusals) {
      const res = await h.admin.get(`/secrets/shared/blob?${q}`);
      expect(res.status, q).toBe(403);
      expect((await json(res)).code).toBe("secret_not_granted");
    }
    const phone = await bobPhone.get(
      `/secrets/shared/blob?name=${NAME}&agentId=${h.seed.bobAgent.id}&deviceId=${bobPc.device.id}`,
    );
    expect(phone.status).toBe(403);
    expect((await json(phone)).code).toBe("forbidden");

    // Bob's install resolves it by reference and keeps nothing in its own vault; Ada's install
    // for Alice gets nothing from the service.
    const bobResolver = resolverFor(bobPc, h.seed.bobAgent.id);
    expect(await bobResolver.get(NAME)).toBe(value);
    expect(await bobPc.vault.has(NAME)).toBe(false);
    await adaPc.vault.delete(NAME);
    expect(await resolverFor(adaPc, h.seed.alice.id).get(NAME)).toBeNull();

    const audit = await h.store.auditLog.list();
    const by = (tool: string) => audit.filter((r) => r.tool === tool);
    expect(by(SHARED_SECRET_AUDIT.approved)).toHaveLength(1);
    expect(by(SHARED_SECRET_AUDIT.approved)[0]).toMatchObject({ human_id: h.seed.bob.id });
    expect(by(SHARED_SECRET_AUDIT.approved)[0]?.input_summary).toContain(bobPhone.deviceId);
    expect(by(SHARED_SECRET_AUDIT.activated)).toHaveLength(1);
    expect(by(SHARED_SECRET_AUDIT.served).length).toBeGreaterThanOrEqual(2);
    expect(by(SHARED_SECRET_AUDIT.served)[0]).toMatchObject({
      agent_id: h.seed.bobAgent.id,
      human_id: h.seed.bob.id,
      allowed: true,
    });
    expect(by(SHARED_SECRET_AUDIT.served)[0]?.input_summary).toContain("bob-pc");
    expect(by(SHARED_SECRET_AUDIT.refused_serve).length).toBe(refusals.length + 1);
    for (const r of by(SHARED_SECRET_AUDIT.refused_serve)) expect(r.allowed).toBe(false);
    expectNoValue(await everything());
  });

  it("refusal: Bob's no cancels the grant, drops the wrapped copies and leaves nothing to serve; a later proposal starts fresh", async () => {
    const first = await propose();
    const card = await bobCard();
    const no = await bobPhone.post(
      `/requests/${card.id}/answer`,
      { version: card.version, answer: "deny" },
      { biometric: true },
    );
    expect(no.status).toBe(200);
    const row = await h.store.secretGrant.mustGet(first.grant.id);
    expect(row).toMatchObject({
      status: "cancelled",
      blobs: [],
      ended_reason: `refused by ${h.seed.bob.id}`,
    });
    expect(await resolverFor(bobPc, h.seed.bobAgent.id).get(NAME)).toBeNull();
    expect(await h.store.secretRef.forAgent(h.seed.bobAgent.id)).toEqual([]);
    expect(await h.store.auditLog.list({ tool: SHARED_SECRET_AUDIT.refused })).toHaveLength(1);
    const second = await propose("second try");
    expect(second.grant.id).not.toBe(first.grant.id);
    expect(second.grant.status).toBe("pending");
    expect((await bobCard()).id).toBe(second.requestIds[0]);
    expectNoValue(await everything());
  });

  it("revoke: the owner ends an active grant from her install or her signed phone; Bob's phone cannot; a pending grant's cards are withdrawn", async () => {
    const { grant } = await propose();
    const card = await bobCard();
    await bobPhone.post(
      `/requests/${card.id}/answer`,
      { version: card.version, answer: "approve" },
      { biometric: true },
    );
    const bobResolver = resolverFor(bobPc, h.seed.bobAgent.id);
    expect(await bobResolver.get(NAME)).toBe(value);
    expect((await bobPhone.post(`/secrets/shared/${grant.id}/revoke`, {})).status).toBe(403);
    expect(
      (await adaPhone.post(`/secrets/shared/${grant.id}/revoke`, {}, { unsigned: true })).status,
    ).toBe(401);
    const revoked = await adaPhone.post(`/secrets/shared/${grant.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(
      (await json<{ grant: { status: string; blobCount: number } }>(revoked)).grant,
    ).toMatchObject({
      status: "revoked",
      blobCount: 0,
    });
    expect(await bobResolver.get(NAME)).toBeNull();
    expect(await h.store.secretRef.forAgent(h.seed.bobAgent.id)).toEqual([]);
    // Idempotent (re-signed with a fresh timestamp: a verbatim repeat is a replay, ADR 0009),
    // and the runtime (Ada's install) may revoke too.
    await h.clock.advance(1_000);
    expect((await adaPhone.post(`/secrets/shared/${grant.id}/revoke`, {})).status).toBe(200);
    const pending = await propose("again");
    const viaInstall = await h.admin.post(
      `/secrets/shared/${pending.grant.id}/revoke`,
      {},
      {
        headers: { "x-forerunner-install": "ada-pc" },
      },
    );
    expect(viaInstall.status).toBe(200);
    expect((await h.store.humanRequest.mustGet(pending.requestIds[0] as string)).status).toBe(
      "withdrawn",
    );
    expect(
      (await json<{ requests: unknown[] }>(await bobPhone.get(`/inbox?humanId=${h.seed.bob.id}`)))
        .requests,
    ).toEqual([]);
    expect((await h.admin.post("/secrets/shared/missing/revoke", {})).status).toBe(404);
    const revokedRows = await h.store.auditLog.list({ tool: SHARED_SECRET_AUDIT.revoked });
    expect(revokedRows).toHaveLength(2);
    expect(revokedRows[0]?.input_summary).toContain(adaPhone.deviceId);
    expect(revokedRows[1]?.input_summary).toContain("ada-pc");
    expectNoValue(await everything());
  });

  it("a revoked install loses its wrapped copies: the desktop's revoke of Bob's PC drops its blob from the active grant, the service refuses to serve it, and the next proposal does not target it", async () => {
    const bobLaptop = await install(h.seed.bob.id, "bob-laptop");
    const { grant } = await propose();
    const card = await bobCard();
    await bobPhone.post(
      `/requests/${card.id}/answer`,
      { version: card.version, answer: "approve" },
      { biometric: true },
    );
    expect(await resolverFor(bobPc, h.seed.bobAgent.id).get(NAME)).toBe(value);
    expect(await resolverFor(bobLaptop, h.seed.bobAgent.id).get(NAME)).toBe(value);
    // Settings -> Devices -> Revoke on Bob's other PC: the daemon calls this route.
    const revoked = await h.admin.post(
      `/devices/${bobPc.device.id}/revoke`,
      {},
      { headers: { "x-forerunner-install": "bob-laptop" } },
    );
    expect(revoked.status).toBe(200);
    const row = await h.store.secretGrant.mustGet(grant.id);
    expect(row.status).toBe("active");
    expect(row.blobs.map((b) => b.device_id)).toEqual([bobLaptop.device.id]);
    // Nothing for the revoked install, even over the wire; the laptop's copy still works.
    const served = await h.admin.get(
      `/secrets/shared/blob?name=${NAME}&agentId=${h.seed.bobAgent.id}&deviceId=${bobPc.device.id}`,
      { headers: { "x-forerunner-install": "bob-pc" } },
    );
    expect(served.status).toBe(403);
    expect((await json(served)).code).toBe("secret_not_granted");
    expect(await resolverFor(bobPc, h.seed.bobAgent.id).get(NAME)).toBeNull();
    expect(await resolverFor(bobLaptop, h.seed.bobAgent.id).get(NAME)).toBe(value);
    const dropped = await h.store.auditLog.list({ tool: SHARED_SECRET_AUDIT.blobsDropped });
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({ human_id: h.seed.bob.id, allowed: true });
    expect(dropped[0]?.input_summary).toContain(bobPc.device.id);
    expect(dropped[0]?.input_summary).toContain("bob-laptop");
    // The owner re-shares: the revoked PC is no wrap target, and a blob made for it is refused.
    const again = await propose("laptop only");
    expect(again.targets.map((t) => t.deviceId)).toEqual([bobLaptop.device.id]);
    const stale = await h.admin.post("/secrets/shared", {
      ownerHumanId: h.seed.ada.id,
      name: NAME,
      agentIds: [h.seed.bobAgent.id],
      blobs: [
        {
          agentId: h.seed.bobAgent.id,
          deviceId: bobPc.device.id,
          blob: wrapSecret(value, bobPc.key.publicKey, {
            name: NAME,
            ownerHumanId: h.seed.ada.id,
            agentId: h.seed.bobAgent.id,
            deviceId: bobPc.device.id,
          }),
        },
      ],
    });
    expect(stale.status).toBe(400);
    // Revoking it again drops nothing more and is still 200.
    await h.clock.advance(1_000);
    expect((await h.admin.post(`/devices/${bobPc.device.id}/revoke`, {})).status).toBe(200);
    expect(await h.store.auditLog.list({ tool: SHARED_SECRET_AUDIT.blobsDropped })).toHaveLength(1);
    expectNoValue(await everything());
  });

  it("two-profile round trip over HTTP: Ada proposes, Bob approves, Bob's install unwraps with its own key and nothing but ciphertext crossed the service", async () => {
    const { grant } = await propose();
    const card = await bobCard();
    await bobPhone.post(
      `/requests/${card.id}/answer`,
      { version: card.version, answer: "approve" },
      { biometric: true },
    );
    const bobResolver = resolverFor(bobPc, h.seed.bobAgent.id);
    expect(await bobResolver.get(NAME)).toBe(value);
    // A second Bob install registered later has no wrapped copy: the owner re-shares for it.
    const bobLaptop = await install(h.seed.bob.id, "bob-laptop");
    expect(await resolverFor(bobLaptop, h.seed.bobAgent.id).get(NAME)).toBeNull();
    const again = await propose("laptop too");
    expect(again.targets.map((t) => t.deviceId).sort()).toEqual(
      [bobPc.device.id, bobLaptop.device.id].sort(),
    );
    const card2 = await bobCard();
    await bobPhone.post(
      `/requests/${card2.id}/answer`,
      { version: card2.version, answer: "approve" },
      { biometric: true },
    );
    expect(await resolverFor(bobLaptop, h.seed.bobAgent.id).get(NAME)).toBe(value);
    expect((await h.store.secretGrant.mustGet(grant.id)).status).toBe("active");
    expectNoValue(await everything());
    // The bodies the service produced hold ciphertext fields and ids, never the value.
    expect(bodies.some((b) => b.includes('"ciphertext"'))).toBe(true);
  });
});
