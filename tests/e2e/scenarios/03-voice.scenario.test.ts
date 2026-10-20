/**
 * Scenario 3, "Voice" (spec, Phase 8): "J asks for status by voice, approves a request by
 * voice, and hears the read-back."
 *
 * Fake provider, no network beyond 127.0.0.1, simulated clock. The morning: Alice did one task
 * and its PR is open; one approval request waits in J's inbox. Then J talks: the real
 * `VoiceLoop` of `@forerunner/voice` (push-to-talk, the package's fake STT and TTS providers,
 * every delay on the simulated clock) is wired to the runtime's `ConversationAgent` over the
 * command registry (`tests/e2e/src/scenario-voice.ts`). J asks for the status and hears the
 * spoken answer, grounded in the session the world ran; asks for a budget raise, which the
 * registry turns into a change card it reads back and files as a pending request (spec O.7:
 * "reads back the action and estimated cost and waits for yes"); says a line that is not a
 * yes and hears the card again; says yes and hears what was done. Asserted on the request
 * rows, the project settings, the change log, the conversation session's events (`chat.*`,
 * `voice.approval`, `voice.turn`, `change`), the audit rows, the transcript entries and the
 * latency reports.
 *
 * What cannot run here, and what stands in for it: the OS audio devices live in the Tauri
 * shell (WASAPI, PipeWire), so microphone frames are pushed into the loop and playback chunks
 * are collected from its sink; the shell's voice bridge (spoken approval rules, transcript and
 * latency into session history) is `voiceBridge` in the helper module, over the same ports.
 * Windows and Android: the same code runs on both (paths and processes through
 * @forerunner/platform); the final-build runs are recorded in gates.md.
 */
import type { CommandLoop, ConversationAgent } from "@forerunner/runtime";
import { textReply } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_OVERRIDE_KEY } from "../../../packages/commands/src/index.ts";
import { medianTotalToFirstAudio } from "../../../packages/voice/src/index.ts";
import { chatTurn, commandLoopFor, conversationAgentFor } from "../src/scenario-commands.ts";
import { coderWrites, criticAccepts } from "../src/scenario-scripts.ts";
import { eventsOfType, type VoiceBridge, voiceBridge } from "../src/scenario-voice.ts";
import { type ScenarioWorld, scenarioWorld } from "../src/scenario-world.ts";

const START = "2026-11-03T08:00:00Z"; // 09:00 Europe/Zurich
const UNTIL = "2026-11-04T05:00:00.000Z"; // "tonight" ends at 06:00 Europe/Zurich the next morning
const T1 = "Shared config module";
const CONFIG = "export const config = { port: 8080, name: 'service' };\n";
const STATUS_REPLY =
  "The session on Sample service completed: Shared config module is done and its pull request is open. One request is waiting for you: merge that pull request.";
const ASK = "Give it 20 francs tonight.";
const SENTENCE =
  "Raised tonight's session budget for Sample service from CHF 5 to CHF 20, until 06:00. Undo.";

describe("scenario 3: voice", () => {
  let w: ScenarioWorld;
  let commands: CommandLoop;
  let agent: ConversationAgent;
  let voice: VoiceBridge | null = null;
  beforeAll(async () => {
    w = await scenarioWorld({ start: START });
    commands = await commandLoopFor(w, w.alice);
    agent = conversationAgentFor(w, w.alice, commands);
  });
  afterAll(async () => {
    await voice?.stop();
    commands?.stop();
    await w?.close();
  });

  it("J asks for status by voice, approves a request by voice, and hears the read-back", async () => {
    // --- The morning: one task done by Alice, one request waiting in J's inbox -------------
    w.provider.pushReplies(
      ...coderWrites(T1, { "src/shared/config.ts": CONFIG }),
      ...criticAccepts(),
    );
    const t1 = await w.addTask({ title: T1, outcome: "src/shared/config.ts exports the config" });
    const session = await w.runSession(w.alice);
    expect(session.status).toBe("completed");
    expect(session.completed).toEqual([t1.id]);
    const pr = (await w.pullRequests({ state: "open" })).find((p) => p.title === T1);
    expect(pr).toBeDefined();
    const merge = await w.store.humanRequest.insert({
      human_id: w.j.id,
      project_id: w.project.id,
      task_id: t1.id,
      session_id: session.sessionId,
      kind: "approval",
      why: `Merge the PR for "${T1}"?`,
      steps: ["Critic grade 92", `PR ${pr?.htmlUrl ?? ""}`],
      options: ["approve", "reject"],
      blocking: false,
      risk: "medium",
      author_agent: w.alice.agent.id,
    });
    expect(merge.status).toBe("open");

    // The one model call of the conversation: a question goes to the model with the command
    // tools; the budget request is understood by the parser and needs no model.
    w.provider.pushReplies(
      textReply(STATUS_REPLY, { when: chatTurn("What is the status"), ttftMs: 0 }),
    );
    voice = await voiceBridge(w, { agent, install: w.alice, projectId: w.project.id });
    const callsBefore = w.provider.calls.length;

    // --- Clause: J asks for status by voice and gets a spoken status ------------------------
    const status = await voice.say("What is the status?");
    expect(status.said).toBe("What is the status?");
    expect(status.reply?.reply).toBe(STATUS_REPLY);
    expect(status.heard).toBe(STATUS_REPLY);
    expect(status.entries.assistant?.role).toBe("assistant");
    expect(status.entries.assistant?.interrupted).toBeUndefined();
    expect(status.audioChunks).toBeGreaterThan(0);
    // Two sentences, each synthesised as the model stream produced it.
    expect(voice.tts.calls.map((c) => c.text)).toEqual([
      "The session on Sample service completed: Shared config module is done and its pull request is open.",
      "One request is waiting for you: merge that pull request.",
    ]);
    // The answer was grounded in the state: the model saw the session summary and the request.
    const statusCall = w.provider.calls[callsBefore]?.request;
    expect(w.provider.calls).toHaveLength(callsBefore + 1);
    const sessionRow = await w.store.session.mustGet(session.sessionId);
    expect(statusCall?.system ?? "").toContain("Sample service (active)");
    expect(statusCall?.system ?? "").toContain(sessionRow.summary.slice(0, 60));
    expect(String(statusCall?.messages[0]?.content)).toContain(merge.id.slice(0, 8));
    expect((statusCall?.tools ?? []).map((t) => t.name)).toContain("budget_set");
    expect(statusCall?.model).toBe("fake-haiku");

    // --- Clause: J asks for something above routine: the card is read back, a request waits -
    const ask = await voice.say(ASK);
    const card = ask.reply?.pendingConfirmation;
    expect(card).toMatchObject({ decision: "needs_yes", commands: ["budget.set"] });
    expect(card?.costUsdMicro).toBe(18_750_000); // CHF 15 more at 0.8 CHF per USD
    expect(card?.readback).toContain("Change: tonight's session budget for Sample service.");
    expect(card?.readback).toContain("From CHF 5 to CHF 20.");
    // The parser named the active project in the command, so the card scopes it by name.
    expect(card?.readback).toContain("Scope: this session (Sample service).");
    expect(card?.readback).toContain("How long: until 06:00.");
    expect(card?.readback).toContain("Risk: medium. Spend impact: +CHF 15.");
    expect(card?.readback).toContain("Say yes to confirm");
    // He heard the whole read-back, once, and nothing else.
    expect(ask.heard).toBe(card?.readback);
    expect(ask.heard.split("Say yes to confirm")).toHaveLength(2);
    expect(ask.reply?.actions).toEqual([]);
    // The registry filed the card as a pending request in the inbox and waits; nothing changed.
    const pendingRows = (await w.humanRequests(w.j, { status: "open" })).filter(
      (r) => r.id === card?.id,
    );
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({
      kind: "approval",
      risk: "medium",
      project_id: w.project.id,
      session_id: voice.sessionId,
      author_human: w.j.id,
    });
    expect(pendingRows[0]?.change_card).toMatchObject({
      command: "budget.set",
      decision: "needs_yes",
      words_used: ASK,
      oldValue: "CHF 5",
      newValue: "CHF 20",
      expiresAt: UNTIL,
    });
    expect(pendingRows[0]?.options).toEqual(["yes", "no"]);
    expect(commands.pending(w.j.id).map((p) => p.id)).toEqual([card?.id]);
    expect(
      (await w.store.project.mustGet(w.project.id)).settings[SESSION_OVERRIDE_KEY],
    ).toBeUndefined();
    expect(await w.changeLog()).toHaveLength(0);
    // Deterministic: no model call for the request.
    expect(w.provider.calls).toHaveLength(callsBefore + 1);

    // --- Clause: spoken approval rules: a question is not a yes; the card is read again ----
    const hesitation = await voice.say("Yes, but what does it cost?");
    expect(hesitation.reply).toBeNull();
    expect(hesitation.approval).toMatchObject({
      approved: false,
      blockedBy: "question",
      matched: "yes",
      line: "Yes, but what does it cost?",
    });
    expect(hesitation.heard).toMatch(/^I did not take that as a yes\. /);
    expect(hesitation.heard).toContain(card?.readback ?? "never");
    expect((await w.store.humanRequest.mustGet(card?.id ?? "")).status).toBe("open");
    expect(commands.pending(w.j.id).map((p) => p.id)).toEqual([card?.id]);
    expect(
      (await w.store.project.mustGet(w.project.id)).settings[SESSION_OVERRIDE_KEY],
    ).toBeUndefined();
    expect(await w.changeLog()).toHaveLength(0);

    // --- Clause: J says yes and hears the read-back of what was done ------------------------
    const beforeYes = w.clock.nowIso();
    const yes = await voice.say("Yes, go ahead.");
    expect(yes.approval).toMatchObject({
      approved: true,
      matched: "yes",
      blockedBy: null,
      line: "Yes, go ahead.",
      subject: card?.readback,
    });
    expect(yes.reply?.actions).toEqual([
      expect.objectContaining({ kind: "budget.set", summary: SENTENCE }),
    ]);
    expect(yes.reply?.actions[0]?.undoToken).toBeTruthy();
    expect(yes.reply?.pendingConfirmation).toBeNull();
    expect(yes.heard).toBe(SENTENCE);
    expect(yes.heard).toBe(yes.reply?.reply);
    expect(voice.pending).toBeNull();
    // No model call for the yes or for the refused line: the registry decided.
    expect(w.provider.calls).toHaveLength(callsBefore + 1);

    // --- Clause: the request is answered in the state, and the change applied --------------
    const cardRow = await w.store.humanRequest.mustGet(card?.id ?? "");
    expect(cardRow).toMatchObject({ status: "answered", answered_by: w.j.id });
    expect((cardRow.answered_at ?? "") >= beforeYes).toBe(true);
    expect((cardRow.answered_at ?? "") <= w.clock.nowIso()).toBe(true);
    expect(cardRow.answer).toMatchObject({ verdict: "confirmed", kind: "yes", by: w.j.id });
    expect(await w.humanRequests(w.j, { status: "open" })).toEqual([
      expect.objectContaining({ id: merge.id }), // the inbox request J did not talk about
    ]);
    expect(commands.pending(w.j.id)).toHaveLength(0);
    expect((await w.store.project.mustGet(w.project.id)).settings[SESSION_OVERRIDE_KEY]).toEqual({
      cap_usd_micro: 25_000_000,
      cap_chf_micro: 20_000_000,
      rate_chf_per_usd: 0.8,
      expires_at: UNTIL,
    });

    // --- Clause: the change log has the entry ----------------------------------------------
    const log = await w.changeLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      human_id: w.j.id,
      agent_id: w.alice.agent.id,
      project_id: w.project.id,
      source: "voice",
      words_used: ASK,
      undo_state: "undoable",
      expires_at: UNTIL,
      scope: "session",
      sentence: SENTENCE,
    });
    expect(log[0]?.commands).toEqual([
      expect.objectContaining({
        name: "budget.set",
        params: expect.objectContaining({ scope: "session", amountChf: 20, until: UNTIL }),
      }),
    ]);
    expect(log[0]?.after).toMatchObject({
      scope: "session",
      project_id: w.project.id,
      [SESSION_OVERRIDE_KEY]: { cap_chf_micro: 20_000_000, expires_at: UNTIL },
    });
    // Spelled out: the sentence went to J's inbox and to the conversation session's log.
    const posted = (await w.inbox(w.j)).find((m) => m.body === SENTENCE);
    expect(posted).toMatchObject({ from_agent_id: w.alice.agent.id, type: "info" });
    const events = await w.eventsOf(voice.sessionId);
    expect(events.find((e) => e.type === "change")?.payload).toMatchObject({
      changeLogId: log[0]?.id,
      commands: ["budget.set"],
      source: "voice",
    });
    // The conversation itself: every human line with its source, the confirmation with the
    // words, the two spoken approval decisions with the exact transcript lines (O.7).
    const humanLines = events.filter((e) => e.type === "chat.human").map((e) => e.payload);
    expect(humanLines).toEqual([
      expect.objectContaining({ text: "What is the status?", source: "voice" }),
      expect.objectContaining({ text: ASK, source: "voice" }),
      expect.objectContaining({ text: "yes", source: "voice" }),
    ]);
    expect(events.find((e) => e.type === "chat.confirmed")?.payload).toMatchObject({
      confirmationId: card?.id,
      commands: ["budget.set"],
      words: "yes",
      status: "done",
    });
    expect(events.some((e) => e.type === "chat.cancelled")).toBe(false);
    const approvals = await eventsOfType(w.store, voice.sessionId, "voice.approval");
    expect(approvals).toEqual([
      expect.objectContaining({
        turn: 3,
        line: "Yes, but what does it cost?",
        approved: false,
        blockedBy: "question",
        pendingId: card?.id,
      }),
      expect.objectContaining({
        turn: 4,
        line: "Yes, go ahead.",
        approved: true,
        matched: "yes",
        pendingId: card?.id,
        commands: ["budget.set"],
      }),
    ]);
    // Nothing ran behind the hooks for the change: the registry's policy was the gate.
    expect(await w.auditRows({ sessionId: voice.sessionId })).toEqual([]);

    // --- Clause: the latency anchors are recorded (O.5) -----------------------------------
    expect(voice.loop.latencies).toHaveLength(4);
    for (const report of voice.loop.latencies) {
      // Push-to-talk released 20 ms after the last frame; the fake STT final 300 ms later;
      // the first audio chunk 200 ms after the first sentence reached the fake TTS.
      expect(report.endOfTurnMs).toBe(20);
      expect(report.finalTranscriptMs).toBe(300);
      expect(report.modelFirstTokenMs).not.toBeNull();
      expect(report.modelFirstTokenMs ?? -1).toBeGreaterThanOrEqual(0);
      expect(report.firstAudioMs).toBe(200);
      expect(report.totalToFirstAudioMs).toBe(20 + 300 + (report.modelFirstTokenMs ?? 0) + 200);
      expect(report.withinTarget).toBe(true);
      expect(report.interrupted).toBe(false);
      expect(report.noResponse).toBe(false);
    }
    expect(
      medianTotalToFirstAudio([...voice.loop.latencies]) ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(1200);
    const turnRows = await eventsOfType(w.store, voice.sessionId, "voice.turn");
    expect(turnRows.map((t) => t.turn)).toEqual([1, 2, 3, 4]);
    expect(turnRows.map((t) => t.said)).toEqual([
      "What is the status?",
      ASK,
      "Yes, but what does it cost?",
      "Yes, go ahead.",
    ]);
    for (const row of turnRows) {
      expect(row.latency).toMatchObject({
        endOfTurnMs: 20,
        finalTranscriptMs: 300,
        firstAudioMs: 200,
        withinTarget: true,
      });
      expect(row.audioStored).toBe(false);
      expect(row.audioChunks as number).toBeGreaterThan(0);
    }

    // --- Transcripts kept, audio not stored (O.10) -----------------------------------------
    expect(voice.loop.transcript.map((t) => [t.turn, t.role])).toEqual([
      [1, "user"],
      [1, "assistant"],
      [2, "user"],
      [2, "assistant"],
      [3, "user"],
      [3, "assistant"],
      [4, "user"],
      [4, "assistant"],
    ]);
    expect(voice.loop.transcript.every((t) => t.audioStored === false && !t.audioFile)).toBe(true);
    expect(voice.loop.state).toBe("idle");

    // --- Secrets: no git token in any row, event or message ---------------------------------
    const dump = JSON.stringify([
      await w.store.auditLog.list(),
      await w.store.message.list(),
      await w.store.humanRequest.list(),
      await w.store.changeLog.list(),
      events,
    ]);
    for (const install of w.installs) expect(dump).not.toContain(install.gitTokenValue);
  }, 90_000);
});
