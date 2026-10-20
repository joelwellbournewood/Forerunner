/**
 * The simulated week of the phase 5 gate (spec, Build order: "Simulated users run a full
 * simulated week only through the UI and the Android emulator, no terminal, answering
 * approvals on the phone. Voice replies reach first audio in under 1.2 s median on both
 * platforms. Every settings change can be made by voice, chat or the UI, and each produces
 * the same change log entry. From the Android app, a simulated user switches project, raises
 * a budget and starts a session on his PC."), driven on the scenario world (ADR 0045):
 *
 * - J and M each have an install (Alice, Bob) and a desktop UI: the daemon app of that install
 *   (`gate5-daemon.ts`), called the way `apps/ui` calls it. Every task of the week is created
 *   through it, every summary read through it, every UI change made through its command routes.
 * - J has a phone paired through the real pairing routes of the state service
 *   (`scenario-phone.ts`); every human request of the week is answered through the phone's
 *   routes (`gate5-phone.ts`), the high-risk ones with the biometric assertion. The PC's own
 *   `RemoteCommandWatcher` (`gate5-pc.ts`) picks the phone's envelopes up and applies the
 *   inbox's answers to the pending cards.
 * - Sessions start from the installs' schedulers on the simulated clock (Alice daily at 06:00,
 *   Bob on weekdays at 05:45, Europe/Zurich); the fake provider plays a scripted coder per task
 *   and an accepting critic; the real runner, executor, critic loop, memory loop and git host
 *   do the rest.
 * - Voice turns run through the real `VoiceLoop` with the fake STT and TTS on the simulated
 *   clock (`scenario-voice.ts`); the latency reports are the measurement.
 *
 * Monday 2 November 2026 to Sunday 8 November 2026, CET (no clock change in the week).
 */
import type { SimulatedClock } from "@forerunner/platform";
import {
  type CommandLoop,
  type ConversationAgent,
  REMOTE_AUDIT_TOOL,
  type RemoteCommandWatcher,
} from "@forerunner/runtime";
import type {
  ChangeLogView,
  ChatReplyView,
  ProjectCard,
} from "@forerunner/runtime/daemon/api-types";
import type { DeviceRow, SessionRow, TaskRow } from "@forerunner/state";
import { textReply, toolReply } from "@forerunner/testenv";
import { endOfTonight, startOfTomorrow } from "../../../apps/ui/src/mobile/time.ts";
import { type LatencyReport, medianTotalToFirstAudio } from "../../../packages/voice/src/index.ts";
import { daemonFor, type ScenarioDaemon } from "./gate5-daemon.ts";
import { drainPc, pcFor, registerPc } from "./gate5-pc.ts";
import { type PhoneAnswer, PhoneApprovals } from "./gate5-phone.ts";
import {
  chatAfterTool,
  chatTurn,
  commandLoopFor,
  conversationAgentFor,
} from "./scenario-commands.ts";
import { type ScenarioNotifier, scenarioNotifier } from "./scenario-notify.ts";
import {
  type AppMobile,
  loadAppMobile,
  type PhoneClient,
  phoneConfirmsAndSends,
  phoneContext,
  phoneUnderstands,
  type RemoteCommandView,
  type ScenarioStateService,
  stateServiceFor,
} from "./scenario-phone.ts";
import { coderWrites, criticAccepts } from "./scenario-scripts.ts";
import { type VoiceBridge, type VoiceTurn, voiceBridge } from "./scenario-voice.ts";
import { type Install, type ScenarioWorld, scenarioWorld } from "./scenario-world.ts";

/** Monday 2 November 2026, 00:00 Europe/Zurich (CET, UTC+1; DST ended on 25 October). */
export const PHASE5_START = "2026-11-01T23:00:00Z";
export const PHASE5_DAYS = 7;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** The spec's anchor: under 1.2 s to first audio. */
export const FIRST_AUDIO_ANCHOR_MS = 1200;
/** At least this many measured voice turns go into the median. */
export const MIN_VOICE_TURNS = 20;
/**
 * The PC's poll during the week, on the simulated clock: the daemon's 500 ms over seven
 * simulated days would be 1.2 million polls (scenario 9 proves the pickup within one 500 ms
 * poll); ten simulated seconds keeps "within seconds" and the run under two minutes.
 */
export const WEEK_PC_POLL_MS = 10_000;
/**
 * The daemons' approvals poll during the week (compose.ts: `FORERUNNER_APPROVALS_POLL_MS`,
 * 5 s by default): an answer given on the phone (Tuesday's sign-off) is applied by J's
 * daemon within this poll. A simulated minute keeps the week's seven days to about ten
 * thousand polls per daemon.
 */
export const WEEK_APPROVALS_POLL_MS = 60_000;

const GAME_REPO = { owner: "sample", name: "game" };
const STATUS_QUESTION = "What is the status?";
const STATUS_REPLY =
  "Things are on track: the morning session completed its task and its pull request is open.";
const EMAIL_ASK = "Set the email mode to draft only.";
const EMAIL_MODEL_TEXT = "The email mode change waits for your confirmation on a paired device.";
const BUDGET_ASK = "Give it 20 francs tonight.";
const AUTONOMY_ASK = "Set the autonomy of Sample service to 3";
/** The settings form's fields for the same three changes (what the UI column sends). */
const FORM_BUDGET_CHF = 20;
const FORM_AUTONOMY_LEVEL = 3;
const FORM_EMAIL_MODE = "draft_only";
const PHONE_SENTENCE =
  "switch to the game, give it 15 francs until tomorrow and start a session on my PC";
const GAME_TASK = "Trading loop skeleton";
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/**
 * Runtime findings the harness pins instead of fixing (ADR 0045 item 7). Each id names a
 * follow-up item in testing.md ("Gate harnesses", Known issues) with the runtime test to
 * write first, and marks the harness assertion that fails once the fix lands, so the
 * fixing PR inverts it in the same change.
 */
export const PHASE5_RUNTIME_FOLLOW_UPS = {} as const;

/**
 * Follow-ups the runtime closed, whose pins the harness inverted (testing.md keeps the
 * entries): RT-P5-1, an accepted sign-off closes its task (`syncSignoffAnswers` from
 * `syncApprovals`, reached by the daemon's approvals poll within `WEEK_APPROVALS_POLL_MS`
 * of the phone's answer); RT-P5-2, the undo of a `session.start` whose session ended is a
 * no-op that never reaches the kill switch (the registry's session ports read the
 * scheduler's active start); RT-P5-3, the hooks no longer hold a command tool on the model
 * path (the registry's card is the one approval, `gate: "registry"` on the command tools);
 * RT-P5-4, the command routes take `source: "ui"` and the settings screen sends it.
 */
export const PHASE5_RUNTIME_FOLLOW_UPS_CLOSED = [
  "RT-P5-1",
  "RT-P5-2",
  "RT-P5-3",
  "RT-P5-4",
] as const;

export type SettingsChange = "budget" | "autonomy" | "email";
export type Channel = "voice" | "chat" | "ui";

export interface SettingsRecord {
  change: SettingsChange;
  channel: Channel;
  /** The pending card's id and decision (none for a low-risk change). */
  pendingId: string | null;
  decision: "needs_yes" | "needs_device" | null;
  /** What a spoken or typed yes got on a high-risk card: the refusal sentence. */
  refusedYes: string | null;
  /** The phone's answers on the card: the status without the biometric, then with it. */
  phoneAnswer: { withoutBiometric: number; withBiometric: number } | null;
  /**
   * A hold by the hooks on the conversation's model path before the registry's card formed:
   * the blocking request they filed for the command tool, answered on the phone, after which
   * the human asked again; "reused": the hooks found that answer for the same tool and input
   * in the session and let the tool through at once. `null` on every channel since the
   * registry's policy is the one gate for a command tool (RT-P5-3 closed,
   * `PHASE5_RUNTIME_FOLLOW_UPS_CLOSED`); the harness still detects a hold so a regression
   * is seen here, not as a missing card.
   */
  hookApproval: HookApproval | "reused" | null;
  row: ChangeLogView;
  undoRow: ChangeLogView;
  /** The value read back after the undo equals the one before the change. */
  restored: boolean;
}

export interface HookApproval {
  requestId: string;
  withoutBiometric: number;
  withBiometric: number;
  /** What the human heard or read while the tool was held. */
  heldReply: string;
}

export interface DaySessionReport {
  agent: string;
  sessionId: string;
  trigger: string;
  status: string;
  startedAt: string | null;
  completed: number;
  needsHuman: number;
}

export interface DayReport {
  day: number;
  name: string;
  /** The tasks created through the UIs that morning, by id. */
  tasks: string[];
  sessions: DaySessionReport[];
  /** The summary message J read through the UI's inbox. */
  summaryRead: boolean;
  /** What happened in the afternoon, in words, for the evidence file. */
  afternoon: string[];
}

export interface VoiceReport {
  turns: number;
  medianMs: number | null;
  withinTarget: number;
  /** Medians per stage over the measured turns. */
  stages: {
    endOfTurnMs: number | null;
    finalTranscriptMs: number | null;
    modelFirstTokenMs: number | null;
    firstAudioMs: number | null;
  };
  reports: LatencyReport[];
  /** The `voice.turn` rows of the conversation session (what session history keeps). */
  rows: number;
}

export interface PhoneFlowReport {
  sentence: string;
  /** The game task created through J's UI for the remote session to find. */
  taskId: string;
  plan: string[];
  cardParts: string[];
  remoteCommandId: string;
  remoteStatus: string;
  changeLogId: string;
  sessionId: string;
  sessionTrigger: string;
  sessionRunner: string;
  sessionStatus: string;
  budgetCapUsdMicro: number;
  overrideChfMicro: number;
  activeProjectAfter: string | null;
  undone: boolean;
  activeProjectAfterUndo: string | null;
  /**
   * Whether the undo of the plan's `session.start` (its session ended hours before) froze
   * the agent on the kill switch, and whether J had to press Resume in the UI's header for
   * Friday's scheduled session to run. Both false since RT-P5-2 was closed: the undo of an
   * ended start is a no-op that never reaches the kill switch (`PHASE5_RUNTIME_FOLLOW_UPS_CLOSED`).
   */
  killFrozenAfterUndo: boolean;
  resumedFromUi: boolean;
}

export interface PhoneChatReport {
  commandId: string;
  status: string;
  reply: string | null;
}

export interface Phase5Report {
  start: string;
  end: string;
  days: DayReport[];
  sessions: {
    scheduled: number;
    remote: number;
    completed: number;
    tasksDone: number;
    pullRequests: number;
  };
  voice: VoiceReport;
  settings: SettingsRecord[];
  phoneFlow: PhoneFlowReport;
  phoneChat: PhoneChatReport;
  /** A medium card answered in the phone's inbox instead of by a yes (Saturday). */
  inboxCard: { requestId: string; changeLogId: string; answerKind: string };
  phoneAnswers: PhoneAnswer[];
  uiCalls: number;
  audit: { rows: number; denied: number; remotePickups: number };
}

export interface Phase5World {
  w: ScenarioWorld;
  clock: SimulatedClock;
  game: { id: string; name: string };
  service: ScenarioStateService;
  app: AppMobile;
  phone: PhoneClient;
  approvals: PhoneApprovals;
  pcDevice: DeviceRow;
  pc: RemoteCommandWatcher;
  notifier: ScenarioNotifier;
  j: InstallSide;
  m: InstallSide;
  voice: VoiceBridge;
  close(): Promise<void>;
}

export interface InstallSide {
  install: Install;
  commands: CommandLoop;
  agent: ConversationAgent;
  /** The principal's conversation session (the activity log of changes). */
  sessionId: string;
  daemon: ScenarioDaemon;
}

function must(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`phase 5 week: ${message}`);
}

function atZurich(day: number, hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return Date.parse(PHASE5_START) + day * DAY_MS + (h * 60 + m) * MINUTE_MS;
}

function median(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

// ---------------------------------------------------------------------------------------
// The world

export async function phase5World(): Promise<Phase5World> {
  const w = await scenarioWorld({ start: PHASE5_START, mail: false });
  const clock = w.clock;
  // The second project with its own repository (both agents are members).
  await w.gitHost.createRepo({
    ...GAME_REPO,
    private: true,
    defaultBranch: "main",
    initialFiles: { "README.md": "# game\n\nA browser space trading game.\n" },
  });
  const gameRow = await w.store.project.insert({
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
    author_human: w.m.id,
  });
  const game = { id: gameRow.id, name: gameRow.name };
  const notifier = scenarioNotifier(w);
  // The critic accepts every review of the week (the rules in code still turn a tier 3 accept
  // into a human sign-off).
  w.provider.pushReplies(...criticAccepts());
  // The conversation agent's model turns: the status question and the email mode change,
  // which no pattern understands and so goes to the model with the command tools.
  w.provider.pushReplies(
    textReply(STATUS_REPLY, {
      when: chatTurn(STATUS_QUESTION),
      ttftMs: 0,
      times: Number.POSITIVE_INFINITY,
    }),
    toolReply("email_mode_set", { mode: "draft_only" }, "Changing the email mode.", {
      when: chatTurn("email mode"),
      times: Number.POSITIVE_INFINITY,
    }),
    textReply(EMAIL_MODEL_TEXT, {
      when: chatAfterTool("email mode"),
      times: Number.POSITIVE_INFINITY,
    }),
  );

  const side = async (install: Install, projectId: string): Promise<InstallSide> => {
    const commands = await commandLoopFor(w, install);
    const agent = conversationAgentFor(w, install, commands);
    const sessionId = await agent.conversationSessionId(install.agent.id, projectId);
    return {
      install,
      commands,
      agent,
      sessionId,
      daemon: daemonFor(w, install, {
        commands,
        conversation: agent,
        notifier,
        approvalsPollMs: WEEK_APPROVALS_POLL_MS,
      }),
    };
  };
  const j = await side(w.alice, w.project.id);
  const m = await side(w.bob, game.id);
  // J's PC: its own desktop device row and the daemon's watcher on the clock.
  const pcDevice = await registerPc(w, w.alice);
  const pc = pcFor(w, {
    install: w.alice,
    commands: j.commands,
    conversation: j.agent,
    pcDeviceId: pcDevice.id,
    sessionId: j.sessionId,
    pollMs: WEEK_PC_POLL_MS,
  });
  pc.start();
  j.daemon.rt.remote.device = pcDevice;
  j.daemon.rt.remote.watcher = pc;
  j.daemon.rt.remote.enabled = true;
  // The state service in process and J's phone, paired through the real routes.
  const service = await stateServiceFor(w);
  const phone = await service.pairPhone(w.j.id, "J's phone");
  const app = await loadAppMobile();
  const approvals = new PhoneApprovals(phone);
  // The voice loop on J's install (push-to-talk, fake STT and TTS on the clock).
  const voice = await voiceBridge(w, { agent: j.agent, install: w.alice, projectId: w.project.id });
  // The schedules (harness configuration: the daemon has no route for a daily schedule yet).
  w.schedule(w.alice, { time: "06:00", kind: "daily" });
  w.schedule(w.bob, { time: "05:45", kind: "weekdays", projectId: game.id });
  return {
    w,
    clock,
    game,
    service,
    app,
    phone,
    approvals,
    pcDevice,
    pc,
    notifier,
    j,
    m,
    voice,
    close: async () => {
      await voice.stop();
      pc.stop();
      j.commands.stop();
      m.commands.stop();
      j.daemon.close();
      m.daemon.close();
      await service.close();
      await w.close();
    },
  };
}

// ---------------------------------------------------------------------------------------
// The days

const SERVICE_TOPICS = [
  "health route",
  "billing export",
  "config loader",
  "rate limiter",
  "metrics endpoint",
  "retry helper",
  "changelog page",
];
const GAME_TOPICS = ["star map", "cargo hold", "trade prices", "docking", "save game"];

function sessionReport(agent: string, s: SessionRow, completed: number, needsHuman: number) {
  return {
    agent,
    sessionId: s.id,
    trigger: s.trigger,
    status: s.status,
    startedAt: s.started_at,
    completed,
    needsHuman,
  } satisfies DaySessionReport;
}

/** The morning of one day: the tasks through the UIs, the scheduled sessions, the inbox. */
async function runMorning(x: Phase5World, day: number): Promise<DayReport> {
  const { w } = x;
  const n = day + 1;
  const weekday = day < 5;
  const tasks: string[] = [];
  await w.advanceTo(atZurich(day, "00:15"));
  // J creates the day's task on the sample service through his UI (tier 3 on Tuesday: the
  // critic's accept becomes a sign-off request for J).
  const serviceTitle = `Service day ${n}: ${SERVICE_TOPICS[day]}`;
  const serviceFile = `src/service/day${n}.ts`;
  const created = await x.j.daemon.ui.createTask(w.project.id, {
    title: serviceTitle,
    outcome: `${serviceFile} implements the ${SERVICE_TOPICS[day]}`,
    acceptanceCriteria: [`${serviceFile} exists`],
    riskTier: day === 1 ? 3 : 1,
    priority: 5,
    budgetUsdMicro: 1_000_000,
  });
  tasks.push(created.id);
  w.provider.pushReplies(
    ...coderWrites(serviceTitle, {
      [serviceFile]: `export const day${n} = ${JSON.stringify(SERVICE_TOPICS[day])};\n`,
    }),
  );
  if (weekday) {
    const gameTitle = `Game day ${n}: ${GAME_TOPICS[day]}`;
    const gameFile = `src/game/day${n}.ts`;
    const t = await x.m.daemon.ui.createTask(x.game.id, {
      title: gameTitle,
      outcome: `${gameFile} implements the ${GAME_TOPICS[day]}`,
      acceptanceCriteria: [`${gameFile} exists`],
      riskTier: 1,
      priority: 5,
      budgetUsdMicro: 1_000_000,
    });
    tasks.push(t.id);
    w.provider.pushReplies(
      ...coderWrites(gameTitle, {
        [gameFile]: `export const gameDay${n} = ${JSON.stringify(GAME_TOPICS[day])};\n`,
      }),
    );
  }
  const sessions: DaySessionReport[] = [];
  if (weekday) {
    await w.advanceTo(atZurich(day, "05:45"));
    const bob = await w.scheduledResult(w.bob);
    const row = await w.store.session.mustGet(bob.sessionId);
    must(row.trigger === "schedule", `Bob's day ${n} session trigger ${row.trigger}`);
    must(bob.status === "completed", `Bob's day ${n} session ${bob.status}`);
    sessions.push(sessionReport("Bob", row, bob.completed.length, bob.needsHuman.length));
  }
  await w.advanceTo(atZurich(day, "06:00"));
  const alice = await w.scheduledResult(w.alice);
  const aliceRow = await w.store.session.mustGet(alice.sessionId);
  must(aliceRow.trigger === "schedule", `Alice's day ${n} session trigger ${aliceRow.trigger}`);
  must(alice.status === "completed", `Alice's day ${n} session ${alice.status}`);
  sessions.push(sessionReport("Alice", aliceRow, alice.completed.length, alice.needsHuman.length));
  // 07:00: J reads the morning summary in the UI's inbox and marks it read.
  await w.advanceTo(atZurich(day, "07:00"));
  const inbox = await x.j.daemon.ui.inbox();
  const summary = inbox.messages.find(
    (msg) =>
      msg.fromAgentId === w.alice.agent.id &&
      msg.projectId === w.project.id &&
      (msg.createdAt ?? "") >= (aliceRow.started_at ?? "") &&
      msg.body.startsWith("Session "),
  );
  must(summary, `no session summary of day ${n} in J's inbox`);
  await x.j.daemon.ui.markRead(summary.id);
  return {
    day,
    name: DAY_NAMES[day] ?? `day ${n}`,
    tasks,
    sessions,
    summaryRead: true,
    afternoon: [],
  };
}

// ---------------------------------------------------------------------------------------
// Wednesday: the settings matrix

function entryOf(row: ChangeLogView): Record<string, unknown> {
  return {
    commands: row.commands,
    before: row.before,
    after: row.after,
    scope: row.scope,
    projectId: row.projectId,
    expiresAt: row.expiresAt,
    sentence: row.sentence,
    humanId: row.humanId,
    agentId: row.agentId,
  };
}

/** The fields of a change log entry that the gate compares across channels. */
export function sameEntry(a: ChangeLogView, b: ChangeLogView): boolean {
  return JSON.stringify(entryOf(a)) === JSON.stringify(entryOf(b));
}

async function changeById(x: Phase5World, id: string): Promise<ChangeLogView> {
  const rows = await x.j.daemon.ui.changes({ limit: 50 });
  const row = rows.find((r) => r.id === id);
  must(row, `change ${id} not in the UI's change log`);
  return row;
}

/** The value a settings change touches, read back from the state for the restore check. */
async function settingValue(x: Phase5World, change: SettingsChange): Promise<string> {
  const { w } = x;
  if (change === "budget") {
    const p = await w.store.project.mustGet(w.project.id);
    return JSON.stringify(p.settings.session_budget_override ?? null);
  }
  if (change === "autonomy")
    return String((await w.store.project.mustGet(w.project.id)).autonomy_level);
  const row = await w.store.extension.byName("capability", `email:${w.alice.agent.id}`);
  const settings = (row?.config as { settings?: { mode?: unknown } } | undefined)?.settings;
  return String(settings?.mode ?? "off");
}

/** The phone answers a high-risk card: refused without the biometric, applied with it. */
async function phoneConfirmsHighRisk(
  x: Phase5World,
  pendingId: string,
): Promise<{ withoutBiometric: number; withBiometric: number }> {
  const inbox = await x.approvals.inbox();
  const req = inbox.requests.find((r) => r.id === pendingId);
  must(req, `the high-risk card ${pendingId} is not in the phone's inbox`);
  must(req.risk === "high", `card ${pendingId} risk ${req.risk}`);
  must(req.options[0] === "approve on device", `card options ${req.options.join(",")}`);
  const plain = await x.approvals.answer(pendingId, req.options[0]);
  must(plain.status === 403, `a high-risk answer without biometric got ${plain.status}`);
  const bio = await x.approvals.answer(pendingId, req.options[0], { biometric: true });
  must(bio.status === 200, `a high-risk answer with biometric got ${bio.status}`);
  // The PC's next poll applies the inbox's answer to the pending card.
  await drainPc(x.w, x.pc);
  return { withoutBiometric: plain.status, withBiometric: bio.status };
}

interface ChangeOutcome {
  pendingId: string | null;
  decision: SettingsRecord["decision"];
  refusedYes: string | null;
  phoneAnswer: SettingsRecord["phoneAnswer"];
  hookApproval: SettingsRecord["hookApproval"];
  changeLogId: string;
}

/**
 * Whether the hooks ever filed a hold for the email mode command tool in this world (see
 * `SettingsRecord.hookApproval`): the hold is a blocking `approval` request whose card names
 * the tool, as the daemon's approval port writes it. None exists since RT-P5-3 was closed;
 * a card that forms at the first ask is then the registry's alone, not a reused hold.
 */
async function hooksHoldFiled(x: Phase5World): Promise<boolean> {
  const rows = await x.w.store.humanRequest.list({ kind: "approval" } as never);
  return rows.some(
    (r) => r.blocking && (r.change_card as { tool?: unknown } | null)?.tool === "email_mode_set",
  );
}

/**
 * The hooks' hold on the model path (see `SettingsRecord.hookApproval`): the blocking
 * request they filed is in the phone's inbox with the tool's risk (high: the service wants
 * the biometric); the phone answers it, and the caller asks again.
 */
async function phoneApprovesHooksHold(x: Phase5World, heldReply: string): Promise<HookApproval> {
  const inbox = await x.approvals.inbox();
  const held = inbox.requests.find(
    (r) => r.blocking && (r.changeCard as { tool?: unknown } | null)?.tool === "email_mode_set",
  );
  must(held, `the hooks' hold on email_mode_set is not in the phone's inbox (${heldReply})`);
  must(held.risk === "high" && held.options[0] === "yes", `hold ${held.id}: ${held.risk}`);
  const plain = await x.approvals.answer(held.id, "yes");
  must(plain.status === 403, `the hold's answer without biometric got ${plain.status}`);
  const bio = await x.approvals.answer(held.id, "yes", { biometric: true });
  must(bio.status === 200, `the hold's answer with biometric got ${bio.status}`);
  return {
    requestId: held.id,
    withoutBiometric: plain.status,
    withBiometric: bio.status,
    heldReply,
  };
}

async function byVoice(x: Phase5World, change: SettingsChange): Promise<ChangeOutcome> {
  const ask = change === "budget" ? BUDGET_ASK : change === "autonomy" ? AUTONOMY_ASK : EMAIL_ASK;
  let asked = await x.voice.say(ask);
  let hookApproval: SettingsRecord["hookApproval"] = null;
  if (change === "email") {
    if (asked.reply?.pendingConfirmation) {
      if (await hooksHoldFiled(x)) hookApproval = "reused";
    } else {
      hookApproval = await phoneApprovesHooksHold(x, asked.heard);
      asked = await x.voice.say(ask);
    }
  }
  const card = asked.reply?.pendingConfirmation;
  must(card, `voice: no card for "${ask}": ${asked.heard}`);
  must(asked.heard.includes(card.readback), "voice: the card was not read back");
  if (change === "email") {
    must(card.decision === "needs_device", `voice: email card decision ${card.decision}`);
    // A spoken yes alone is not enough for a high-risk change (Q.8).
    const yes = await x.voice.say("Yes, go ahead.");
    must(yes.approval?.approved === true, "voice: the spoken yes was not recognised");
    must(yes.reply?.actions.length === 0, "voice: a spoken yes applied a high-risk change");
    const refusedYes = yes.heard;
    must(refusedYes.includes("not enough"), `voice: unexpected reply to the yes: ${refusedYes}`);
    const phoneAnswer = await phoneConfirmsHighRisk(x, card.id);
    const row = (await x.j.daemon.ui.changes({ limit: 5 }))[0];
    must(row && row.source === "voice", "voice: the email change did not land in the log");
    return {
      pendingId: card.id,
      decision: card.decision,
      refusedYes,
      phoneAnswer,
      hookApproval,
      changeLogId: row.id,
    };
  }
  must(card.decision === "needs_yes", `voice: ${change} card decision ${card.decision}`);
  const done: VoiceTurn = await x.voice.say("Yes, go ahead.");
  must(done.approval?.approved === true, "voice: the yes was not recognised");
  const action = done.reply?.actions[0];
  must(action?.id, `voice: the yes did not run the change: ${done.heard}`);
  must(done.heard === action.summary, "voice: the sentence was not spoken");
  return {
    pendingId: card.id,
    decision: card.decision ?? null,
    refusedYes: null,
    phoneAnswer: null,
    hookApproval,
    changeLogId: action.id,
  };
}

async function undoByVoice(x: Phase5World): Promise<string> {
  const turn = await x.voice.say("Undo.");
  const action = turn.reply?.actions[0];
  must(action?.kind === "undo" && action.id, `voice: undo did not run: ${turn.heard}`);
  return action.id;
}

function chatBody(x: Phase5World, text: string) {
  return {
    humanId: x.w.j.id,
    agentId: x.w.alice.agent.id,
    projectId: x.w.project.id,
    text,
    source: "text" as const,
  };
}

async function byChat(x: Phase5World, change: SettingsChange): Promise<ChangeOutcome> {
  const ui = x.j.daemon.ui;
  const ask = change === "budget" ? BUDGET_ASK : change === "autonomy" ? AUTONOMY_ASK : EMAIL_ASK;
  let asked: ChatReplyView = await ui.chat(chatBody(x, ask));
  let hookApproval: SettingsRecord["hookApproval"] = null;
  if (change === "email") {
    if (asked.pendingConfirmation) {
      if (await hooksHoldFiled(x)) hookApproval = "reused";
    } else {
      hookApproval = await phoneApprovesHooksHold(x, asked.reply);
      asked = await ui.chat(chatBody(x, ask));
    }
  }
  const card = asked.pendingConfirmation;
  must(card, `chat: no card for "${ask}": ${asked.reply}`);
  if (change === "email") {
    must(card.decision === "needs_device", `chat: email card decision ${card.decision}`);
    const yes = await ui.chat(chatBody(x, "yes"));
    must(
      yes.actions.length === 0 && yes.reply.includes("not enough"),
      `chat: yes got ${yes.reply}`,
    );
    const phoneAnswer = await phoneConfirmsHighRisk(x, card.id);
    const row = (await ui.changes({ limit: 5 }))[0];
    must(row && row.source === "chat", "chat: the email change did not land in the log");
    return {
      pendingId: card.id,
      decision: card.decision,
      refusedYes: yes.reply,
      phoneAnswer,
      hookApproval,
      changeLogId: row.id,
    };
  }
  must(card.decision === "needs_yes", `chat: ${change} card decision ${card.decision}`);
  const done = await ui.chat(chatBody(x, "yes"));
  const action = done.actions[0];
  must(action?.id, `chat: the yes did not run the change: ${done.reply}`);
  return {
    pendingId: card.id,
    decision: card.decision ?? null,
    refusedYes: null,
    phoneAnswer: null,
    hookApproval,
    changeLogId: action.id,
  };
}

async function undoByChat(x: Phase5World): Promise<string> {
  const r = await x.j.daemon.ui.chat(chatBody(x, "undo"));
  const action = r.actions[0];
  must(action?.kind === "undo" && action.id, `chat: undo did not run: ${r.reply}`);
  return action.id;
}

/**
 * What the settings form sends for each change (`apps/ui/src/pages/SettingsPage.tsx`,
 * `commandForSetting`): the project from the row's scope, the CHF amount as typed, the
 * level as typed, the mode as picked, and the session window the way the app resolves
 * "tonight" (`endOfTonight` on the device's clock and the human's timezone). Built from the
 * fields, not from what the spoken change resolved to, so the `commands` half of
 * `sameEntry` is a real comparison on the UI column too (ADR 0045 item 6).
 */
function uiFormParams(x: Phase5World, change: SettingsChange): Record<string, unknown> {
  const { w } = x;
  if (change === "budget")
    return {
      scope: "session",
      amountChf: FORM_BUDGET_CHF,
      project: w.project.id,
      until: new Date(endOfTonight(w.clock.now(), w.j.timezone)).toISOString(),
    };
  if (change === "autonomy") return { level: FORM_AUTONOMY_LEVEL, project: w.project.id };
  return { mode: FORM_EMAIL_MODE };
}

/** The settings screen: the command with the form's values, the card, then the tap. */
async function byUi(x: Phase5World, change: SettingsChange): Promise<ChangeOutcome> {
  const ui = x.j.daemon.ui;
  const params = uiFormParams(x, change);
  const name =
    change === "budget" ? "budget.set" : change === "autonomy" ? "autonomy.set" : "email.mode.set";
  const first = await ui.executeCommands({
    commands: [{ name, params }],
    wordsUsed: `Settings: ${name} to ${JSON.stringify(params)}`,
    source: "ui",
    projectId: x.w.project.id,
  });
  must(first.status === "pending" && first.pendingId, `ui: ${name} did not ask: ${first.status}`);
  if (change === "email") {
    must(first.decision === "needs_device", `ui: email card decision ${first.decision}`);
    const phoneAnswer = await phoneConfirmsHighRisk(x, first.pendingId);
    const row = (await ui.changes({ limit: 5 }))[0];
    must(row && row.commands.length === 1, "ui: the email change did not land in the log");
    return {
      pendingId: first.pendingId,
      decision: first.decision,
      refusedYes: null,
      phoneAnswer,
      hookApproval: null,
      changeLogId: row.id,
    };
  }
  must(first.decision === "needs_yes", `ui: ${name} card decision ${first.decision}`);
  const tapped = await ui.confirmCommand(first.pendingId, { answer: "tap" });
  must(
    tapped.status === "done" && tapped.changeLogId,
    `ui: the tap did not run ${name}: ${tapped.status}`,
  );
  return {
    pendingId: first.pendingId,
    decision: first.decision,
    refusedYes: null,
    phoneAnswer: null,
    hookApproval: null,
    changeLogId: tapped.changeLogId,
  };
}

async function undoByUi(x: Phase5World, changeLogId: string): Promise<string> {
  const r = await x.j.daemon.ui.undoChange(changeLogId);
  must(r.status === "done" && r.changeLogId, `ui: undo of ${changeLogId} got ${r.status}`);
  return r.changeLogId;
}

/** Wednesday afternoon: every settings change by voice, by chat and through the UI, each undone. */
async function settingsMatrix(x: Phase5World): Promise<SettingsRecord[]> {
  const records: SettingsRecord[] = [];
  for (const change of ["budget", "autonomy", "email"] as const) {
    for (const channel of ["voice", "chat", "ui"] as const) {
      const before = await settingValue(x, change);
      const out =
        channel === "voice"
          ? await byVoice(x, change)
          : channel === "chat"
            ? await byChat(x, change)
            : await byUi(x, change);
      const row = await changeById(x, out.changeLogId);
      must(row.undoState === "undoable", `${channel} ${change}: undo state ${row.undoState}`);
      must(row.undoable, `${channel} ${change}: not undoable in the UI's view`);
      const during = await settingValue(x, change);
      must(during !== before, `${channel} ${change}: the state did not change`);
      const undoId =
        channel === "voice"
          ? await undoByVoice(x)
          : channel === "chat"
            ? await undoByChat(x)
            : await undoByUi(x, row.id);
      const undoRow = await changeById(x, undoId);
      const after = await settingValue(x, change);
      const undone = await changeById(x, row.id);
      must(
        undone.undoState === "undone",
        `${channel} ${change}: after the undo the state is ${undone.undoState}`,
      );
      records.push({
        change,
        channel,
        pendingId: out.pendingId,
        decision: out.decision,
        refusedYes: out.refusedYes,
        phoneAnswer: out.phoneAnswer,
        hookApproval: out.hookApproval,
        row: undone,
        undoRow,
        restored: after === before,
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------------------
// Wednesday: the voice turns

async function voiceTurns(x: Phase5World, count: number): Promise<VoiceTurn[]> {
  const turns: VoiceTurn[] = [];
  for (let i = 0; i < count; i++) {
    const t = await x.voice.say(STATUS_QUESTION);
    must(t.heard === STATUS_REPLY, `voice turn ${t.turn}: heard "${t.heard}"`);
    turns.push(t);
  }
  return turns;
}

function voiceReport(bridge: VoiceBridge, rows: number): VoiceReport {
  const reports = [...bridge.loop.latencies];
  return {
    turns: reports.length,
    medianMs: medianTotalToFirstAudio(reports),
    withinTarget: reports.filter((r) => r.withinTarget).length,
    stages: {
      endOfTurnMs: median(reports.map((r) => r.endOfTurnMs)),
      finalTranscriptMs: median(reports.map((r) => r.finalTranscriptMs)),
      modelFirstTokenMs: median(reports.map((r) => r.modelFirstTokenMs)),
      firstAudioMs: median(reports.map((r) => r.firstAudioMs)),
    },
    reports,
    rows,
  };
}

// ---------------------------------------------------------------------------------------
// Thursday: from the phone

async function phoneFlow(x: Phase5World): Promise<PhoneFlowReport> {
  const { w, app, phone } = x;
  // The work the started session will find on the game, created through J's UI.
  const gameTask = await x.j.daemon.ui.createTask(x.game.id, {
    title: GAME_TASK,
    outcome: "src/trade.ts exports the trading loop entry point",
    acceptanceCriteria: ["src/trade.ts exists"],
    riskTier: 1,
    priority: 5,
    budgetUsdMicro: 1_000_000,
  });
  w.provider.pushReplies(
    ...coderWrites(GAME_TASK, { "src/trade.ts": "export const trade = () => 'buy';\n" }),
  );
  const projects = await phone.get<{ projects: ProjectCard[] }>("/projects");
  must(projects.status === 200, `phone GET /projects: ${projects.status}`);
  const activeBefore = await x.j.commands.activeProject(w.j.id);
  must(
    activeBefore === w.project.id,
    `the active project before the phone flow is ${activeBefore}`,
  );
  const ctx = phoneContext(app, projects.body.projects, {
    timezone: w.j.timezone,
    now: w.clock.now(),
    activeProjectId: activeBefore,
    source: "voice",
  });
  const said = phoneUnderstands(app, PHONE_SENTENCE, ctx);
  const until = new Date(startOfTomorrow(w.clock.now(), w.j.timezone)).toISOString();
  must(
    said.plan.map((c) => c.name).join(",") === "project.switch,budget.set,session.start",
    `phone plan ${JSON.stringify(said.plan)}`,
  );
  const sent = await phoneConfirmsAndSends(phone, app, {
    plan: said.plan,
    card: said.card,
    words: PHONE_SENTENCE,
    confirmedAt: w.clock.nowIso(),
  });
  await drainPc(w, x.pc);
  const done = await x.approvals.command(sent.row.id);
  must(
    done.status === "done",
    `the phone's command ended ${done.status}: ${JSON.stringify(done.result)}`,
  );
  const result = done.result as { changeLogId?: string; executed?: string[] };
  must(result.changeLogId, "the plan ran without a change log id");
  const started = await w.scheduledResult(w.alice);
  const session = await w.store.session.mustGet(started.sessionId);
  must(
    started.completed.includes(gameTask.id),
    "the remote session did not complete the game task",
  );
  const gameRow = await w.store.project.mustGet(x.game.id);
  const override = gameRow.settings.session_budget_override as
    | { cap_chf_micro?: number; expires_at?: string }
    | undefined;
  must(
    override?.expires_at === until,
    `the override expires ${override?.expires_at}, expected ${until}`,
  );
  const activeAfter = await x.j.commands.activeProject(w.j.id);
  // Undo from the UI's Changes screen.
  const undo = await x.j.daemon.ui.undoChange(result.changeLogId);
  must(undo.status === "done", `undo of the phone's plan got ${undo.status}: ${undo.reason}`);
  const afterUndo = await w.store.project.mustGet(x.game.id);
  must(afterUndo.settings.session_budget_override === undefined, "the override survived the undo");
  const killFrozenAfterUndo = w.alice.kill.isFrozen({ agentId: w.alice.agent.id });
  const resumed = killFrozenAfterUndo ? await x.j.daemon.ui.resumeKill() : null;
  must(!w.alice.kill.isFrozen({ agentId: w.alice.agent.id }), "the kill switch stayed active");
  return {
    sentence: PHONE_SENTENCE,
    taskId: gameTask.id,
    plan: said.plan.map((c) => c.name),
    cardParts: said.card.parts?.map((p) => p.command) ?? [said.card.command],
    remoteCommandId: sent.row.id,
    remoteStatus: done.status,
    changeLogId: result.changeLogId,
    sessionId: session.id,
    sessionTrigger: session.trigger,
    sessionRunner: session.runner,
    sessionStatus: session.status,
    budgetCapUsdMicro: session.budget_cap_usd_micro,
    overrideChfMicro: override?.cap_chf_micro ?? 0,
    activeProjectAfter: activeAfter,
    undone: (await changeById(x, result.changeLogId)).undoState === "undone",
    activeProjectAfterUndo: await x.j.commands.activeProject(w.j.id),
    killFrozenAfterUndo,
    resumedFromUi: resumed?.ok === true && resumed.killActive === false,
  };
}

// ---------------------------------------------------------------------------------------
// The week

export async function runPhase5Week(x: Phase5World): Promise<Phase5Report> {
  const { w } = x;
  const days: DayReport[] = [];
  let voiceStatusTurns: VoiceTurn[] = [];
  let settings: SettingsRecord[] = [];
  let flow: PhoneFlowReport | null = null;
  let phoneChat: PhoneChatReport | null = null;
  let inboxCard: Phase5Report["inboxCard"] | null = null;
  let signoff: TaskRow | null = null;

  // Monday, before anything else: J opens the sample service in his UI (the active project).
  const opened = await x.j.daemon.ui.executeCommands({
    commands: [{ name: "project.switch", params: { project: w.project.id } }],
    wordsUsed: "",
  });
  must(opened.status === "done", `the UI's project switch got ${opened.status}`);

  for (let day = 0; day < PHASE5_DAYS; day++) {
    const report = await runMorning(x, day);
    await w.advanceTo(atZurich(day, "14:00"));
    if (day === 1) {
      // Tuesday: the tier 3 task's sign-off waits for J; he answers it on the phone.
      const inbox = await x.approvals.inbox();
      const req = inbox.requests.find((r) => r.blocking && r.kind === "approval" && r.taskId);
      must(req, "no blocking sign-off request in the phone's inbox on Tuesday");
      const answered = await x.approvals.answer(req.id, "accept");
      must(answered.status === 200, `the sign-off answer got ${answered.status}`);
      const atAnswer = (await w.store.task.mustGet(req.taskId as string)).status;
      // J's daemon applies the phone's answer on its approvals poll (RT-P5-1 closed); the
      // test asserts the task `done` at the end of the week.
      await w.advanceTo(w.clock.now() + WEEK_APPROVALS_POLL_MS);
      signoff = await w.store.task.mustGet(req.taskId as string);
      report.afternoon.push(
        `sign-off ${req.id} answered "accept" on the phone (task ${atAnswer}; ${signoff.status} after the daemon's approvals poll)`,
      );
    }
    if (day === 2) {
      // Wednesday: voice turns for the latency median, then the settings matrix.
      voiceStatusTurns = await voiceTurns(x, MIN_VOICE_TURNS);
      settings = await settingsMatrix(x);
      report.afternoon.push(
        `${voiceStatusTurns.length} voice status turns, ${settings.length} settings changes`,
      );
    }
    if (day === 3) {
      flow = await phoneFlow(x);
      report.afternoon.push(
        `phone plan ${flow.remoteCommandId} -> session ${flow.sessionId}, undone from the UI`,
      );
    }
    if (day === 4) {
      // Friday: the phone's quick chat runs on the PC.
      const row = await x.approvals.quickChat(x.app, STATUS_QUESTION, w.project.id);
      await drainPc(w, x.pc);
      const done = await x.approvals.command(row.id);
      const result = done.result as { kind?: string; reply?: string } | null;
      must(
        done.status === "done" && result?.kind === "chat",
        `the phone's chat ended ${done.status}`,
      );
      phoneChat = { commandId: row.id, status: done.status, reply: result?.reply ?? null };
      report.afternoon.push(`phone chat ${row.id} answered on the PC`);
    }
    if (day === 5) {
      // Saturday: a medium card asked by chat, answered in the phone's inbox (not by a yes).
      const asked = await x.j.daemon.ui.chat(chatBody(x, BUDGET_ASK));
      const card = asked.pendingConfirmation;
      must(card?.decision === "needs_yes", "Saturday: no medium card");
      const inbox = await x.approvals.inbox();
      const req = inbox.requests.find((r) => r.id === card.id);
      must(req?.options[0] === "yes", "Saturday: the card is not in the phone's inbox");
      const answered = await x.approvals.answer(card.id, "yes");
      must(answered.status === 200, `Saturday: the phone's yes got ${answered.status}`);
      await drainPc(w, x.pc);
      const row = (await x.j.daemon.ui.changes({ limit: 3 }))[0];
      must(
        row && row.undoState === "undoable" && row.commands.length === 1,
        "Saturday: the card was not applied",
      );
      const stored = await w.store.humanRequest.mustGet(card.id);
      inboxCard = {
        requestId: card.id,
        changeLogId: row.id,
        answerKind: JSON.stringify(stored.answer),
      };
      const undo = await x.j.daemon.ui.undoChange(row.id);
      must(undo.status === "done", `Saturday: undo got ${undo.status}`);
      report.afternoon.push(
        `medium card ${card.id} answered in the phone's inbox, applied by the PC, undone from the UI`,
      );
    }
    days.push(report);
  }
  await w.advanceTo(atZurich(PHASE5_DAYS, "00:00"));
  must(flow && phoneChat && inboxCard, "the week skipped an afternoon");
  must(signoff, "no sign-off on Tuesday");

  const sessions = await w.store.session.list(undefined, { limit: 500 });
  const real = sessions.filter((s) => s.summary !== "conversation");
  const tasks = await w.store.task.list(undefined, { limit: 500 });
  const prs = [
    ...(await w.pullRequests({ state: "all" })),
    ...(await w.alice.github.listPullRequests(GAME_REPO, { state: "all" })),
  ];
  const audit = await w.auditRows();
  const voiceRows = (await w.eventsOf(x.voice.sessionId)).filter(
    (e) => e.type === "voice.turn",
  ).length;
  return {
    start: PHASE5_START,
    end: w.clock.nowIso(),
    days,
    sessions: {
      scheduled: real.filter((s) => s.trigger === "schedule").length,
      remote: real.filter((s) => s.trigger === "remote").length,
      completed: real.filter((s) => s.status === "completed").length,
      tasksDone: tasks.filter((t) => t.status === "done").length,
      pullRequests: prs.length,
    },
    voice: voiceReport(x.voice, voiceRows),
    settings,
    phoneFlow: flow,
    phoneChat,
    inboxCard,
    phoneAnswers: x.approvals.answers,
    uiCalls: x.j.daemon.ui.calls.length + x.m.daemon.ui.calls.length,
    audit: {
      rows: audit.length,
      denied: audit.filter((r) => !r.allowed).length,
      remotePickups: audit.filter((r) => r.tool === REMOTE_AUDIT_TOOL).length,
    },
  };
}

/** The evidence lines for docs/status/gates.md. */
export function formatPhase5(r: Phase5Report): string {
  const lines: string[] = [];
  lines.push(`phase 5 week ${r.start} -> ${r.end}`);
  for (const d of r.days) {
    const s = d.sessions
      .map(
        (x) =>
          `${x.agent} ${x.trigger} ${x.status} done=${x.completed} human=${x.needsHuman} at ${x.startedAt ?? "-"}`,
      )
      .join("; ");
    lines.push(
      `${d.name}: tasks ${d.tasks.length}; ${s}; summary read ${d.summaryRead}${d.afternoon.length ? `; ${d.afternoon.join("; ")}` : ""}`,
    );
  }
  lines.push(
    `sessions: scheduled ${r.sessions.scheduled}, remote ${r.sessions.remote}, completed ${r.sessions.completed}; tasks done ${r.sessions.tasksDone}; pull requests ${r.sessions.pullRequests}`,
  );
  const v = r.voice;
  lines.push(
    `voice: ${v.turns} turns, median to first audio ${v.medianMs ?? "-"} ms (anchor ${FIRST_AUDIO_ANCHOR_MS}), ${v.withinTarget} within target; stage medians end of turn ${v.stages.endOfTurnMs}, final transcript ${v.stages.finalTranscriptMs}, model first token ${v.stages.modelFirstTokenMs}, first audio ${v.stages.firstAudioMs}; ${v.rows} voice.turn rows`,
  );
  for (const s of r.settings) {
    lines.push(
      `settings ${s.change} by ${s.channel}: ${s.decision ?? "act"}${s.hookApproval ? `, hooks hold ${s.hookApproval === "reused" ? "reused" : `${s.hookApproval.requestId} ${s.hookApproval.withoutBiometric}/${s.hookApproval.withBiometric}`}` : ""}${s.refusedYes ? ", yes refused" : ""}${s.phoneAnswer ? `, phone ${s.phoneAnswer.withoutBiometric}/${s.phoneAnswer.withBiometric}` : ""}; row ${s.row.id} source ${s.row.source} "${s.row.sentence}"; undo ${s.undoRow.id}; restored ${s.restored}`,
    );
  }
  const f = r.phoneFlow;
  lines.push(
    `phone: "${f.sentence}" -> ${f.plan.join(",")}; card ${f.cardParts.join(",")}; command ${f.remoteCommandId} ${f.remoteStatus}; session ${f.sessionId} ${f.sessionTrigger}/${f.sessionRunner} ${f.sessionStatus} cap ${f.budgetCapUsdMicro}; override CHF micro ${f.overrideChfMicro}; active ${f.activeProjectAfter} -> undone ${f.undone} -> ${f.activeProjectAfterUndo}; kill frozen after the undo ${f.killFrozenAfterUndo}, resumed from the UI ${f.resumedFromUi}`,
  );
  lines.push(`phone chat ${r.phoneChat.commandId} ${r.phoneChat.status}: ${r.phoneChat.reply}`);
  lines.push(
    `inbox card ${r.inboxCard.requestId} answer ${r.inboxCard.answerKind} -> change ${r.inboxCard.changeLogId}`,
  );
  lines.push(
    `phone answers: ${r.phoneAnswers.length} (${r.phoneAnswers.filter((a) => a.status === 200).length} accepted, ${r.phoneAnswers.filter((a) => a.biometric).length} with biometric)`,
  );
  lines.push(
    `ui calls ${r.uiCalls}; audit rows ${r.audit.rows}, denied ${r.audit.denied}, remote pickups ${r.audit.remotePickups}`,
  );
  const pinned = Object.entries(PHASE5_RUNTIME_FOLLOW_UPS as Record<string, string>)
    .map(([id, what]) => `${id} ${what}`)
    .join("; ");
  lines.push(
    `runtime follow-ups pinned (testing.md, Gate harnesses, Known issues): ${pinned || "none"}; closed: ${PHASE5_RUNTIME_FOLLOW_UPS_CLOSED.join(", ")}`,
  );
  return lines.join("\n");
}

export type { RemoteCommandView };
