import { z } from "zod";
import { isSemver } from "./semver.ts";

/**
 * The release manifest: what a signed release says about itself. The feed (GitHub Releases or
 * a releases.json) carries one `SignedManifest` per release; the signature is Ed25519 over the
 * canonical JSON of `manifest` (sorted keys, no whitespace), so any change to the version, the
 * notes, an artefact hash or the minimum schema version invalidates it.
 */
export const UPDATE_CHANNELS = ["stable", "beta"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const ARTIFACT_PLATFORMS = ["windows-x64", "linux-x64", "android"] as const;
export type ArtifactPlatform = (typeof ARTIFACT_PLATFORMS)[number];

export const MANIFEST_SCHEMA_VERSION = 1;

export const ReleaseArtifact = z.object({
  platform: z.enum(ARTIFACT_PLATFORMS),
  /** File name of the artefact (for example forerunner-1.2.0-linux-x64.zip). */
  name: z.string().min(1).max(200),
  url: z.url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters"),
  size: z.number().int().nonnegative(),
});
export type ReleaseArtifact = z.infer<typeof ReleaseArtifact>;

export const ReleaseManifest = z.object({
  schema: z.literal(MANIFEST_SCHEMA_VERSION),
  version: z.string().refine(isSemver, "version must be a semantic version"),
  channel: z.enum(UPDATE_CHANNELS),
  /** ISO-8601 UTC. */
  publishedAt: z.string().min(1),
  /** Changelog / release notes, Markdown. */
  notes: z.string(),
  /** Lowest state-schema version (schema_migrations) this release can start from. */
  minSchema: z.number().int().nonnegative(),
  artifacts: z.array(ReleaseArtifact).min(1),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

export const ManifestSignature = z.object({
  alg: z.literal("ed25519"),
  /** Identifies the trusted key: sha256 of the raw public key, first 16 hex characters. */
  keyId: z.string().min(1),
  /** Base64 of the 64-byte Ed25519 signature over canonicalJson(manifest). */
  signature: z.string().min(1),
});
export type ManifestSignature = z.infer<typeof ManifestSignature>;

export const SignedManifest = z.object({
  manifest: ReleaseManifest,
  signature: ManifestSignature.optional(),
});
export type SignedManifest = z.infer<typeof SignedManifest>;

/** The releases.json feed document (JsonFeed). */
export const ReleasesDocument = z.object({
  schema: z.literal(MANIFEST_SCHEMA_VERSION),
  releases: z.array(SignedManifest),
});
export type ReleasesDocument = z.infer<typeof ReleasesDocument>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (value === undefined) return "null";
    if (typeof value === "number" && !Number.isFinite(value)) return "null";
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

/** Deterministic JSON: keys sorted at every level, no whitespace, undefined dropped. */
export function canonicalJson(value: unknown): string {
  return canonical(value);
}

/** The bytes a release signature covers. */
export function manifestBytes(manifest: ReleaseManifest): Buffer {
  return Buffer.from(canonicalJson(manifest), "utf8");
}

/** The artefact of a manifest for one platform, if the release ships one. */
export function artifactFor(
  manifest: ReleaseManifest,
  platform: ArtifactPlatform,
): ReleaseArtifact | undefined {
  return manifest.artifacts.find((a) => a.platform === platform);
}

/** Artefact kind by file extension; only zip artefacts are unpacked by the staged install. */
export type ArtifactKind = "zip" | "msi" | "appimage" | "deb" | "apk" | "other";

export function artifactKind(name: string): ArtifactKind {
  const lower = name.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".msi")) return "msi";
  if (lower.endsWith(".appimage")) return "appimage";
  if (lower.endsWith(".deb")) return "deb";
  if (lower.endsWith(".apk")) return "apk";
  return "other";
}
