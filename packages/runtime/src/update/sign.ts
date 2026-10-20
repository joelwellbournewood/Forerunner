import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { basename, ForerunnerError } from "@forerunner/platform";
import { parseSecretRef, type Vault } from "@forerunner/vault";
import {
  type ArtifactPlatform,
  MANIFEST_SCHEMA_VERSION,
  type ManifestSignature,
  manifestBytes,
  type ReleaseArtifact,
  ReleaseManifest,
  type SignedManifest,
  type UpdateChannel,
} from "./manifest.ts";
import { ED25519_PUBLIC_KEY_BYTES, keyIdOf } from "./verify.ts";

/**
 * The signer the release workflow uses (the matching half of verify.ts). The private key is a
 * secret: it reaches this module as a vault reference (`secret:update_signing_key`) or as a
 * value already resolved by the caller, and it is never logged or echoed. Key material is
 * handled as base64 of the 32-byte Ed25519 seed (what `generateSigningKeyPair` prints) or as
 * a PEM PKCS#8 key.
 */
/** DER prefix of an Ed25519 PKCS#8 PrivateKeyInfo (RFC 8410) before the 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SEED_BYTES = 32;

export interface SigningKeyPair {
  keyId: string;
  /** Base64 of the raw public key; this goes into update.trustedKeys. */
  publicKey: string;
  /** Base64 of the 32-byte seed; this goes into the vault / CI secret, never into git. */
  privateKey: string;
}

function rawPublicOf(key: KeyObject): Buffer {
  const pub = key.type === "public" ? key : createPublicKey(key);
  const spki = pub.export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - ED25519_PUBLIC_KEY_BYTES));
}

export function generateSigningKeyPair(): SigningKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  const rawPublic = rawPublicOf(publicKey);
  const seed = Buffer.from(pkcs8.subarray(pkcs8.length - ED25519_SEED_BYTES));
  return {
    keyId: keyIdOf(rawPublic),
    publicKey: rawPublic.toString("base64"),
    privateKey: seed.toString("base64"),
  };
}

/** Accepts base64 of the 32-byte seed or a PEM PKCS#8 key. Errors never include the input. */
export function privateKeyFrom(text: string): { key: KeyObject; publicKeyRaw: Buffer } {
  const trimmed = text.trim();
  let key: KeyObject;
  try {
    if (trimmed.startsWith("-----BEGIN")) {
      key = createPrivateKey({ key: trimmed, format: "pem" });
    } else {
      const seed = Buffer.from(trimmed, "base64");
      if (seed.length !== ED25519_SEED_BYTES)
        throw new ForerunnerError("validation", "signing key must be a 32-byte seed or PEM");
      key = createPrivateKey({
        key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
        format: "der",
        type: "pkcs8",
      });
    }
  } catch (e) {
    if (e instanceof ForerunnerError) throw e;
    // The cause is dropped on purpose: OpenSSL errors can echo key bytes.
    throw new ForerunnerError("validation", "signing key could not be read");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw new ForerunnerError("validation", "signing key is not an Ed25519 key");
  return { key, publicKeyRaw: rawPublicOf(key) };
}

export interface SignOptions {
  /** Overrides the derived key id (must then match the trusted key's configured id). */
  keyId?: string;
}

/** Sign a manifest with a private key value (base64 seed or PEM). */
export function signManifest(
  manifest: ReleaseManifest,
  privateKey: string,
  opts: SignOptions = {},
): SignedManifest {
  const checked = ReleaseManifest.parse(manifest);
  const { key, publicKeyRaw } = privateKeyFrom(privateKey);
  const sig = cryptoSign(null, manifestBytes(checked), key);
  const signature: ManifestSignature = {
    alg: "ed25519",
    keyId: opts.keyId ?? keyIdOf(publicKeyRaw),
    signature: Buffer.from(sig).toString("base64"),
  };
  return { manifest: checked, signature };
}

/** SHA-256 and size of a file, streamed in 1 MiB reads so release artefacts never sit in memory. */
export function hashFileSync(file: string): { sha256: string; size: number } {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let size = 0;
  const fd = openSync(file, "r");
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      size += n;
    }
  } finally {
    closeSync(fd);
  }
  return { sha256: hash.digest("hex"), size };
}

export interface ManifestArtifactInput {
  platform: ArtifactPlatform;
  /** Local path of the built artefact; its basename becomes the artefact name unless `name` is set. */
  file: string;
  /** Where the installer will download it from (the Release asset URL). */
  url: string;
  name?: string;
}

export interface BuildManifestInput {
  version: string;
  channel: UpdateChannel;
  /** ISO-8601 UTC. */
  publishedAt: string;
  notes: string;
  minSchema: number;
  artifacts: ManifestArtifactInput[];
}

/**
 * The release workflow's first step: an unsigned manifest whose artefact hashes and sizes are
 * computed from the built files on disk (never typed by hand). Validated by the zod schema.
 */
export function buildReleaseManifest(input: BuildManifestInput): ReleaseManifest {
  if (input.artifacts.length === 0)
    throw new ForerunnerError("validation", "a release manifest needs at least one artefact");
  const seen = new Set<ArtifactPlatform>();
  const artifacts: ReleaseArtifact[] = input.artifacts.map((a) => {
    if (seen.has(a.platform))
      throw new ForerunnerError("validation", `two artefacts for platform ${a.platform}`);
    seen.add(a.platform);
    const { sha256, size } = hashFileSync(a.file);
    return { platform: a.platform, name: a.name ?? basename(a.file), url: a.url, sha256, size };
  });
  const parsed = ReleaseManifest.safeParse({
    schema: MANIFEST_SCHEMA_VERSION,
    version: input.version.replace(/^v/, ""),
    channel: input.channel,
    publishedAt: input.publishedAt,
    notes: input.notes,
    minSchema: input.minSchema,
    artifacts,
  });
  if (!parsed.success) {
    throw new ForerunnerError(
      "validation",
      `release manifest: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/**
 * Sign with a key held in the vault by reference ("secret:<name>"). The value is read, used
 * and dropped; nothing about it is returned or logged.
 */
export async function signManifestWithSecret(
  manifest: ReleaseManifest,
  secretRef: string,
  vault: Pick<Vault, "get">,
  opts: SignOptions = {},
): Promise<SignedManifest> {
  const name = parseSecretRef(secretRef);
  const value = await vault.get(name);
  if (!value) {
    throw new ForerunnerError("secret_not_granted", `signing key ${name} is not in the vault`, {
      details: { name },
    });
  }
  return signManifest(manifest, value, opts);
}
