import { z } from "zod";

/**
 * Shapes the state service answers with. They mirror the daemon API views (ADR 0011,
 * `packages/runtime/src/daemon/api-types.ts`) that the service reuses (ADR 0024) plus the
 * service-only views (`services/state-api/src/views.ts`). This page cannot import the runtime
 * package (it is a browser bundle with its own dependency list), so the schemas it needs are
 * repeated here; every response is validated with them before a screen sees it.
 */
export const Money = z.object({ usdMicro: z.number().int(), chfMicro: z.number().int() });
export type Money = z.infer<typeof Money>;

export const ProjectCard = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  stage: z.string(),
  status: z.string(),
  autonomyLevel: z.number().int().min(0).max(4),
  nextMilestone: z
    .object({ id: z.string(), name: z.string(), targetDate: z.string().nullable() })
    .nullable(),
  health: z.enum(["good", "attention", "blocked", "idle"]),
  spend: Money,
  budget: Money,
  waitingOnYou: z.number().int(),
  latestCriticGrade: z.number().int().min(0).max(100).nullable(),
  lastSessionAt: z.string().nullable(),
  active: z.boolean(),
});
export type ProjectCard = z.infer<typeof ProjectCard>;
export const ProjectList = z.object({ projects: z.array(ProjectCard) });

export const MessageView = z.object({
  id: z.string(),
  fromAgentId: z.string(),
  fromAgentName: z.string(),
  toAgentId: z.string().nullable(),
  toHumanId: z.string().nullable(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  type: z.string(),
  body: z.string(),
  requiresAck: z.boolean(),
  deliveredAt: z.string().nullable(),
  readAt: z.string().nullable(),
  actedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MessageView = z.infer<typeof MessageView>;

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const HumanRequestView = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  taskId: z.string().nullable(),
  sessionId: z.string().nullable(),
  kind: z.string(),
  why: z.string(),
  steps: z.array(z.string()),
  options: z.array(z.string()),
  blocking: z.boolean(),
  risk: z.enum(RISK_LEVELS),
  changeCard: z.unknown().nullable(),
  status: z.string(),
  answer: z.unknown().nullable(),
  createdAt: z.string(),
  version: z.number().int(),
});
export type HumanRequestView = z.infer<typeof HumanRequestView>;

export const InboxView = z.object({
  requests: z.array(HumanRequestView),
  messages: z.array(MessageView),
  blockingCount: z.number().int(),
});
export type InboxView = z.infer<typeof InboxView>;

/** The risk a change card declares, when it declares one (module Q). */
export function changeCardRisk(card: unknown): RiskLevel | null {
  if (!card || typeof card !== "object") return null;
  const risk = (card as { risk?: unknown }).risk;
  return typeof risk === "string" && (RISK_LEVELS as readonly string[]).includes(risk)
    ? (risk as RiskLevel)
    : null;
}

/** High risk means the service demands `confirm:high` (ADR 0009): the page must confirm. */
export function isHighRisk(r: Pick<HumanRequestView, "risk" | "changeCard">): boolean {
  return r.risk === "high" || changeCardRisk(r.changeCard) === "high";
}

export const PairingCompleteView = z.object({
  deviceId: z.string(),
  humanId: z.string(),
  kind: z.string(),
  token: z.string().min(1),
  expiresAt: z.string(),
  scopes: z.array(z.string()),
  schemaVersion: z.number().int(),
});
export type PairingCompleteView = z.infer<typeof PairingCompleteView>;

export const MeView = z.object({
  principal: z.literal("device"),
  deviceId: z.string(),
  humanId: z.string(),
  humanName: z.string().nullable(),
  kind: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.string(),
  signed: z.boolean(),
  schemaVersion: z.number().int(),
});
export type MeView = z.infer<typeof MeView>;

export const DeviceView = z.object({
  id: z.string(),
  ownerHumanId: z.string(),
  name: z.string(),
  platform: z.string(),
  kind: z.string(),
  publicKey: z.string(),
  lastSeen: z.string().nullable(),
  revoked: z.boolean(),
  revokedAt: z.string().nullable(),
  pairedAt: z.string(),
  version: z.number().int(),
});
export type DeviceView = z.infer<typeof DeviceView>;
export const DeviceList = z.object({ devices: z.array(DeviceView) });

export const SessionView = z.object({
  id: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  projectId: z.string().nullable(),
  trigger: z.string(),
  status: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  budgetCap: Money,
  spent: Money,
  stepCap: z.number().int(),
  steps: z.number().int(),
  currentTask: z.object({ id: z.string(), title: z.string(), specialist: z.string() }).nullable(),
  summary: z.string(),
  handoff: z.unknown().nullable(),
  runner: z.string(),
});
export type SessionView = z.infer<typeof SessionView>;
export const SessionList = z.object({ sessions: z.array(SessionView) });

export const REMOTE_TARGETS = ["pc", "cloud"] as const;
export type RemoteTarget = (typeof REMOTE_TARGETS)[number];
/** `chat` is the relay this page needs (ADR: approvals web); the others are the service's. */
export const REMOTE_COMMANDS = ["start", "pause", "stop", "kill", "chat"] as const;
export type RemoteCommandName = (typeof REMOTE_COMMANDS)[number];
export const REMOTE_COMMAND_STATUSES = ["pending", "picked_up", "done", "failed"] as const;

export const RemoteCommandView = z.object({
  id: z.string(),
  deviceId: z.string(),
  target: z.string(),
  targetDeviceId: z.string().nullable(),
  command: z.string(),
  params: z.record(z.string(), z.unknown()),
  status: z.enum(REMOTE_COMMAND_STATUSES),
  pickedUpAt: z.string().nullable(),
  result: z.unknown(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type RemoteCommandView = z.infer<typeof RemoteCommandView>;
export const RemoteCommandList = z.object({ commands: z.array(RemoteCommandView) });

/** The web stand-in for the phone's biometric step: a fresh code through the notification channel. */
export const ConfirmChallengeView = z.object({
  challengeId: z.string(),
  expiresAt: z.string(),
  /** Where the code went, in plain words ("your phone", "the desktop app", "email"). */
  channel: z.string(),
});
export type ConfirmChallengeView = z.infer<typeof ConfirmChallengeView>;

export const HealthView = z.object({
  ok: z.literal(true),
  service: z.string(),
  version: z.string(),
  time: z.string(),
});
export type HealthView = z.infer<typeof HealthView>;

export const ErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** One frame of `GET /events` (services/state-api/src/realtime.ts `ChangeEvent`). */
export const ChangeEvent = z.object({
  seq: z.number().int(),
  type: z.string(),
  at: z.string(),
  humanId: z.string().nullable(),
  projectId: z.string().nullable(),
  sessionId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  origin: z.string(),
});
export type ChangeEvent = z.infer<typeof ChangeEvent>;

/** `payload.id` of a change event, when it has one. */
export function changedId(e: ChangeEvent): string | null {
  const id = e.payload.id;
  return typeof id === "string" ? id : null;
}
