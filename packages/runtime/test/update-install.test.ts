import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isForerunnerError, join, sep } from "@forerunner/platform";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerUpdateCli } from "../src/update/cli.ts";
import { GitHubReleasesFeed, MemoryReleaseFeed } from "../src/update/feed.ts";
import { StaticHealthProbe } from "../src/update/health.ts";
import { assertSafeZipEntry, detectArtifactPlatform, unpackZip } from "../src/update/install.ts";
import {
  type CurrentPointer,
  cleanStalePointerTemps,
  pointerPath,
  readPointer,
  versionDir,
  versionsRoot,
  writePointer,
} from "../src/update/pointer.ts";
import { generateSigningKeyPair, signManifest } from "../src/update/sign.ts";
import { ReleaseVerifier, refusalReason } from "../src/update/verify.ts";
import {
  buildRelease,
  FakeReleaseServer,
  type Harness,
  makeHarness,
  makeZip,
  protectedHashes,
  rawZip,
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
      const p = readPointer(h.dirs);
      expect(p).toMatchObject({ current: "1.0.0", previous: null, state: "installed" });
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
      expect(readPointer(h.dirs)?.current).toBe("1.0.0");
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
        current: "1.0.0",
        previous: null,
        state: "installed",
      });
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
});
