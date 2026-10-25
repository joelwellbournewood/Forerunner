import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import {
  ensureInstallWrapKey,
  INSTALL_WRAP_KEY_NAME,
  MemoryVault,
  valueEncodings,
} from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { registerDesktopDevice } from "../src/remote/index.ts";
import {
  applySharedGrantAnswer,
  proposeSharedSecret,
  SHARED_SECRET_AUDIT,
  SharedSecretVault,
  StoreSharedSecretService,
} from "../src/secrets/index.ts";

/**
 * The daemon side of shared secrets (spec S.13, ADR 0065): at compose the install's wrapping
 * key is created in its vault and registered on its `desktop` device row; the daemon's
 * `/secrets/shared` routes let the owner propose, list and revoke; the active grants' names
 * join every session grant; and a peer install on the same shared state resolves the value
 * by reference while this install's vault keeps the only clear copy.
 */
const NAME = "org_deploy_token";
const REGISTRY = join(process.cwd(), "evals", "registry");
let rt: RuntimeApp;
let app: ReturnType<typeof createDaemonApp>["app"];
let token: string;
let clock: SimulatedClock;
let home: string;
let value: string;
let vault: MemoryVault;

function freshValue(prefix = "v-"): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

async function api(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  clock = new SimulatedClock("2026-10-23T09:00:00Z");
  home = mkdtempSync(join(tmpdir(), "fr-shared-secrets-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  vault = new MemoryVault();
  value = freshValue("deploy-");
  await vault.set(NAME, value);
  rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs,
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "shared.sqlite")}`,
    vault,
    registryDir: REGISTRY,
    identity: { humanName: "Ada", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    startServices: false,
    remote: { enabled: true, deviceName: "ada-pc" },
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
  ({ app, token } = createDaemonApp(rt));
}, 120_000);
afterAll(async () => {
  await rt?.close();
});

describe("shared secrets in the daemon", () => {
  it("creates the install wrapping key in the vault and registers it on the desktop device row", async () => {
    const device = rt.remote.device;
    expect(device).not.toBeNull();
    const key = await ensureInstallWrapKey(vault);
    expect(device?.wrap_public_key).toBe(key.publicKey);
    expect((await rt.store.device.mustGet(device?.id as string)).wrap_public_key).toBe(
      key.publicKey,
    );
    expect(await vault.list()).toContain(INSTALL_WRAP_KEY_NAME);
    expect(rt.sharedSecrets.vault.bound).toBe(true);
    // A second registration keeps the row and the key.
    const again = await registerDesktopDevice({
      store: rt.store,
      dirs: rt.dirs,
      humanId: rt.human.id,
      name: "ada-pc",
      platform: "linux",
      wrapPublicKey: key.publicKey,
    });
    expect(again.id).toBe(device?.id);
    expect(again.wrap_public_key).toBe(key.publicKey);
  });

  it("the owner proposes through the daemon route, the peer's human approves, the peer install resolves by reference, the names join the session grant, and a revoke ends it", async () => {
    // Bob and his agent on another install, sharing the same state (seeded as that install would).
    const bob = await rt.store.human.insert({ name: "Bob", email: "bob@example.test" });
    const bobby = await rt.store.agent.insert({ name: "Bobby", owner_human_id: bob.id });
    const bobVault = new MemoryVault();
    const bobKey = await ensureInstallWrapKey(bobVault);
    const bobPc = await registerDesktopDevice({
      store: rt.store,
      dirs: appDirs({ env: { FORERUNNER_HOME: mkdtempSync(join(tmpdir(), "fr-bob-")) } }),
      humanId: bob.id,
      name: "bob-pc",
      platform: "linux",
      wrapPublicKey: bobKey.publicKey,
    });

    // Nothing shared yet: the session grant carries only the local names.
    expect(await rt.sharedSecrets.names()).toEqual([]);

    const proposed = await api("POST", "/secrets/shared", {
      name: NAME,
      agentIds: [bobby.id],
      why: "deploys",
    });
    expect(proposed.status).toBe(201);
    const body = (await proposed.json()) as {
      grant: { id: string; status: string; blobCount: number; requiredHumanIds: string[] };
      requestIds: string[];
      targets: { deviceId: string }[];
    };
    expect(body.grant).toMatchObject({
      status: "pending",
      blobCount: 1,
      requiredHumanIds: [bob.id],
    });
    expect(body.targets.map((t) => t.deviceId)).toEqual([bobPc.id]);
    expect(JSON.stringify(body)).not.toContain(value);

    const listed = (await (await api("GET", "/secrets/shared")).json()) as {
      grants: { id: string; status: string }[];
    };
    expect(listed.grants.map((g) => [g.id, g.status])).toEqual([[body.grant.id, "pending"]]);

    // Bob approves (what the state service's answer route does inside its transaction).
    const [card] = await rt.store.humanRequest.open({ humanId: bob.id });
    expect(card?.risk).toBe("high");
    await rt.store.transaction(async (tx) => {
      const answered = await tx.humanRequest.answer(
        card?.id as string,
        card?.version as number,
        "approve",
        bob.id,
      );
      return applySharedGrantAnswer(tx, answered, bob.id, { clock });
    });
    expect((await rt.store.secretGrant.mustGet(body.grant.id)).status).toBe("active");

    // Bob's install resolves it by reference; Ada's own session grant does not list it
    // (Alice is not named), Bobby's does.
    const bobResolver = new SharedSecretVault({
      local: bobVault,
      source: new StoreSharedSecretService(rt.store, { clock, installId: bobPc.id }),
      agentId: bobby.id,
      install: { deviceId: bobPc.id, privateKey: () => bobKey.privateKey },
    });
    expect(await bobResolver.get(NAME)).toBe(value);
    expect(await bobVault.has(NAME)).toBe(false);
    expect(await rt.sharedSecrets.names()).toEqual([]);
    expect(await rt.store.secretGrant.activeNamesFor(bobby.id)).toEqual([NAME]);

    const revoked = await api("POST", `/secrets/shared/${body.grant.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { grant: { status: string } }).grant.status).toBe("revoked");
    expect(await bobResolver.get(NAME)).toBeNull();
    expect((await api("POST", "/secrets/shared/nope/revoke", {})).status).toBe(404);
    expect((await api("POST", "/secrets/shared", { name: "Bad Name", agentIds: [] })).status).toBe(
      400,
    );

    // The audit trail names the secret and the installs, never the value.
    const rows = await rt.store.auditLog.list();
    const tools = rows.map((r) => r.tool);
    for (const t of [
      SHARED_SECRET_AUDIT.proposed,
      SHARED_SECRET_AUDIT.approved,
      SHARED_SECRET_AUDIT.activated,
      SHARED_SECRET_AUDIT.served,
      SHARED_SECRET_AUDIT.revoked,
    ]) {
      expect(tools, t).toContain(t);
    }
    const text = JSON.stringify([
      rows,
      await rt.store.secretGrant.list(),
      await rt.store.humanRequest.list(),
    ]);
    for (const enc of valueEncodings(value)) expect(text).not.toContain(enc);
  });

  it("the other way round: Bob shares with Alice, Ada answers the card through the daemon's own answer route, and resolving through this install's vault writes `secret.shared_resolved` without the value", async () => {
    const bob = (await rt.store.human.list({ name: "Bob" } as never))[0];
    if (!bob) throw new Error("seed missing");
    const bobVault = new MemoryVault();
    const shared = freshValue("bob-");
    await bobVault.set("bob_token", shared);
    const bobService = new StoreSharedSecretService(rt.store, { clock, installId: "bob-pc" });
    const { grant, requestIds } = await proposeSharedSecret({
      vault: bobVault,
      service: bobService,
      ownerHumanId: bob.id,
      name: "bob_token",
      agentIds: [rt.agent.id],
      why: "Alice deploys too",
    });
    expect(grant).toMatchObject({ status: "pending", requiredHumanIds: [rt.human.id] });
    expect(await rt.sharedSecrets.names()).toEqual([]);
    // Ada answers in her desktop app: the daemon's route moves the grant in the same write.
    const card = await rt.store.humanRequest.mustGet(requestIds[0] as string);
    const answered = await api("POST", `/requests/${card.id}/answer`, {
      version: card.version,
      answer: "approve",
    });
    expect(answered.status).toBe(200);
    expect((await rt.store.secretGrant.mustGet(grant.id)).status).toBe("active");
    expect(await rt.sharedSecrets.names()).toEqual(["bob_token"]);
    expect(await rt.sharedSecrets.vault.get("bob_token")).toBe(shared);
    expect(await vault.has("bob_token")).toBe(false);
    // Ada's daemon lists the grant (she had to approve it) but cannot revoke it: Bob owns it.
    const listed = (await (await api("GET", "/secrets/shared")).json()) as {
      grants: { id: string }[];
    };
    expect(listed.grants.map((g) => g.id)).toContain(grant.id);
    const notOwner = await api("POST", `/secrets/shared/${grant.id}/revoke`, {});
    expect(notOwner.status).toBe(403);
    expect(((await notOwner.json()) as { code: string }).code).toBe("tool_not_allowed");
    expect((await rt.store.secretGrant.mustGet(grant.id)).status).toBe("active");
    expect(await rt.store.secretGrant.activeNamesFor(rt.agent.id)).toEqual(["bob_token"]);
    const rows = await rt.store.auditLog.list({ tool: SHARED_SECRET_AUDIT.resolved });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ human_id: rt.human.id, agent_id: rt.agent.id, allowed: true });
    expect(rows[0]?.input_summary).toContain("bob_token");
    const approved = await rt.store.auditLog.list({ tool: SHARED_SECRET_AUDIT.approved });
    expect(approved.at(-1)?.input_summary).toContain(rt.remote.device?.id as string);
    const store = await openStore({ url: `sqlite:${join(home, "shared.sqlite")}`, clock });
    try {
      const text = JSON.stringify([await store.auditLog.list(), await store.secretGrant.list()]);
      for (const enc of valueEncodings(shared)) expect(text).not.toContain(enc);
    } finally {
      await store.close();
    }
  });
});
