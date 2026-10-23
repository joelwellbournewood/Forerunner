/**
 * Scenario 9, "From the phone, by talking" (spec, Phase 8): "On the Android app J says
 * 'switch to the game, give it 15 francs until tomorrow and start a session on my PC'. He
 * gets one change card, confirms, the PC starts, and the change log shows it with undo."
 *
 * Fake provider, no network beyond 127.0.0.1, simulated clock. Two projects; J's PC has the
 * first one active. The phone side runs the Android app's own code: the sentence goes
 * through `apps/ui/src/mobile/intent.ts` (three commands), the one card for the plan comes
 * from `apps/ui/src/mobile/change-card.ts`, and after the tap the app's plan envelope
 * (ADR 0032 item 4; the verb from the app's `verbForPlan` and the client id from its
 * `newClientId`, both loaded at run time from `apps/ui/src/api/state-client.ts`) is sent as
 * ONE signed `POST /remote/commands` to the REAL state service (`services/state-api`, in process over
 * the world's store) by a phone paired through the real pairing routes with a real Ed25519
 * key. The PC side is the daemon's own `RemoteCommandWatcher` (`packages/runtime/src/remote`,
 * ADR 0041) on the install's kill switch, scheduler and command registry: it takes the row
 * from the shared store, re-plans the envelope against the real state, files the one change
 * card and applies the phone's tap to it as the one confirmation, and the registry does the
 * project switch, the temporary budget in CHF at the billing rate, and the session the
 * install's scheduler starts (`tests/e2e/src/scenario-phone.ts`). Asserted on the remote
 * command rows, the change log, the card's request row, the project settings, the session
 * row and events, the scheduler log, the PR on the game's repository, the messages and the
 * audit rows; then the change is undone from the log.
 *
 * What cannot run here, and what stands in for it: the Android emulator and the screens are
 * not driven (the sentence enters at the parser the Chat screen calls, the tap is the
 * envelope's `confirmedAt`). Windows and Android: the same code runs on both (paths and
 * processes through @forerunner/platform); the final-build runs are recorded in gates.md.
 */
import {
  type CommandLoop,
  REMOTE_AUDIT_TOOL,
  type RemoteCommandWatcher,
} from "@forerunner/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startOfTomorrow } from "../../../apps/ui/src/mobile/time.ts";
import { chfToUsdMicro, FixedRateSource } from "../../../packages/billing/src/index.ts";
import {
  commandLoopFor,
  commandTurnFor,
  conversationAgentFor,
  SCENARIO_CHF_PER_USD,
} from "../src/scenario-commands.ts";
import {
  type AppMobile,
  loadAppMobile,
  type PhoneClient,
  pcWatcherFor,
  phoneConfirmsAndSends,
  phoneContext,
  phoneUnderstands,
  type RemoteCommandView,
  type ScenarioStateService,
  stateServiceFor,
} from "../src/scenario-phone.ts";
import { coderWrites, criticAccepts } from "../src/scenario-scripts.ts";
import { type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";

const START = "2026-11-03T13:00:00Z"; // 14:00 Europe/Zurich
const SENTENCE =
  "switch to the game, give it 15 francs until tomorrow and start a session on my PC";
const GAME_TASK = "Trading loop skeleton";
const GAME_REPO = { owner: "sample", name: "game" };
const CHF_15 = 15_000_000;

describe("scenario 9: from the phone, by talking", () => {
  let w: ScenarioWorld;
  let service: ScenarioStateService;
  let phone: PhoneClient;
  let commands: CommandLoop;
  let watcher: RemoteCommandWatcher | null = null;
  let app: AppMobile;
  let game: { id: string; name: string };
  let pcDeviceId: string;
  let sessionId: string;
  beforeAll(async () => {
    w = await scenarioWorld({ start: START });
    // The second project, with its own repository in the fake git host.
    await w.gitHost.createRepo({
      ...GAME_REPO,
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# game\n\nA browser space trading game.\n" },
    });
    const row = await w.store.project.insert({
      name: "Space game",
      goal: "A browser space trading game with a weekly release",
      repos: [`${GAME_REPO.owner}/${GAME_REPO.name}`],
      stage: "build",
      status: "active",
      budget_usd_micro: 62_500_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [w.alice.agent.id, w.bob.agent.id] },
      small_project_mode: false,
      active: true,
      author_human: w.j.id,
    });
    game = { id: row.id, name: row.name };
    // The PC: its own device row; the registry and a conversation session for the change log.
    pcDeviceId = (
      await w.store.device.register({
        owner_human_id: w.j.id,
        name: "J's PC",
        platform: "linux",
        public_key: "pc-public-key",
        kind: "desktop",
      })
    ).id;
    commands = await commandLoopFor(w, w.alice);
    sessionId = await conversationAgentFor(w, w.alice, commands).conversationSessionId(
      w.alice.agent.id,
      w.project.id,
    );
    service = await stateServiceFor(w);
    phone = await service.pairPhone(w.j.id, "J's phone");
    app = await loadAppMobile();
  });
  afterAll(async () => {
    watcher?.stop();
    commands?.stop();
    await service?.close();
    await w?.close();
  });

  it("one change card, confirmed once, the PC switches, budgets and starts, the change log shows it with undo", async () => {
    // --- The day so far: the PC has the sample project active (a switch from the desktop UI) --
    const uiTurn = commandTurnFor(w.alice, sessionId, { source: "text", wordsUsed: "" });
    const prior = await commands.execute(
      { name: "project.switch", params: { project: w.project.id } },
      uiTurn,
    );
    expect(prior.status).toBe("done");
    expect(await commands.activeProject(w.j.id)).toBe(w.project.id);
    const rate = await new FixedRateSource(SCENARIO_CHF_PER_USD).chfPerUsd(w.clock.nowIso());
    const until = new Date(startOfTomorrow(w.clock.now(), w.j.timezone)).toISOString();
    expect(until).toBe("2026-11-04T05:00:00.000Z"); // 06:00 Europe/Zurich the next morning
    const sessionCapUsd = chfToUsdMicro(CHF_15, rate);
    expect(sessionCapUsd).toBe(18_750_000);
    // The work the started session will find on the game.
    w.provider.pushReplies(
      ...coderWrites(GAME_TASK, { "src/trade.ts": "export const trade = () => 'buy';\n" }),
      ...criticAccepts(),
    );
    const gameTask = await w.store.task.insert({
      project_id: game.id,
      title: GAME_TASK,
      outcome: "src/trade.ts exports the trading loop entry point",
      acceptance_criteria: ["src/trade.ts exists"],
      risk_tier: 1,
      status: "ready",
      priority: 50,
      depends_on: [],
      budget_usd_micro: 1_000_000,
      est_cost_usd_micro: 50_000,
      actual_cost_usd_micro: 0,
      attempt: 0,
      reason: "planned",
      specialist: "coder",
      author_human: w.j.id,
    });

    // --- Clause: on the phone, J says the sentence ------------------------------------------
    const projects = await phone.get<{ projects: Parameters<typeof phoneContext>[1] }>("/projects");
    expect(projects.status).toBe(200);
    expect(projects.body.projects.map((p) => p.name).sort()).toEqual([
      "Sample service",
      "Space game",
    ]);
    const ctx = phoneContext(app, projects.body.projects, {
      timezone: w.j.timezone,
      now: w.clock.now(),
      activeProjectId: w.project.id,
      source: "voice",
    });
    const said = phoneUnderstands(app, SENTENCE, ctx);
    expect(said.intent.matched).toBe("pattern");
    expect(said.intent.unmatched).toEqual([]);
    expect(said.plan).toEqual([
      { name: "project.switch", params: { project: game.id } },
      { name: "budget.set", params: { scope: "session", amountChf: 15, project: game.id, until } },
      { name: "session.start", params: { project: game.id, runner: "pc" } },
    ]);

    // --- Clause: he gets ONE change card ----------------------------------------------------
    const card = said.card;
    expect(card.command).toBe("compose");
    expect(card.parts?.map((p) => p.command)).toEqual([
      "project.switch",
      "budget.set",
      "session.start",
    ]);
    expect(card).toMatchObject({
      projectId: game.id,
      projectName: game.name,
      expiresAt: until,
      reversible: true,
      impact: { risk: "medium" },
    });
    expect(card.parts?.[0]).toMatchObject({ oldValue: "Sample service", newValue: "Space game" });
    expect(card.parts?.[1]).toMatchObject({
      newValue: "CHF 15",
      expiresAt: until,
      scope: "session",
    });
    // The phone's preview of the start: the registry prices the session from the budget the
    // second step sets, which the card builder on the phone does not know yet.
    expect(card.parts?.[2]).toMatchObject({
      command: "session.start",
      what: "a session on Space game on your PC",
      newValue: "running",
      scope: "session",
    });
    expect(card.sentence).toContain("Switched the active project to Space game. Undo.");

    // --- Clause: he confirms once: one signed request, one envelope, one remote command ----
    const confirmedAt = w.clock.nowIso();
    const sent = await phoneConfirmsAndSends(phone, app, {
      plan: said.plan,
      card,
      words: SENTENCE,
      confirmedAt,
    });
    // The app's `newClientId`: a UUID on a runtime with one (32 hex characters otherwise).
    expect(sent.envelope.clientId).toMatch(/^[0-9a-f-]{32,36}$/);
    expect(sent.row).toMatchObject({
      status: "pending",
      target: "pc",
      command: "start",
      deviceId: phone.deviceId,
      targetDeviceId: null,
    });
    expect(sent.row.params).toMatchObject({
      v: 1,
      kind: "plan",
      wordsUsed: SENTENCE,
      confirmedAt,
      clientId: sent.envelope.clientId,
    });
    expect((sent.row.params as { plan: unknown[] }).plan).toHaveLength(3);
    const mine = await phone.get<{ commands: RemoteCommandView[] }>("/remote/commands");
    expect(mine.body.commands.map((c) => c.id)).toEqual([sent.row.id]);
    expect((await w.store.remoteCommand.list()).map((r) => r.id)).toEqual([sent.row.id]);
    // The device row the phone got at pairing is a phone of J's; the signature was checked.
    const phoneDevice = await w.store.device.mustGet(phone.deviceId);
    expect(phoneDevice).toMatchObject({ kind: "phone", owner_human_id: w.j.id, revoked: false });

    // --- Clause: the PC picks the command up and runs the plan through the registry --------
    const handledRows: { id: string; result: Record<string, unknown> }[] = [];
    const handled = new Promise<void>((resolve) => {
      watcher = pcWatcherFor(w, {
        commands,
        install: w.alice,
        pcDeviceId,
        sessionId,
        pollMs: 500,
        onHandled: (row, result) => {
          handledRows.push({ id: row.id, result });
          resolve();
        },
      });
    });
    const pc = watcher as RemoteCommandWatcher | null;
    if (!pc) throw new Error("no watcher");
    pc.start();
    await w.clock.advance(500); // the poll tick, on the clock as the daemon runs it
    await handled;
    pc.stop();
    expect(pc.stats.handled).toBe(1);
    expect(handledRows.map((h) => h.id)).toEqual([sent.row.id]);
    const done = await phone.get<RemoteCommandView>(`/remote/commands/${sent.row.id}`);
    expect(done.body).toMatchObject({ status: "done", pickedUpAt: expect.any(String) });
    expect(done.body.result).toMatchObject({
      kind: "plan",
      status: "done",
      executed: ["project.switch", "budget.set", "session.start"],
      commands: ["project.switch", "budget.set", "session.start"],
      clientId: sent.envelope.clientId,
    });
    const changeLogId = (done.body.result as { changeLogId: string }).changeLogId;
    expect(changeLogId).toBeTruthy();
    const pickupAudit = (await w.store.auditLog.list()).filter((r) => r.tool === REMOTE_AUDIT_TOOL);
    expect(pickupAudit).toHaveLength(1);
    expect(pickupAudit[0]).toMatchObject({
      allowed: true,
      human_id: w.j.id,
      agent_id: w.alice.agent.id,
    });
    expect(pickupAudit[0]?.input_summary).toContain(sent.row.id);
    expect(JSON.parse(pickupAudit[0]?.input_summary ?? "{}")).toMatchObject({
      kind: "plan",
      commands: ["project.switch", "budget.set", "session.start"],
    });
    // One confirmation: the registry re-planned the envelope into ONE medium-risk card, and
    // the tap the phone recorded answered it; nothing waits for a second yes.
    const cardRows = (await w.store.humanRequest.list()).filter(
      (r) => r.human_id === w.j.id && r.change_card && r.created_at >= confirmedAt,
    );
    expect(cardRows).toHaveLength(1);
    expect(cardRows[0]).toMatchObject({
      status: "answered",
      answered_by: w.j.id,
      kind: "approval",
    });
    expect(cardRows[0]?.answer).toMatchObject({ verdict: "confirmed", kind: "tap", by: w.j.id });
    expect(cardRows[0]?.change_card).toMatchObject({
      command: "compose",
      decision: "needs_yes",
      words_used: SENTENCE,
    });
    const cardJson = cardRows[0]?.change_card as { parts?: unknown[] } | null | undefined;
    expect(cardJson?.parts).toHaveLength(3);
    expect(commands.pending(w.j.id)).toHaveLength(0);
    expect(await w.humanRequests(w.j, { status: "open" })).toHaveLength(0);

    // --- Clause: the project switch -------------------------------------------------------
    expect(await commands.activeProject(w.j.id)).toBe(game.id);

    // --- Clause: the 15 CHF budget until tomorrow, CHF converted through the billing rate --
    const gameRow = await w.store.project.mustGet(game.id);
    expect(gameRow.settings.session_budget_override).toEqual({
      cap_usd_micro: sessionCapUsd,
      cap_chf_micro: CHF_15,
      rate_chf_per_usd: rate,
      expires_at: until,
    });
    expect(
      (await w.store.project.mustGet(w.project.id)).settings.session_budget_override,
    ).toBeUndefined();

    // --- Clause: the session starts on the PC --------------------------------------------
    const started = await w.scheduledResult(w.alice);
    const session = await w.store.session.mustGet(started.sessionId);
    expect(session).toMatchObject({
      agent_id: w.alice.agent.id,
      project_id: game.id,
      trigger: "remote",
      runner: "pc",
      budget_cap_usd_micro: sessionCapUsd,
      status: "completed",
    });
    expect((session.started_at ?? "") >= confirmedAt).toBe(true);
    const log = w.alice.scheduler.log.filter((l) => l.result === "started");
    expect(log).toHaveLength(1);
    expect(log[0]?.req).toMatchObject({
      trigger: "remote",
      projectId: game.id,
      agentId: w.alice.agent.id,
    });
    // "via chat", not "via phone": the change sources of the state schema (`CHANGE_SOURCES` in
    // @forerunner/state) have no phone value, and the daemon's `CommandLoop` maps the
    // watcher's turn source `phone` to `chat` (`SOURCE_OF` in
    // packages/runtime/src/loop/commands.ts); the tap answer's own `source` is never read by
    // the executor. The same mapped value is on the change log row and the `change` event
    // below. A `phone` change source would be a state schema decision, not this scenario's.
    expect(log[0]?.req.reason).toBe(`human ${w.j.id} via chat`);
    const events = await w.eventsOf(started.sessionId);
    expect(events.find((e) => e.type === "session.started")?.payload).toMatchObject({
      trigger: "remote",
    });
    expect(started.completed).toEqual([gameTask.id]);
    expect((await w.store.task.mustGet(gameTask.id)).status).toBe("done");
    const gamePrs = await w.alice.github.listPullRequests(GAME_REPO, { state: "open" });
    expect(gamePrs.map((p) => p.title)).toEqual([GAME_TASK]);
    const ledger = await w.store.costLedger.sum({ sessionId: started.sessionId });
    expect(ledger.usd_micro).toBeGreaterThan(0);
    expect(ledger.usd_micro).toBeLessThan(sessionCapUsd);

    // --- Clause: the change log shows the three changes with undo ------------------------
    const rows = await w.changeLog(game.id);
    expect(rows.map((r) => r.id)).toEqual([changeLogId]);
    const change = rows[0];
    expect(change).toMatchObject({
      human_id: w.j.id,
      agent_id: w.alice.agent.id,
      source: "chat", // the loop's change source for a phone turn (see the scheduler log note)
      words_used: SENTENCE,
      undo_state: "undoable",
      expires_at: until,
      scope: "global",
    });
    expect(change?.commands.map((c) => (c as { name: string }).name)).toEqual([
      "project.switch",
      "budget.set",
      "session.start",
    ]);
    expect(change?.sentence).toBe(
      [
        "Switched the active project to Space game. Undo.",
        "Raised tonight's session budget for Space game from CHF 5 to CHF 15, until 06:00. Undo.",
        "Started a session on Space game on your PC with a budget of CHF 15. Undo.",
      ].join(" "),
    );
    expect(change?.after).toEqual([
      expect.objectContaining({ active_project: game.id }),
      expect.objectContaining({
        session_budget_override: expect.objectContaining({ cap_chf_micro: CHF_15 }),
      }),
      expect.objectContaining({ budget_usd_micro: sessionCapUsd, agent_id: w.alice.agent.id }),
    ]);
    expect(
      (await commands.changeLog({ humanId: w.j.id, undoable: true })).map((r) => r.id),
    ).toContain(changeLogId);
    // Spelled out: the sentence reached J's inbox and the conversation session's log.
    expect(
      (await w.inbox(w.j)).some((m) => m.body === change?.sentence && m.project_id === game.id),
    ).toBe(true);
    expect(
      (await w.eventsOf(sessionId)).find(
        (e) =>
          e.type === "change" &&
          (e.payload as { changeLogId?: string }).changeLogId === changeLogId,
      )?.payload,
    ).toMatchObject({
      commands: ["project.switch", "budget.set", "session.start"],
      source: "chat", // as on the change log row
    });

    // --- And the undo: one click reverts the three changes ---------------------------------
    const undone = await commands.undo(
      changeLogId,
      commandTurnFor(w.alice, sessionId, { wordsUsed: "undo" }),
    );
    expect(undone.status).toBe("done");
    expect((await w.store.changeLog.mustGet(changeLogId)).undo_state).toBe("undone");
    expect(await commands.activeProject(w.j.id)).toBe(w.project.id);
    expect(
      (await w.store.project.mustGet(game.id)).settings.session_budget_override,
    ).toBeUndefined();

    // --- Secrets: no device key, session token or git token in any row, event or message ---
    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.message.list(),
      await w.store.remoteCommand.list(),
      await w.store.changeLog.list(),
      await w.store.device.list(),
      events,
    ]);
    expect(dump).not.toContain(phone.keys.secretKey);
    expect(dump).not.toContain(phone.token);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  }, 90_000);

  // Known gap, outside this scenario's paths (critic, 2026-10-20): neither `POST /remote/commands`
  // (services/state-api/src/routes/remote.ts) nor `RemoteCommandWatcher.runPlan` dedupes a plan
  // envelope the phone's outbox replays after a reconnect (same device, same `clientId`): a
  // replay inside the tap's 10 min window runs the plan a second time (a second change log row,
  // a second session start). The `/sync/outbox` route's idempotency store is the model. When
  // the dedupe lands, make this the case that posts the same envelope twice, drains, and
  // asserts one change log row, one session and one `done` row with a `duplicate` result.
  it.todo("a plan envelope the outbox replays (same device and clientId) runs once");
});
