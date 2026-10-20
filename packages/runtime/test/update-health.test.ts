import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore } from "@forerunner/state";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DaemonHealthProbe,
  DefaultHealthProbe,
  DoctorHealthProbe,
  type HealthResult,
  probeWithTimeout,
  runStartupHealthCheck,
  StaticHealthProbe,
} from "../src/update/health.ts";
import { writePointer } from "../src/update/pointer.ts";
import { FakeUpdateHumanPort, RecordingRestarter } from "../src/update/ports.ts";

/**
 * The default health probes: the daemon's /health route (located through daemon.json) and
 * `fr doctor --json` (any argv, no shell). Both run against stand-ins on this machine: a
 * node:http server on 127.0.0.1 and `node -e` printing a checks array.
 */
interface FakeDaemon {
  url: string;
  body: Record<string, unknown>;
  status: number;
  delayMs: number;
  stop(): Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  const state = { body: { ok: true, version: "1.2.0" } as Record<string, unknown>, status: 200 };
  let delayMs = 0;
  const server: Server = createServer((req, res) => {
    if (req.url !== "/health") {
      res.writeHead(404);
      res.end();
      return;
    }
    setTimeout(() => {
      res.writeHead(state.status, { "content-type": "application/json" });
      res.end(JSON.stringify(state.body));
    }, delayMs);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    get body() {
      return state.body;
    },
    set body(v) {
      state.body = v;
    },
    get status() {
      return state.status;
    },
    set status(v) {
      state.status = v;
    },
    get delayMs() {
      return delayMs;
    },
    set delayMs(v) {
      delayMs = v;
    },
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

function dirsFor(): ReturnType<typeof appDirs> {
  const home = mkdtempSync(join(tmpdir(), "fr-health-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  return dirs;
}

const signal = new AbortController().signal;

describe("DaemonHealthProbe", () => {
  let daemon: FakeDaemon;
  beforeAll(async () => {
    daemon = await startFakeDaemon();
  });
  afterAll(() => daemon.stop());

  it("reads daemon.json, calls /health and requires ok plus the version under test", async () => {
    const dirs = dirsFor();
    const probe = new DaemonHealthProbe({ dirs });
    // no daemon.json: the daemon did not start
    let r = await probe.check({ version: "1.2.0", signal });
    expect(r).toMatchObject({
      ok: false,
      detail: expect.stringContaining("daemon.json not found"),
    });
    writeFileSync(DaemonHealthProbe.daemonFile(dirs), "{nope");
    r = await probe.check({ version: "1.2.0", signal });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/unreadable/);
    writeFileSync(DaemonHealthProbe.daemonFile(dirs), JSON.stringify({ url: daemon.url, pid: 1 }));
    r = await probe.check({ version: "1.2.0", signal });
    expect(r).toEqual({ ok: true, detail: `daemon healthy (${daemon.url})` });
    // the route reports another version: the staged build is not what runs
    r = await probe.check({ version: "1.3.0", signal });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/reports version 1.2.0, expected 1.3.0/);
    // not ok, or a non-2xx answer
    daemon.body = { ok: false, version: "1.2.0" };
    expect((await probe.check({ version: "1.2.0", signal })).ok).toBe(false);
    daemon.body = { ok: true, version: "1.2.0" };
    daemon.status = 503;
    r = await probe.check({ version: "1.2.0", signal });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/answered 503/);
    daemon.status = 200;
    // unreachable daemon
    writeFileSync(
      DaemonHealthProbe.daemonFile(dirs),
      JSON.stringify({ url: "http://127.0.0.1:9", pid: 1 }),
    );
    r = await probe.check({ version: "1.2.0", signal });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/unreachable/);
  });

  it("is aborted by the timeout on the injected clock and the result is a failure, not a throw", async () => {
    const dirs = dirsFor();
    writeFileSync(DaemonHealthProbe.daemonFile(dirs), JSON.stringify({ url: daemon.url, pid: 1 }));
    daemon.delayMs = 5_000;
    try {
      const clock = new SimulatedClock("2026-10-20T12:00:00Z");
      const probe = new DaemonHealthProbe({ dirs });
      const pending = probeWithTimeout(probe, "1.2.0", 1_000, clock);
      await clock.advance(1_000);
      const r = await pending;
      expect(r.ok).toBe(false);
      expect(r.detail).toMatch(/timed out after 1000 ms/);
    } finally {
      daemon.delayMs = 0;
    }
  });
});

describe("DoctorHealthProbe", () => {
  const node = process.execPath;
  const script = (checks: unknown, exitCode = 0) =>
    `process.stdout.write(JSON.stringify(${JSON.stringify(checks)})); process.exitCode = ${exitCode};`;

  it("runs the argv without a shell and requires exit 0 and every check ok", async () => {
    const ok = new DoctorHealthProbe({
      argv: [
        node,
        "-e",
        script([
          { name: "node", ok: true, detail: "22" },
          { name: "git", ok: true, detail: "/usr/bin/git" },
        ]),
      ],
    });
    const r = await ok.check({ version: "1.2.0", signal });
    expect(r.ok).toBe(true);
    expect(r.detail).toBe("doctor ok");
    expect(r.checks?.map((c) => c.name)).toEqual(["node", "git"]);

    const failing = new DoctorHealthProbe({
      argv: [
        node,
        "-e",
        script([
          { name: "node", ok: true, detail: "22" },
          { name: "container engine", ok: false, detail: "none" },
        ]),
      ],
    });
    const f = await failing.check({ version: "1.2.0", signal });
    expect(f.ok).toBe(false);
    expect(f.detail).toBe("failing: container engine");

    // only the required checks decide when `required` is set
    const required = new DoctorHealthProbe({
      argv: [
        node,
        "-e",
        script([
          { name: "node", ok: true, detail: "22" },
          { name: "container engine", ok: false, detail: "none" },
        ]),
      ],
      required: ["node"],
    });
    expect((await required.check({ version: "1.2.0", signal })).ok).toBe(true);

    const crash = new DoctorHealthProbe({ argv: [node, "-e", script([], 3)] });
    const c = await crash.check({ version: "1.2.0", signal });
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/exited 3/);

    const garbage = new DoctorHealthProbe({ argv: [node, "-e", "process.stdout.write('nope')"] });
    const g = await garbage.check({ version: "1.2.0", signal });
    expect(g.ok).toBe(false);
    expect(g.detail).toMatch(/unreadable/);
  });
});

describe("DefaultHealthProbe and probeWithTimeout", () => {
  it("uses the daemon route when daemon.json exists, else the doctor command", async () => {
    const dirs = dirsFor();
    const doctorArgv = [
      process.execPath,
      "-e",
      "process.stdout.write(JSON.stringify([{name:'node',ok:true,detail:'22'}]))",
    ];
    const probe = new DefaultHealthProbe({ dirs, doctorArgv });
    expect(await probe.check({ version: "1.0.0", signal })).toMatchObject({
      ok: true,
      detail: "doctor ok",
    });
    writeFileSync(
      DaemonHealthProbe.daemonFile(dirs),
      JSON.stringify({ url: "http://127.0.0.1:9", pid: 1 }),
    );
    const viaDaemon = await probe.check({ version: "1.0.0", signal });
    expect(viaDaemon.ok).toBe(false);
    expect(viaDaemon.detail).toMatch(/unreachable/);
    // without a doctor argv the daemon route is the only probe
    const daemonOnly = new DefaultHealthProbe({ dirs: dirsFor() });
    expect((await daemonOnly.check({ version: "1.0.0", signal })).detail).toMatch(/not found/);
  });

  it("names the install whose check produced the verdict on the release row (health.reportedBy), not the row's author", async () => {
    const clock = new SimulatedClock("2026-10-20T12:00:00Z");
    const store = await openStore({ url: "sqlite::memory:", clock });
    const pending = (dirs: ReturnType<typeof dirsFor>, current: string, previous: string | null) =>
      writePointer(dirs, {
        schema: 1,
        current,
        previous,
        state: "pending_health_check",
        updatedAt: clock.nowIso(),
        lastRollback: null,
      });
    const depsFor = (
      dirs: ReturnType<typeof dirsFor>,
      version: string,
      humanId: string | null | undefined,
    ) => ({
      dirs,
      clock,
      probe: new StaticHealthProbe({ ok: false, detail: "daemon answered 500" }),
      timeoutMs: 1_000,
      store: { release: store.release, auditLog: store.auditLog },
      human: new FakeUpdateHumanPort(),
      restarter: new RecordingRestarter(),
      runningVersion: version,
      ...(humanId === undefined ? {} : { humanId }),
    });
    try {
      // The shared row was first recorded by another install (its author); this one rolls back.
      const shared = await store.release.insert({
        release_version: "1.2.0",
        channel: "stable",
        changelog: "",
        signature: "",
        status: "installed",
        artifacts: [],
        published_at: null,
        author_human: "human-m",
        author_agent: "updater",
      });
      const dirs = dirsFor();
      pending(dirs, "1.2.0", "1.1.0");
      const rolled = await runStartupHealthCheck(depsFor(dirs, "1.2.0", "human-j"));
      expect(rolled).toMatchObject({ kind: "rolled_back", from: "1.2.0", to: "1.1.0" });
      const after = await store.release.mustGet(shared.id);
      expect(after.author_human).toBe("human-m");
      expect(after.health).toEqual({
        ok: false,
        detail: "daemon answered 500",
        probe: "static",
        checkedAt: clock.nowIso(),
        reportedBy: { human: "human-j", agent: null },
      });

      // A first install with nothing to roll back to: the failed row names it too.
      await store.release.insert({
        release_version: "1.3.0",
        channel: "stable",
        changelog: "",
        signature: "",
        status: "published",
        artifacts: [],
        published_at: null,
        author_human: "human-m",
        author_agent: "updater",
      });
      const first = dirsFor();
      pending(first, "1.3.0", null);
      await clock.advance(1_000);
      expect((await runStartupHealthCheck(depsFor(first, "1.3.0", "human-j"))).kind).toBe(
        "failed_no_previous",
      );
      expect((await store.release.latest("stable", "failed"))?.health).toMatchObject({
        checkedAt: clock.nowIso(),
        reportedBy: { human: "human-j", agent: null },
      });

      // An install with no human (a bare CLI run) records that the reporter is unknown rather
      // than letting the row's author pass for it.
      await store.release.insert({
        release_version: "1.4.0",
        channel: "stable",
        changelog: "",
        signature: "",
        status: "published",
        artifacts: [],
        published_at: null,
        author_human: "human-m",
        author_agent: "updater",
      });
      const bare = dirsFor();
      pending(bare, "1.4.0", "1.1.0");
      await clock.advance(1_000);
      expect((await runStartupHealthCheck(depsFor(bare, "1.4.0", undefined))).kind).toBe(
        "rolled_back",
      );
      const rows = await store.release.list({ release_version: "1.4.0" }, { limit: 1 });
      expect(rows[0]?.health).toMatchObject({ reportedBy: { human: null, agent: null } });
    } finally {
      await store.close();
    }
  });

  it("turns a throwing probe into a failed result and cancels the timer on success", async () => {
    const clock = new SimulatedClock("2026-10-20T12:00:00Z");
    const throwing = new StaticHealthProbe(() => {
      throw new Error("probe exploded");
    });
    const r = await probeWithTimeout(throwing, "1.0.0", 1_000, clock);
    expect(r).toEqual({ ok: false, detail: "health probe threw: probe exploded" });
    const fine: HealthResult = { ok: true, detail: "fine" };
    expect(await probeWithTimeout(new StaticHealthProbe(fine), "1.0.0", 1_000, clock)).toEqual(
      fine,
    );
    expect(clock.pendingTimers()).toBe(0);
  });
});
