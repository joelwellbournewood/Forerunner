/**
 * Phase 7 gate harness (spec, build order): "A UI change requested in plain language ships as
 * an update both users install, and a deliberately broken build rolls back on its own." Plus
 * the model watch half of phase 7 (spec D.6, D.21: "Weekly model watch with eval-based
 * recommendations", "Human approves").
 *
 * Fake provider, no network beyond 127.0.0.1, simulated clock, on the scenario world
 * (`scenario-world.ts`) with the repository as the Forerunner stand-in (`gate7-release.ts`).
 *
 * Part 1, the UI change. J types "make the inbox badge show the blocking count" to the
 * conversation agent of his install; no parser pattern knows the sentence, so it goes to the
 * fast model with the registry's command tools and the scripted model files a ready, tier 2
 * task through `task_create`: a change log row with the words used, a task row on the
 * Forerunner project like any other (M.1). Alice's session runs it: the coder changes
 * `apps/ui/src/inbox-badge.ts` on a branch, the critic reviews at tier 2 on the opus rung and
 * accepts, the PR opens; J merges it (the human approval of M.2). The release is built from
 * main as the publish job builds it (`releaseFromMain`: the UI file as merged, `app/VERSION`,
 * the doctor, a changelog line naming the request and the PR), signed with the build key and
 * published on the fake git host. Two installs on the shared state (Alice's and Bob's
 * updaters, `scenarioUpdater`) check the feed, see "Update available" with the changelog in
 * the updates view, apply ("Update and restart"), pass the startup health check, and hold the
 * changed UI file in their staged build; one shared release row says `installed`; audit rows
 * and `update_applied` notifications per human; config, data and memory untouched (M.4).
 *
 * Part 2, the broken build. 1.2.0's doctor cannot start. Alice's install takes it (signed,
 * verified, newer: nothing in the trust chain can tell), restarts into it, fails the health
 * check and rolls back on its own to 1.1.0 with the pointer, release row, audit rows, inbox
 * item and notification saying so, and no human request. Bob's install never takes it: its
 * check reads the shared release row (`rolled_back`) and lists 1.2.0 as `previously_rejected`,
 * an explicit apply is refused with an audit row, M gets no rollback and no inbox item. That
 * shared row is the "peer reports it broken" rule in code (`UpdateManager.assertNotRejectedBefore`
 * over the shared `release` table; ADR 0046).
 *
 * Part 3, the model watch. The weekly `scheduleModelWatch` trigger on the session scheduler
 * fires the production `ModelWatch` of Alice's install (`gate7-model-watch.ts`): the provider
 * lists a new sonnet-rung model priced by the price list; the coder eval set (the registry's
 * first four tasks) runs on the baseline, one effort lower and the candidate through the real
 * grader on the fake provider; the report measures a quality delta (the baseline fails one
 * task, the candidate none) and a cost delta (the candidate's price, the lower effort's
 * shorter answers) and proposes a switch and a lower effort; the decision is a request in J's
 * inbox and nothing is written until J answers "adopt"; then `models.json` and
 * `pricing.json` under the install's config directory, the tables in force handed to the
 * runtime, the release row `installed`, audit rows for every step. A week later the schedule
 * fires again: the adopted model is the baseline, nothing is proposed, no request is opened.
 *
 * Windows and Android: the same code runs on both (paths and processes through
 * @forerunner/platform; the doctor and the eval checks run as argv arrays); the final-build
 * runs are recorded in gates.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "@forerunner/platform";
import {
  type CommandLoop,
  type ConversationAgent,
  effortForTask,
  MODEL_WATCH_AGENT_ID,
  MODEL_WATCH_CHANNEL,
  MODEL_WATCH_SCHEDULE_ID,
  modelIdFor,
  modelSettings,
  ProviderRegistry,
  updates,
  WEEK_MINUTES,
} from "@forerunner/runtime";
import type { TaskRow } from "@forerunner/state";
import { FakeProvider, textReply, toolReply } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parsePricingOverrides } from "../../../packages/billing/src/index.ts";
import { ModelWatchUpdates } from "../../../packages/runtime/src/daemon/adapters.ts";
import {
  CANDIDATE_MODEL,
  coderEvalTasks,
  evalProbeReplies,
  evalRunnerOnWorld,
  type ScenarioModelWatch,
  scenarioModelWatch,
  WATCH_PRICING,
} from "../src/gate7-model-watch.ts";
import {
  APPS_DOC,
  APPS_DOC_AFTER,
  BADGE_AFTER,
  BADGE_ARTEFACT,
  BADGE_BEFORE,
  BADGE_FILE,
  type BuiltRelease,
  changedMarkers,
  FORERUNNER_FILES,
  type PlantedMarkers,
  plantMarkers,
  releaseFromMain,
  updaterRows,
} from "../src/gate7-release.ts";
import {
  chatAfterTool,
  chatTurn,
  commandLoopFor,
  conversationAgentFor,
  wordsOf,
} from "../src/scenario-commands.ts";
import { coderWrites, criticAccepts } from "../src/scenario-scripts.ts";
import { iso } from "../src/scenario-support.ts";
import {
  type ReleaseFeedOnHost,
  releaseFeedOnHost,
  type ScenarioUpdater,
  scenarioUpdater,
} from "../src/scenario-update.ts";
import { type Install, type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";

const MORNING = iso("2026-11-02T08:00:00Z"); // 09:00 Europe/Zurich, Monday 2 November 2026
const PACKAGED = "1.0.0";
const SHIPPED = "1.1.0";
const BROKEN = "1.2.0";
const REQUEST = "make the inbox badge show the blocking count";
const TASK_TITLE = "Inbox badge shows the blocking count";
const BROKEN_REQUEST = "render the inbox badge without a layout pass";
const CRASH = "renderer failed to start: inbox badge module has no export inboxBadgeCount";
const HEALTH_TIMEOUT_MS = 30_000;
const EVAL_TASKS = 4;

/** Alice's and Bob's updaters in the order the gate installs on them. */
type Updaters = Array<{ up: ScenarioUpdater; install: Install }>;

describe("phase 7 gate: a UI change ships as an update both users install; a broken build rolls back on its own; the weekly model watch proposes a switch the human adopts (fake provider)", () => {
  let w: ScenarioWorld;
  let feed: ReleaseFeedOnHost;
  let alice: ScenarioUpdater;
  let bob: ScenarioUpdater;
  let commands: CommandLoop;
  let agent: ConversationAgent;
  let both: Updaters;
  let shipped: BuiltRelease;
  let prNumber: number;
  const later = () => w.clock.advance(60_000);

  beforeAll(async () => {
    w = await scenarioWorld({
      start: MORNING,
      project: {
        name: "Forerunner",
        goal: "Forerunner, managed as a Forerunner project",
        owner: "forerunner",
        repo: "forerunner",
        files: FORERUNNER_FILES,
      },
    });
    feed = await releaseFeedOnHost(w, w.alice, { repo: "forerunner-app" });
    alice = scenarioUpdater(w, w.alice, feed, {
      runningVersion: PACKAGED,
      healthTimeoutMs: HEALTH_TIMEOUT_MS,
    });
    bob = scenarioUpdater(w, w.bob, feed, {
      runningVersion: PACKAGED,
      healthTimeoutMs: HEALTH_TIMEOUT_MS,
    });
    both = [
      { up: alice, install: w.alice },
      { up: bob, install: w.bob },
    ];
    commands = await commandLoopFor(w, w.alice);
    agent = conversationAgentFor(w, w.alice, commands);
  });
  afterAll(async () => {
    commands?.stop();
    await w?.close();
  });

  it("a UI change requested in plain language becomes a task, a PR the critic reviews and J merges, and a signed release both installs apply and verify healthy", async () => {
    // The scripts: the conversation agent's model turn files the task through the registry's
    // tool (the sentence matches no parser pattern); the coder writes the change; the critic
    // accepts. The production registry, executor, critic loop and PR flow do the rest.
    w.provider.pushReplies(
      toolReply(
        "task_create",
        {
          title: TASK_TITLE,
          outcome: `The inbox badge counts only the open items that block a session (${BADGE_FILE}).`,
          acceptance_criteria: [
            `${BADGE_FILE} counts open items with blocking true only`,
            "the InboxItem shape is unchanged",
          ],
          priority: 8,
          risk_tier: 2,
          status: "ready",
        },
        "Filing that as a task on Forerunner.",
        { when: chatTurn(REQUEST) },
      ),
      textReply(
        `Filed "${TASK_TITLE}" as a ready task on Forerunner; the next session picks it up.`,
        {
          when: chatAfterTool(REQUEST),
        },
      ),
      ...coderWrites(
        TASK_TITLE,
        { [BADGE_FILE]: BADGE_AFTER, [APPS_DOC]: APPS_DOC_AFTER },
        "Changed inboxBadgeCount to count open blocking items only, updated the apps doc and read both back.",
      ),
      ...criticAccepts(),
    );

    // --- Clause: a UI change requested in plain language -----------------------------------
    const callsBefore = w.provider.calls.length;
    const reply = await agent.chat({
      humanId: w.j.id,
      agentId: w.alice.agent.id,
      projectId: w.project.id,
      text: REQUEST,
      source: "text",
    });
    expect(reply.pendingConfirmation).toBeNull(); // a task is low risk: it acts at once
    expect(reply.question).toBeNull();
    expect(reply.actions).toEqual([
      expect.objectContaining({ kind: "task.create", id: expect.any(String) }),
    ]);
    expect(reply.actions[0]?.undoToken).toBeTruthy();
    expect(reply.reply).toContain(TASK_TITLE);
    // One model call, on the text-chat rung, with the registry's command tools and nothing else.
    const chatCalls = w.provider.calls
      .slice(callsBefore)
      .filter((c) => wordsOf(c.request).includes(REQUEST));
    expect(chatCalls).toHaveLength(2); // the tool call and the closing turn
    const chatCall = chatCalls[0]?.request;
    expect(chatCall?.model).toBe("fake-haiku");
    const toolNames = (chatCall?.tools ?? []).map((t) => t.name);
    expect(toolNames).toContain("task_create");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("read_file");
    expect(chatCall?.system ?? "").toContain("Forerunner");

    // --- Clause: Forerunner is a project in Forerunner; the request is in its task list ------
    const tasks = await w.store.task.forProject(w.project.id);
    expect(tasks).toHaveLength(1);
    const task = tasks[0] as TaskRow;
    expect(task).toMatchObject({
      title: TASK_TITLE,
      status: "ready",
      risk_tier: 2,
      priority: 8,
      project_id: w.project.id,
      author_human: w.j.id,
    });
    expect(task.reason).toContain(`created by human ${w.j.id} via chat`);
    // The change log row with the words used; the conversation's events; the tool's audit row.
    const log = await w.changeLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      id: reply.actions[0]?.id,
      human_id: w.j.id,
      agent_id: w.alice.agent.id,
      project_id: w.project.id,
      source: "chat",
      words_used: REQUEST,
      undo_state: "undoable",
      scope: "project",
    });
    expect(log[0]?.commands).toEqual([
      expect.objectContaining({
        name: "task.create",
        params: expect.objectContaining({ title: TASK_TITLE, status: "ready", risk_tier: 2 }),
      }),
    ]);
    expect(log[0]?.after).toMatchObject({ task_id: task.id, project_id: w.project.id });
    const conversationId = await agent.conversationSessionId(w.alice.agent.id, w.project.id);
    const chatEvents = await w.eventsOf(conversationId);
    expect(chatEvents.find((e) => e.type === "chat.human")?.payload).toMatchObject({
      text: REQUEST,
      source: "text",
    });
    expect(chatEvents.find((e) => e.type === "chat.reply")?.payload).toMatchObject({
      actions: ["task.create"],
    });
    expect(chatEvents.find((e) => e.type === "change")?.payload).toMatchObject({
      changeLogId: log[0]?.id,
      commands: ["task.create"],
    });
    const toolRows = (await w.auditRows({})).filter((r) => r.tool === "task_create");
    expect(toolRows).toHaveLength(1);
    expect(toolRows[0]?.allowed).toBe(true);

    // --- Clause: the change goes through a PR the critic reviews (tier 2) -------------------
    await later();
    const session = await w.runSession(w.alice);
    expect(session.status).toBe("completed");
    expect(session.completed).toEqual([task.id]);
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    const reviews = await w.store.review.forTask(task.id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ tier: 2, verdict: "accept", critic_model: "fake-opus" });
    const pr = (await w.pullRequests({ state: "open" })).find((p) => p.title === TASK_TITLE);
    expect(pr).toBeDefined();
    if (!pr) throw new Error("no PR for the badge change");
    prNumber = pr.number;
    expect(await w.fileOnHost(BADGE_FILE, pr.head.ref)).toBe(BADGE_AFTER);
    expect(await w.fileOnHost(BADGE_FILE)).toBe(BADGE_BEFORE); // main until the human merges
    expect(await w.fileOnHost(APPS_DOC, pr.head.ref)).toBe(APPS_DOC_AFTER);
    // The PR carries the module's doc with the change (the critic's docs-drift check, G.6).
    const writes = (await w.auditRows({})).filter((r) => r.tool === "write_file");
    expect(writes).toHaveLength(2);
    expect(writes.every((r) => r.allowed)).toBe(true);
    expect(
      writes.map((r) => [BADGE_FILE, APPS_DOC].find((f) => r.input_summary.includes(f))).sort(),
    ).toEqual([APPS_DOC, BADGE_FILE].sort());

    // --- Clause: human approval: J merges the PR ------------------------------------------
    await later();
    const merged = await w.alice.github.mergePullRequest(w.project.repo, pr.number, {
      method: "squash",
    });
    expect(merged.merged).toBe(true);
    expect(await w.fileOnHost(BADGE_FILE)).toBe(BADGE_AFTER);
    expect((await w.pullRequests({ state: "open" })).map((p) => p.number)).not.toContain(pr.number);

    // --- Clause: ships as an update: the signed release built from main -------------------
    await later();
    shipped = await releaseFromMain(w, feed, {
      version: SHIPPED,
      prNumber: pr.number,
      request: REQUEST,
    });
    expect(shipped.files[BADGE_ARTEFACT]).toBe(BADGE_AFTER);
    expect(shipped.changelog).toContain(REQUEST);
    expect(shipped.changelog).toContain(`#${pr.number}`);
    expect(shipped.published.manifest.notes).toBe(shipped.changelog);
    expect(shipped.published.signed.signature?.keyId).toBe(feed.key.keyId);
    expect(shipped.published.manifest.artifacts.map((a) => a.platform).sort()).toEqual([
      "android",
      "linux-x64",
      "windows-x64",
    ]);

    // --- Clause: both users install it ---------------------------------------------------
    const markers = new Map<string, PlantedMarkers>();
    for (const { up, install } of both) markers.set(install.name, plantMarkers(up, install));
    for (const { up, install } of both) {
      const by = { kind: "human" as const, id: install.human.id };
      await later();
      const check = await up.manager.check(by);
      expect(check).toMatchObject({ runningVersion: PACKAGED, rejected: [], cached: false });
      expect(check.available?.version).toBe(SHIPPED);
      expect(check.available?.notes).toBe(shipped.changelog);
      expect(check.signed?.signature?.keyId).toBe(feed.key.keyId);
      // The updates screen: "Update available" with the changelog, before "Update and restart".
      const view = await updates.composeUpdatesView({ manager: up.manager, clock: w.clock });
      expect(view.app).toMatchObject({
        state: "available",
        runningVersion: PACKAGED,
        currentVersion: PACKAGED,
      });
      expect(view.app.available).toMatchObject({
        version: SHIPPED,
        changelog: shipped.changelog,
        minSchema: 1,
      });
      await later();
      const applied = await up.manager.apply({ by });
      expect(applied).toMatchObject({ version: SHIPPED, previous: PACKAGED });
      expect(applied.staged.unpackedFiles).toBe(3);
      expect(readFileSync(join(applied.staged.dir, "app", "VERSION"), "utf8")).toBe(SHIPPED);
      expect(readFileSync(join(applied.staged.dir, ...BADGE_ARTEFACT.split("/")), "utf8")).toBe(
        BADGE_AFTER,
      );
      expect(JSON.parse(readFileSync(applied.staged.manifestPath, "utf8"))).toEqual(
        shipped.published.signed,
      );
      expect(applied.staged.artifact.sha256).toBe(updates.sha256Hex(shipped.published.zip));
      expect(applied.pointer).toMatchObject({
        current: SHIPPED,
        previous: PACKAGED,
        state: "pending_health_check",
      });
      expect(up.restarter.requests).toEqual([
        { reason: "update", targetVersion: SHIPPED, fromVersion: PACKAGED },
      ]);
      expect(up.running.version).toBe(SHIPPED);
      // First start after the update: the staged build's own doctor passes.
      await later();
      expect(await up.manager.healthCheck()).toMatchObject({ kind: "healthy", version: SHIPPED });
      expect(up.pointer()).toMatchObject({
        current: SHIPPED,
        previous: PACKAGED,
        state: "installed",
        lastRollback: null,
      });
      expect(up.manager.installedVersion()).toBe(SHIPPED);
      expect(up.manager.status().versionsOnDisk).toEqual([SHIPPED]);
      expect(up.probe.checks.map((c) => c.version)).toEqual([SHIPPED]);
      // The running build carries the UI change the request asked for.
      expect(
        readFileSync(
          join(updates.versionDir(up.dirs, SHIPPED), ...BADGE_ARTEFACT.split("/")),
          "utf8",
        ),
      ).toBe(BADGE_AFTER);
      // Audit rows of this human: the view's check, the check, the apply with its own check,
      // the health check; every row allowed.
      const rows = await updaterRows(w, install.human.id);
      expect(rows.map((r) => r.tool).sort()).toEqual([
        "update.apply",
        "update.check",
        "update.check",
        "update.check",
        "update.health",
      ]);
      expect(rows.every((r) => r.allowed)).toBe(true);
      expect(rows.find((r) => r.tool === "update.apply")?.input_summary).toContain(
        `install ${SHIPPED} from github`,
      );
      expect(rows.find((r) => r.tool === "update.health")?.result_summary).toContain("doctor ok");
      // The notification of the restart reached this human, and only this human.
      const records = up.notifications();
      expect(records.map((r) => r.notification.kind)).toEqual(["update_applied"]);
      expect(records[0]?.notification.title).toContain(SHIPPED);
      expect(records[0]).toMatchObject({ urgency: "normal", outcome: "delivered" });
      expect(records[0]?.deliveries.map((d) => [d.channel, d.status])).toEqual([
        ["desktop", "delivered"],
      ]);
      // No human request was needed: J's and M's own "Update and restart".
      expect(
        (await w.store.humanRequest.list({ author_agent: updates.UPDATE_REQUEST_AUTHOR })).filter(
          (r) => r.human_id === install.human.id,
        ),
      ).toHaveLength(0);
    }
    // One release row on the shared state, installed on both, with the change log.
    const releaseRows = await w.store.release.list({ release_version: SHIPPED });
    expect(releaseRows).toHaveLength(1);
    expect(releaseRows[0]).toMatchObject({
      channel: "stable",
      status: "installed",
      changelog: shipped.changelog,
      signature: JSON.stringify(shipped.published.signed.signature),
    });
    expect(releaseRows[0]?.health).toMatchObject({ ok: true, probe: "doctor" });
    // Both installs' audit rows name their own human; neither wrote a row for the other.
    expect((await updaterRows(w, w.j.id)).every((r) => r.human_id === w.j.id)).toBe(true);
    expect((await updaterRows(w, w.m.id)).every((r) => r.human_id === w.m.id)).toBe(true);
    expect(await updaterRows(w, w.m.id)).toHaveLength(5);
    // Config, memory and data untouched by the updates (M.4).
    for (const { install } of both) {
      const planted = markers.get(install.name);
      if (!planted) throw new Error(`no markers for ${install.name}`);
      expect(changedMarkers(planted), install.name).toEqual([]);
    }
    // Secrets: the publish token, the signing key and the git tokens reached no row or record.
    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.humanRequest.list(),
      await w.store.release.list(),
      await w.store.changeLog.list(),
      alice.notifications(),
      bob.notifications(),
      alice.pointer(),
      bob.pointer(),
    ]);
    expect(dump).not.toContain(feed.token);
    expect(dump).not.toContain(feed.key.privateKey);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  }, 120_000);

  it("a deliberately broken build installs on one install, fails its health check and rolls back on its own; the other install never takes it after the shared release row says it broke", async () => {
    const byJ = { kind: "human" as const, id: w.j.id };
    const byM = { kind: "human" as const, id: w.m.id };
    expect(alice.running.version).toBe(SHIPPED);
    expect(bob.running.version).toBe(SHIPPED);
    // An hour on (the notifier's dedupe window is ten minutes); the broken build is a release
    // like any other: signed with the build key, newer, schema-compatible.
    await w.clock.advance(60 * 60_000);
    const since = w.clock.nowIso();
    const broken = await releaseFromMain(w, feed, {
      version: BROKEN,
      prNumber: prNumber + 1,
      request: BROKEN_REQUEST,
      broken: CRASH,
    });
    expect(broken.published.signed.signature?.keyId).toBe(feed.key.keyId);

    // --- Clause: a deliberately broken build installs (on Alice's install) ------------------
    await later();
    const check = await alice.manager.check(byJ, { fresh: true });
    expect(check.available?.version).toBe(BROKEN);
    expect(check.rejected).toEqual([]);
    await later();
    const applied = await alice.manager.apply({ by: byJ });
    expect(applied).toMatchObject({ version: BROKEN, previous: SHIPPED });
    expect(applied.pointer).toMatchObject({
      current: BROKEN,
      previous: SHIPPED,
      state: "pending_health_check",
    });
    expect(alice.running.version).toBe(BROKEN);
    expect(alice.manager.status().versionsOnDisk).toEqual([SHIPPED, BROKEN]);
    expect((await w.store.release.list({ release_version: BROKEN }))[0]?.status).toBe("published");

    // --- Clause: fails its health check and rolls back on its own --------------------------
    await later();
    const outcome = await alice.manager.healthCheck();
    expect(outcome.kind).toBe("rolled_back");
    if (outcome.kind !== "rolled_back") throw new Error("no rollback");
    expect(outcome).toMatchObject({ from: BROKEN, to: SHIPPED });
    expect(outcome.reason).toContain("doctor exited 1");
    expect(outcome.reason).toContain(CRASH);
    expect(alice.pointer()).toMatchObject({
      current: SHIPPED,
      previous: null,
      state: "installed",
      lastRollback: { from: BROKEN, to: SHIPPED, automatic: true, reason: outcome.reason },
    });
    expect(alice.pointer()?.lastRollback?.at).toBe(w.clock.nowIso());
    expect(alice.restarter.requests.slice(-2)).toEqual([
      { reason: "update", targetVersion: BROKEN, fromVersion: SHIPPED },
      { reason: "rollback", targetVersion: SHIPPED, fromVersion: BROKEN },
    ]);
    expect(alice.running.version).toBe(SHIPPED);
    expect(alice.manager.installedVersion()).toBe(SHIPPED);
    // The build it went back to is the one with the UI change.
    expect(
      readFileSync(
        join(updates.versionDir(alice.dirs, SHIPPED), ...BADGE_ARTEFACT.split("/")),
        "utf8",
      ),
    ).toBe(BADGE_AFTER);
    // The shared release row carries the verdict.
    const brokenRow = (await w.store.release.list({ release_version: BROKEN }))[0];
    expect(brokenRow?.status).toBe("rolled_back");
    expect(brokenRow?.health).toMatchObject({ ok: false, probe: "doctor", detail: outcome.reason });
    expect((await w.store.release.list({ release_version: SHIPPED }))[0]?.status).toBe("installed");
    // Audit rows of J since the hour: check, apply with its check, the automatic rollback.
    const rows = (await updaterRows(w, w.j.id)).filter((r) => r.occurred_at > since);
    expect(rows.map((r) => r.tool).sort()).toEqual([
      "update.apply",
      "update.check",
      "update.check",
      "update.rollback",
    ]);
    expect(rows.every((r) => r.allowed)).toBe(true);
    const rollbackRow = rows.find((r) => r.tool === "update.rollback");
    expect(rollbackRow?.input_summary).toBe(
      `automatic rollback: health check of ${BROKEN} failed (doctor)`,
    );
    expect(rollbackRow?.result_summary).toBe(`rolled back to ${SHIPPED}: ${outcome.reason}`);
    expect(rollbackRow?.human_id).toBe(w.j.id);
    expect(rollbackRow?.agent_id).toBeNull();
    // The notification: the updater's inbox item and the notifier's record, J's only.
    const inbox = await w.store.humanRequest.list(
      { human_id: w.j.id, author_agent: updates.UPDATE_REQUEST_AUTHOR },
      { orderBy: "created_at desc" },
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ kind: "info", status: "open", blocking: false, risk: "high" });
    expect(inbox[0]?.why).toContain(`Update ${BROKEN} rolled back`);
    expect(inbox[0]?.why).toContain(`went back to ${SHIPPED}`);
    expect(inbox[0]?.why).toContain(CRASH);
    const records = alice.notifications();
    expect(records.map((r) => r.notification.kind)).toEqual([
      "update_applied",
      "update_applied",
      "update_applied",
    ]);
    expect(records[0]?.notification.title).toBe(`Rolled back to ${SHIPPED} (from ${BROKEN})`);
    expect(records[0]?.notification.body).toContain("did not pass its health check");
    expect(records[0]).toMatchObject({ urgency: "normal", outcome: "delivered" });
    // No human request was opened or answered for any of it.
    expect(await w.store.humanRequest.list({ kind: "approval" })).toHaveLength(0);
    expect(
      (await w.store.humanRequest.list({ author_agent: updates.UPDATE_REQUEST_AUTHOR })).every(
        (r) => r.answered_at === null,
      ),
    ).toBe(true);

    // --- Clause: the other install never takes it ----------------------------------------
    // Bob's install reads the same release table: the row Alice's rollback marked
    // `rolled_back` makes 1.2.0 `previously_rejected` for him before any download.
    await later();
    const bobCheck = await bob.manager.check(byM, { fresh: true });
    expect(bobCheck.available).toBeNull();
    expect(bobCheck.runningVersion).toBe(SHIPPED);
    expect(bobCheck.rejected).toEqual([
      { version: BROKEN, reason: "previously_rejected", message: expect.stringContaining(BROKEN) },
    ]);
    const bobView = await updates.composeUpdatesView({ manager: bob.manager, clock: w.clock });
    expect(bobView.app).toMatchObject({
      state: "rejected",
      currentVersion: SHIPPED,
      available: null,
      rejected: [expect.objectContaining({ version: BROKEN, reason: "previously_rejected" })],
    });
    await expect(bob.manager.apply({ by: byM, version: BROKEN })).rejects.toMatchObject({
      details: { reason: "previously_rejected" },
    });
    const refused = (await updaterRows(w, w.m.id)).filter((r) => r.occurred_at > since);
    expect(refused.map((r) => [r.tool, r.allowed, r.denied_reason])).toEqual(
      expect.arrayContaining([["update.apply", false, "previously_rejected"]]),
    );
    expect(refused.filter((r) => r.tool === "update.apply")).toHaveLength(1);
    expect(refused.some((r) => r.tool === "update.rollback" || r.tool === "update.health")).toBe(
      false,
    );
    // Nothing moved on Bob's install: pointer, running version, disk, restarts, inbox.
    expect(bob.pointer()).toMatchObject({
      current: SHIPPED,
      previous: PACKAGED,
      state: "installed",
      lastRollback: null,
    });
    expect(bob.running.version).toBe(SHIPPED);
    expect(bob.manager.status().versionsOnDisk).toEqual([SHIPPED]);
    expect(bob.restarter.requests).toEqual([
      { reason: "update", targetVersion: SHIPPED, fromVersion: PACKAGED },
    ]);
    expect(bob.probe.checks.map((c) => c.version)).toEqual([SHIPPED]);
    expect(bob.notifications().map((r) => r.notification.kind)).toEqual(["update_applied"]);
    expect(
      await w.store.humanRequest.list({
        human_id: w.m.id,
        author_agent: updates.UPDATE_REQUEST_AUTHOR,
      }),
    ).toHaveLength(0);
    // Alice's install never offers it again either; a prune drops it.
    const again = await alice.manager.check(byJ, { fresh: true });
    expect(again.available).toBeNull();
    expect(again.rejected.map((r) => [r.version, r.reason])).toEqual([
      [BROKEN, "previously_rejected"],
    ]);
    expect(alice.manager.prune()).toEqual([BROKEN]);
    expect(alice.manager.status().versionsOnDisk).toEqual([SHIPPED]);

    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.humanRequest.list(),
      await w.store.release.list(),
      alice.notifications(),
      bob.notifications(),
    ]);
    expect(dump).not.toContain(feed.token);
    expect(dump).not.toContain(feed.key.privateKey);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  }, 60_000);

  it("the weekly model watch proposes a switch with measured quality and cost deltas; J's adopt applies it; the next weekly run keeps it and proposes nothing", async () => {
    const tasks = coderEvalTasks(EVAL_TASKS);
    expect(tasks).toHaveLength(EVAL_TASKS);
    const failing = tasks[2]?.id ?? "";
    // The probes: the sonnet rung's model fails one task at every effort, the candidate none.
    w.provider.pushReplies(
      ...evalProbeReplies({
        models: ["fake-sonnet", CANDIDATE_MODEL],
        fails: [{ model: "fake-sonnet", taskId: failing }],
      }),
    );
    const mw: ScenarioModelWatch = scenarioModelWatch(w, w.alice, {
      configDir: alice.dirs.config,
      workRoot: join(w.root, "model-watch"),
      tasks,
    });
    expect(mw.schedule).toMatchObject({
      id: MODEL_WATCH_SCHEDULE_ID,
      agentId: MODEL_WATCH_AGENT_ID,
      kind: "every",
      everyMinutes: WEEK_MINUTES,
      timezone: w.j.timezone,
      enabled: true,
    });
    expect(existsSync(mw.settings.modelsPath)).toBe(false);
    expect(existsSync(mw.settings.pricingPath)).toBe(false);

    // --- Clause: a weekly model-watch run ... ----------------------------------------------
    await later();
    const weekOne = w.clock.nowIso();
    await mw.tick();
    expect(mw.runs).toHaveLength(1);
    const first = mw.runs[0];
    if (!first) throw new Error("the schedule did not fire");
    expect(first.request).toMatchObject({ agentId: MODEL_WATCH_AGENT_ID, trigger: "schedule" });
    expect(first.at).toBe(weekOne);
    const run1 = await first.result;
    const report = run1.report;
    expect(report.providers).toEqual([
      {
        name: "fake",
        listed: expect.arrayContaining([{ id: CANDIDATE_MODEL, tier: "sonnet" }]),
        error: null,
      },
    ]);
    expect(report.providers[0]?.listed).toHaveLength(5);
    expect(report.price_list).toMatchObject({ source: "fixture", as_of: "2026-11-02", models: 1 });
    expect(report.diff.new_models).toEqual([
      expect.objectContaining({
        provider: "fake",
        id: CANDIDATE_MODEL,
        tier: "sonnet",
        priced: true,
        price_origin: "price_list",
      }),
    ]);
    expect(report.diff.retired_models).toEqual([]);
    expect(report.diff.repriced).toEqual([]);
    expect(report.diff.unpriced).toEqual([]);

    // --- Clause: ... on the fake provider, the eval set measured -----------------------------
    // Three eval runs over the real coder tasks: the baseline, one effort lower, the candidate;
    // the grader ran the checks on the files the driver wrote; the costs are the usage priced.
    const perTask = (model: string, effort: string) => {
      const usage = { low: 250, medium: 500 }[effort] ?? 0;
      const price = model === CANDIDATE_MODEL ? { in: 1.5, out: 7.5 } : { in: 3, out: 15 };
      return 1000 * price.in + usage * price.out;
    };
    expect(
      report.evals.map((e) => [
        e.role,
        e.model,
        e.effort,
        e.passed,
        e.failed,
        e.total,
        e.cost_usd_micro,
      ]),
    ).toEqual([
      [
        "baseline",
        "fake-sonnet",
        "medium",
        3,
        1,
        EVAL_TASKS,
        EVAL_TASKS * perTask("fake-sonnet", "medium"),
      ],
      [
        "lower_effort",
        "fake-sonnet",
        "low",
        3,
        1,
        EVAL_TASKS,
        EVAL_TASKS * perTask("fake-sonnet", "low"),
      ],
      [
        "candidate",
        CANDIDATE_MODEL,
        "medium",
        4,
        0,
        EVAL_TASKS,
        EVAL_TASKS * perTask(CANDIDATE_MODEL, "medium"),
      ],
    ]);
    expect(report.evals.every((e) => e.skipped_reason === null && e.needs_model === 0)).toBe(true);
    expect(report.eval_cost_usd_micro).toBe(
      EVAL_TASKS *
        (perTask("fake-sonnet", "medium") +
          perTask("fake-sonnet", "low") +
          perTask(CANDIDATE_MODEL, "medium")),
    );
    expect(report.eval_cost_usd_micro).toBeLessThan(report.eval_budget_usd_micro);
    expect(report.skipped).toEqual([]);
    // The probes went to the fake provider once per task, effort and model.
    const probes = w.provider.calls.filter((c) => {
      const first = c.request.messages[0];
      return typeof first?.content === "string" && first.content.startsWith("model-watch eval ");
    });
    expect(probes).toHaveLength(3 * EVAL_TASKS);
    expect(new Set(probes.map((c) => `${c.request.model}@${c.request.effort}`))).toEqual(
      new Set(["fake-sonnet@medium", "fake-sonnet@low", `${CANDIDATE_MODEL}@medium`]),
    );

    // --- Clause: proposes a switch with measured deltas ------------------------------------
    const switchRec = report.recommendations.find((r) => r.kind === "switch_model");
    expect(switchRec).toMatchObject({
      kind: "switch_model",
      provider: "fake",
      rung: "sonnet",
      from: "fake-sonnet",
      to: CANDIDATE_MODEL,
      quality_delta_points: 25,
      min_quality_delta_points: 25,
      cost_delta_pct: -50,
    });
    expect(switchRec?.evidence).toEqual([
      `coder: 4/4 passed at medium vs 3/4 on fake-sonnet; cost -50%`,
    ]);
    expect(switchRec?.text).toContain("quality +25 points, cost -50%");
    const lowerRec = report.recommendations.find((r) => r.kind === "lower_effort");
    expect(lowerRec).toMatchObject({
      kind: "lower_effort",
      mode: "coder",
      specialist: "coder",
      model: "fake-sonnet",
      from: "medium",
      to: "low",
      pass_rate: 0.75,
      baseline_pass_rate: 0.75,
      cost_delta_pct: -35.71,
    });
    expect(report.recommendations).toHaveLength(2);
    expect(report.pricing_proposal).toEqual({
      [CANDIDATE_MODEL]: expect.objectContaining({
        input_per_mtok_usd: 1.5,
        output_per_mtok_usd: 7.5,
        as_of: "2026-11-02",
        source: "list",
      }),
    });
    expect(report.summary).toContain("2 recommendation(s)");

    // --- Clause: the human approves: a decision in the inbox, nothing applied before ---------
    expect(run1.decision).toBe("pending");
    expect(run1.applied).toEqual([]);
    expect(run1.release).toMatchObject({
      channel: MODEL_WATCH_CHANNEL,
      release_version: report.id,
      status: "published",
    });
    const decision = (await w.humanRequests(w.j, { status: "open" })).find(
      (r) => r.id === run1.requestId,
    );
    expect(decision).toMatchObject({
      kind: "decision",
      options: ["adopt", "ignore", "remind"],
      blocking: false,
      risk: "medium",
      author_agent: w.alice.agent.id,
    });
    expect(decision?.change_card).toMatchObject({ key: `model_watch:${report.id}` });
    expect(decision?.steps).toEqual(
      expect.arrayContaining([
        switchRec?.text,
        lowerRec?.text,
        expect.stringContaining(CANDIDATE_MODEL),
      ]),
    );
    expect(await w.humanRequests(w.m, { status: "open" })).toHaveLength(0);
    expect(existsSync(mw.settings.modelsPath)).toBe(false);
    expect(existsSync(mw.settings.pricingPath)).toBe(false);
    expect(await mw.watch.syncPendingAnswers()).toBe(0);
    expect(mw.adopted).toEqual([]);
    // The updates screen lists the model recommendation next to the app's update state (M.5).
    const view = await updates.composeUpdatesView({
      manager: alice.manager,
      clock: w.clock,
      modelWatch: new ModelWatchUpdates(mw.watch),
    });
    expect(view.app).toMatchObject({ currentVersion: SHIPPED, runningVersion: SHIPPED });
    expect(view.models.map((m) => [m.kind, m.model])).toEqual([
      ["new_model", CANDIDATE_MODEL],
      ["recommendation", "fake-sonnet"], // the lower effort on the rung's model
      ["recommendation", CANDIDATE_MODEL], // the switch
    ]);
    expect(view.models[2]?.recommendedAction).toContain(
      `Decide in the inbox (request ${decision?.id})`,
    );
    expect(view.models[2]?.evidence).toEqual(switchRec?.evidence);
    expect(view.models[1]?.summary).toBe(lowerRec?.text);

    // --- Clause: the human's approval applies it ------------------------------------------
    await later();
    await w.store.humanRequest.answer(decision?.id ?? "", decision?.version ?? 1, "adopt", w.j.id);
    expect(await mw.watch.syncPendingAnswers()).toBe(1); // the daemon's tick does this
    const adoptedAt = w.clock.nowIso();
    const after = await mw.watch.getReport(report.id);
    expect(after.health).toMatchObject({
      decision: "adopted",
      request_id: decision?.id,
      decided_at: adoptedAt,
      by: w.j.id,
      applied: [
        `pricing overrides written for ${CANDIDATE_MODEL}`,
        `ladder sonnet/fake: fake-sonnet -> ${CANDIDATE_MODEL}`,
        "effort coder: medium -> low",
      ],
    });
    expect(after.release.status).toBe("installed");
    // The files the daemon reads, under this install's config directory.
    const models = modelSettings.parseModelSettings(readFileSync(mw.settings.modelsPath, "utf8"));
    expect(models.ladder.sonnet?.fake).toBe(CANDIDATE_MODEL);
    expect(models.efforts.coder).toBe("low");
    expect(models.history).toEqual([
      expect.objectContaining({ report_id: report.id, by: w.j.id, at: adoptedAt }),
    ]);
    const pricing = parsePricingOverrides(readFileSync(mw.settings.pricingPath, "utf8"));
    expect(pricing[CANDIDATE_MODEL]).toMatchObject({
      input_per_mtok_usd: 1.5,
      output_per_mtok_usd: 7.5,
    });
    expect(mw.settings.modelsPath.startsWith(alice.dirs.config)).toBe(true);
    // The tables in force were handed to the runtime: the coder's rung and effort changed.
    expect(mw.adopted).toHaveLength(1);
    const adopted = mw.adopted[0];
    expect(adopted).toMatchObject({ reportId: report.id, by: w.j.id });
    expect(modelIdFor("sonnet", "fake", adopted?.config.ladder)).toBe(CANDIDATE_MODEL);
    expect(modelIdFor("sonnet", "fake")).toBe("fake-sonnet");
    expect(effortForTask("coder", 1, 0, adopted?.config.modeDefaults)).toBe("low");
    expect(effortForTask("coder", 1)).toBe("medium");
    expect(adopted?.pricing[CANDIDATE_MODEL]?.input_per_mtok_usd).toBe(1.5);
    // Every step is an audit row of J's, none denied.
    const watchRows = (await w.auditRows({ humanId: w.j.id })).filter((r) =>
      r.tool.startsWith("model_watch."),
    );
    expect(watchRows.map((r) => r.tool)).toEqual([
      "model_watch.price_list",
      "model_watch.eval",
      "model_watch.eval",
      "model_watch.eval",
      "model_watch.report",
      "model_watch.request",
      "model_watch.write_pricing",
      "model_watch.write_settings",
      "model_watch.decision",
      "model_watch.reload",
    ]);
    expect(watchRows.every((r) => r.allowed)).toBe(true);
    expect(
      watchRows.filter((r) => r.tool === "model_watch.eval").map((r) => r.cost_usd_micro),
    ).toEqual([
      EVAL_TASKS * perTask("fake-sonnet", "medium"),
      EVAL_TASKS * perTask("fake-sonnet", "low"),
      EVAL_TASKS * perTask(CANDIDATE_MODEL, "medium"),
    ]);
    expect(watchRows.find((r) => r.tool === "model_watch.decision")?.result_summary).toContain(
      `ladder sonnet/fake: fake-sonnet -> ${CANDIDATE_MODEL}`,
    );
    expect((await w.store.humanRequest.mustGet(decision?.id ?? "")).status).toBe("answered");

    // --- Clause: weekly: a day later nothing fires; a week later it fires again -------------
    await w.clock.advance(24 * 60 * 60_000);
    await mw.tick();
    expect(mw.runs).toHaveLength(1);
    await w.clock.advance(6 * 24 * 60 * 60_000);
    await mw.tick();
    expect(mw.runs).toHaveLength(2);
    const second = mw.runs[1];
    if (!second) throw new Error("the schedule did not fire a week later");
    // The scheduler fires on the first minute tick after the week has passed (here a minute
    // later than a week: the adopt happened a minute after the first run).
    const gapMs = new Date(second.at).getTime() - new Date(first.at).getTime();
    expect(gapMs).toBeGreaterThanOrEqual(WEEK_MINUTES * 60_000);
    expect(gapMs).toBeLessThanOrEqual(WEEK_MINUTES * 60_000 + 60_000);
    const run2 = await second.result;
    // The adopted model is the baseline at the adopted effort; the old one is a candidate that
    // passes less and costs more, so nothing is proposed and nobody is asked.
    expect(run2.report.evals.map((e) => [e.role, e.model, e.effort, e.passed, e.total])).toEqual([
      ["baseline", CANDIDATE_MODEL, "low", 4, EVAL_TASKS],
      ["candidate", "fake-sonnet", "low", 3, EVAL_TASKS],
    ]);
    expect(run2.report.diff.new_models.map((m) => m.id)).toEqual(["fake-sonnet"]);
    expect(run2.report.diff.retired_models).toEqual([]);
    expect(run2.report.diff.repriced).toEqual([]);
    expect(run2.report.recommendations).toEqual([]);
    expect(run2.report.pricing_proposal).toEqual({});
    expect(run2).toMatchObject({ decision: "nothing_to_decide", requestId: null, applied: [] });
    // J's only open item is still the rollback notice of the broken build; no decision.
    expect((await w.humanRequests(w.j, { status: "open" })).map((r) => r.kind)).toEqual(["info"]);
    expect(await w.store.humanRequest.list({ kind: "decision", status: "open" })).toHaveLength(0);
    expect(mw.adopted).toHaveLength(1);
    expect((await mw.watch.listReports()).map((r) => [r.id, r.status, r.decision])).toEqual([
      [run2.report.id, "published", "nothing_to_decide"],
      [report.id, "installed", "adopted"],
    ]);

    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.humanRequest.list(),
      await w.store.release.list(),
    ]);
    expect(dump).not.toContain(feed.token);
    expect(dump).not.toContain(feed.key.privateKey);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  }, 120_000);

  // Guard on the harness itself, not a gate clause: a probe the script does not answer must
  // fail the eval run loudly. A bare `FakeProvider` echoes an unscripted prompt (its default
  // `onNoMatch`; the world's provider throws instead), and `runEvalSet` records a throwing
  // driver as an errored task that counts as failed, so without the guard a model added to
  // the listing without a script would show up as a quality delta in the report, never as
  // a "no scripted reply" error.
  it("guard: the eval probe driver refuses an answer that is neither PASS nor FAIL, so a scripting gap is an error and not a measured delta", async () => {
    const echo = new FakeProvider({ latency: "none", clock: w.clock });
    const runner = evalRunnerOnWorld(
      w,
      new ProviderRegistry().register(echo),
      coderEvalTasks(1),
      join(w.root, "model-watch-guard"),
    );
    await expect(
      runner.run({
        specialist: "coder",
        provider: echo.name,
        model: "fake-sonnet",
        effort: "medium",
        pricing: WATCH_PRICING,
      }),
    ).rejects.toThrow(/answered neither PASS nor FAIL/);
    expect(echo.calls).toHaveLength(1);
  });
});
