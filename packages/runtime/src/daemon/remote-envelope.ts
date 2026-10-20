import { CHANGE_SOURCES } from "@forerunner/state";
import { z } from "zod";

/**
 * What a paired device puts into `remote_command.params` for the PC (ADR 0032). Two envelopes
 * carry version 1 and a `kind`; anything else is a bare verb with the cloud runner's parameter
 * shapes (ADR 0033) or the rows ADR 0030 item 7 enqueues. The daemon validates every shape
 * here before it acts, and never reads the phone's `card`: the registry plans the change again
 * on the real state and the confirmation policy decides on that card.
 */
export const REMOTE_ENVELOPE_VERSION = 1 as const;

export const RemotePlanStep = z.object({
  /** A registry command name, e.g. "project.switch". */
  name: z.string().min(1).max(80),
  params: z.unknown().optional(),
});
export type RemotePlanStep = z.infer<typeof RemotePlanStep>;

export const RemotePlanEnvelope = z.object({
  v: z.literal(REMOTE_ENVELOPE_VERSION),
  kind: z.literal("plan"),
  plan: z.array(RemotePlanStep).max(20),
  /** The words the human used; stored in the change log. */
  wordsUsed: z.string().max(4000).default(""),
  /** The card the device showed. Informational: the daemon plans again and ignores it. */
  card: z.unknown().optional(),
  clientId: z.string().max(200).optional(),
  /** When the human confirmed the card on the device; counts as the human's tap (medium risk). */
  confirmedAt: z.string().max(64).optional(),
  /** The change-log entry this plan undoes; the plan array is then ignored. */
  undoOf: z.string().min(1).max(200).optional(),
  /** Where the words came from; the change log's `source` (default "ui"). */
  source: z.enum(CHANGE_SOURCES).optional(),
});
export type RemotePlanEnvelope = z.infer<typeof RemotePlanEnvelope>;

export const RemoteChatEnvelope = z.object({
  v: z.literal(REMOTE_ENVELOPE_VERSION),
  kind: z.literal("chat"),
  text: z.string().min(1).max(20_000),
  projectId: z.string().min(1).optional(),
  clientId: z.string().max(200).optional(),
});
export type RemoteChatEnvelope = z.infer<typeof RemoteChatEnvelope>;

export const RemoteEnvelope = z.discriminatedUnion("kind", [
  RemotePlanEnvelope,
  RemoteChatEnvelope,
]);
export type RemoteEnvelope = z.infer<typeof RemoteEnvelope>;

/**
 * True when `params` claims to be a versioned envelope (a `v` and a `kind`): then it must parse
 * as one, and an unknown version is refused rather than read as a bare verb.
 */
export function isRemoteEnvelope(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const p = params as { v?: unknown; kind?: unknown };
  return p.v !== undefined && typeof p.kind === "string";
}

const scopeObject = z.object({
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
});

/** `kill` (ADR 0033, ADR 0034 item 6): everything, or one agent or session. */
export const RemoteKillParams = z.object({
  scope: z.union([z.literal("all"), scopeObject]).default("all"),
  reason: z.string().max(200).optional(),
});
export type RemoteKillParams = z.infer<typeof RemoteKillParams>;

/** `stop` / `session.stop` (ADR 0033 and the row ADR 0030 item 7 enqueues). */
export const RemoteStopParams = z.object({
  scope: z
    .union([z.literal("all"), z.literal("agent"), z.literal("session"), scopeObject])
    .default("agent"),
  session: z.string().nullish(),
  agentId: z.string().nullish(),
  reason: z.string().max(200).nullish(),
});
export type RemoteStopParams = z.infer<typeof RemoteStopParams>;

/** `start` / `session.start`. */
export const RemoteStartParams = z.object({
  agentId: z.string().nullish(),
  projectId: z.string().nullish(),
  budgetUsdMicro: z.number().int().positive().optional(),
  reason: z.string().max(200).nullish(),
});
export type RemoteStartParams = z.infer<typeof RemoteStartParams>;

/** `chat` without an envelope (ADR 0034 item 5: the approvals web). */
export const RemoteChatParams = z.object({
  text: z.string().min(1).max(20_000),
  projectId: z.string().min(1).optional(),
});
export type RemoteChatParams = z.infer<typeof RemoteChatParams>;
