import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, isForerunnerError, join, sep } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUpdateCli } from "../src/update/cli.ts";
import { GitHubReleasesFeed, MemoryReleaseFeed } from "../src/update/feed.ts";
import { StaticHealthProbe } from "../src/update/health.ts";
import {
  assertSafeZipEntry,
  detectArtifactPlatform,
  UpdateManager,
  unpackZip,
} from "../src/update/install.ts";
import {
  installLockPath,
  isPidAlive,
  readInstallLock,
  withInstallLock,
} from "../src/update/lock.ts";
import { ReleaseManifest } from "../src/update/manifest.ts";
import {
  type CurrentPointer,
  cleanStalePointerTemps,
  hasVersionDir,
  POINTER_STATES,
  pointerPath,
  readPointer,
  versionDir,
  versionsRoot,
  writePointer,
} from "../src/update/pointer.ts";
import { FakeUpdateHumanPort, HumanRequestUpdatePort } from "../src/update/ports.ts";
import { isReleaseVersion } from "../src/update/semver.ts";
import { generateSigningKeyPair, signManifest } from "../src/update/sign.ts";
import { ReleaseVerifier, refusalReason, sha256Hex } from "../src/update/verify.ts";
import {
  BootingRestarter,
  buildRelease,
  FakeReleaseServer,
  type Harness,
  makeHarness,
  makeZip,
  protectedHashes,
  rawZip,
  signRaw,
  testKey,
} from "./update-helpers.ts";

const server = new FakeReleaseServer();
let feed: GitHubReleasesFeed;

beforeAll(async () => {
  await server.start();
  feed = new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: server.url });
});
afterAll(() => server.stop());

async function harness(over: Parameters<typeof makeHarness>[0] = {}): Promise<Harness> {
  return makeHarness({ feed, ...over });
}

function walkForSymlinks(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.push(p);
    else if (st.isDirectory()) out.push(...walkForSymlinks(p));
  }
  return out;
}

describe("staged install", () => {
  let h: Harness;
  beforeAll(async () => {
    buildRelease(server, {
      version: "1.1.0",
      notes: "## 1.1.0\n- better",
      files: {
        "app/VERSION": "1.1.0",
        "app/bin/forerunner": "#!/bin/sh\necho hi\n",
        "app/lib/a.txt": "a",
      },
    });
    buildRelease(server, { version: "1.0.5", notes: "older" });
    h = await harness();
  });
  afterAll(() => h.close());

  it("check() reports the newest verified release that is newer than the running one", async () => {
    const c = await h.manager.check();
    expect(c.runningVersion).toBe("1.0.0");
    expect(c.available?.version).toBe("1.1.0");
    expect(c.rejected).toEqual([]);
    const audit = await h.store.auditLog.list({ tool: "update.check" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.result_summary).toContain("1.1.0");
  });

  it("apply() downloads, verifies, unpacks under data/versions/<version>, records the row, writes the pointer and restarts", async () => {
    const before = protectedHashes(h.dirs);
    const r = await h.manager.apply({ by: { kind: "human", id: "human-j" } });
    expect(r.version).toBe("1.1.0");
    expect(r.previous).toBe("1.0.0");
    expect(r.staged.dir).toBe(join(versionsRoot(h.dirs), "1.1.0"));
    expect(r.staged.dir.startsWith(join(h.dirs.data, "versions"))).toBe(true);
    expect(r.staged.unpackedFiles).toBe(3);
    expect(readFileSync(join(r.staged.dir, "app", "VERSION"), "utf8")).toBe("1.1.0");
    expect(readFileSync(join(r.staged.dir, "app", "lib", "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(r.staged.dir, "release.json"))).toBe(true);
    expect(existsSync(join(r.staged.dir, "download"))).toBe(false);
    // no staging directory left behind
    expect(readdirSync(versionsRoot(h.dirs)).filter((n) => n.startsWith("."))).toEqual([]);
    // pointer
    const p = readPointer(h.dirs);
    expect(p).toMatchObject({ current: "1.1.0", previous: "1.0.0", state: "pending_health_check" });
    // release row
    expect(r.release.status).toBe("published");
    expect(r.release.changelog).toContain("better");
    expect(r.release.signature).toContain(testKey().keyId);
    // audit and restart
    const audit = await h.store.auditLog.list({ tool: "update.apply" });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.allowed).toBe(true);
    expect(audit[0]?.human_id).toBe("human-j");
    expect(h.restarter.requests).toEqual([
      { reason: "update", targetVersion: "1.1.0", fromVersion: "1.0.0" },
    ]);
    expect(h.running.version).toBe("1.1.0");
    expect(h.manager.runningVersion).toBe("1.1.0");
    // config, memory and data (outside versions/) untouched
    expect(protectedHashes(h.dirs)).toEqual(before);
    // Windows path neutrality: no symlinks anywhere in the install tree
    expect(walkForSymlinks(versionsRoot(h.dirs))).toEqual([]);
  });

  it("the health check passing marks the pointer installed and the release row installed", async () => {
    const o = await h.manager.healthCheck();
    expect(o).toMatchObject({ kind: "healthy", version: "1.1.0" });
    expect(h.probe.calls.map((c) => c.version)).toEqual(["1.1.0"]);
    expect(readPointer(h.dirs)?.state).toBe("installed");
    const row = await h.store.release.latest("stable");
    expect(row?.status).toBe("installed");
    expect(row?.health).toMatchObject({ ok: true, probe: "static" });
    // a second start does nothing
    expect((await h.manager.healthCheck()).kind).toBe("not_pending");
    expect(h.probe.calls).toHaveLength(1);
  });

  it("status() names versions on disk and the trusted keys; prune() keeps current and previous", async () => {
    const s = h.manager.status();
    expect(s.versionsOnDisk).toEqual(["1.1.0"]);
    expect(s.trustedKeyIds).toEqual([testKey().keyId]);
    expect(s.pointer?.current).toBe("1.1.0");
    expect(h.manager.prune()).toEqual([]);
  });

  it("refuses an explicit downgrade without the flag and allows it with the flag", async () => {
    const e = await h.manager
      .apply({ by: { kind: "human", id: "human-j" }, version: "1.0.5" })
      .catch((err: unknown) => err);
    expect(refusalReason(e)).toBe("downgrade");
    const denied = await h.store.auditLog.list({ tool: "update.apply", allowed: false });
    expect(denied.at(-1)?.denied_reason).toBe("downgrade");
    const h2 = await harness({ allowDowngrade: true, runningVersion: "1.1.0" });
    try {
      const r = await h2.manager.apply({ by: { kind: "human", id: "human-j" }, version: "1.0.5" });
      expect(r.version).toBe("1.0.5");
      expect(readPointer(h2.dirs)).toMatchObject({ current: "1.0.5", previous: "1.1.0" });
    } finally {
      await h2.close();
    }
  });

  it("a release not on the channel is not found; no update when up to date", async () => {
    const e = await h.manager
      .apply({ by: { kind: "human", id: "human-j" }, version: "7.7.7" })
      .catch((err: unknown) => err);
    expect(isForerunnerError(e, "not_found")).toBe(true);
    const h2 = await harness({ runningVersion: "1.1.0" });
    try {
      expect((await h2.manager.check()).available).toBeNull();
      const e2 = await h2.manager
        .apply({ by: { kind: "human", id: "human-j" } })
        .catch((err: unknown) => err);
      expect(isForerunnerError(e2, "not_found")).toBe(true);
    } finally {
      await h2.close();
    }
  });
});

describe("trust refusals on the wire", () => {
  it("rejects unsigned, wrong-key and tampered manifests and falls through to the next verified release", async () => {
    const s = new FakeReleaseServer();
    await s.start();
    try {
      const other = generateSigningKeyPair();
      buildRelease(s, { version: "2.0.0", key: null });
      buildRelease(s, { version: "1.9.0", key: other });
      buildRelease(s, {
        version: "1.8.0",
        mutate: (m) => {
          m.notes = "edited after signing";
        },
      });
      buildRelease(s, { version: "1.7.0", minSchema: 5 });
      buildRelease(s, { version: "1.6.0" });
      const h = await harness({
        feed: new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: s.url }),
      });
      try {
        const c = await h.manager.check();
        expect(c.available?.version).toBe("1.6.0");
        expect(c.rejected.map((r) => [r.version, r.reason])).toEqual([
          ["2.0.0", "unsigned"],
          ["1.9.0", "untrusted_key"],
          ["1.8.0", "bad_signature"],
          ["1.7.0", "schema_too_old"],
        ]);
        for (const v of ["2.0.0", "1.9.0", "1.8.0", "1.7.0"]) {
          const e = await h.manager
            .apply({ by: { kind: "human", id: "j" }, version: v })
            .catch((err: unknown) => err);
          expect(isForerunnerError(e, "validation")).toBe(true);
          expect(existsSync(join(versionsRoot(h.dirs), v))).toBe(false);
        }
        expect(readPointer(h.dirs)).toBeNull();
        // trust is checked before a human is asked: an agent's request for a refused release
        // never becomes an approval item in the inbox
        const agentErr = await h.manager
          .apply({ by: { kind: "agent", id: "alice" }, version: "2.0.0" })
          .catch((err: unknown) => err);
        expect(refusalReason(agentErr)).toBe("unsigned");
        expect(h.human.asks).toEqual([]);
        const denied = await h.store.auditLog.list({ tool: "update.apply", allowed: false });
        expect(denied.at(-1)).toMatchObject({ agent_id: "alice", denied_reason: "unsigned" });
      } finally {
        await h.close();
      }
    } finally {
      await s.stop();
    }
  });

  it("refuses an artefact whose bytes differ from the signed hash, or exceed the signed size, leaving nothing behind", async () => {
    const s = new FakeReleaseServer();
    await s.start();
    try {
      const rel = buildRelease(s, { version: "1.4.0", files: { "app/VERSION": "1.4.0" } });
      const name = [...rel.assets.keys()].find((n) => n.includes("linux-x64")) as string;
      const h = await harness({
        feed: new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: s.url }),
      });
      try {
        const before = protectedHashes(h.dirs);
        // same length, different bytes
        const evil = makeZip({ "app/VERSION": "6.6.6" });
        s.overrides.set(
          `${rel.tag}/${name}`,
          Buffer.concat([evil]).subarray(0, (rel.assets.get(name) as Buffer).length),
        );
        let e = await h.manager
          .apply({ by: { kind: "human", id: "j" } })
          .catch((err: unknown) => err);
        expect(refusalReason(e)).toBe("tampered");
        // too many bytes
        s.overrides.set(
          `${rel.tag}/${name}`,
          Buffer.concat([rel.assets.get(name) as Buffer, Buffer.from("extra")]),
        );
        e = await h.manager.apply({ by: { kind: "human", id: "j" } }).catch((err: unknown) => err);
        expect(refusalReason(e)).toBe("tampered");
        expect(existsSync(join(versionsRoot(h.dirs), "1.4.0"))).toBe(false);
        expect(
          (existsSync(versionsRoot(h.dirs)) ? readdirSync(versionsRoot(h.dirs)) : []).filter((n) =>
            n.startsWith("."),
          ),
        ).toEqual([]);
        expect(readPointer(h.dirs)).toBeNull();
        expect(h.restarter.requests).toEqual([]);
        expect(protectedHashes(h.dirs)).toEqual(before);
        const denied = await h.store.auditLog.list({ tool: "update.apply", allowed: false });
        expect(denied).toHaveLength(2);
        // honest bytes install
        s.overrides.clear();
        const r = await h.manager.apply({ by: { kind: "human", id: "j" } });
        expect(readFileSync(join(r.staged.dir, "app", "VERSION"), "utf8")).toBe("1.4.0");
      } finally {
        await h.close();
      }
    } finally {
      await s.stop();
    }
  });

  it("refuses zip-slip and symlink entries and absolute or drive-letter names", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-zip-"));
    const slip = rawZip([{ name: "../../evil.txt", data: Buffer.from("x") }]);
    writeFileSync(join(dir, "slip.zip"), slip);
    expect(() => unpackZip(join(dir, "slip.zip"), join(dir, "out"))).toThrow(/parent directory/);
    expect(existsSync(join(dir, "evil.txt"))).toBe(false);
    const link = rawZip([
      { name: "app/link", data: Buffer.from("/etc/passwd"), unixMode: 0o120777 },
    ]);
    writeFileSync(join(dir, "link.zip"), link);
    expect(() => unpackZip(join(dir, "link.zip"), join(dir, "out2"))).toThrow(/symlink/);
    expect(() => assertSafeZipEntry("/abs/path", 0)).toThrow(/absolute/);
    expect(() => assertSafeZipEntry("C:/x", 0)).toThrow(/drive letter/);
    expect(() => assertSafeZipEntry("a\\..\\b", 0)).toThrow(/backslash/);
    expect(() => assertSafeZipEntry("a/./b", 0)).not.toThrow();
    const good = rawZip([
      { name: "app/ok.txt", data: Buffer.from("ok") },
      { name: "app/sub/", data: Buffer.alloc(0) },
    ]);
    writeFileSync(join(dir, "good.zip"), good);
    expect(unpackZip(join(dir, "good.zip"), join(dir, "out3"))).toBe(1);
    expect(readFileSync(join(dir, "out3", "app", "ok.txt"), "utf8")).toBe("ok");
    expect(walkForSymlinks(join(dir, "out3"))).toEqual([]);
    // the same protection applies through apply()
    const s = new FakeReleaseServer();
    await s.start();
    try {
      buildRelease(s, { version: "1.5.0", zip: slip });
      const h = await harness({
        feed: new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: s.url }),
      });
      try {
        const e = await h.manager
          .apply({ by: { kind: "human", id: "j" } })
          .catch((err: unknown) => err);
        expect(isForerunnerError(e, "path_not_allowed")).toBe(true);
        expect(existsSync(join(h.dirs.data, "evil.txt"))).toBe(false);
        expect(existsSync(join(versionsRoot(h.dirs), "1.5.0"))).toBe(false);
      } finally {
        await h.close();
      }
    } finally {
      await s.stop();
    }
  });
});

describe("humans and agents", () => {
  it("an agent-initiated update needs a human's approval; denied or pending is refused and audited", async () => {
    buildRelease(server, { version: "1.2.0" });
    const h = await harness();
    try {
      h.human.setOutcome("pending");
      let e = await h.manager
        .apply({ by: { kind: "agent", id: "alice" } })
        .catch((err: unknown) => err);
      expect(isForerunnerError(e, "approval_required")).toBe(true);
      h.human.setOutcome("denied");
      e = await h.manager
        .apply({ by: { kind: "agent", id: "alice" } })
        .catch((err: unknown) => err);
      expect(isForerunnerError(e, "approval_required")).toBe(true);
      expect(h.human.asks).toHaveLength(2);
      expect(h.human.asks[0]).toMatchObject({ kind: "approval", risk: "high", blocking: true });
      expect(readPointer(h.dirs)).toBeNull();
      expect(h.restarter.requests).toEqual([]);
      const denied = await h.store.auditLog.list({ tool: "update.apply", allowed: false });
      expect(denied.map((d) => d.denied_reason)).toEqual(["pending", "denied"]);
      expect(denied[0]?.agent_id).toBe("alice");
      h.human.setOutcome("approved");
      const r = await h.manager.apply({ by: { kind: "agent", id: "alice" } });
      expect(r.version).toBe("1.2.0");
      expect(r.release.author_agent).toBe("alice");
    } finally {
      await h.close();
    }
  });
});

describe("health check and automatic rollback", () => {
  it("a failing health check rolls back to the previous version, records the row, tells the human and restarts", async () => {
    const h = await harness({
      probe: new StaticHealthProbe({ ok: false, detail: "daemon answered 500" }),
    });
    try {
      await h.manager.apply({ by: { kind: "human", id: "human-j" } });
      const before = protectedHashes(h.dirs);
      const o = await h.manager.healthCheck();
      expect(o).toEqual({
        kind: "rolled_back",
        from: "1.2.0",
        to: "1.0.0",
        reason: "daemon answered 500",
      });
      // the packaged 1.0.0 has no directory under versions/: the pointer says so (current null)
      const p = readPointer(h.dirs);
      expect(p).toMatchObject({ current: null, previous: null, state: "installed" });
      expect(h.manager.installedVersion()).toBe("1.0.0");
      expect(p?.lastRollback).toMatchObject({
        from: "1.2.0",
        to: "1.0.0",
        reason: "daemon answered 500",
        automatic: true,
      });
      const row = await h.store.release.latest("stable");
      expect(row?.release_version).toBe("1.2.0");
      expect(row?.status).toBe("rolled_back");
      expect(row?.health).toMatchObject({ ok: false, detail: "daemon answered 500" });
      expect(h.human.notifications).toHaveLength(1);
      expect(h.human.notifications[0]).toMatchObject({
        severity: "error",
        title: "Update 1.2.0 rolled back",
      });
      expect(h.human.notifications[0]?.body).toContain("daemon answered 500");
      expect(h.restarter.requests.at(-1)).toEqual({
        reason: "rollback",
        targetVersion: "1.0.0",
        fromVersion: "1.2.0",
      });
      const audit = await h.store.auditLog.list({ tool: "update.rollback" });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.input_summary).toContain("automatic");
      expect(protectedHashes(h.dirs)).toEqual(before);
      // the broken version cannot be re-applied; a new release has to be cut
      const e = await h.manager
        .apply({ by: { kind: "human", id: "human-j" }, version: "1.2.0" })
        .catch((err: unknown) => err);
      expect(isForerunnerError(e, "validation") && e.details.reason).toBe("previously_rejected");
      // prune drops the rolled-back directory
      expect(h.manager.prune()).toEqual(["1.2.0"]);
    } finally {
      await h.close();
    }
  });

  it("a rollback on one install refuses the release on every install sharing the state store, and the refusal says so", async () => {
    // Alice's install rolls 1.2.0 back. Bob's install (its own home, the same store, as two
    // updaters over one shared state) never ran it, yet the shared release row refuses it for
    // him too: the message must name the shared state, not "this install".
    const alice = await harness({
      probe: new StaticHealthProbe({ ok: false, detail: "daemon answered 500" }),
    });
    const bobHome = mkdtempSync(join(tmpdir(), "fr-update-bob-"));
    const bobDirs = appDirs({ env: { FORERUNNER_HOME: bobHome } });
    for (const d of Object.values(bobDirs)) mkdirSync(d, { recursive: true });
    const bobRunning = { version: "1.0.0" };
    const bobHuman = new FakeUpdateHumanPort("approved");
    const bobRestarter = new BootingRestarter(bobRunning);
    const bob = new UpdateManager({
      ...alice.deps,
      dirs: bobDirs,
      human: bobHuman,
      restarter: bobRestarter,
      probe: new StaticHealthProbe({ ok: true, detail: "fake daemon healthy" }),
      runningVersion: () => bobRunning.version,
      humanId: "human-b",
    });
    const byBob = { kind: "human" as const, id: "human-b" };
    try {
      await alice.manager.apply({ by: { kind: "human", id: "human-j" } });
      expect((await alice.manager.healthCheck()).kind).toBe("rolled_back");
      expect((await alice.store.release.latest("stable"))?.status).toBe("rolled_back");
      expect(readPointer(bobDirs)).toBeNull();

      // Bob's next check lists 1.2.0 as previously rejected and falls through to 1.1.0.
      const check = await bob.check(byBob, { fresh: true });
      expect(check.available?.version).toBe("1.1.0");
      expect(check.rejected).toEqual([
        {
          version: "1.2.0",
          reason: "previously_rejected",
          message:
            "release 1.2.0 was rolled back on an install sharing this state; cut a new release",
        },
      ]);
      expect(check.rejected[0]?.message).not.toContain("this install");

      // An explicit apply is refused with the same words and audited as denied.
      const e = await bob.apply({ by: byBob, version: "1.2.0" }).catch((err: unknown) => err);
      expect(isForerunnerError(e, "validation") && e.details.reason).toBe("previously_rejected");
      expect(isForerunnerError(e) && e.message).toBe(
        "release 1.2.0 was rolled back on an install sharing this state; cut a new release",
      );
      const denied = await alice.store.auditLog.list({ tool: "update.apply", allowed: false });
      expect(denied).toHaveLength(1);
      expect(denied[0]).toMatchObject({
        tool: "update.apply",
        allowed: false,
        denied_reason: "previously_rejected",
        input_summary: "install 1.2.0",
        human_id: "human-b",
        agent_id: null,
      });
      expect(denied[0]?.result_summary).toContain("on an install sharing this state");
      expect(denied[0]?.result_summary).not.toContain("this install");

      // Bob's install is untouched: nothing staged, no pointer, nobody asked, no restart.
      expect(readPointer(bobDirs)).toBeNull();
      expect(bob.status().versionsOnDisk).toEqual([]);
      expect(bobHuman.asks).toHaveLength(0);
      expect(bobRestarter.requests).toHaveLength(0);
      expect(bobRunning.version).toBe("1.0.0");
    } finally {
      await alice.close();
    }
  });

  it("a health probe that never answers times out on the simulated clock and rolls back", async () => {
    const probe = new StaticHealthProbe(() => new Promise(() => undefined));
    const h = await harness({ probe, healthTimeoutMs: 30_000 });
    try {
      await h.manager.apply({ by: { kind: "human", id: "human-j" } });
      const pending = h.manager.healthCheck();
      await h.clock.advance(29_999);
      await h.clock.advance(1);
      const o = await pending;
      expect(o.kind).toBe("rolled_back");
      if (o.kind === "rolled_back") expect(o.reason).toMatch(/timed out after 30000 ms/);
      expect(probe.calls[0]?.signal.aborted).toBe(true);
      expect(readPointer(h.dirs)?.lastRollback?.to).toBe("1.0.0");
      expect(h.manager.installedVersion()).toBe("1.0.0");
    } finally {
      await h.close();
    }
  });

  it("the staged version not starting at all (running version mismatch) is a failure too", async () => {
    const h = await harness();
    try {
      h.restarter.boots = false; // the new build crashes on start; the shell relaunches the old one
      await h.manager.apply({ by: { kind: "human", id: "human-j" } });
      expect(h.running.version).toBe("1.0.0");
      const o = await h.manager.healthCheck();
      expect(o.kind).toBe("rolled_back");
      if (o.kind === "rolled_back")
        expect(o.reason).toMatch(/running version 1.0.0 is not the staged 1.2.0/);
      expect(h.probe.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("with no previous version the release is marked failed and the human is told", async () => {
    const h = await harness({
      probe: new StaticHealthProbe({ ok: false, detail: "boom" }),
      runningVersion: "1.2.0",
    });
    try {
      writePointer(h.dirs, {
        schema: 1,
        current: "1.2.0",
        previous: null,
        state: "pending_health_check",
        updatedAt: "2026-10-20T12:00:00.000Z",
        lastRollback: null,
      });
      await h.store.release.insert({
        release_version: "1.2.0",
        channel: "stable",
        status: "published",
      });
      const o = await h.manager.healthCheck();
      expect(o).toEqual({ kind: "failed_no_previous", version: "1.2.0", reason: "boom" });
      expect(readPointer(h.dirs)?.state).toBe("failed");
      expect((await h.store.release.latest("stable"))?.status).toBe("failed");
      expect(h.human.notifications[0]?.severity).toBe("error");
      expect(h.restarter.requests).toEqual([]);
    } finally {
      await h.close();
    }
  });
});

describe("manual rollback", () => {
  it("swaps current and previous, marks the row rolled back, notifies and restarts; nothing when no previous", async () => {
    const h = await harness();
    try {
      const e = await h.manager
        .rollback({ by: { kind: "human", id: "human-j" } })
        .catch((err: unknown) => err);
      expect(isForerunnerError(e, "not_found")).toBe(true);
      await h.manager.apply({ by: { kind: "human", id: "human-j" } });
      await h.manager.healthCheck();
      const before = protectedHashes(h.dirs);
      const r = await h.manager.rollback({
        by: { kind: "human", id: "human-j" },
        reason: "voice is broken",
      });
      expect(r).toMatchObject({ from: "1.2.0", to: "1.0.0" });
      expect(readPointer(h.dirs)).toMatchObject({
        current: null, // the packaged build runs again
        previous: null,
        state: "installed",
      });
      expect(h.manager.installedVersion()).toBe("1.0.0");
      expect(readPointer(h.dirs)?.lastRollback).toMatchObject({
        automatic: false,
        reason: "voice is broken",
      });
      expect((await h.store.release.latest("stable"))?.status).toBe("rolled_back");
      expect(h.human.notifications.at(-1)?.severity).toBe("warning");
      expect(h.restarter.requests.at(-1)).toEqual({
        reason: "rollback",
        targetVersion: "1.0.0",
        fromVersion: "1.2.0",
      });
      expect(protectedHashes(h.dirs)).toEqual(before);
      // an agent needs approval for a rollback as well
      const h2 = await harness();
      try {
        await h2.manager.apply({ by: { kind: "human", id: "human-j" } });
        h2.human.setOutcome("denied");
        const e2 = await h2.manager
          .rollback({ by: { kind: "agent", id: "bob" } })
          .catch((err: unknown) => err);
        expect(isForerunnerError(e2, "approval_required")).toBe(true);
        expect(readPointer(h2.dirs)?.current).toBe("1.2.0");
      } finally {
        await h2.close();
      }
    } finally {
      await h.close();
    }
  });
});

describe("pointer file", () => {
  const pointer = (over: Partial<CurrentPointer> = {}): CurrentPointer => ({
    schema: 1,
    current: "1.0.0",
    previous: null,
    state: "installed",
    updatedAt: "2026-10-20T12:00:00.000Z",
    lastRollback: null,
    ...over,
  });

  it("survives a crash between the temp write and the rename, and cleans the temp up later", async () => {
    const h = await harness();
    try {
      writePointer(h.dirs, pointer());
      const crash = () => {
        throw new Error("power cut");
      };
      expect(() =>
        writePointer(h.dirs, pointer({ current: "1.1.0", previous: "1.0.0" }), {
          beforeRename: crash,
        }),
      ).toThrow(/power cut/);
      // the old pointer is intact and readable; the temp file is a sibling, never a partial current.json
      expect(readPointer(h.dirs)).toMatchObject({ current: "1.0.0", previous: null });
      const temps = readdirSync(versionsRoot(h.dirs)).filter(
        (n) => n.startsWith("current.json.") && n.endsWith(".tmp"),
      );
      expect(temps).toHaveLength(1);
      expect(cleanStalePointerTemps(h.dirs)).toHaveLength(1);
      expect(readdirSync(versionsRoot(h.dirs)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      // a completed write replaces atomically
      writePointer(h.dirs, pointer({ current: "1.1.0", previous: "1.0.0" }));
      expect(readPointer(h.dirs)).toMatchObject({ current: "1.1.0", previous: "1.0.0" });
      expect(lstatSync(pointerPath(h.dirs)).isSymbolicLink()).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("refuses a corrupt pointer instead of guessing, and unsafe version names", async () => {
    const h = await harness();
    try {
      mkdirSync(versionsRoot(h.dirs), { recursive: true });
      writeFileSync(pointerPath(h.dirs), "{broken");
      expect(() => readPointer(h.dirs)).toThrow(/not valid JSON/);
      writeFileSync(pointerPath(h.dirs), JSON.stringify({ schema: 2 }));
      expect(() => readPointer(h.dirs)).toThrow(/unknown shape/);
      expect(() => versionDir(h.dirs, "../x")).toThrow(/safe directory name/);
      expect(() => versionDir(h.dirs, `1.0.0${sep}evil`)).toThrow(/safe directory name/);
      expect(versionDir(h.dirs, "1.2.3-beta.1")).toBe(join(versionsRoot(h.dirs), "1.2.3-beta.1"));
    } finally {
      await h.close();
    }
  });
});

describe("platform detection", () => {
  it("maps the OS and architecture to an artefact platform and refuses others", () => {
    expect(detectArtifactPlatform("windows", "x64")).toBe("windows-x64");
    expect(detectArtifactPlatform("linux", "x64")).toBe("linux-x64");
    expect(detectArtifactPlatform("android", "arm64")).toBe("android");
    expect(() => detectArtifactPlatform("macos", "arm64")).toThrow(/no release artefact/);
  });
});

describe("fr update CLI", () => {
  function program(h: Harness, lines: string[]) {
    const p = new Command();
    p.exitOverride();
    registerUpdateCli(p, {
      manager: async () => ({ manager: h.manager, close: async () => undefined }),
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
    });
    return (...args: string[]) => p.parseAsync(["node", "fr", "update", ...args]);
  }

  it("registers check, apply, rollback, status and health and drives the manager", async () => {
    const h = await harness();
    const lines: string[] = [];
    const fr = program(h, lines);
    try {
      await fr("check");
      expect(lines.join("\n")).toContain("Update available: 1.2.0");
      lines.length = 0;
      await fr("status", "--json");
      expect(JSON.parse(lines.join("\n"))).toMatchObject({
        runningVersion: "1.0.0",
        pointer: null,
      });
      lines.length = 0;
      await fr("apply");
      expect(lines.join("\n")).toContain("Staged 1.2.0");
      expect(readPointer(h.dirs)?.state).toBe("pending_health_check");
      lines.length = 0;
      await fr("health", "--json");
      expect(JSON.parse(lines.join("\n"))).toMatchObject({ kind: "healthy", version: "1.2.0" });
      lines.length = 0;
      await fr("rollback", "--reason", "cli test");
      expect(lines.join("\n")).toContain("Rolled back 1.2.0 -> 1.0.0");
      lines.length = 0;
      await fr("rollback");
      expect(lines.join("\n")).toMatch(/ERR error \[not_found\]/);
      process.exitCode = 0;
      const help = new Command();
      registerUpdateCli(help, {
        manager: async () => ({ manager: h.manager, close: async () => undefined }),
      });
      const names = help.commands.find((c) => c.name() === "update")?.commands.map((c) => c.name());
      expect(names).toEqual(
        expect.arrayContaining([
          "check",
          "apply",
          "rollback",
          "status",
          "health",
          "keygen",
          "sign",
        ]),
      );
    } finally {
      await h.close();
    }
  });

  it("keygen writes the private key to a file only; sign produces a manifest the verifier accepts", async () => {
    const h = await harness();
    const lines: string[] = [];
    const fr = program(h, lines);
    const dir = mkdtempSync(join(tmpdir(), "fr-keygen-"));
    try {
      const keyFile = join(dir, "release.key");
      await fr("keygen", "--out", keyFile);
      const printed = lines.join("\n");
      const privateKey = readFileSync(keyFile, "utf8").trim();
      expect(privateKey.length).toBeGreaterThan(30);
      expect(printed).not.toContain(privateKey);
      const publicKey = /Public key[^:]*: (\S+)/.exec(printed)?.[1] as string;
      const keyId = /Key id: (\S+)/.exec(printed)?.[1] as string;
      expect(publicKey).toBeTruthy();
      await fr("keygen", "--out", keyFile);
      expect(lines.at(-1)).toMatch(/refusing to overwrite/);
      process.exitCode = 0;
      const manifest = { ...buildRelease(server, { version: "3.0.0" }).signed.manifest };
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      lines.length = 0;
      await fr(
        "sign",
        "--manifest",
        join(dir, "manifest.json"),
        "--key-file",
        keyFile,
        "--out",
        join(dir, "signed.json"),
      );
      expect(lines.join("\n")).toContain(`Signed 3.0.0 with key ${keyId}`);
      const signed = JSON.parse(readFileSync(join(dir, "signed.json"), "utf8"));
      const verifier = new ReleaseVerifier([{ publicKey }]);
      expect(verifier.verifyManifest(signed).keyId).toBe(keyId);
      // and the same key signs identically through the library
      expect(signManifest(manifest, privateKey).signature?.keyId).toBe(keyId);
      // but not for a different trusted set
      expect(
        refusalReason(
          await Promise.resolve().then(() => {
            try {
              new ReleaseVerifier([{ publicKey: testKey().publicKey }]).verifyManifest(signed);
              return null;
            } catch (e) {
              return e;
            }
          }),
        ),
      ).toBe("untrusted_key");
      void MemoryReleaseFeed;
    } finally {
      await h.close();
    }
  });

  it("manifest computes hashes and sizes from the built artefacts; sign --key-secret reads the key from the vault by reference", async () => {
    const h = await harness();
    const lines: string[] = [];
    const vault = new MemoryVault();
    await vault.set("update_signing_key", testKey().privateKey);
    const p = new Command();
    p.exitOverride();
    registerUpdateCli(p, {
      manager: async () => ({ manager: h.manager, close: async () => undefined }),
      vault: async () => vault,
      out: (l) => lines.push(l),
      err: (l) => lines.push(`ERR ${l}`),
    });
    const fr = (...args: string[]) => p.parseAsync(["node", "fr", "update", ...args]);
    const dir = mkdtempSync(join(tmpdir(), "fr-manifest-"));
    try {
      const linux = makeZip({ "app/VERSION": "2.0.0" });
      const windows = makeZip({ "app/VERSION": "2.0.0", "app/forerunner.exe": "MZ" });
      writeFileSync(join(dir, "forerunner-2.0.0-linux-x64.zip"), linux);
      writeFileSync(join(dir, "forerunner-2.0.0-windows-x64.zip"), windows);
      writeFileSync(join(dir, "notes.md"), "## 2.0.0\n- two\n");
      await fr(
        "manifest",
        "--version",
        "v2.0.0",
        "--notes-file",
        join(dir, "notes.md"),
        "--min-schema",
        "1",
        "--base-url",
        "https://example.invalid/releases/download/v2.0.0/",
        "--artifact",
        `linux-x64:${join(dir, "forerunner-2.0.0-linux-x64.zip")}`,
        "--artifact",
        `windows-x64:${join(dir, "forerunner-2.0.0-windows-x64.zip")}`,
        "--published-at",
        "2026-10-20T10:00:00.000Z",
        "--out",
        join(dir, "manifest.json"),
      );
      expect(lines.join("\n")).toContain("Manifest for 2.0.0 (stable, 2 artefact(s))");
      const manifest = ReleaseManifest.parse(
        JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")),
      );
      expect(manifest.version).toBe("2.0.0");
      expect(manifest.notes).toBe("## 2.0.0\n- two\n");
      expect(manifest.artifacts).toEqual([
        {
          platform: "linux-x64",
          name: "forerunner-2.0.0-linux-x64.zip",
          url: "https://example.invalid/releases/download/v2.0.0/forerunner-2.0.0-linux-x64.zip",
          sha256: sha256Hex(linux),
          size: linux.length,
        },
        {
          platform: "windows-x64",
          name: "forerunner-2.0.0-windows-x64.zip",
          url: "https://example.invalid/releases/download/v2.0.0/forerunner-2.0.0-windows-x64.zip",
          sha256: sha256Hex(windows),
          size: windows.length,
        },
      ]);
      // bad specs are refused before anything is written
      lines.length = 0;
      await fr(
        "manifest",
        "--version",
        "2.0.1",
        "--notes-file",
        join(dir, "notes.md"),
        "--min-schema",
        "1",
        "--base-url",
        "https://example.invalid/d/",
        "--artifact",
        `macos-arm64:${join(dir, "forerunner-2.0.0-linux-x64.zip")}`,
        "--out",
        join(dir, "bad.json"),
      );
      expect(lines.at(-1)).toMatch(/ERR error \[validation\].*<platform>:<file>/);
      expect(existsSync(join(dir, "bad.json"))).toBe(false);
      process.exitCode = 0;
      // sign by secret reference: the key never appears in the output or the signed file
      lines.length = 0;
      await fr(
        "sign",
        "--manifest",
        join(dir, "manifest.json"),
        "--key-secret",
        "secret:update_signing_key",
        "--out",
        join(dir, "signed.json"),
      );
      expect(lines.join("\n")).toContain(`Signed 2.0.0 with key ${testKey().keyId}`);
      const signedText = readFileSync(join(dir, "signed.json"), "utf8");
      expect(signedText).not.toContain(testKey().privateKey);
      expect(lines.join("\n")).not.toContain(testKey().privateKey);
      expect(
        new ReleaseVerifier([{ publicKey: testKey().publicKey }]).verifyManifest(
          JSON.parse(signedText),
        ).keyId,
      ).toBe(testKey().keyId);
      // a missing secret or both key sources are refused
      lines.length = 0;
      await fr(
        "sign",
        "--manifest",
        join(dir, "manifest.json"),
        "--key-secret",
        "secret:nope",
        "--out",
        join(dir, "signed2.json"),
      );
      expect(lines.at(-1)).toMatch(/ERR error \[secret_not_granted\]/);
      expect(existsSync(join(dir, "signed2.json"))).toBe(false);
      lines.length = 0;
      await fr(
        "sign",
        "--manifest",
        join(dir, "manifest.json"),
        "--out",
        join(dir, "signed3.json"),
      );
      expect(lines.at(-1)).toMatch(/one of --key-file or --key-secret/);
      process.exitCode = 0;
    } finally {
      await h.close();
    }
  });
});

describe("versions that cannot be a directory (build metadata, leading v)", () => {
  function manifestFor(version: string) {
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
          url: "https://example.invalid/d/forerunner-linux-x64.zip",
          sha256: sha256Hex("x"),
          size: 1,
        },
      ],
    };
  }

  it("check() never offers a release that apply() could not stage; both refuse it with the same reason", async () => {
    const feed = new MemoryReleaseFeed([
      signRaw(manifestFor("1.2.0+build.7")),
      signRaw(manifestFor("v1.1.5")),
    ]);
    const h = await harness({ feed });
    try {
      const c = await h.manager.check();
      expect(c.available).toBeNull();
      expect(c.rejected.map((r) => [r.version, r.reason])).toEqual([
        ["1.2.0+build.7", "malformed"],
        ["v1.1.5", "malformed"],
      ]);
      expect(c.rejected[0]?.message).toMatch(/build metadata|directory name/);
      for (const v of ["1.2.0+build.7", "v1.1.5"]) {
        const e = await h.manager
          .apply({ by: { kind: "human", id: "human-j" }, version: v })
          .catch((err: unknown) => err);
        expect(refusalReason(e)).toBe("malformed");
      }
      const denied = await h.store.auditLog.list({ tool: "update.apply", allowed: false });
      expect(denied.map((d) => d.denied_reason)).toEqual(["malformed", "malformed"]);
      expect(readPointer(h.dirs)).toBeNull();
      expect(h.restarter.requests).toEqual([]);
      expect(
        (existsSync(versionsRoot(h.dirs)) ? readdirSync(versionsRoot(h.dirs)) : []).filter(
          (n) => n !== "current.json",
        ),
      ).toEqual([]);
      // the directory rule and the manifest rule are one rule
      expect(() => versionDir(h.dirs, "1.2.0+build.7")).toThrow(/safe directory name/);
      expect(() => versionDir(h.dirs, "v1.1.5")).toThrow(/safe directory name/);
      expect(isReleaseVersion("1.2.0+build.7")).toBe(false);
      expect(isReleaseVersion("v1.1.5")).toBe(false);
      expect(isReleaseVersion("1.2.0-rc.1")).toBe(true);
      expect(isReleaseVersion("1.2.0")).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe("one install operation at a time", () => {
  it("two parallel apply() calls: one stages and restarts, the other is refused as in progress", async () => {
    const s = new FakeReleaseServer();
    await s.start();
    try {
      buildRelease(s, { version: "1.1.0" });
      const h = await harness({
        feed: new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: s.url }),
      });
      try {
        const by = { kind: "human" as const, id: "human-j" };
        const results = await Promise.all([
          h.manager.apply({ by }).then(
            () => "ok",
            (e: unknown) => e,
          ),
          h.manager.apply({ by }).then(
            () => "ok",
            (e: unknown) => e,
          ),
        ]);
        const errors = results.filter((r) => r !== "ok");
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(errors).toHaveLength(1);
        expect(isForerunnerError(errors[0], "version_conflict")).toBe(true);
        expect(isForerunnerError(errors[0]) && errors[0].details.reason).toBe("in_progress");
        expect(isForerunnerError(errors[0]) && errors[0].retryable).toBe(true);
        expect(h.restarter.requests).toHaveLength(1);
        expect(await h.store.release.list({ release_version: "1.1.0" })).toHaveLength(1);
        expect(readPointer(h.dirs)).toMatchObject({
          current: "1.1.0",
          previous: "1.0.0",
          state: "pending_health_check",
        });
        // the lock is released afterwards and the refusal was audited
        expect(existsSync(installLockPath(h.dirs))).toBe(false);
        expect(readInstallLock(h.dirs)).toBeNull();
        const denied = await h.store.auditLog.list({ tool: "update.apply", allowed: false });
        expect(denied).toHaveLength(1);
        expect(denied[0]?.denied_reason).toBe("in_progress");
      } finally {
        await h.close();
      }
    } finally {
      await s.stop();
    }
  });

  it("a lock held by a live process blocks rollback, health check and prune; a lock left by a dead process is cleared", async () => {
    const h = await harness();
    try {
      await withInstallLock(h.dirs, { operation: "apply", clock: h.clock }, async () => {
        const lock = readInstallLock(h.dirs);
        expect(lock).toMatchObject({ pid: process.pid, operation: "apply" });
        const calls: Array<() => unknown> = [
          () => h.manager.rollback({ by: { kind: "human", id: "human-j" } }),
          () => h.manager.healthCheck(),
          () => h.manager.prune(),
        ];
        for (const call of calls) {
          const e = await Promise.resolve()
            .then(call)
            .catch((err: unknown) => err);
          expect(isForerunnerError(e, "version_conflict")).toBe(true);
          expect(isForerunnerError(e) && e.details).toMatchObject({
            reason: "in_progress",
            operation: "apply",
          });
        }
      });
      expect(existsSync(installLockPath(h.dirs))).toBe(false);
      // a dead process's lock does not block forever
      const dead = spawnSync(process.execPath, ["-e", ""]);
      expect(dead.status).toBe(0);
      mkdirSync(versionsRoot(h.dirs), { recursive: true });
      writeFileSync(
        installLockPath(h.dirs),
        JSON.stringify({ pid: dead.pid, operation: "apply", startedAt: h.clock.nowIso() }),
      );
      expect(isPidAlive(dead.pid)).toBe(false);
      expect(isPidAlive(process.pid)).toBe(true);
      expect((await h.manager.healthCheck()).kind).toBe("not_pending");
      expect(existsSync(installLockPath(h.dirs))).toBe(false);
      // an unreadable lock written just now (another process between create and write) is
      // treated as held; one older than a few seconds on the injected clock is stale
      writeFileSync(installLockPath(h.dirs), "{broken");
      const fresh = new Date(h.clock.now());
      utimesSync(installLockPath(h.dirs), fresh, fresh);
      const e = await h.manager.healthCheck().catch((err: unknown) => err);
      expect(isForerunnerError(e, "version_conflict")).toBe(true);
      const old = new Date(h.clock.now() - 60 * 60 * 1000);
      utimesSync(installLockPath(h.dirs), old, old);
      expect((await h.manager.healthCheck()).kind).toBe("not_pending");
      expect(existsSync(installLockPath(h.dirs))).toBe(false);
    } finally {
      await h.close();
    }
  });
});

describe("rollback to the packaged build (launcher contract)", () => {
  it("writes current: null when the previous version has no directory, so the pointer never names a missing install", async () => {
    const s = new FakeReleaseServer();
    await s.start();
    try {
      buildRelease(s, { version: "1.1.0" });
      buildRelease(s, { version: "1.2.0" });
      const h = await harness({
        feed: new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: s.url }),
        probe: new StaticHealthProbe({ ok: false, detail: "broken" }),
      });
      try {
        const by = { kind: "human" as const, id: "human-j" };
        // the first staged update fails: back to the packaged 1.0.0, which has no directory
        await h.manager.apply({ by, version: "1.1.0" });
        const o = await h.manager.healthCheck();
        expect(o).toMatchObject({ kind: "rolled_back", from: "1.1.0", to: "1.0.0" });
        let p = readPointer(h.dirs);
        expect(p).toMatchObject({ current: null, previous: null, state: "installed" });
        expect(p?.lastRollback).toMatchObject({ from: "1.1.0", to: "1.0.0", automatic: true });
        expect(hasVersionDir(h.dirs, "1.0.0")).toBe(false);
        expect(h.manager.installedVersion()).toBe("1.0.0");
        expect(h.restarter.requests.at(-1)).toEqual({
          reason: "rollback",
          targetVersion: "1.0.0",
          fromVersion: "1.1.0",
        });
        expect(h.manager.prune()).toEqual(["1.1.0"]);
        // the next update is staged against the packaged version again
        await h.manager.apply({ by, version: "1.2.0" });
        p = readPointer(h.dirs);
        expect(p).toMatchObject({ current: "1.2.0", previous: "1.0.0" });
        // a manual rollback to the packaged build is the same contract
        h.probe = new StaticHealthProbe({ ok: true, detail: "fine" });
        const h2 = new UpdateManager({ ...h.deps, probe: h.probe });
        await h2.healthCheck();
        const r = await h2.rollback({ by, reason: "voice is broken" });
        expect(r).toMatchObject({ from: "1.2.0", to: "1.0.0" });
        p = readPointer(h.dirs);
        expect(p).toMatchObject({ current: null, previous: null });
        for (const v of [p?.current, p?.previous])
          if (v) expect(hasVersionDir(h.dirs, v)).toBe(true);
        expect(POINTER_STATES).not.toContain("rolled_back");
      } finally {
        await h.close();
      }
    } finally {
      await s.stop();
    }
  });

  it("keeps the previous version's name when its directory exists", async () => {
    const s = new FakeReleaseServer();
    await s.start();
    try {
      buildRelease(s, { version: "1.1.0" });
      buildRelease(s, { version: "1.2.0" });
      const h = await harness({
        feed: new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: s.url }),
      });
      try {
        const by = { kind: "human" as const, id: "human-j" };
        await h.manager.apply({ by, version: "1.1.0" });
        await h.manager.healthCheck();
        await h.manager.apply({ by, version: "1.2.0" });
        expect(readPointer(h.dirs)).toMatchObject({ current: "1.2.0", previous: "1.1.0" });
        const broken = new UpdateManager({
          ...h.deps,
          probe: new StaticHealthProbe({ ok: false, detail: "no daemon" }),
        });
        expect((await broken.healthCheck()).kind).toBe("rolled_back");
        const p = readPointer(h.dirs);
        expect(p).toMatchObject({ current: "1.1.0", previous: null, state: "installed" });
        expect(hasVersionDir(h.dirs, "1.1.0")).toBe(true);
        expect(h.manager.installedVersion()).toBe("1.1.0");
      } finally {
        await h.close();
      }
    } finally {
      await s.stop();
    }
  });
});

describe("HumanRequestUpdatePort", () => {
  it("answers pending with an inbox row, then approved or denied from the same row; expired rows are asked again", async () => {
    const s = new FakeReleaseServer();
    await s.start();
    try {
      buildRelease(s, { version: "1.1.0" });
      const h = await harness({
        feed: new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: s.url }),
      });
      try {
        // inbox rows reference the human who answers them
        await h.store.human.insert({ id: "human-j", name: "J", email: "j@example.test" });
        const port = new HumanRequestUpdatePort(h.store.humanRequest, "human-j");
        const m = new UpdateManager({ ...h.deps, human: port });
        const by = { kind: "agent" as const, id: "alice" };
        let e = await m.apply({ by }).catch((err: unknown) => err);
        expect(isForerunnerError(e, "approval_required")).toBe(true);
        let rows = await h.store.humanRequest.list({ kind: "approval" });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          human_id: "human-j",
          blocking: true,
          risk: "high",
          status: "open",
          author_agent: "updater",
        });
        expect(rows[0]?.why).toContain("1.1.0");
        // asking again while the row is open does not add a second one
        e = await m.apply({ by }).catch((err: unknown) => err);
        expect(isForerunnerError(e, "approval_required")).toBe(true);
        expect(isForerunnerError(e) && e.details.requestId).toBe(rows[0]?.id);
        rows = await h.store.humanRequest.list({ kind: "approval" });
        expect(rows).toHaveLength(1);
        // the human says no from the inbox
        const first = rows[0] as (typeof rows)[number];
        await h.store.humanRequest.answer(first.id, first.version, "no", "human-j");
        e = await m.apply({ by }).catch((err: unknown) => err);
        expect(isForerunnerError(e, "approval_required")).toBe(true);
        expect(isForerunnerError(e) && e.details.outcome).toBe("denied");
        expect(await h.store.humanRequest.list({ kind: "approval" })).toHaveLength(1);
        // a withdrawn answer means the question is open again: a new row
        await h.store.humanRequest.withdraw(first.id, first.version + 1).catch(() => undefined);
        // (an answered row cannot be withdrawn; expire a fresh one instead)
        const second = await h.store.humanRequest.insert({
          kind: "approval",
          why: "placeholder",
          author_agent: "updater",
          change_card: { key: "update.apply:1.1.0" },
        });
        await h.store.humanRequest.expire(second.id, second.version);
        e = await m.apply({ by }).catch((err: unknown) => err);
        expect(isForerunnerError(e, "approval_required")).toBe(true);
        rows = await h.store.humanRequest.list({ kind: "approval" });
        expect(rows.map((r) => r.status).sort()).toEqual(["answered", "expired", "open"]);
        const open = rows.find((r) => r.status === "open") as (typeof rows)[number];
        // the human says yes: the same apply now goes through, no new row
        await h.store.humanRequest.answer(open.id, open.version, { choice: "approve" }, "human-j");
        const r = await m.apply({ by });
        expect(r.version).toBe("1.1.0");
        expect(r.release.author_agent).toBe("alice");
        expect(await h.store.humanRequest.list({ kind: "approval" })).toHaveLength(3);
        // notifications are non-blocking info rows
        await port.notify({ title: "t", body: "b", severity: "warning" });
        const infos = await h.store.humanRequest.list({ kind: "info" });
        expect(infos).toHaveLength(1);
        expect(infos[0]).toMatchObject({ blocking: false, risk: "medium", human_id: "human-j" });
      } finally {
        await h.close();
      }
    } finally {
      await s.stop();
    }
  });
});
