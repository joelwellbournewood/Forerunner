import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  UNLOCK_CARD_KIND,
  UNLOCK_HKDF_INFO_PREFIX,
  UNLOCK_OPTIONS,
  UNLOCK_PROTOCOL_VERSION,
  type UnlockAnswer,
} from "@forerunner/vault/runner-unlock";

/**
 * A cloud runner's side of the unlock for the UI tests (spec S.12, ADR 0033): a challenge as
 * `RunnerVaultUnlock.fileChallenge` files it, the request around it, and the runner's unwrap
 * (node:crypto, as in services/cloud-runner) so a test can prove the answer carries the key.
 */
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

export function runnerChallenge(runnerId = "runner-eu", ttlMs = 10 * 60_000, now = Date.now()) {
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
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  /** The runner's unwrap: throws for a tampered answer or one wrapped to another challenge. */
  const unwrap = (answer: UnlockAnswer): Buffer => {
    const device = createPublicKey({
      key: Buffer.concat([SPKI, Buffer.from(answer.devicePublicKey, "base64")]),
      format: "der",
      type: "spki",
    });
    const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: device });
    const wrap = Buffer.from(
      hkdfSync("sha256", shared, nonce, `${UNLOCK_HKDF_INFO_PREFIX}${card.challengeId}`, 32),
    );
    const d = createDecipheriv("aes-256-gcm", wrap, Buffer.from(answer.iv, "base64"));
    d.setAAD(Buffer.from(`${runnerId}:${card.challengeId}`));
    d.setAuthTag(Buffer.from(answer.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(answer.ciphertext, "base64")), d.final()]);
  };
  return { card, unwrap };
}

/** The request a runner start files (kind credential, high risk, blocking). */
export function unlockRequest(
  card: ReturnType<typeof runnerChallenge>["card"],
  overrides: {
    id?: string;
    projectId?: string | null;
    projectName?: string | null;
    now?: number;
  } = {},
) {
  return {
    id: overrides.id ?? `req_unlock_${card.challengeId.slice(0, 8)}`,
    projectId: overrides.projectId ?? null,
    projectName: overrides.projectName ?? null,
    taskId: null,
    sessionId: null,
    kind: "credential",
    why: `Cloud runner "${card.runnerId}" needs the vault key to start (runner start). The key is wrapped to a one-time runner key and never stored.`,
    steps: [
      "Confirm on a paired device (biometric on the phone).",
      `The challenge expires at ${card.expiresAt}.`,
    ],
    options: [...UNLOCK_OPTIONS],
    blocking: true,
    risk: "high" as const,
    changeCard: card,
    status: "open" as const,
    answer: null,
    createdAt: new Date((overrides.now ?? Date.now()) - 2 * 60_000).toISOString(),
    version: 1,
  };
}

/** Every encoding of a key a DOM, a call or a log could carry. */
export function keyEncodings(key: Uint8Array): string[] {
  const b = Buffer.from(key);
  return [b.toString("base64"), b.toString("base64url"), b.toString("hex"), [...b].join(",")];
}
