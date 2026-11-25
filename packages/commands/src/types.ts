import type { PricingTable } from "@forerunner/billing";
import type { Clock } from "@forerunner/platform";
import type {
  ActionClass,
  AutonomyLevel,
  ContentSource,
  EffortLevel,
  ProviderCapabilities,
  SpecialistProposal,
  StartRequest,
} from "@forerunner/runtime";
import type {
  ChangeScope,
  ChangeSource,
  HumanRequestRow,
  JsonValue,
  ProjectRow,
  RiskLevel,
  StateStore,
} from "@forerunner/state";
import type { z } from "zod";
import type { CardSubject, ChangeCard } from "./change-card.ts";

/**
 * The command registry types (spec module Q). Every action a button, the palette, the API,
 * chat, voice or email can take is a CommandDef: typed parameters, a risk level, a scope and
 * an undo. The executor runs them through one confirmation policy and one change log.
 */

export type Risk = RiskLevel;
export type CommandScope = ChangeScope;
export type CommandSource = ChangeSource;

/** The commands shipped in this package (the registry accepts further names). */
export const COMMAND_NAMES = [
  "project.switch",
  "project.create",
  "task.create",
  "task.transition",
  "task.pause",
  "task.resume",
  "task.reopen",
  "task.update",
  "task.dependencies",
  "budget.set",
  "autonomy.set",
  "session.start",
  "session.stop",
  "session.pause",
  "session.resume",
  "capability.grant",
  "settings.set",
  "note.add",
  "summary.speak",
  "request.answer",
  "email.mode.set",
  "device.revoke",
  "memory.record",
  "model.settings.set",
  "specialist.propose",
  "repo.create",
  "repo.take_over",
  "project.join",
  "task.split",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];

export interface Actor {
  kind: "human" | "agent";
  id: string;
}

export interface SessionStartPortRequest extends StartRequest {
  budgetUsdMicro?: number;
  runner?: "pc" | "cloud";
  /** The device that asked (a phone or web client), when known. */
  deviceId?: string;
}

export interface KillScope {
  agentId?: string;
  sessionId?: string;
  /**
   * The undo of a `session.start` names the start it undoes (the `startId` the start port
   * answered with, kept in the row's `after.start_id`), so the runtime's port stops the
   * session that start began and nothing else: never the agent's scope, never a later start.
   */
  startId?: string;
}

export interface KillReportLike {
  stoppedRuns: number;
  killedProcesses: number;
}

/** A lesson the human stated (spec O.2, ADR 0061), for the principal's private memory. */
export interface LessonRecordPortRequest {
  /** The principal agent whose private memory receives it. */
  agentId: string;
  /** The human who stated it; the port refuses an agent this human does not own. */
  humanId: string;
  /** The project the lesson is about; null for every project of the agent. */
  projectId: string | null;
  text: string;
  tags: string[];
  /** `human:<id>;<chat|voice|...>:<conversation session id>` (the memory source grammar). */
  source: string;
}

export interface LessonRecordPortResult {
  lessonId: string;
  /** The text as stored (trimmed, normalised): what the sentence reads back. */
  text: string;
  /** `merged` when a near-duplicate lesson was superseded by this one. */
  action: "inserted" | "merged";
  supersededId?: string | null;
}

/**
 * A specialist the principal agent proposes (`specialist.propose`, spec C.5, ADR 0071): the
 * registry file's frontmatter without `status` (the gate forces `proposed`) and `eval_set`
 * (derived from the name), the role prompt, why, and who proposes it for whom. The shape is
 * the runtime's `SpecialistProposal`, so the port hands it to `SpecialistApprovals.propose`
 * unchanged.
 */
export type SpecialistProposePortRequest = SpecialistProposal;

export interface SpecialistProposePortResult {
  name: string;
  /** `<name>@<semver>+<sha8>` of the file written; the human is shown the same version. */
  promptVersion: string;
  /** The blocking approval request the gate filed for the human. */
  requestId: string;
  /** Registry-relative path of the proposal file (`proposed/<name>/specialist.md`). */
  file: string;
  /** `evals/<name>`: where the eval set must be before an approval can activate it. */
  evalSet: string;
  evalTaskCount: number;
  /** The gate's bar (ADR 0071): tasks decided and the pass rate a run needs. */
  minEvalTasks: number;
  passRate: number;
}

/** What the card needs before anything is written: the name's state and the eval set's size. */
export interface SpecialistNameState {
  name: string;
  /** `active`: a specialist of that name exists; `proposed`: a proposal is pending; null: free. */
  taken: "active" | "proposed" | null;
  evalTaskCount: number;
  minEvalTasks: number;
  passRate: number;
}

/**
 * The approval gate of proposed specialists (`RuntimeApp.specialistApprovals`, ADR 0071)
 * behind `specialist.propose`. `propose` writes `proposed/<name>/` and files the blocking
 * approval request; nothing here activates a specialist (only the human's approve and a
 * passing eval set do, in the runtime). `withdraw` is the command's undo: the proposal is
 * taken back while it still waits for the human.
 */
export interface SpecialistCommandPort {
  check(name: string): Promise<SpecialistNameState>;
  propose(req: SpecialistProposePortRequest): Promise<SpecialistProposePortResult>;
  withdraw(req: { name: string; humanId: string }): Promise<{ outcome: string }>;
}

/**
 * A repository for a project that has none (`repo.create`, U-037, ADR 0097), as the card shows
 * it before anything is created: the name, the account or organization, private or public.
 */
export interface RepoPreview {
  projectId: string;
  projectName: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  accountKind: "account" | "organization";
}

/**
 * The runtime's repository creator (`RepoCreator`, `src/loop/repo-create.ts`): `preview` checks
 * that the project has no repository and the person's GitHub token is there, and names the
 * repository; `create` creates it on the git host, pushes the project's workspace as the first
 * commit and links it to the project. Absent: `repo.create` is refused as unavailable.
 */
export interface RepoCommandPort {
  preview(req: {
    projectId: string;
    name?: string;
    owner?: string;
    private: boolean;
  }): Promise<RepoPreview>;
  create(req: {
    projectId: string;
    name: string;
    owner?: string;
    private: boolean;
    humanId: string;
    agentId: string | null;
  }): Promise<{ fullName: string; htmlUrl: string; files: number }>;
}

/** The memory the registry writes to: the runtime's `MemoryLoop` behind `memoryCommandPort`. */
export interface MemoryCommandPort {
  recordLesson(req: LessonRecordPortRequest): Promise<LessonRecordPortResult>;
  /** Undo: retire the recorded lesson and put back the one it superseded, if any. */
  forgetLesson(req: {
    lessonId: string;
    restoreId?: string | null;
    humanId: string;
  }): Promise<void>;
}

/**
 * What commands need from the rest of the system. Everything durable is the state store;
 * these ports are the live runtime (sessions, kill switch) and the billing rate.
 */
export interface CommandPorts {
  /** CHF per USD at the day's rate (the billing RateSource). */
  chfPerUsd(dateIso: string): Promise<number>;
  /**
   * Starts a session for the principal agent (the scheduler in production). `sessionId` when
   * the port knows it at once; `startId` the identity of the start request (the scheduler's
   * entry), which the undo passes back in its kill scope.
   */
  startSession?(
    req: SessionStartPortRequest,
  ): Promise<{ sessionId?: string; startId?: string } | undefined>;
  /** The kill switch: stops runs for one agent, one session or everyone. */
  kill?(scope: KillScope | "all", reason: string): Promise<KillReportLike | undefined>;
  pauseSession?(sessionId: string, reason: string): Promise<void>;
  resumeSession?(sessionId: string, reason: string): Promise<void>;
  /**
   * Stops the run working on one task now (U-039), or the critic's review of it (phase C): a
   * person paused, stopped or cancelled it. The session goes on with its other tasks. Answers
   * whether a live run or review of the task was stopped: only then does a cancel's sentence
   * say its work is removed (the session sets aside exactly such a run's changes). Absent: the
   * session notices the move at the task's end (the daemon's Tasks tab route also stops it).
   */
  stopTask?(taskId: string, reason: string): Promise<boolean | undefined> | boolean | undefined;
  /**
   * Whether a run or review of the task goes on in this app now (what `stopTask` would stop):
   * a cancel's read-back of a task in review says its review stops and its work is removed
   * only then (L-7). A running task's read-back always says its run stops (a run on another
   * computer stops once its runner sees the move). Absent: a task in review has no review.
   */
  liveWork?(taskId: string): boolean;
  /**
   * Undo of the cancel of a task that ran (phase C, live walk 2 C1): what its run changed,
   * which the session took out of the folder, goes back in. `missing` when nothing was taken
   * out; `conflict` when the folder changed since in the same places (nothing is put back).
   * Absent: the undo moves the task only.
   */
  bringBackWork?(taskId: string): Promise<"restored" | "missing" | "conflict">;
  /**
   * The cancel of a task that is not running (a paused one, budget-resume): its work in
   * progress is set aside (Undo and Reopen bring it back with `bringBackWork`). `files`: what was
   * taken out; `kept`: why it stays ('"Y" built on it', in a project's folder that another task
   * built on since). Absent: nothing is set aside.
   */
  setAsideWork?(taskId: string): Promise<{ files: string[]; kept: string | null }>;
  /**
   * Lifts Stop all ("Allow sessions again", design §3.1): new sessions may start. Answers
   * whether sessions were stopped. Absent: `session.resume` is refused as unavailable.
   */
  allowSessions?(): Promise<{ wasStopped: boolean }> | { wasStopped: boolean };
  /**
   * Why a session started now on the project would do nothing (design §3.6: Stop all is on,
   * Claude is not connected, nothing can run), in one sentence; null when it would work.
   * `session.start` refuses with it, as the Start dialog does. Absent: no check.
   */
  startBlocked?(projectId: string, budgetUsdMicro: number): Promise<string | null>;
  /** Starting a session above this budget is "costly" and needs a yes. Default USD 2. */
  costlySessionUsdMicro?: number;
  /** Lesson memory (`memory.record`); absent: the command is refused as unavailable. */
  memory?: MemoryCommandPort;
  /**
   * The specialist approval gate (`specialist.propose`, spec C.5, ADR 0071): the runtime's
   * `specialistCommandPort` over `RuntimeApp.specialistApprovals`. Absent: the command is
   * refused as unavailable; no command writes a proposal any other way.
   */
  specialists?: SpecialistCommandPort;
  /** Humans who share a project with the asking human. Default: project.settings.shared_with. */
  sharedWith?(projectId: string, humanId: string): Promise<string[]>;
  /**
   * Called after `request.answer` recorded an answer: the daemon applies it at once (its
   * `syncApprovals`: an approved plan starts, a sign-off closes the task), as its answer
   * route does, so an answer said in chat or voice acts like one given in the inbox.
   */
  requestAnswered?(requestId: string): Promise<void>;
  /**
   * Refuses an answer the request cannot act on (U-034): the runtime's `assertAnswerAccepted`,
   * the same check as the daemon's and the state service's answer routes, so a sign-off or plan
   * card answered in chat or voice with a word that is none of its options stays open and the
   * reply lists the options. Throws a `validation` ForerunnerError; absent, any answer is taken.
   */
  checkAnswer?(request: HumanRequestRow, answer: string): void;
  /**
   * A card as the Inbox shows it (the runtime's request words): its title, its options with
   * the one-line consequence of each, and, once answered, its Done line. `request.answer`
   * reads its card back in these words ("Approve and start (Plan for "X": 3 tasks)? Writes
   * these 3 tasks ...") and says the Done line when it is answered; absent, the request's own
   * `why` is quoted.
   */
  cardWords?(request: HumanRequestRow): Promise<{
    title: string;
    /**
     * `input: "note"`: the option takes a note for the next attempt (Try again, Send it back),
     * as the Inbox's note field does (fixup-l4-selftasks-carried); absent or null: none.
     */
    choices: { label: string; explain: string | null; input?: "note" | "text" | null }[];
    outcome: string | null;
  } | null>;
  /**
   * Called after `project.create` inserted the row (spec G.5, ADR 0058): the daemon scaffolds
   * the project's standard doc set, as its create route does. The command awaits the hook and
   * logs one that throws; the creation never fails on it.
   */
  projectCreated?(projectId: string): Promise<void>;
  /**
   * W15-36: the New project dialog's creation, as `POST /projects` makes it (the brief, the
   * plan from the brief or the standard doc set, the members): given for one call by that route,
   * so the dialog's create is one `project.create` with one Changes row. Absent: the command
   * inserts the row itself and calls `projectCreated`.
   */
  createProject?(params: { name: string; goal: string; repos: string[] }): Promise<ProjectRow>;
  /**
   * The price table in force (built-ins plus `<config>/pricing.json` and adopted rows), for a
   * setting whose effect quotes a price (`fast_mode`, spec D.20, ADR 0057). Default: the
   * built-in table.
   */
  pricingTable?(): PricingTable;
  /**
   * Read a text aloud through the voice provider (`summary.speak`, spec A.6, L.6): the runtime's
   * speaker over the registry's TTS. Absent, or answering `spoken: false` with the reason, the
   * command puts the text in its sentence instead.
   */
  speak?(req: SpeakPortRequest): Promise<SpeakPortResult>;
  /**
   * What `model.settings.set` checks against (spec D.4, ADR 0072): the runnable specialists'
   * names and the capability flags of the provider in use. Absent: any registry-shaped name
   * is accepted and a temperature is refused (no provider is known to accept one).
   */
  modelSettings?: {
    specialists(): readonly string[];
    capabilities(): ProviderCapabilities;
    /** A runnable specialist's `max_effort` from its registry file: no effort above it is stored. */
    maxEffort?(specialist: string): EffortLevel | undefined;
    /**
     * l4-selftasks-carried (L4-other-1 D-6): whether a specialist writes no file (none of its
     * tools writes one: the reviewer), so chat's read-back of a task for it says so.
     */
    writesNoFile?(specialist: string): boolean;
  };
  /**
   * Sets an agent's email sending mode through the capability's settings store (ADR 0081):
   * a mode change to `off` turns email commands off there, with the store's audit row and the
   * owner's notification. `restoreCommands` (an undo) turns commands back on with the mode.
   * Absent (tests, a hand-built loop), `email.mode.set` writes the row itself under the same
   * rule and audit row, without the notification.
   */
  emailMode?(req: EmailModePortRequest): Promise<EmailModePortResult>;
  /** Creates a project's repository (`repo.create`, U-037); absent, the command is unavailable. */
  repos?: RepoCommandPort;
  /**
   * D4 (d1109-oversize-start): the warning of a session started now on the project that would
   * take a task larger than its work budget ('"Build the shop" needs more than its work budget of
   * CHF 4.00: it pauses with its work kept and asks you to continue.'), the Start check's own
   * sentence for the chat; null when it takes none. `session.start` reads it back with its
   * question and never refuses such a start. Absent: no warning.
   */
  startWarning?(projectId: string, budgetUsdMicro: number): Promise<string | null>;
  /**
   * d1109-onerepo-link (ADR 0117): one repository, one project. `project.create` asks it in its
   * plan (so chat is refused before a read-back) and its run, before anything is written. It
   * resolves when the links are free, and throws the refusal otherwise: a `ForerunnerError`
   * 'validation' whose message names the project that uses the link and whose details carry the
   * offer and, when it quotes repository text (a marker's name), the untrusted mark. Absent:
   * nothing is checked.
   */
  repositoryUse?: {
    check(repos: readonly string[]): Promise<void>;
    /**
     * w8-together (W8-join-4): chat's Work together. What `project.create` with `together: true`
     * would join, read from GitHub now (never from the model): the repository's one other
     * Forerunner project's name as its marker gives it, cleaned and scanned (null when it has
     * none or it reads as an instruction). Throws the link's refusal in words otherwise.
     */
    together?(repos: readonly string[]): Promise<{ name: string | null }>;
    /**
     * The together project made on the yes, through the dialog's own creation (the repository's
     * id and name read from GitHub again at the run; a removed together row comes back).
     */
    createTogether?(params: { name: string; goal: string; repos: string[] }): Promise<ProjectRow>;
  };
  /**
   * d1109-onerepo-link (ADR 0117, OR-07): `repo.take_over` for a project whose repository names
   * a Forerunner project that is not on this computer. Absent: the command is refused.
   */
  repositoryTakeOver?: RepositoryTakeOverPort;
  /**
   * d1109-starts-engine (S-9, ADR 0118): a command that made a task ready prepares it after its
   * transaction: it joins the project's running session if it fits, else it waits for the
   * person's next Start (or the project's "Start a session by itself" starts one). Answers the
   * one line that says what happens next, or null. Absent: nothing is prepared or said.
   */
  prepareWork?(req: {
    projectId: string;
    taskIds: string[];
    by: "person" | "agent";
  }): Promise<string | null>;
  /** The same line, read-only, for chat's read-back of such a move (nothing joins or starts). */
  previewWork?(req: {
    projectId: string;
    by: "person" | "agent";
    /** The tasks the move makes ready (l4-starts-carried L4g-left-2: read with their estimate). */
    taskIds?: string[];
  }): Promise<string | null>;
  /**
   * S-10: one wait per project: the sentence that says when the person's session waiting for its
   * Claude credential goes on ("Your session of 14:05 goes on by itself at 15:40."), or null.
   * `session.start` answers it and starts nothing.
   */
  startWaits?(projectId: string): Promise<string | null>;
  /**
   * l4-starts-carried (L4a-left-5, S-10's "Start at 15:40" for chat): when a person's start of
   * the project now is kept for its Claude credential's reset ("at 15:40", "on 1 Dec": the
   * credential the work needs rests, nothing is kept or runs for the project), read-only; null
   * when a start now runs as usual. `session.start` reads it back ('Start a session on Map notes
   * at 15:40 (up to CHF 5.00)?').
   */
  startKeptWhen?(projectId: string): Promise<string | null>;
  /**
   * The same start kept for the reset (`RuntimeApp.continuations.keepStart`): its sentence ("A
   * session of Map notes starts at 15:40.") and the kept start's own id (fixup-l4-starts-carried:
   * its Undo drops that start only), or null when nothing waits for a reset now (the start then
   * runs as usual).
   */
  keepStart?(
    projectId: string,
    budgetUsdMicro: number,
  ): Promise<{ sentence: string; keptId: string } | null>;
  /**
   * Undo of a kept start: the start kept with that id is dropped and nothing starts at the
   * reset; a continuation or another kept start of the project stays. False when it no longer
   * waits (it ran, or it was cancelled).
   */
  cancelKeptStart?(projectId: string, keptId: string): Promise<boolean>;
  /**
   * d1109-onerepo-join (ADR 0117 amended): Make one project's checks, read by `project.join` in
   * its plan and again at its run. Absent: the command is refused as unavailable.
   */
  projectJoin?: ProjectJoinPort;
  /**
   * l4-chat-answers (L4-chat-103): a stored session result as it holds now (the daemon's
   * `resultAfterWait`): after Cancel, "...; then your session goes on." reads "...; then it runs
   * at your next Start.". Chat's "summary" reads the last result through it. Absent: as stored.
   */
  resultNow?(projectId: string, since: string | null, text: string): Promise<string>;
  /**
   * l4-starts-sessions (L4-money-204): a project budget or the monthly cap was just written: the
   * tasks paused at a limit that now has room are made ready again at once (prepared like every
   * wake, never started, except under the hands-off setting as built), and the answer is the
   * line that says so ("1 paused task is ready again: it runs at your next Start."), or null
   * when none was. Absent: the scheduler's next tick wakes them.
   */
  limitChanged?(projectId: string | null): Promise<string | null>;
}

/** What `project.join` asks the daemon before anything moves (`join-preview.ts`). */
export interface ProjectJoinPort {
  /**
   * Why the projects cannot be made one now, in one sentence (a session working or waiting to go
   * on, a plan waiting for its answer, a merge under way, no shared repository or folder, a
   * project that is not the person's own); null when nothing holds the join.
   */
  refusal(keepId: string, closeIds: readonly string[]): Promise<string | null>;
  /**
   * w8-together (OJ-11, W8-join-1, -2): Work together for a project already here, whose
   * repository is another Forerunner's project. Absent: the together form is refused.
   */
  together?: ProjectTogetherPort;
}

/** What `project.join`'s together form asks the daemon (`join-preview.ts`, `RepositoryUse`). */
export interface ProjectTogetherPort {
  /** Why it cannot be made now (gone, not the person's, running or waiting work), or null. */
  refusal(projectId: string): Promise<string | null>;
  /**
   * The repository's project, read from GitHub now (never from the page or the model); throws a
   * refusal in words when GitHub does not answer or the repository names no such project.
   */
  facts(projectId: string): Promise<ProjectTogetherFacts>;
  /**
   * W8-join-2 (D-W8-45): the join's one GitHub write: the project's own old status pull request,
   * if an earlier version of this install opened one, is closed; its number, or null when there
   * is none. Throws when GitHub does not answer (then nothing moves).
   */
  closeOldStatus(project: ProjectRow): Promise<number | null>;
}

/** The repository's project as `ProjectTogetherPort.facts` read it. */
export interface ProjectTogetherFacts {
  id: string;
  /** Its name in the repository (cleaned and scanned), or null. */
  name: string | null;
  activeOn: string | null;
  login: string | null;
  /** A together project with that id removed here: the row that comes back. */
  revive: ProjectRow | null;
  /** The name is repository text: the card and the outcome carry it as data. */
  untrusted: { source: "repo_file"; origin: string };
}

/** What `repo.take_over` takes, read from GitHub at the press (never from the model). */
export interface RepoTakeOverFacts {
  /** The repository as the person reads it: "o/kite". */
  locator: string;
  /** The ids the repository names that are not on this computer: the ones taken over. */
  projects: string[];
  /** The name its marker gives, cut, scanned and without quotes; null when none or flagged. */
  name: string | null;
}

export interface RepositoryTakeOverPort {
  /**
   * The take-over's facts, read from GitHub now; throws the refusal in words: another GitHub
   * account worked on it within 14 days, GitHub did not answer, or the repository names no
   * project that is not on this computer.
   */
  check(projectId: string): Promise<RepoTakeOverFacts>;
  /**
   * After `settings.took_over` is written: this project's docs pull request replaces exactly
   * that marker (the scaffold run again). Never throws: a failure leaves it to the next docs
   * pull request; the pull request opened or updated, when there is one, and `failed` when the
   * scaffold failed, so the sentence says what could not be done (C2-left-11).
   */
  writeMarker(projectId: string): Promise<{ prUrl: string | null; failed?: boolean }>;
  /**
   * Why the take-over cannot be undone now: its docs pull request is open (close it there
   * first) or merged (the repository names this project); null while neither is the case.
   */
  undoBlocked(projectId: string, since: string, prUrl: string | null): Promise<string | null>;
}

export interface EmailModePortRequest {
  agentId: string;
  mode: "off" | "read_only" | "draft_only" | "allowlist" | "full_discretion";
  /** The human who made the change, when a human did. */
  authorHuman: string | null;
  /** Turn email commands back on with the mode (the undo of a switch-off). */
  restoreCommands?: boolean;
}

export interface EmailModePortResult {
  /** Email commands were on before and the mode change to off turned them off. */
  commandsSwitchedOff: boolean;
}

export interface SpeakPortRequest {
  text: string;
  projectId: string;
  projectName: string;
  humanId: string;
  source: CommandSource;
}

export type SpeakPortResult = { spoken: true; id: string } | { spoken: false; reason: string };

export interface CommandContext {
  actor: Actor;
  /** The human the change is for (the actor, or the owner of an agent actor). */
  humanId: string;
  /** The human's principal agent: author of activity messages, subject of session commands. */
  agentId: string | null;
  activeProjectId: string | null;
  store: StateStore;
  clock: Clock;
  ports: CommandPorts;
  source: CommandSource;
  /** The words the human used (stored in the change log). */
  wordsUsed: string;
  /** IANA time zone of the human; "until 06:00" is read in it. */
  timezone: string;
  /** The device the request came from (a paired phone routes session commands remotely). */
  deviceId?: string | null;
  /** Session whose event log receives the spoken sentence (the conversation session). */
  sessionId?: string | null;
  /**
   * d1109-chat-guard (ADR 0114): the chat turn this change comes from read a record (a read
   * tool's or a command's answer marked untrusted, a card listed in full in words Forerunner did
   * not write, a flagged excerpt, lesson or task line in the facts). The executor then reads
   * every change back once, whatever its risk; stopping the running session and "stop after
   * this task" still act at once, Stop all is read back (`decideSteps`). Read when the command
   * tools build each call's context, so a lookup earlier in the turn counts.
   */
  recordsRead?: boolean;
  /**
   * d1109-selftasks-run (ADR 0119): the change is the agent's own fix of its task list (the task
   * check of a session, chat's "fix the tasks"), at the project's autonomy level. Set only by the
   * runtime, never from a request body or a tool's input (params are validated by each command's
   * schema; the context is built in code). At a level that frees `plan_fix` (Standard and up),
   * a change said in words acts at once without its read-back and posts no Inbox line (the
   * session's one Update tells it); a turn that read a record still reads it back (`recordsRead`
   * wins), and every risk rule holds as before. d1109-selftasks-chat: below Standard every
   * change of it is read back, a new task too; `askFirst` (the fence asked first: the person's
   * own task, a further reach, a deploy) reads it back at every level.
   */
  planFix?: {
    level: AutonomyLevel;
    askFirst?: boolean;
    /**
     * l4-selftasks-chat (run C decision 53): the task list's fingerprint its check judged
     * (`taskListFingerprint`); a Yes after the list changed says so and applies nothing.
     */
    fingerprint?: string;
  };
  /**
   * l4-selftasks-chat (L4-selftasks-116; run C decision 52, the owner's "Changes the person names
   * in their own words stay the person's instruction"): the change is one the chat model calls on
   * the person's own words in a conversation turn that read no record. Set only by the command
   * loop's chat tools (`CommandLoop.commandToolSpecs`), never from a request body or a tool's
   * input. It decides nothing: the change is planned, decided and read back as the agent's (ADR
   * 0030 item 2); once the person says yes it runs and is recorded as theirs ("Changed by you",
   * their name on Changes, no Inbox echo). One that acts at once stays the agent's act on the
   * Changes screen (security-command-actor.test.ts) and is not echoed in the Inbox either: the
   * chat's reply shows it with its Undo.
   */
  onPersonsWords?: boolean;
}

export interface CommandOutcome {
  before: JsonValue;
  after: JsonValue;
  /** The plain sentence posted to the activity log, ending in "Undo." when reversible. */
  sentence: string;
  /** Undo for this exact run; the executor prefers it over CommandDef.undo. */
  undo?: () => Promise<void>;
  /** ISO instant at which a temporary change reverts on its own. */
  expiresAt?: string | null;
  projectId?: string | null;
  /** Overrides CommandDef.reversible for this run (a transition without a way back). */
  reversible?: boolean;
  /** When the run changed the active project, so a composed plan can continue with it. */
  activeProjectId?: string | null;
  /** Appended to the change log when the run was only partly done. */
  note?: string;
  /**
   * d1109-chat-guard (ADR 0114): the sentence quotes text the person did not write (a
   * repository's marker, a page): the chat model gets it inside the data envelope, scanned, and
   * the rest of its turn reads every change back (`CommandContext.recordsRead`).
   */
  untrusted?: { source: ContentSource; origin?: string };
}

export type RiskFn<P> = (params: P, ctx: CommandContext) => Risk | Promise<Risk>;

export interface CommandDef<P = unknown> {
  /** Dotted name, e.g. "budget.set". */
  name: string;
  description: string;
  params: z.ZodType<P>;
  /** Static, or a function of the parameters and the current state. */
  risk: Risk | RiskFn<P>;
  /**
   * A change said in words (chat, voice) is read back for a yes first, whatever its risk
   * (design §3.9): the words were interpreted, so the person sees which task it touches
   * before it happens. The Tasks tab's buttons (source ui) act at once, with Undo.
   */
  askFromChat?: boolean;
  /**
   * w8-together (L4i-left-4): read back once in chat or voice when this says so for the call
   * (`task.create`: when its title or description is the model's words, not the person's).
   */
  askFromChatWhen?(params: P, ctx: CommandContext): boolean;
  /** The highest risk a dynamic risk can reach; the tool spec and the command table use it. */
  maxRisk?: Risk;
  /**
   * d1109-selftasks-run: false keeps the command out of the chat model's tools (`toToolSpecs`):
   * `task.split` is the session's task check's until d1109-selftasks-chat gives chat its own
   * `task_split` tool. Absent: every command is a tool.
   */
  chatTool?: boolean;
  scope: CommandScope | ((params: P) => CommandScope);
  reversible: boolean;
  /** One line stored in the command table: how the change is undone. */
  undoStrategy: string;
  /** Action class for the runtime's autonomy hooks; derived from the risk when absent. */
  actionClass?: ActionClass;
  /** The command changes a limit (budget, autonomy, capability, permissions). */
  limit?: boolean;
  /**
   * The call this one is said as instead, or null (the executor asks before it plans): a move
   * said in chat or voice on a task whose Inbox card offers the same thing is that card's
   * answer (`request.answer` with the option as its button says it), so the card stays the one
   * card about it (design §3.8, §3.9; phase E review: "try X again" filed a Resume card beside
   * the failed task's card). A redirected call is never redirected again.
   */
  redirect?(params: P, ctx: CommandContext): Promise<CommandCall | null>;
  /** Preview without acting. */
  plan?(params: P, ctx: CommandContext): Promise<ChangeCard>;
  run(params: P, ctx: CommandContext): Promise<CommandOutcome>;
  /**
   * State-based undo from the change log (works after a restart). A sentence it returns is
   * added to the undo's own ("What it changed is back in the folder.").
   */
  undo?(
    params: P,
    before: JsonValue,
    after: JsonValue,
    ctx: CommandContext,
    // l4-selftasks-chat (L4-selftasks-125): `unknown`, not `void | string`, so a plain undo that
    // returns nothing still fits; the executor reads a string result only.
  ): Promise<unknown>;
  /**
   * The risk of the undo (U-057, ADR 0099): the risk of putting `before` back on the current
   * state. An undo that raises or widens a limit is confirmed like the forward change that
   * would set that value (raising the monthly cap needs a paired device); one that lowers or
   * narrows acts at once. Absent: low, the undo acts at once.
   */
  undoRisk?(params: P, before: JsonValue, after: JsonValue, ctx: CommandContext): Promise<Risk>;
  /**
   * Why the undo cannot be done now, in plain words (U-061): the task moved on, the note was
   * already read. Null when it can. The executor refuses with it before anything runs, and the
   * change log offers Undo only when it is null, so nothing says "Undone" when nothing changed.
   */
  undoBlocked?(
    params: P,
    before: JsonValue,
    after: JsonValue,
    ctx: CommandContext,
    /**
     * l4-chat-carried (C4-left-6): the steps of the whole change this step is part of (a composed
     * row), so a check can tell what the same change did from what came after it.
     */
    change?: { steps: readonly { name: string; after: JsonValue }[] },
  ): Promise<string | null>;
  /**
   * l4-selftasks-chat (L4-selftasks-117): what the change names as it is now (a task's fields),
   * kept on its card when it is read back; the Yes compares it with the state then.
   */
  subjects?(params: P, ctx: CommandContext): Promise<CardSubject[]>;
  /** The sentence of a done undo, when "<what> is back to <old value>" would not be true. */
  undoSentence?(params: P, before: JsonValue, after: JsonValue): string;
  /**
   * The one-line question an undo that waits for a yes asks (W15-34): "Put <what> back to
   * <old value>? <What that means>." from the change log row alone, so it reads the same after a
   * restart. Absent: the executor asks from the change's card, else from its sentence.
   */
  undoAsk?(
    params: P,
    before: JsonValue,
    after: JsonValue,
    ctx: CommandContext,
  ): Promise<string | null>;
}

export interface CommandCall {
  name: string;
  params: unknown;
  /**
   * L4-selftasks-116: the call is a change the person named in their own words (its context's
   * `onPersonsWords` when it was read back), kept with a stored card so it stays theirs after a
   * restart or a merge with the agent's own changes (`CommandLoop.recompose`). Code sets it.
   */
  onPersonsWords?: boolean;
}
