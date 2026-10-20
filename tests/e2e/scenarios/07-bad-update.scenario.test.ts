/**
 * Scenario 7, "Bad update" (spec, Phase 8): "A broken release installs, fails its health check
 * and rolls back."
 *
 * Fake provider (no model call is needed here), no network beyond 127.0.0.1, simulated clock.
 * The app's releases live in a repository on the world's fake git host; the publish job's
 * steps (`scenario-update.ts`) upload one zip artefact per platform and the Ed25519-signed
 * manifest as release assets, and the install's updater (the production `UpdateManager` over
 * the shared store, the GitHub releases feed against the fake host, the build's trusted key,
 * the production inbox port, a shell stand-in that "boots" the version `current.json` names,
 * and the staged build's own doctor script as the health probe) consumes them.
 *
 * Morning: J installs 1.0.0 from the feed ("Update and restart"); its doctor passes and it is
 * the known-good version. Then 1.1.0 is published: signed and verified, it installs, the shell
 * restarts into it, and its doctor fails (the build cannot start). The startup health check
 * rolls back on its own to 1.0.0: the pointer names 1.0.0 with the automatic rollback
 * recorded, the release row is `rolled_back` with the health verdict, the audit rows say
 * install, health, install, automatic rollback, the shell relaunches 1.0.0, J's inbox holds
 * the rollback notice, and no human request was opened or answered for any of it. The install
 * never offers 1.1.0 again. Every clause is asserted on the pointer file, state rows, audit
 * rows, notification records and the shell stand-in's requests.
 *
 * The second case is the other way a release breaks: 1.2.0's doctor never answers. The
 * updater's health timeout (30 simulated seconds on the world's clock) ends the check while
 * the scenario advances the clock, the doctor process is killed by the abort, and the same
 * automatic rollback follows with "timed out" as the reason.
 *
 * Windows and Android: the same code runs on both (paths and processes through
 * @forerunner/platform; the doctor runs as an argv array); the final-build runs are recorded
 * in gates.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "@forerunner/platform";
import { updates } from "@forerunner/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { advanceUntil, iso, waitFor } from "../src/scenario-support.ts";
import {
  brokenDoctor,
  DOCTOR_SCRIPT,
  hangingDoctor,
  healthyDoctor,
  type PublishedRelease,
  type ReleaseFeedOnHost,
  releaseFeedOnHost,
  type ScenarioUpdater,
  scenarioUpdater,
} from "../src/scenario-update.ts";
import { type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";

const MORNING = iso("2026-11-04T07:00:00Z"); // 08:00 Europe/Zurich, 4 November 2026
const PACKAGED = "0.9.0";
const GOOD = "1.0.0";
const BAD = "1.1.0";
const HUNG = "1.2.0";
const CRASH = "daemon failed to start: Cannot find module './server.mjs'";
/** The updater's health timeout, simulated ms (the helper's default). */
const HEALTH_TIMEOUT_MS = 30_000;

describe("scenario 7: bad update", () => {
  let w: ScenarioWorld;
  let feed: ReleaseFeedOnHost;
  let up: ScenarioUpdater;
  beforeAll(async () => {
    w = await scenarioWorld({ start: MORNING });
    feed = await releaseFeedOnHost(w, w.alice);
    up = scenarioUpdater(w, w.alice, feed, {
      runningVersion: PACKAGED,
      healthTimeoutMs: HEALTH_TIMEOUT_MS,
    });
  });
  afterAll(async () => {
    await w?.close();
  });

  it("a broken release installs, fails its health check and rolls back on its own; the pointer, the audit rows and the notification say so; no human request is needed", async () => {
    const by = { kind: "human" as const, id: w.j.id };
    const updaterRows = async () =>
      (await w.store.auditLog.list({ humanId: w.j.id })).filter((r) =>
        r.tool.startsWith("update."),
      );
    const release = async (version: string) =>
      (await w.store.release.list({ release_version: version }, { limit: 1 }))[0];

    // --- The known-good release: 1.0.0 is published, installs and passes its health check ---
    const good: PublishedRelease = await feed.publish({
      version: GOOD,
      files: { "app/VERSION": GOOD, [DOCTOR_SCRIPT]: healthyDoctor(GOOD) },
      notes: `## ${GOOD}\n- first release`,
    });
    // The morning passes a minute at a time between the steps, so every row has its own time.
    const later = () => w.clock.advance(60_000);
    await later();
    const check1 = await up.manager.check({ kind: "system", id: null });
    expect(check1.available?.version).toBe(GOOD);
    expect(check1.signed?.signature?.keyId).toBe(feed.key.keyId);
    expect(check1.rejected).toEqual([]);
    await later();
    const applied1 = await up.manager.apply({ by });
    expect(applied1.pointer).toMatchObject({
      current: GOOD,
      previous: PACKAGED,
      state: "pending_health_check",
      lastRollback: null,
    });
    expect(up.running.version).toBe(GOOD);
    await later();
    expect(await up.manager.healthCheck()).toMatchObject({ kind: "healthy", version: GOOD });
    expect(up.pointer()).toMatchObject({ current: GOOD, previous: PACKAGED, state: "installed" });
    expect((await release(GOOD))?.status).toBe("installed");
    expect(up.probe.checks.map((c) => c.version)).toEqual([GOOD]);

    // --- Clause: a broken release installs -------------------------------------------------
    // Signed with the build key, verified against the install's trusted key, newer than the
    // running version, schema-compatible: nothing in the trust chain can tell it is broken,
    // only running it can.
    await later();
    const bad: PublishedRelease = await feed.publish({
      version: BAD,
      files: { "app/VERSION": BAD, [DOCTOR_SCRIPT]: brokenDoctor(CRASH) },
      notes: `## ${BAD}\n- faster start-up`,
    });
    await later();
    const check2 = await up.manager.check(by);
    expect(check2.available?.version).toBe(BAD);
    expect(check2.rejected).toEqual([]);
    expect(check2.available?.artifacts.map((a) => a.platform).sort()).toEqual([
      "android",
      "linux-x64",
      "windows-x64",
    ]);
    expect(check2.available?.artifacts[0]?.url).toContain(
      `/${feed.owner}/${feed.repo}/releases/download/${encodeURIComponent(bad.tag)}/`,
    );
    await later();
    const applied2 = await up.manager.apply({ by });
    expect(applied2.version).toBe(BAD);
    expect(applied2.previous).toBe(GOOD);
    expect(applied2.staged.unpackedFiles).toBe(2);
    expect(readFileSync(join(applied2.staged.dir, "app", "VERSION"), "utf8")).toBe(BAD);
    expect(existsSync(join(applied2.staged.dir, ...DOCTOR_SCRIPT.split("/")))).toBe(true);
    expect(JSON.parse(readFileSync(applied2.staged.manifestPath, "utf8"))).toEqual(bad.signed);
    expect(applied2.staged.artifact.sha256).toBe(updates.sha256Hex(bad.zip));
    expect(applied2.pointer).toMatchObject({
      schema: 1,
      current: BAD,
      previous: GOOD,
      state: "pending_health_check",
    });
    expect(applied2.release).toMatchObject({ release_version: BAD, status: "published" });
    expect(up.manager.status().versionsOnDisk).toEqual([GOOD, BAD]);
    // "Update and restart": the shell relaunched into the new version.
    expect(up.restarter.requests.at(-1)).toEqual({
      reason: "update",
      targetVersion: BAD,
      fromVersion: GOOD,
    });
    expect(up.running.version).toBe(BAD);
    const installRow = (await updaterRows()).filter((r) => r.tool === "update.apply").at(-1);
    expect(installRow?.allowed).toBe(true);
    expect(installRow?.input_summary).toContain(`install ${BAD} from github`);
    expect(installRow?.result_summary).toContain(`previous ${GOOD}; restart requested`);

    // --- Clause: fails its health check ----------------------------------------------------
    // First start after the update: the probe runs the staged build's own doctor; it cannot
    // start and says why.
    await later();
    const outcome = await up.manager.healthCheck();
    expect(outcome.kind).toBe("rolled_back");
    if (outcome.kind !== "rolled_back") throw new Error("no rollback");
    expect(outcome).toMatchObject({ from: BAD, to: GOOD });
    expect(outcome.reason).toContain("doctor exited 1");
    expect(outcome.reason).toContain(CRASH);
    expect(up.probe.checks.map((c) => c.version)).toEqual([GOOD, BAD]);

    // --- Clause: rolls back on its own; the pointer says so --------------------------------
    const pointer = up.pointer();
    expect(pointer).toMatchObject({
      schema: 1,
      current: GOOD,
      previous: null,
      state: "installed",
      lastRollback: { from: BAD, to: GOOD, automatic: true, reason: outcome.reason },
    });
    expect(pointer?.lastRollback?.at).toBe(w.clock.nowIso());
    expect(pointer?.updatedAt).toBe(w.clock.nowIso());
    // The shell was asked to relaunch the previous version and did; the staged build stays
    // on disk for the post-mortem until a prune.
    expect(up.restarter.requests.at(-1)).toEqual({
      reason: "rollback",
      targetVersion: GOOD,
      fromVersion: BAD,
    });
    expect(up.restarter.requests.map((r) => r.reason)).toEqual(["update", "update", "rollback"]);
    expect(up.running.version).toBe(GOOD);
    expect(up.manager.installedVersion()).toBe(GOOD);
    expect(up.manager.status().versionsOnDisk).toEqual([GOOD, BAD]);
    expect(readFileSync(join(updates.versionDir(up.dirs, GOOD), "app", "VERSION"), "utf8")).toBe(
      GOOD,
    );

    // --- The release rows say so -----------------------------------------------------------
    const badRow = await release(BAD);
    expect(badRow?.status).toBe("rolled_back");
    expect(badRow?.health).toMatchObject({ ok: false, probe: "doctor", detail: outcome.reason });
    expect(badRow?.signature).toBe(JSON.stringify(bad.signed.signature));
    expect((await release(GOOD))?.status).toBe("installed");
    expect((await release(GOOD))?.health).toMatchObject({ ok: true, probe: "doctor" });
    expect(good.manifest.version).toBe(GOOD);

    // --- Clause: the audit rows say so -----------------------------------------------------
    // Each "Update and restart" asks the feed once more before it stages (the second check of
    // each pair), so the trail reads: check, check, install, health, check, check, install,
    // automatic rollback.
    // Rows of one step share a simulated time and carry no order between them, so the trail
    // is read step by step (by time), each step as a set.
    const rows = await updaterRows();
    const steps = new Map<string, string[]>();
    for (const r of rows) steps.set(r.occurred_at, [...(steps.get(r.occurred_at) ?? []), r.tool]);
    expect(
      [...steps.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, tools]) => tools.sort()),
    ).toEqual([
      ["update.check"],
      ["update.apply", "update.check"],
      ["update.health"],
      ["update.check"],
      ["update.apply", "update.check"],
      ["update.rollback"],
    ]);
    expect(rows.every((r) => r.allowed)).toBe(true);
    const rollbackRow = rows.find((r) => r.tool === "update.rollback");
    expect(rollbackRow?.input_summary).toBe(
      `automatic rollback: health check of ${BAD} failed (doctor)`,
    );
    expect(rollbackRow?.result_summary).toBe(`rolled back to ${GOOD}: ${outcome.reason}`);
    expect(rollbackRow?.human_id).toBe(w.j.id);
    expect(rollbackRow?.agent_id).toBeNull();
    expect(rollbackRow?.occurred_at).toBe(pointer?.lastRollback?.at);
    expect(rows.every((r) => r.occurred_at <= (rollbackRow?.occurred_at ?? ""))).toBe(true);
    expect(rows.find((r) => r.tool === "update.health")?.result_summary).toContain("doctor ok");
    // No human tool ran: the rollback happened between the two starts, on the pointer alone.
    expect(rows.filter((r) => r.tool === "update.rollback")).toHaveLength(1);

    // --- Clause: the notification says so --------------------------------------------------
    // The updater's own inbox item (the production port writes it as an info request) ...
    const inbox = await w.store.humanRequest.list(
      { human_id: w.j.id, author_agent: updates.UPDATE_REQUEST_AUTHOR },
      { orderBy: "created_at desc" },
    );
    expect(inbox).toHaveLength(1);
    const notice = inbox[0];
    expect(notice).toMatchObject({
      kind: "info",
      status: "open",
      blocking: false,
      risk: "high",
      answer: null,
      answered_at: null,
    });
    expect(notice?.why).toContain(`Update ${BAD} rolled back`);
    expect(notice?.why).toContain(`went back to ${GOOD}`);
    expect(notice?.why).toContain(CRASH);
    expect((await w.humanRequests(w.j, { status: "open" })).map((r) => r.id)).toEqual([notice?.id]);
    // ... and the notifier's record of the restart: urgency normal, delivered on the desktop
    // channel, audited, with the rollback named in the title.
    const records = up.notifications();
    expect(records.map((r) => r.notification.kind)).toEqual([
      "update_applied",
      "update_applied",
      "update_applied",
    ]);
    const rolled = records[0];
    expect(rolled?.notification.title).toBe(`Rolled back to ${GOOD} (from ${BAD})`);
    expect(rolled?.notification.body).toContain("did not pass its health check");
    expect(rolled).toMatchObject({ urgency: "normal", outcome: "delivered" });
    expect(rolled?.deliveries.map((d) => [d.channel, d.status])).toEqual([
      ["desktop", "delivered"],
    ]);
    expect(up.notify.channel.sent.at(-1)?.notification.title).toBe(
      `Rolled back to ${GOOD} (from ${BAD})`,
    );
    const notifyRows = (
      await w.store.auditLog.list({ humanId: w.j.id, tool: "notify.desktop" })
    ).filter((r) => r.input_summary.startsWith("update_applied"));
    expect(notifyRows).toHaveLength(3);
    expect(notifyRows.at(-1)?.input_summary).toContain(`Rolled back to ${GOOD}`);

    // --- Clause: a human request is not needed ---------------------------------------------
    // Nobody was asked: no approval row exists (the installs were J's own "Update and
    // restart", the rollback the health check's), nothing was answered.
    const approvals = await w.store.humanRequest.list({ kind: "approval" });
    expect(approvals).toHaveLength(0);
    expect((await w.store.humanRequest.list()).every((r) => r.answered_at === null)).toBe(true);
    expect(await w.store.humanRequest.list({ kind: "decision" })).toHaveLength(0);

    // --- The install never offers the broken release again --------------------------------
    await later();
    const check3 = await up.manager.check(by, { fresh: true });
    expect(check3.available).toBeNull();
    expect(check3.rejected).toEqual([
      { version: BAD, reason: "previously_rejected", message: expect.stringContaining(BAD) },
    ]);
    expect(check3.runningVersion).toBe(GOOD);
    await expect(up.manager.apply({ by, version: BAD })).rejects.toMatchObject({
      details: { reason: "previously_rejected" },
    });
    expect((await updaterRows()).at(-1)).toMatchObject({
      tool: "update.apply",
      allowed: false,
      denied_reason: "previously_rejected",
    });
    // A prune keeps the running version and drops the rolled-back one.
    expect(up.manager.prune()).toEqual([BAD]);
    expect(up.manager.status().versionsOnDisk).toEqual([GOOD]);

    // --- Secrets: the publish job's token reached no row, no notification, no pointer -------
    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.humanRequest.list(),
      await w.store.release.list(),
      records,
      up.pointer(),
    ]);
    expect(dump).not.toContain(feed.token);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
    expect(dump).not.toContain(feed.key.privateKey);
  }, 90_000);

  it("a release whose doctor never answers is timed out by the health check and rolled back on its own; the doctor process is killed", async () => {
    const by = { kind: "human" as const, id: w.j.id };
    const later = () => w.clock.advance(60_000);
    expect(up.running.version).toBe(GOOD);
    // An hour on: the notifier dedupes a repeat of the same notification within ten minutes
    // (`update-applied:rollback:1.0.0` was delivered in the case above); a release an hour
    // later is its own event.
    await w.clock.advance(60 * 60_000);
    const since = w.clock.nowIso();

    // --- The release installs: signed, verified, newer ---------------------------------------
    await later();
    const hung: PublishedRelease = await feed.publish({
      version: HUNG,
      files: { "app/VERSION": HUNG, [DOCTOR_SCRIPT]: hangingDoctor() },
      notes: `## ${HUNG}\n- a doctor that never answers`,
    });
    await later();
    const check = await up.manager.check(by, { fresh: true });
    expect(check.available?.version).toBe(HUNG);
    expect(check.rejected.map((r) => r.version)).not.toContain(HUNG);
    await later();
    const applied = await up.manager.apply({ by });
    expect(applied.version).toBe(HUNG);
    expect(applied.previous).toBe(GOOD);
    expect(applied.pointer).toMatchObject({
      current: HUNG,
      previous: GOOD,
      state: "pending_health_check",
    });
    expect(up.running.version).toBe(HUNG);

    // --- Clause: fails its health check (by the timeout) ----------------------------------
    // The check is pending on the doctor; the clock is advanced a second at a time (real I/O
    // in between) until the updater's own timeout, on the simulated clock, ends it.
    await later();
    const startedAt = w.clock.nowIso();
    let outcome: updates.HealthOutcome | null = null;
    const pending = up.manager.healthCheck().then((o) => {
      outcome = o;
      return o;
    });
    const advanced = await advanceUntil(w.clock, () => outcome !== null, {
      maxMs: HEALTH_TIMEOUT_MS * 4,
    });
    const result = await pending;
    expect(advanced).toBeGreaterThanOrEqual(HEALTH_TIMEOUT_MS);
    expect(advanced).toBeLessThanOrEqual(HEALTH_TIMEOUT_MS + 2_000);
    expect(result.kind).toBe("rolled_back");
    if (result.kind !== "rolled_back") throw new Error("no rollback");
    expect(result).toEqual({
      kind: "rolled_back",
      from: HUNG,
      to: GOOD,
      reason: `health check timed out after ${HEALTH_TIMEOUT_MS} ms`,
    });
    // The abort killed the doctor after the timeout won: by signal on Linux, with exit code 1
    // on Windows (no signals there); either way its own run ended without an ok.
    const doctorRun = await waitFor(
      () => up.probe.results.find((r) => r.version === HUNG),
      "the hung doctor's exit",
    );
    expect(doctorRun.result.ok).toBe(false);
    expect(doctorRun.result.detail).toMatch(/^doctor exited (by signal|[1-9]\d*):/);
    expect(up.probe.checks.map((c) => c.version)).toEqual([GOOD, BAD, HUNG]);

    // --- Clause: rolls back on its own; the pointer, the rows and the shell say so ----------
    expect(up.pointer()).toMatchObject({
      current: GOOD,
      previous: null,
      state: "installed",
      lastRollback: { from: HUNG, to: GOOD, automatic: true, reason: result.reason },
    });
    expect((up.pointer()?.lastRollback?.at ?? "") >= startedAt).toBe(true);
    expect(up.restarter.requests.at(-1)).toEqual({
      reason: "rollback",
      targetVersion: GOOD,
      fromVersion: HUNG,
    });
    expect(up.running.version).toBe(GOOD);
    const row = (await w.store.release.list({ release_version: HUNG }, { limit: 1 }))[0];
    expect(row?.status).toBe("rolled_back");
    expect(row?.health).toMatchObject({ ok: false, probe: "doctor", detail: result.reason });
    expect(row?.signature).toBe(JSON.stringify(hung.signed.signature));
    const rows = (await w.store.auditLog.list({ humanId: w.j.id })).filter(
      (r) => r.tool.startsWith("update.") && r.occurred_at > since,
    );
    expect(rows.map((r) => r.tool).sort()).toEqual(
      ["update.apply", "update.check", "update.check", "update.rollback"].sort(),
    );
    expect(rows.every((r) => r.allowed)).toBe(true);
    const rollback = rows.find((r) => r.tool === "update.rollback");
    expect(rollback?.input_summary).toBe(
      `automatic rollback: health check of ${HUNG} failed (doctor)`,
    );
    expect(rollback?.result_summary).toBe(`rolled back to ${GOOD}: ${result.reason}`);

    // --- Clause: the notification says so; a human request is not needed ------------------
    const inbox = await w.store.humanRequest.list(
      { human_id: w.j.id, author_agent: updates.UPDATE_REQUEST_AUTHOR },
      { orderBy: "created_at desc" },
    );
    expect(inbox.map((r) => r.kind)).toEqual(["info", "info"]);
    expect(inbox[0]?.why).toContain(`Update ${HUNG} rolled back`);
    expect(inbox[0]?.why).toContain("timed out");
    expect(inbox[0]?.answered_at).toBeNull();
    expect(up.notifications()[0]?.notification.title).toBe(`Rolled back to ${GOOD} (from ${HUNG})`);
    expect(up.notifications()[0]).toMatchObject({ urgency: "normal", outcome: "delivered" });
    expect(await w.store.humanRequest.list({ kind: "approval" })).toHaveLength(0);
    expect(await w.store.humanRequest.list({ kind: "decision" })).toHaveLength(0);
    // Not offered again.
    const after = await up.manager.check(by, { fresh: true });
    expect(after.available).toBeNull();
    expect(after.rejected).toEqual(
      expect.arrayContaining([
        { version: HUNG, reason: "previously_rejected", message: expect.stringContaining(HUNG) },
      ]),
    );
    expect(up.manager.prune()).toEqual([HUNG]);

    const dump = JSON.stringify([await w.store.auditLog.list(), up.notifications(), up.pointer()]);
    expect(dump).not.toContain(feed.token);
    expect(dump).not.toContain(feed.key.privateKey);
  }, 60_000);
});
