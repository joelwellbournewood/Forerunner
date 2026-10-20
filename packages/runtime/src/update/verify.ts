import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { ForerunnerError } from "@forerunner/platform";
import type { TrustedKey } from "./config.ts";
import {
  type ManifestSignature,
  manifestBytes,
  type ReleaseArtifact,
  type ReleaseManifest,
  SignedManifest,
} from "./manifest.ts";
import { compareSemver } from "./semver.ts";

/**
 * Trust decisions for releases, all in code: a release installs only when its manifest is
 * signed by a configured trusted key, every downloaded artefact matches the manifest's size
 * and SHA-256, the version is newer than the running one (unless a human allowed downgrades)
 * and the local state schema is one the release can start from. Each refusal is a
 * ForerunnerError("validation") whose details.reason names the cause so the UI and the tests
 * match on it.
 */
export type VerifyRefusal =
  | "unsigned"
  | "untrusted_key"
  | "bad_signature"
  | "malformed"
  | "tampered"
  | "downgrade"
  | "schema_too_old"
  | "already_installed"
  | "previously_rejected";

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410) before the 32 raw key bytes. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const ED25519_PUBLIC_KEY_BYTES = 32;

export function refusal(
  reason: VerifyRefusal,
  message: string,
  details: Record<string, unknown> = {},
) {
  return new ForerunnerError("validation", message, { details: { reason, ...details } });
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Key id: first 16 hex characters of sha256(raw public key). */
export function keyIdOf(rawPublicKey: Uint8Array): string {
  return sha256Hex(rawPublicKey).slice(0, 16);
}

/** Accepts base64 of the raw 32 bytes or a PEM SubjectPublicKeyInfo. */
export function publicKeyFrom(text: string): { key: KeyObject; raw: Buffer } {
  const trimmed = text.trim();
  let key: KeyObject;
  if (trimmed.startsWith("-----BEGIN")) {
    key = createPublicKey({ key: trimmed, format: "pem" });
  } else {
    const raw = Buffer.from(trimmed, "base64");
    if (raw.length !== ED25519_PUBLIC_KEY_BYTES) {
      throw new ForerunnerError("validation", "trusted key must be 32 raw bytes (base64) or PEM", {
        details: { bytes: raw.length },
      });
    }
    key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new ForerunnerError("validation", "trusted key is not an Ed25519 key", {
      details: { type: key.asymmetricKeyType ?? "unknown" },
    });
  }
  const der = key.export({ format: "der", type: "spki" });
  return { key, raw: Buffer.from(der.subarray(der.length - ED25519_PUBLIC_KEY_BYTES)) };
}

export interface ResolvedTrustedKey {
  id: string;
  key: KeyObject;
  rawBase64: string;
}

export function resolveTrustedKeys(keys: TrustedKey[]): Map<string, ResolvedTrustedKey> {
  const out = new Map<string, ResolvedTrustedKey>();
  for (const k of keys) {
    const { key, raw } = publicKeyFrom(k.publicKey);
    const id = k.id ?? keyIdOf(raw);
    out.set(id, { id, key, rawBase64: raw.toString("base64") });
  }
  return out;
}

export interface VerifyManifestResult {
  manifest: ReleaseManifest;
  keyId: string;
}

export class ReleaseVerifier {
  private readonly keys: Map<string, ResolvedTrustedKey>;

  constructor(trustedKeys: TrustedKey[]) {
    this.keys = resolveTrustedKeys(trustedKeys);
  }

  get trustedKeyIds(): string[] {
    return [...this.keys.keys()];
  }

  /** Parse an untrusted document and check its signature; returns the manifest or throws. */
  verifyManifest(input: unknown): VerifyManifestResult {
    const parsed = SignedManifest.safeParse(input);
    if (!parsed.success) {
      throw refusal(
        "malformed",
        `release manifest is malformed: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const { manifest, signature } = parsed.data;
    if (!signature) {
      throw refusal("unsigned", `release ${manifest.version} is not signed`, {
        version: manifest.version,
      });
    }
    return { manifest, keyId: this.checkSignature(manifest, signature) };
  }

  private checkSignature(manifest: ReleaseManifest, signature: ManifestSignature): string {
    const trusted = this.keys.get(signature.keyId);
    if (!trusted) {
      throw refusal(
        "untrusted_key",
        `release ${manifest.version} is signed by an unknown key ${signature.keyId}`,
        { version: manifest.version, keyId: signature.keyId },
      );
    }
    const sig = Buffer.from(signature.signature, "base64");
    let ok = false;
    try {
      ok = sig.length === 64 && cryptoVerify(null, manifestBytes(manifest), trusted.key, sig);
    } catch {
      ok = false;
    }
    if (!ok) {
      throw refusal(
        "bad_signature",
        `release ${manifest.version}: signature does not match the manifest (tampered or re-signed)`,
        { version: manifest.version, keyId: signature.keyId },
      );
    }
    return trusted.id;
  }

  /** Downgrades are refused unless a human turned allowDowngrade on; re-installs always. */
  assertNotDowngrade(candidate: string, current: string, allowDowngrade: boolean): void {
    const cmp = compareSemver(candidate, current);
    if (cmp === 0) {
      throw refusal("already_installed", `release ${candidate} is already installed`, {
        candidate,
        current,
      });
    }
    if (allowDowngrade) return;
    if (cmp < 0) {
      throw refusal(
        "downgrade",
        `release ${candidate} is older than the running ${current}; downgrades are off`,
        { candidate, current },
      );
    }
  }

  /** The local schema must be at least the release's minimum. */
  assertSchemaCompatible(manifest: ReleaseManifest, localSchemaVersion: number): void {
    if (localSchemaVersion < manifest.minSchema) {
      throw refusal(
        "schema_too_old",
        `release ${manifest.version} needs state schema >= ${manifest.minSchema}; this install is at ${localSchemaVersion}`,
        { version: manifest.version, minSchema: manifest.minSchema, localSchemaVersion },
      );
    }
  }

  /** Size and SHA-256 of a downloaded artefact must match the signed manifest. */
  assertArtifactMatches(artifact: ReleaseArtifact, size: number, sha256: string): void {
    if (size !== artifact.size || sha256 !== artifact.sha256) {
      throw refusal(
        "tampered",
        `artefact ${artifact.name} does not match the manifest (size ${size}/${artifact.size}, sha256 ${sha256.slice(0, 12)}…/${artifact.sha256.slice(0, 12)}…)`,
        { name: artifact.name, expectedSize: artifact.size, size },
      );
    }
  }
}

/** The reason of a refusal thrown by the verifier, or null for any other error. */
export function refusalReason(e: unknown): VerifyRefusal | null {
  if (e instanceof ForerunnerError && e.code === "validation") {
    const r = e.details.reason;
    if (typeof r === "string") return r as VerifyRefusal;
  }
  return null;
}
