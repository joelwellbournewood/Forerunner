import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import {
  MemoryVault,
  runnerKeySecretName,
  UNLOCK_CARD_KIND,
  UNLOCK_HKDF_INFO_PREFIX,
  UNLOCK_PROTOCOL_VERSION,
} from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunnerKeyStatusView, RunnerUnlockAnswerView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { RUNNER_UNLOCK_WRAP_AUDIT_TOOL } from "../src/secrets/runner-unlock-routes.ts";

/**
 * The daemon's side of the cloud runner unlock (spec S.12, ADR 0068): the desktop inbox's card
 * asks the daemon, which holds the vault, whether it has the runner's key and to wrap it to a
 * challenge. The key never appears in a response, a log-bearing audit row or an error; the
 * answer unwraps (runner side, node:crypto here) to exactly the stored key.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const RUNNER = "runner-eu";
let rt: RuntimeApp;
let app: ReturnType<typeof createDaemonApp>["app"];
let token: string;
let clock: SimulatedClock;
let vault: MemoryVault;
const key = randomBytes(32);

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

/** A challenge as the runner files it, with the private half kept for the unwrap. */
function challenge(runnerId = RUNNER, ttlMs = 60_000) {
  const pair = generateKeyPairSync("x25519");
  const raw = pair.publicKey.export({ format: "der", type: "spki" }).subarray(SPKI.length);
  const nonce = randomBytes(32);
  const card = {
    kind: UNLOCK_CARD_KIND,
    version: UNLOCK_PROTOCOL_VERSION,
    runnerId,
    challengeId: randomUUID(),
    runnerPublicKey: Buffer.from(raw).toString("base64"),
    nonce: nonce.toString("base64"),
    expiresAt: new Date(clock.now() + ttlMs).toISOString(),
  };
  return { card, privateKey: pair.privateKey, nonce };
}

function unwrap(
  c: ReturnType<typeof challenge>,
  answer: RunnerUnlockAnswerView,
  privateKey: KeyObject = c.privateKey,
): Buffer {
  const device = createPublicKey({
    key: Buffer.concat([SPKI, Buffer.from(answer.devicePublicKey, "base64")]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey, publicKey: device });
  const wrap = Buffer.from(
    hkdfSync("sha256", shared, c.nonce, `${UNLOCK_HKDF_INFO_PREFIX}${c.card.challengeId}`, 32),
  );
  const d = createDecipheriv("aes-256-gcm", wrap, Buffer.from(answer.iv, "base64"));
  d.setAAD(Buffer.from(`${c.card.runnerId}:${c.card.challengeId}`));
  d.setAuthTag(Buffer.from(answer.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(answer.ciphertext, "base64")), d.final()]);
}

const encodings = (b: Buffer) => [b.toString("base64"), b.toString("hex"), b.toString("base64url")];

beforeAll(async () => {
  clock = new SimulatedClock("2026-10-23T09:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-runner-unlock-"));
  vault = new MemoryVault();
  await vault.set(runnerKeySecretName(RUNNER), key.toString("base64"));
  rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault,
    registryDir: REGISTRY,
    identity: { humanName: "Ada", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    startServices: false,
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
  });
  ({ app, token } = createDaemonApp(rt));
}, 120_000);
afterAll(async () => {
  await rt?.close();
});

describe("daemon runner unlock routes", () => {
  it("reports whether the key is here without ever returning it", async () => {
    const here = RunnerKeyStatusView.parse(
      await (await api("GET", `/runner-unlock/${RUNNER}/key`)).json(),
    );
    expect(here).toEqual({ runnerId: RUNNER, available: true, backend: "memory", reason: null });
    const res = await api("GET", "/runner-unlock/other-runner/key");
    const text = await res.text();
    const missing = RunnerKeyStatusView.parse(JSON.parse(text));
    expect(missing.available).toBe(false);
    expect(missing.reason).toContain("cloud_runner_vault_key:other-runner");
    for (const enc of encodings(key)) expect(text).not.toContain(enc);
  });

  it("wraps the stored key to the challenge; the runner unwraps exactly that key; one audit row", async () => {
    const c = challenge();
    const until = new Date(clock.now() + 8 * 3_600_000).toISOString();
    const res = await api("POST", "/runner-unlock/wrap", { card: c.card, autoUnlockUntil: until });
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const enc of encodings(key)) expect(text).not.toContain(enc);
    const answer = RunnerUnlockAnswerView.parse(JSON.parse(text));
    expect(answer).toMatchObject({ challengeId: c.card.challengeId, autoUnlockUntil: until });
    expect(unwrap(c, answer).equals(key)).toBe(true);
    // Another runner key cannot unwrap it (the answer is bound to this challenge's key pair).
    expect(() => unwrap(c, answer, generateKeyPairSync("x25519").privateKey)).toThrow();

    const rows = await rt.store.auditLog.list({ humanId: rt.human.id });
    const wrapped = rows.filter((r) => r.tool === RUNNER_UNLOCK_WRAP_AUDIT_TOOL);
    expect(wrapped).toHaveLength(1);
    const all = rows.map((r) => `${r.input_summary} ${r.result_summary}`).join("\n");
    for (const enc of encodings(key)) expect(all).not.toContain(enc);
  });

  it("refuses a card that is not a challenge, an expired one, a bad window and a missing key", async () => {
    const bad = await api("POST", "/runner-unlock/wrap", { card: { kind: "other" } });
    expect(bad.status).toBe(400);
    const expired = challenge(RUNNER, -1);
    expect((await api("POST", "/runner-unlock/wrap", { card: expired.card })).status).toBe(400);
    const week = challenge();
    const far = new Date(clock.now() + 8 * 24 * 3_600_000).toISOString();
    const tooLong = await api("POST", "/runner-unlock/wrap", {
      card: week.card,
      autoUnlockUntil: far,
    });
    expect(tooLong.status).toBe(400);
    const elsewhere = challenge("runner-without-key");
    const missing = await api("POST", "/runner-unlock/wrap", { card: elsewhere.card });
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe("not_found");
  });

  it("clears the window when asked (null travels with the answer)", async () => {
    const c = challenge();
    const res = await api("POST", "/runner-unlock/wrap", { card: c.card, autoUnlockUntil: null });
    const answer = RunnerUnlockAnswerView.parse(await res.json());
    expect(answer.autoUnlockUntil).toBeNull();
    expect(unwrap(c, answer).equals(key)).toBe(true);
  });
});
