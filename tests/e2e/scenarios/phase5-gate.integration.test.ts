/**
 * Phase 5 gate harness (spec, build order): "Simulated users run a full simulated week only
 * through the UI and the Android emulator, no terminal, answering approvals on the phone.
 * Voice replies reach first audio in under 1.2 s median on both platforms. Every settings
 * change can be made by voice, chat or the UI, and each produces the same change log entry.
 * From the Android app, a simulated user switches project, raises a budget and starts a
 * session on his PC."
 *
 * Runs on the scenario world (fake provider, no network beyond 127.0.0.1, simulated clock):
 * seven simulated days driven only through the daemon API the desktop UI calls
 * (`createDaemonApp` over each install, `gate5-daemon.ts`) and the state service routes the
 * Android app calls (`scenario-phone.ts`, `gate5-phone.ts`), never through the CLI, the
 * registry or the store (the store is read to assert and written only to seed the world).
 * Sessions start from the installs' schedulers on the clock; every human request of the week
 * is answered through the phone's routes, the high-risk ones with the biometric assertion;
 * the PC's own `RemoteCommandWatcher` applies the inbox's answers and runs the phone's
 * envelopes. Voice turns go through the real `VoiceLoop` with the fake STT and TTS. The
 * three settings changes (raise a budget, change autonomy, change the email mode) are made
 * by voice, by chat and through the settings route, each undone, and the change log entries
 * are compared. See `tests/e2e/src/gate5-week.ts` for the days and ADR 0045 for what stands
 * in for the emulator and the audio devices.
 *
 * What cannot run here: the Android emulator (the screens are not driven; what enters is
 * what the app's code sends after a tap) and the OS audio devices (the fake STT and TTS play
 * the spec's anchors on the simulated clock, so the model stage is the fake provider's
 * zero-latency stream). Both halves stay pending rows in gates.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "@forerunner/platform";
import { REMOTE_AUDIT_TOOL } from "@forerunner/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIRST_AUDIO_ANCHOR_MS,
  formatPhase5,
  MIN_VOICE_TURNS,
  PHASE5_DAYS,
  type Phase5Report,
  type Phase5World,
  phase5World,
  runPhase5Week,
  sameEntry,
} from "../src/gate5-week.ts";
import { SCENARIO_ADMIN_TOKEN } from "../src/scenario-phone.ts";
import { eventsOfType } from "../src/scenario-voice.ts";

/** The gate evidence lines, also written to FORERUNNER_E2E_REPORT_DIR when it is set. */
function record(name: string, text: string): void {
  console.log(text);
  const dir = process.env.FORERUNNER_E2E_REPORT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `${text}\n`, "utf8");
}

describe("phase 5 gate: a simulated week through the UI and the phone (fake provider)", () => {
  let x: Phase5World;
  let report: Phase5Report;

  beforeAll(async () => {
    x = await phase5World();
    report = await runPhase5Week(x);
    record("phase5-week.txt", formatPhase5(report));
  }, 600_000);
  afterAll(async () => {
    await x?.close();
  });

  it("the week ran only through the UI and the phone: scheduled sessions every day, every request answered on the phone, every outward action audited", async () => {
    const { w } = x;
    expect(report.days).toHaveLength(PHASE5_DAYS);
    expect(report.days.map((d) => d.name)).toEqual([
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ]);
    // Alice every morning at 06:00, Bob on weekdays at 05:45, all started by the schedulers.
    for (const d of report.days) {
      const alice = d.sessions.find((s) => s.agent === "Alice");
      expect(alice, d.name).toMatchObject({ trigger: "schedule", status: "completed" });
      expect(alice?.startedAt?.endsWith("T05:00:00.000Z"), `${d.name} 06:00 Zurich`).toBe(true);
      const bob = d.sessions.find((s) => s.agent === "Bob");
      if (d.day < 5) {
        expect(bob, d.name).toMatchObject({
          trigger: "schedule",
          status: "completed",
          completed: 1,
        });
        expect(bob?.startedAt?.endsWith("T04:45:00.000Z"), `${d.name} 05:45 Zurich`).toBe(true);
      } else expect(bob).toBeUndefined();
      expect(d.summaryRead).toBe(true);
    }
    expect(report.sessions).toMatchObject({ scheduled: 12, remote: 1, completed: 13 });
    // Tuesday's tier 3 task went to J (sign-off) with its PR open; every other task closed
    // with a PR: thirteen pull requests on the two repositories, twelve tasks done.
    const tuesday = report.days[1]?.sessions.find((s) => s.agent === "Alice");
    expect(tuesday).toMatchObject({ completed: 0, needsHuman: 1 });
    expect(report.sessions.tasksDone).toBe(12);
    expect(report.sessions.pullRequests).toBe(13);
    const schedulerStarts = [...w.alice.scheduler.log, ...w.bob.scheduler.log].filter(
      (l) => l.result === "started",
    );
    expect(schedulerStarts).toHaveLength(13);
    expect(schedulerStarts.filter((l) => l.req.trigger === "schedule")).toHaveLength(12);
    // No terminal: every task was created through a daemon route; no direct `fr` run, no
    // session started outside the schedulers and the phone's plan.
    // The task ids the daemons' routes answered with are the rows the sessions worked on
    // (every row's author fields now carry the agent that last moved it).
    const created = report.days.flatMap((d) => d.tasks);
    expect(created).toHaveLength(12);
    const tasks = await w.store.task.list(undefined, { limit: 100 });
    expect(tasks.map((t) => t.id).sort()).toEqual([...created, report.phoneFlow.taskId].sort());
    expect(
      x.j.daemon.ui.calls.filter((c) => c.path.endsWith("/tasks") && c.method === "POST"),
    ).toHaveLength(8);
    expect(
      x.m.daemon.ui.calls.filter((c) => c.path.endsWith("/tasks") && c.method === "POST"),
    ).toHaveLength(5);
    expect(x.j.daemon.ui.calls.every((c) => c.status < 400)).toBe(true);
    expect(x.m.daemon.ui.calls.every((c) => c.status < 400)).toBe(true);
    expect(report.uiCalls).toBeGreaterThan(60);

    // Every human request of the week is answered: the registry's own confirmations (a yes,
    // a tap) carry the executor's verdict; everything else was answered through the phone.
    const requests = await w.store.humanRequest.list();
    expect(requests.length).toBeGreaterThanOrEqual(12);
    const open = requests.filter((r) => r.status === "open");
    expect(open).toEqual([]);
    const phoneAnswered = new Set(
      report.phoneAnswers.filter((a) => a.status === 200).map((a) => a.requestId),
    );
    for (const r of requests) {
      const byExecutor =
        r.answer !== null &&
        typeof r.answer === "object" &&
        !Array.isArray(r.answer) &&
        typeof (r.answer as { verdict?: unknown }).verdict === "string";
      expect(r.status, r.id).toBe("answered");
      expect(r.answered_by, r.id).toBe(w.j.id);
      if (!byExecutor) expect(phoneAnswered.has(r.id), `${r.id} ${r.why}`).toBe(true);
    }
    // The sign-off of the tier 3 task: blocking, answered "accept" on the phone, recorded.
    const signoff = requests.find((r) => r.blocking && r.task_id);
    expect(signoff).toMatchObject({ status: "answered", answer: "accept", answered_by: w.j.id });
    expect(phoneAnswered.has(signoff?.id ?? "")).toBe(true);
    // Follow-up RT-P5-1 (testing.md, Gate harnesses, Known issues): nothing applies an
    // accepted sign-off to the task, which stays `needs_human` (`needs_human -> ready` is its
    // only way on). Pinned so the fix is seen; the fixing PR inverts this to `ready`.
    expect((await w.store.task.mustGet(signoff?.task_id ?? "")).status, "RT-P5-1").toBe(
      "needs_human",
    );
    // High-risk answers: the hooks' hold (once) and the three email mode cards (voice, chat,
    // UI), each refused without the biometric (403) and accepted with it; the sign-off and
    // Saturday's medium card as plain answers.
    const high = report.phoneAnswers.filter((a) => a.risk === "high");
    expect(high.filter((a) => !a.biometric).map((a) => a.status)).toEqual([403, 403, 403, 403]);
    expect(high.filter((a) => a.biometric).map((a) => a.status)).toEqual([200, 200, 200, 200]);
    expect(report.phoneAnswers.filter((a) => a.status === 200)).toHaveLength(6);
    expect(report.inboxCard.answerKind).toBe(JSON.stringify("yes"));

    // Audit: a row per tool call of every run, one per remote pickup (the plan and the chat).
    // The only denials are the hooks' holds on the email mode command tool on the
    // conversation's model path (`permission_change` is always-human; the hooks file their
    // own request before the registry's card can form), once by voice; the chat round found
    // that answer in the session. Follow-up RT-P5-3 (testing.md): the registry's policy
    // should be the one gate for a command tool, as it is for the parsed and the UI path;
    // the fixing PR inverts this to no denial and `hookApproval` null on every channel.
    const denied = (await w.auditRows()).filter((r) => !r.allowed);
    expect(denied.map((r) => [r.tool, r.denied_reason])).toEqual([
      ["email_mode_set", "approval_required: pending"],
    ]);
    expect(report.audit.denied).toBe(1);
    expect(report.audit.remotePickups).toBe(2);
    const pickups = (await w.auditRows()).filter((r) => r.tool === REMOTE_AUDIT_TOOL);
    expect(pickups.map((r) => JSON.parse(r.input_summary ?? "{}").kind).sort()).toEqual([
      "chat",
      "plan",
    ]);
    const toolCalls = w.runEvents.filter((e) => e.event.type === "tool_call").length;
    expect(toolCalls).toBeGreaterThanOrEqual(13);
    expect(report.audit.rows).toBeGreaterThanOrEqual(toolCalls + 2);
    // The phone's quick chat ran on the PC and the phone read the reply back.
    expect(report.phoneChat.status).toBe("done");
    expect(report.phoneChat.reply).toContain("on track");

    // Secrets: no device key, phone token, admin token or git token in any row, event or message.
    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.message.list(),
      await w.store.remoteCommand.list(),
      await w.store.changeLog.list(),
      await w.store.humanRequest.list(),
      await w.store.device.list(),
      await w.eventsOf(x.j.sessionId),
    ]);
    expect(dump).not.toContain(x.phone.keys.secretKey);
    expect(dump).not.toContain(x.phone.token);
    expect(dump).not.toContain(SCENARIO_ADMIN_TOKEN);
    expect(dump).not.toContain(x.j.daemon.token);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  });

  it("voice replies reach first audio in under 1.2 s median over at least 20 turns (fake STT and TTS on the simulated clock)", async () => {
    const v = report.voice;
    expect(v.turns).toBeGreaterThanOrEqual(MIN_VOICE_TURNS);
    expect(v.medianMs).not.toBeNull();
    expect(v.medianMs ?? Number.POSITIVE_INFINITY).toBeLessThan(FIRST_AUDIO_ANCHOR_MS);
    // Every measured turn inside its anchors: push-to-talk released 20 ms after the last
    // frame, the fake STT final 300 ms later, the first audio chunk 200 ms after the first
    // sentence reached the fake TTS, the model stage the fake provider's stream.
    expect(v.withinTarget).toBe(v.turns);
    expect(v.stages).toMatchObject({ endOfTurnMs: 20, finalTranscriptMs: 300, firstAudioMs: 200 });
    expect(v.stages.modelFirstTokenMs).not.toBeNull();
    for (const r of v.reports) {
      expect(r.interrupted).toBe(false);
      expect(r.noResponse).toBe(false);
      expect(r.totalToFirstAudioMs ?? Number.POSITIVE_INFINITY).toBeLessThan(FIRST_AUDIO_ANCHOR_MS);
    }
    // Spoken approvals are logged with the exact transcript line (O.7): the yes on the
    // budget card, on the autonomy card, and the one the registry refused on the email card.
    const approvals = await eventsOfType(x.w.store, x.voice.sessionId, "voice.approval");
    expect(approvals.map((a) => [a.line, a.approved])).toEqual([
      ["Yes, go ahead.", true],
      ["Yes, go ahead.", true],
      ["Yes, go ahead.", true],
    ]);
    // Session history keeps every turn's transcript and stages (O.10), no audio.
    expect(v.rows).toBe(v.turns);
    const rows = await eventsOfType(x.w.store, x.voice.sessionId, "voice.turn");
    expect(rows.every((r) => r.audioStored === false)).toBe(true);
    expect(x.voice.loop.transcript.every((t) => t.audioStored === false && !t.audioFile)).toBe(
      true,
    );
  });

  it("every settings change made by voice, by chat and through the settings route produces the same change log entry, each with undo", () => {
    expect(report.settings.map((s) => `${s.change}/${s.channel}`)).toEqual([
      "budget/voice",
      "budget/chat",
      "budget/ui",
      "autonomy/voice",
      "autonomy/chat",
      "autonomy/ui",
      "email/voice",
      "email/chat",
      "email/ui",
    ]);
    for (const change of ["budget", "autonomy", "email"] as const) {
      const [voice, chat, ui] = report.settings.filter((s) => s.change === change);
      if (!voice || !chat || !ui) throw new Error(`missing channel for ${change}`);
      // The same entry: commands and parameters, before and after, scope, project, expiry,
      // the sentence, the human and the agent; only the source and the words differ.
      expect(sameEntry(voice.row, chat.row), `${change}: voice vs chat`).toBe(true);
      expect(sameEntry(voice.row, ui.row), `${change}: voice vs ui`).toBe(true);
      expect(voice.row.source).toBe("voice");
      expect(chat.row.source).toBe("chat");
      // Follow-up RT-P5-4 (testing.md): the UI's command route carries no "ui" source today,
      // its turn is `text`, logged as `chat`. Pinned; the fixing PR inverts this to "ui".
      expect(ui.row.source, "RT-P5-4").toBe("chat");
      expect(voice.row.wordsUsed).not.toBe(ui.row.wordsUsed);
      for (const s of [voice, chat, ui]) {
        expect(s.row.undoState, `${change}/${s.channel}`).toBe("undone");
        expect(s.undoRow.commands, `${change}/${s.channel} undo`).toHaveLength(1);
        expect(s.undoRow.undoState).toBe("irreversible");
        expect(s.restored, `${change}/${s.channel} restored`).toBe(true);
        expect(s.row.sentence.endsWith(" Undo.")).toBe(true);
      }
    }
    // Confirmation by risk (Q.5 to Q.8): a budget raise and a one-step autonomy change are
    // medium (a yes, a tap); the email mode is high: a spoken or typed yes is refused and
    // the phone's biometric answer is what applied it, on all three channels.
    for (const s of report.settings) {
      if (s.change === "email") {
        expect(s.decision, `${s.change}/${s.channel}`).toBe("needs_device");
        expect(s.phoneAnswer).toEqual({ withoutBiometric: 403, withBiometric: 200 });
        if (s.channel !== "ui") expect(s.refusedYes).toContain("not enough");
        // The model path's extra approval (the hooks' hold), answered on the phone once by
        // voice and found again by chat; the UI's command route goes straight to the registry.
        // Follow-up RT-P5-3: the fixing PR turns the voice and chat pins into `toBeNull()`.
        if (s.channel === "voice")
          expect(s.hookApproval, "RT-P5-3").toMatchObject({
            withoutBiometric: 403,
            withBiometric: 200,
          });
        if (s.channel === "chat") expect(s.hookApproval, "RT-P5-3").toBe("reused");
        if (s.channel === "ui") expect(s.hookApproval).toBeNull();
      } else {
        expect(s.hookApproval).toBeNull();
        expect(s.decision, `${s.change}/${s.channel}`).toBe("needs_yes");
        expect(s.phoneAnswer).toBeNull();
        expect(s.refusedYes).toBeNull();
      }
    }
    const budget = report.settings.find((s) => s.change === "budget");
    expect(budget?.row.scope).toBe("session");
    expect(budget?.row.expiresAt).toBe("2026-11-05T05:00:00.000Z"); // 06:00 Zurich on Thursday
    expect(budget?.row.sentence).toBe(
      "Raised tonight's session budget for Sample service from CHF 5 to CHF 20, until 06:00. Undo.",
    );
    const autonomy = report.settings.find((s) => s.change === "autonomy");
    expect(autonomy?.row.sentence).toBe(
      "Set the autonomy of Sample service from 2 (Standard) to 3 (Trusted). Undo.",
    );
    const email = report.settings.find((s) => s.change === "email");
    expect(email?.row.scope).toBe("global");
    expect(email?.row.sentence).toBe(
      "Changed the email mode of Alice from Off to Draft only. Undo.",
    );
  });

  it("from the phone, J switches project, raises a budget and starts a session on his PC; the change log shows it with undo", async () => {
    const f = report.phoneFlow;
    const { w } = x;
    expect(f.plan).toEqual(["project.switch", "budget.set", "session.start"]);
    expect(f.cardParts).toEqual(["project.switch", "budget.set", "session.start"]);
    expect(f.remoteStatus).toBe("done");
    expect(f).toMatchObject({
      sessionTrigger: "remote",
      sessionRunner: "pc",
      sessionStatus: "completed",
      budgetCapUsdMicro: 18_750_000, // CHF 15 at 0.8 CHF per USD
      overrideChfMicro: 15_000_000,
      activeProjectAfter: x.game.id,
      undone: true,
      activeProjectAfterUndo: w.project.id,
      // Follow-up RT-P5-2 (testing.md): the undo's kill of the ended session froze the
      // agent; J resumed from the UI's header, and Friday's scheduled session ran. Pinned;
      // the fixing PR inverts both to false.
      killFrozenAfterUndo: true,
      resumedFromUi: true,
    });
    const row = await w.store.changeLog.mustGet(f.changeLogId);
    expect(row).toMatchObject({
      human_id: w.j.id,
      agent_id: w.alice.agent.id,
      source: "chat",
      words_used: f.sentence,
      undo_state: "undone",
      scope: "global",
    });
    expect(row.commands.map((c) => (c as { name: string }).name)).toEqual(f.plan);
    // One confirmation: the tap on the phone answered the one medium card; nothing waited.
    const remote = await w.store.remoteCommand.mustGet(f.remoteCommandId);
    expect(remote).toMatchObject({ status: "done", target: "pc", command: "start" });
    const card = (await w.store.humanRequest.list()).find(
      (r) => r.change_card && (r.change_card as { words_used?: string }).words_used === f.sentence,
    );
    expect(card?.answer).toMatchObject({ verdict: "confirmed", kind: "tap", by: w.j.id });
    const session = await w.store.session.mustGet(f.sessionId);
    expect(session.project_id).toBe(x.game.id);
    const game = await w.store.project.mustGet(x.game.id);
    expect(game.settings.session_budget_override).toBeUndefined();
    expect(
      (
        await w.alice.github.listPullRequests({ owner: "sample", name: "game" }, { state: "open" })
      ).map((p) => p.title),
    ).toContain("Trading loop skeleton");
  });
});
