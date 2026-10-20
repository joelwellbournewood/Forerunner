import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, isForerunnerError, join } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseFeedEnv,
  parseTrustedKeysEnv,
  readUpdateConfig,
  updateConfigPath,
} from "../src/update/config.ts";
import { GitHubReleasesFeed, JsonFeed, MemoryReleaseFeed } from "../src/update/feed.ts";
import { canonicalJson, type ReleaseManifest, SignedManifest } from "../src/update/manifest.ts";
import {
  compareSemver,
  isNewerVersion,
  parseSemver,
  sortVersionsDesc,
} from "../src/update/semver.ts";
import {
  buildReleaseManifest,
  generateSigningKeyPair,
  hashFileSync,
  privateKeyFrom,
  signManifest,
  signManifestWithSecret,
} from "../src/update/sign.ts";
import { keyIdOf, publicKeyFrom, ReleaseVerifier, refusalReason } from "../src/update/verify.ts";
import { buildRelease, FakeReleaseServer, testKey } from "./update-helpers.ts";

function manifestOf(version: string, over: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schema: 1,
    version,
    channel: "stable",
    publishedAt: "2026-10-20T10:00:00.000Z",
    notes: `Release ${version}`,
    minSchema: 1,
    artifacts: [
      {
        platform: "linux-x64",
        name: `forerunner-${version}-linux-x64.zip`,
        url: "http://127.0.0.1:1/x.zip",
        sha256: "a".repeat(64),
        size: 10,
      },
    ],
    ...over,
  };
}

describe("semver", () => {
  it("parses, orders and detects newer versions", () => {
    expect(parseSemver("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("01.2.3")).toBeNull();
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.10.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.10")).toBe(-1);
    expect(compareSemver("1.0.0-beta", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
    expect(compareSemver("1.0.0-1", "1.0.0-a")).toBe(-1);
    expect(isNewerVersion("1.1.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(sortVersionsDesc(["1.0.0", "2.0.0", "1.5.0-rc.1", "1.5.0"], (v) => v)).toEqual([
      "2.0.0",
      "1.5.0",
      "1.5.0-rc.1",
      "1.0.0",
    ]);
    expect(() => compareSemver("nope", "1.0.0")).toThrow(/semantic version/);
  });
});

describe("manifest canonical form", () => {
  it("sorts keys at every level, drops undefined and ignores formatting", () => {
    const a = canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: "x" }, u: undefined });
    const b = canonicalJson({ a: { c: "x", d: [3, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });
});

describe("signing and verification (Ed25519, node:crypto)", () => {
  const key = testKey();
  const verifier = new ReleaseVerifier([{ id: key.keyId, publicKey: key.publicKey }]);

  it("round-trips a signed manifest through a trusted key", () => {
    const signed = signManifest(manifestOf("1.2.0"), key.privateKey);
    expect(signed.signature?.alg).toBe("ed25519");
    expect(signed.signature?.keyId).toBe(key.keyId);
    const r = verifier.verifyManifest(JSON.parse(JSON.stringify(signed)));
    expect(r.manifest.version).toBe("1.2.0");
    expect(r.keyId).toBe(key.keyId);
    // key ids derive from the raw public key and accept PEM or base64 keys
    const { raw, key: pub } = publicKeyFrom(key.publicKey);
    expect(keyIdOf(raw)).toBe(key.keyId);
    const pem = pub.export({ format: "pem", type: "spki" }).toString();
    expect(new ReleaseVerifier([{ publicKey: pem }]).trustedKeyIds).toEqual([key.keyId]);
  });

  it("refuses unsigned, untrusted-key, tampered and malformed manifests with a named reason", () => {
    const unsigned = { manifest: manifestOf("1.2.0") };
    expect(refusalReason(catchErr(() => verifier.verifyManifest(unsigned)))).toBe("unsigned");

    const other = generateSigningKeyPair();
    const wrongKey = signManifest(manifestOf("1.2.0"), other.privateKey);
    expect(refusalReason(catchErr(() => verifier.verifyManifest(wrongKey)))).toBe("untrusted_key");

    // same key id claimed, signature made by another key
    const forged = signManifest(manifestOf("1.2.0"), other.privateKey, { keyId: key.keyId });
    expect(refusalReason(catchErr(() => verifier.verifyManifest(forged)))).toBe("bad_signature");

    const tampered = signManifest(manifestOf("1.2.0"), key.privateKey);
    tampered.manifest.artifacts[0] = {
      ...(tampered.manifest.artifacts[0] as ReleaseManifest["artifacts"][number]),
      sha256: "b".repeat(64),
    };
    expect(refusalReason(catchErr(() => verifier.verifyManifest(tampered)))).toBe("bad_signature");

    const notesChanged = signManifest(manifestOf("1.2.0"), key.privateKey);
    notesChanged.manifest.notes = "now with a free upgrade";
    expect(refusalReason(catchErr(() => verifier.verifyManifest(notesChanged)))).toBe(
      "bad_signature",
    );

    expect(
      refusalReason(catchErr(() => verifier.verifyManifest({ manifest: { version: 1 } }))),
    ).toBe("malformed");
    expect(
      refusalReason(
        catchErr(() =>
          verifier.verifyManifest({
            ...signManifest(manifestOf("1.2.0"), key.privateKey),
            signature: { alg: "ed25519", keyId: key.keyId, signature: "AAAA" },
          }),
        ),
      ),
    ).toBe("bad_signature");
  });

  it("refuses downgrades unless allowed, and releases needing a newer schema", () => {
    expect(
      refusalReason(catchErr(() => verifier.assertNotDowngrade("0.9.0", "1.0.0", false))),
    ).toBe("downgrade");
    expect(() => verifier.assertNotDowngrade("0.9.0", "1.0.0", true)).not.toThrow();
    expect(refusalReason(catchErr(() => verifier.assertNotDowngrade("1.0.0", "1.0.0", true)))).toBe(
      "already_installed",
    );
    expect(() => verifier.assertNotDowngrade("1.0.1", "1.0.0", false)).not.toThrow();
    expect(
      refusalReason(
        catchErr(() => verifier.assertSchemaCompatible(manifestOf("2.0.0", { minSchema: 3 }), 1)),
      ),
    ).toBe("schema_too_old");
    expect(() =>
      verifier.assertSchemaCompatible(manifestOf("2.0.0", { minSchema: 1 }), 1),
    ).not.toThrow();
    expect(
      refusalReason(
        catchErr(() =>
          verifier.assertArtifactMatches(
            manifestOf("1.0.0").artifacts[0] as ReleaseManifest["artifacts"][number],
            10,
            "b".repeat(64),
          ),
        ),
      ),
    ).toBe("tampered");
  });

  it("signs with a key held by secret reference and never echoes the key", async () => {
    const vault = new MemoryVault();
    await vault.set("update_signing_key", key.privateKey);
    const signed = await signManifestWithSecret(
      manifestOf("1.3.0"),
      "secret:update_signing_key",
      vault,
    );
    expect(verifier.verifyManifest(signed).manifest.version).toBe("1.3.0");
    expect(JSON.stringify(signed)).not.toContain(key.privateKey);
    const missing = await signManifestWithSecret(manifestOf("1.3.0"), "secret:nope", vault).catch(
      (e: unknown) => e,
    );
    expect(isForerunnerError(missing, "secret_not_granted")).toBe(true);
    const bad = catchErr(() => privateKeyFrom("bm90LWEta2V5"));
    expect(isForerunnerError(bad, "validation")).toBe(true);
    expect(String((bad as Error).message)).not.toContain("bm90LWEta2V5");
    // a PEM private key is accepted too
    const pem = privateKeyFrom(key.privateKey)
      .key.export({ format: "pem", type: "pkcs8" })
      .toString();
    expect(signManifest(manifestOf("1.3.0"), pem).signature?.keyId).toBe(key.keyId);
  });

  it("validates the schema of trusted keys", () => {
    expect(() => new ReleaseVerifier([{ publicKey: "AAAA" }])).toThrow(/32 raw bytes/);
  });

  it("buildReleaseManifest hashes the built files and refuses duplicates, empty sets and bad fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-build-manifest-"));
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7); // longer than one read buffer
    writeFileSync(join(dir, "forerunner-1.4.0-linux-x64.zip"), bytes);
    writeFileSync(join(dir, "forerunner-1.4.0.apk"), "apk");
    expect(hashFileSync(join(dir, "forerunner-1.4.0-linux-x64.zip"))).toEqual({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    });
    const m = buildReleaseManifest({
      version: "v1.4.0",
      channel: "beta",
      publishedAt: "2026-10-20T10:00:00.000Z",
      notes: "beta notes",
      minSchema: 2,
      artifacts: [
        {
          platform: "linux-x64",
          file: join(dir, "forerunner-1.4.0-linux-x64.zip"),
          url: "https://example.invalid/d/forerunner-1.4.0-linux-x64.zip",
        },
        {
          platform: "android",
          file: join(dir, "forerunner-1.4.0.apk"),
          url: "https://example.invalid/d/forerunner-1.4.0.apk",
          name: "app.apk",
        },
      ],
    });
    expect(m.version).toBe("1.4.0");
    expect(m.artifacts.map((a) => [a.platform, a.name, a.size])).toEqual([
      ["linux-x64", "forerunner-1.4.0-linux-x64.zip", bytes.length],
      ["android", "app.apk", 3],
    ]);
    // the signed manifest is accepted by the verifier as any other
    expect(verifier.verifyManifest(signManifest(m, key.privateKey)).manifest.minSchema).toBe(2);
    const base = {
      version: "1.4.0",
      channel: "stable" as const,
      publishedAt: "2026-10-20T10:00:00.000Z",
      notes: "",
      minSchema: 1,
    };
    const one = {
      platform: "android" as const,
      file: join(dir, "forerunner-1.4.0.apk"),
      url: "https://example.invalid/d/forerunner-1.4.0.apk",
    };
    expect(() => buildReleaseManifest({ ...base, artifacts: [] })).toThrow(/at least one/);
    expect(() => buildReleaseManifest({ ...base, artifacts: [one, one] })).toThrow(
      /two artefacts for platform android/,
    );
    expect(() => buildReleaseManifest({ ...base, version: "1.4", artifacts: [one] })).toThrow(
      /semantic version/,
    );
    expect(() => buildReleaseManifest({ ...base, artifacts: [{ ...one, url: "nope" }] })).toThrow(
      /url/i,
    );
    expect(() =>
      buildReleaseManifest({ ...base, artifacts: [{ ...one, file: join(dir, "missing.apk") }] }),
    ).toThrow(/ENOENT|no such file/i);
  });
});

describe("release feeds over a fake server on 127.0.0.1", () => {
  const server = new FakeReleaseServer();
  beforeAll(async () => {
    await server.start();
    buildRelease(server, { version: "1.1.0", notes: "one point one" });
    buildRelease(server, { version: "1.2.0", notes: "one point two" });
    buildRelease(server, { version: "1.3.0-beta.1", channel: "beta", prerelease: true });
    buildRelease(server, { version: "9.9.9", draft: true });
    buildRelease(server, { version: "1.0.5", key: null });
    server.add({
      tag: "v1.2.1",
      signed: { manifest: manifestOf("1.2.1") },
      assets: new Map(),
      draft: false,
      prerelease: false,
      rawManifest: "{not json",
    });
  });
  afterAll(() => server.stop());

  it("GitHubReleasesFeed lists manifests by channel, newest first, skipping drafts and unreadable ones", async () => {
    const feed = new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: server.url });
    const stable = await feed.list("stable");
    expect(stable.map((r) => r.manifest.version)).toEqual(["1.2.0", "1.1.0", "1.0.5"]);
    expect((await feed.latest("stable"))?.manifest.version).toBe("1.2.0");
    expect((await feed.latest("beta"))?.manifest.version).toBe("1.3.0-beta.1");
    // unsigned documents are returned as-is; trust is the verifier's job
    const unsigned = stable.find((r) => r.manifest.version === "1.0.5");
    expect(unsigned?.signature).toBeUndefined();
    expect(server.requests).toContain("/repos/owner/repo/releases");
    expect(feed.releasesUrl).toBe(`${server.url}/repos/owner/repo/releases?per_page=30`);
  });

  it("JsonFeed reads a releases.json document", async () => {
    const feed = new JsonFeed({ url: `${server.url}/releases.json` });
    expect((await feed.list("stable")).map((r) => r.manifest.version)).toEqual([
      "1.2.0",
      "1.1.0",
      "1.0.5",
    ]);
    expect((await feed.latest("beta"))?.manifest.version).toBe("1.3.0-beta.1");
    const bad = new JsonFeed({ url: `${server.url}/repos/owner/repo/releases` });
    const e = await bad.list("stable").catch((err: unknown) => err);
    expect(isForerunnerError(e, "validation")).toBe(true);
  });

  it("reports an unreachable or failing feed as unavailable", async () => {
    const feed = new JsonFeed({ url: "http://127.0.0.1:9/releases.json" });
    const e = await feed.list("stable").catch((err: unknown) => err);
    expect(isForerunnerError(e, "unavailable")).toBe(true);
    server.status = 503;
    try {
      const gh = new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: server.url });
      const e2 = await gh.list("stable").catch((err: unknown) => err);
      expect(isForerunnerError(e2, "unavailable")).toBe(true);
    } finally {
      server.status = 200;
    }
  });

  it("MemoryReleaseFeed sorts and filters like the others", async () => {
    const feed = new MemoryReleaseFeed([
      { manifest: manifestOf("1.0.0") },
      { manifest: manifestOf("2.0.0") },
      { manifest: manifestOf("1.5.0", { channel: "beta" }) },
    ]);
    expect((await feed.list("stable")).map((r) => r.manifest.version)).toEqual(["2.0.0", "1.0.0"]);
    expect(SignedManifest.safeParse((await feed.latest("beta")) ?? {}).success).toBe(true);
  });
});

describe("update configuration", () => {
  it("reads update.json and applies FORERUNNER_UPDATE_* overrides; owner/repo are never hardcoded", () => {
    const home = mkdtempSync(join(tmpdir(), "fr-update-cfg-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    expect(readUpdateConfig(dirs, {})).toMatchObject({
      channel: "stable",
      feed: null,
      trustedKeys: [],
      allowDowngrade: false,
    });
    const key = testKey();
    writeFileSync(
      updateConfigPath(dirs),
      JSON.stringify({
        channel: "beta",
        feed: { kind: "github", owner: "someone", repo: "forerunner" },
        trustedKeys: [{ publicKey: key.publicKey }],
        healthTimeoutMs: 5000,
      }),
    );
    const cfg = readUpdateConfig(dirs, {});
    expect(cfg.channel).toBe("beta");
    expect(cfg.feed).toEqual({ kind: "github", owner: "someone", repo: "forerunner" });
    expect(cfg.healthTimeoutMs).toBe(5000);
    const over = readUpdateConfig(dirs, {
      FORERUNNER_UPDATE_CHANNEL: "stable",
      FORERUNNER_UPDATE_FEED: "https://example.invalid/releases.json",
      FORERUNNER_UPDATE_TRUSTED_KEYS: `${key.keyId}=${key.publicKey}`,
      FORERUNNER_UPDATE_ALLOW_DOWNGRADE: "true",
      FORERUNNER_UPDATE_HEALTH_TIMEOUT_MS: "1234",
    });
    expect(over.channel).toBe("stable");
    expect(over.feed).toEqual({ kind: "json", url: "https://example.invalid/releases.json" });
    expect(over.trustedKeys).toEqual([{ id: key.keyId, publicKey: key.publicKey }]);
    expect(over.allowDowngrade).toBe(true);
    expect(over.healthTimeoutMs).toBe(1234);
    expect(parseFeedEnv("github:o/r", "http://127.0.0.1:1")).toEqual({
      kind: "github",
      owner: "o",
      repo: "r",
      apiBase: "http://127.0.0.1:1",
    });
    expect(() => parseFeedEnv("ftp://x")).toThrow(/github:<owner>/);
    expect(parseTrustedKeysEnv(`${key.publicKey}, ${key.publicKey}`)).toHaveLength(2);
    writeFileSync(updateConfigPath(dirs), "{oops");
    expect(() => readUpdateConfig(dirs, {})).toThrow(/not valid JSON/);
    writeFileSync(updateConfigPath(dirs), JSON.stringify({ channel: "nightly" }));
    expect(() => readUpdateConfig(dirs, {})).toThrow(/channel/);
  });
});

function catchErr(fn: () => unknown): unknown {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}
