/**
 * Shared fixture for the email tests: an in-memory state store, the testenv mail server with
 * DKIM and SPF, one human (J) with agent Alice, the settings store, policy, gate, fake provider
 * and command handler wired the way the orchestrator does it in production.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { type HumanRow, openStore, type ProjectRow, type StateStore } from "@forerunner/state";
import {
  type BuildAttachment,
  FakeProvider,
  generateDkimKeyPair,
  LocalMailServer,
  type ScriptedReply,
  type Mailbox as ServerMailbox,
  type StoredMessage,
  textReply,
} from "@forerunner/testenv";
import {
  AuditSentLog,
  AuthResultsHeaderVerifier,
  type CostEstimatePort,
  type EmailApprovalPort,
  EmailCommandGate,
  EmailCommandHandler,
  type EmailMode,
  EmailPolicy,
  EmailSettingsStore,
  FakeCloudSessions,
  FixedRate,
  HumanRequestApprovalPort,
  type InboundEmail,
  MemoryEventSink,
  ModelCommandClassifier,
  parseInboundEmail,
  StoreIdentityLookup,
  TestMailbox,
} from "../../src/email/index.ts";

export const DOMAIN = "example.test";
export const OWNER = `j@${DOMAIN}`;
export const AGENT = `alice@${DOMAIN}`;
export const OTHER = `bob@${DOMAIN}`;
export const STRANGER = "client@external.test";
export const MARKER = "[FR-test]";
export const OWNER_PASSWORD = ["owner", "pass", "word", "1"].join("-"); // not-a-secret
export const AGENT_PASSWORD = ["agent", "pass", "word", "2"].join("-"); // not-a-secret
export const OTHER_PASSWORD = ["other", "pass", "word", "3"].join("-"); // not-a-secret
export const RATE_CHF_PER_USD = 0.8;

/** 1 micro-USD per input token, 5 per output token: a tiny, exact fake price. */
export const fakeEstimate: CostEstimatePort = (est) =>
  est.inputTokens * 1 + est.maxOutputTokens * 5;

export interface WorldOptions {
  mode?: EmailMode;
  commands?: boolean;
  approvals?: EmailApprovalPort;
  replies?: ScriptedReply[];
  projects?: string[];
  timezone?: string;
  start?: string;
  dailySendCap?: number;
  perRecipientDailyCap?: number;
  signature?: boolean;
  dailyTaskCap?: number;
  perEmailCapChfMicro?: number;
  autonomyLevel?: number;
}

export interface World {
  clock: SimulatedClock;
  store: StateStore;
  server: LocalMailServer;
  human: HumanRow;
  agentId: string;
  projects: ProjectRow[];
  settings: EmailSettingsStore;
  identity: StoreIdentityLookup;
  sentLog: AuditSentLog;
  approvals: EmailApprovalPort;
  mailbox: TestMailbox;
  events: MemoryEventSink;
  policy: EmailPolicy;
  verifier: AuthResultsHeaderVerifier;
  gate: EmailCommandGate;
  provider: FakeProvider;
  cloud: FakeCloudSessions;
  handler: EmailCommandHandler;
  dataRoot: string;
  ownerBox: ServerMailbox;
  agentBox: ServerMailbox;
  stop(): Promise<void>;
}

export async function emailWorld(opts: WorldOptions = {}): Promise<World> {
  const clock = new SimulatedClock(opts.start ?? "2026-03-02T10:00:00.000Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = await store.human.insert({
    name: "J",
    email: OWNER,
    timezone: opts.timezone ?? "Europe/Zurich",
    default_autonomy: 2,
  });
  const agent = await store.agent.insert({ name: "Alice", owner_human_id: human.id });
  const projects: ProjectRow[] = [];
  for (const name of opts.projects ?? ["Sample"]) {
    projects.push(await store.project.insert({ name, goal: `goal of ${name}`, autonomy_level: 2 }));
  }
  const keys = generateDkimKeyPair(1024);
  const server = await LocalMailServer.start({
    domains: [DOMAIN],
    dkim: { selector: "fr1", ...keys },
    clock,
  });
  const ownerBox = server.createMailbox(OWNER, OWNER_PASSWORD);
  const agentBox = server.createMailbox(AGENT, AGENT_PASSWORD);
  server.createMailbox(OTHER, OTHER_PASSWORD);

  const settings = new EmailSettingsStore(store.extension, clock);
  await settings.update(agent.id, {
    settings: {
      mode: opts.mode ?? "full_discretion",
      mailbox: { address: AGENT, imap: null, smtp: null },
      ...(opts.dailySendCap !== undefined ? { dailySendCap: opts.dailySendCap } : {}),
      ...(opts.perRecipientDailyCap !== undefined
        ? { perRecipientDailyCap: opts.perRecipientDailyCap }
        : {}),
      ...(opts.signature !== undefined ? { signature: { enabled: opts.signature } } : {}),
    },
    commands: {
      enabled: opts.commands ?? true,
      registeredHumanAddress: OWNER,
      marker: MARKER,
      ...(opts.dailyTaskCap !== undefined ? { dailyTaskCap: opts.dailyTaskCap } : {}),
      ...(opts.perEmailCapChfMicro !== undefined
        ? { perEmailCapChfMicro: opts.perEmailCapChfMicro }
        : {}),
      ...(opts.autonomyLevel !== undefined ? { autonomyLevel: opts.autonomyLevel } : {}),
    },
  });
  const identity = new StoreIdentityLookup(store.agent, store.human);
  const sentLog = new AuditSentLog(store.auditLog, clock);
  const approvals = opts.approvals ?? new HumanRequestApprovalPort(store.humanRequest);
  const mailbox = new TestMailbox({ server, address: AGENT, clock });
  const events = new MemoryEventSink();
  const policy = new EmailPolicy({
    settings,
    identity,
    sentLog,
    approvals,
    mailboxFor: async () => mailbox,
    clock,
    events,
  });
  const verifier = new AuthResultsHeaderVerifier({ trustedAuthservIds: [server.authservId] });
  const gate = new EmailCommandGate({ settings, verifier, sentLog, clock });
  const provider = new FakeProvider({
    clock,
    latency: "none",
    replies: opts.replies ?? [],
    onNoMatch: "throw",
  });
  const cloud = new FakeCloudSessions({ startsAt: "now", logUrl: "forerunner://sessions/log" });
  const dataRoot = mkdtempSync(join(tmpdir(), "fr-email-"));
  const handler = new EmailCommandHandler({
    gate,
    settings,
    identity,
    policy,
    classifier: new ModelCommandClassifier(provider, "fake-haiku"),
    store: {
      task: store.task,
      queue: store.queue,
      project: store.project,
      auditLog: store.auditLog,
    },
    approvals,
    cloud,
    estimateUsdMicro: fakeEstimate,
    estimateModel: "fake-haiku",
    rates: new FixedRate(RATE_CHF_PER_USD),
    clock,
    projectDataDir: (projectId) => join(dataRoot, projectId),
    events,
  });
  return {
    clock,
    store,
    server,
    human,
    agentId: agent.id,
    projects,
    settings,
    identity,
    sentLog,
    approvals,
    mailbox,
    events,
    policy,
    verifier,
    gate,
    provider,
    cloud,
    handler,
    dataRoot,
    ownerBox,
    agentBox,
    async stop() {
      await server.stop();
      await store.close();
    },
  };
}

export interface OwnerMailOptions {
  subject: string;
  text: string;
  /** Prefix the subject with the command marker (default true). */
  marker?: boolean;
  attachments?: BuildAttachment[];
  inReplyTo?: string;
  references?: string[];
  from?: string;
}

/** The owner sends a message through the authenticated submission listener (signed, SPF pass). */
export async function ownerSends(world: World, opts: OwnerMailOptions): Promise<StoredMessage> {
  const subject = opts.marker === false ? opts.subject : `${MARKER} ${opts.subject}`;
  const result = await world.server.sendFrom(opts.from ?? OWNER, {
    to: AGENT,
    subject,
    text: opts.text,
    attachments: opts.attachments,
    inReplyTo: opts.inReplyTo,
    references: opts.references,
  });
  const delivered = result.delivered.find((m) => m.mailbox === AGENT);
  if (!delivered) throw new Error("message was not delivered to the agent");
  return delivered;
}

export function inboundOf(stored: StoredMessage): Promise<InboundEmail> {
  return parseInboundEmail(stored.raw, { id: stored.id, receivedAt: stored.receivedAt });
}

export function lastOutbox(world: World) {
  return world.server.outbox[world.server.outbox.length - 1];
}

export function lastOwnerMail(world: World): StoredMessage | undefined {
  return world.ownerBox.messages[world.ownerBox.messages.length - 1];
}

/** A scripted classifier reply. */
export function interpretation(
  body: {
    kind: "question" | "task" | "note";
    project?: string | null;
    title?: string;
    summary: string;
    answer?: string | null;
  },
  when: string,
): ScriptedReply {
  return textReply(
    JSON.stringify({
      kind: body.kind,
      project: body.project ?? null,
      title: body.title ?? "Email task",
      summary: body.summary,
      answer: body.answer ?? null,
    }),
    { when: { lastUserIncludes: when } },
  );
}
