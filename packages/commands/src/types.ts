import type { PricingTable } from "@forerunner/billing";
import type { Clock } from "@forerunner/platform";
import type { ActionClass, StartRequest } from "@forerunner/runtime";
import type {
  ChangeScope,
  ChangeSource,
  JsonValue,
  RiskLevel,
  StateStore,
} from "@forerunner/state";
import type { z } from "zod";
import type { ChangeCard } from "./change-card.ts";

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
  "budget.set",
  "autonomy.set",
  "session.start",
  "session.stop",
  "session.pause",
  "capability.grant",
  "settings.set",
  "note.add",
  "request.answer",
  "email.mode.set",
  "device.revoke",
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
  /** Starting a session above this budget is "costly" and needs a yes. Default USD 2. */
  costlySessionUsdMicro?: number;
  /** Humans who share a project with the asking human. Default: project.settings.shared_with. */
  sharedWith?(projectId: string, humanId: string): Promise<string[]>;
  /**
   * Called after `request.answer` recorded an answer: the daemon applies it at once (its
   * `syncApprovals`: an approved plan starts, a sign-off closes the task), as its answer
   * route does, so an answer said in chat or voice acts like one given in the inbox.
   */
  requestAnswered?(requestId: string): Promise<void>;
  /**
   * The price table in force (built-ins plus `<config>/pricing.json` and adopted rows), for a
   * setting whose effect quotes a price (`fast_mode`, spec D.20, ADR 0057). Default: the
   * built-in table.
   */
  pricingTable?(): PricingTable;
}

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
}

export type RiskFn<P> = (params: P, ctx: CommandContext) => Risk | Promise<Risk>;

export interface CommandDef<P = unknown> {
  /** Dotted name, e.g. "budget.set". */
  name: string;
  description: string;
  params: z.ZodType<P>;
  /** Static, or a function of the parameters and the current state. */
  risk: Risk | RiskFn<P>;
  /** The highest risk a dynamic risk can reach; the tool spec and the command table use it. */
  maxRisk?: Risk;
  scope: CommandScope | ((params: P) => CommandScope);
  reversible: boolean;
  /** One line stored in the command table: how the change is undone. */
  undoStrategy: string;
  /** Action class for the runtime's autonomy hooks; derived from the risk when absent. */
  actionClass?: ActionClass;
  /** The command changes a limit (budget, autonomy, capability, permissions). */
  limit?: boolean;
  /** Preview without acting. */
  plan?(params: P, ctx: CommandContext): Promise<ChangeCard>;
  run(params: P, ctx: CommandContext): Promise<CommandOutcome>;
  /** State-based undo from the change log (works after a restart). */
  undo?(params: P, before: JsonValue, after: JsonValue, ctx: CommandContext): Promise<void>;
}

export interface CommandCall {
  name: string;
  params: unknown;
}
