/**
 * Production adapters and in-memory fakes for the ports in types.ts. The orchestrator wires
 * the adapters; tests use the fakes. Nothing here enforces a limit: that is policy.ts and
 * commands.ts.
 */
import { ForerunnerError } from "@forerunner/platform";
import type {
  AgentRepo,
  EventRepo,
  HumanRepo,
  HumanRequestRepo,
  HumanRequestRow,
  JsonObject,
} from "@forerunner/state";
import type {
  ApprovalAnswer,
  CloudSessionRequest,
  CloudSessionStarted,
  EmailApprovalPort,
  EmailApprovalRequest,
  EmailApprovalTicket,
  EmailIdentity,
  EventSink,
  IdentityPort,
  RatePort,
  StartCloudSessionPort,
} from "./types.ts";

// ---------------------------------------------------------------------------------------------
// Identity

export class StoreIdentityLookup implements IdentityPort {
  constructor(
    private readonly agents: AgentRepo,
    private readonly humans: HumanRepo,
  ) {}

  async lookup(agentId: string): Promise<EmailIdentity> {
    const agent = await this.agents.mustGet(agentId);
    const human = await this.humans.mustGet(agent.owner_human_id);
    return {
      agentId: agent.id,
      agentName: agent.name,
      humanId: human.id,
      humanName: human.name,
      humanEmail: human.email.trim().toLowerCase(),
      timezone: human.timezone || "UTC",
    };
  }
}

export class StaticIdentity implements IdentityPort {
  constructor(private readonly identities: EmailIdentity[]) {}
  async lookup(agentId: string): Promise<EmailIdentity> {
    const found = this.identities.find((i) => i.agentId === agentId);
    if (!found) throw new ForerunnerError("not_found", `no identity for agent ${agentId}`);
    return found;
  }
}

// ---------------------------------------------------------------------------------------------
// Approvals: HumanRequest rows in production, a map in tests

const APPROVAL_CARD_KIND = "email_approval";

function ticketFromRow(row: HumanRequestRow): EmailApprovalTicket {
  const card = (row.change_card ?? {}) as JsonObject;
  const request = card.request as unknown as EmailApprovalRequest | undefined;
  if (card.kind !== APPROVAL_CARD_KIND || !request) {
    throw new ForerunnerError("validation", `human request ${row.id} is not an email approval`);
  }
  let answer: ApprovalAnswer = "pending";
  if (row.status === "answered") {
    const given = typeof row.answer === "string" ? row.answer.trim().toLowerCase() : "";
    answer = given === "yes" ? "yes" : "no";
  } else if (row.status === "expired" || row.status === "withdrawn") {
    answer = "no";
  }
  return { id: row.id, answer, request, answeredBy: row.answered_by };
}

/** Approvals as `human_request` rows (kind "approval"); the answer arrives later. */
export class HumanRequestApprovalPort implements EmailApprovalPort {
  constructor(private readonly requests: HumanRequestRepo) {}

  async ask(req: EmailApprovalRequest): Promise<EmailApprovalTicket> {
    const row = await this.requests.insert({
      human_id: req.humanId,
      project_id: req.projectId ?? null,
      session_id: req.sessionId ?? null,
      task_id: req.taskId ?? null,
      kind: "approval",
      why: req.why,
      steps: ["Answer yes or no in the app, or reply yes or no to the email."],
      options: ["yes", "no"],
      blocking: false,
      risk: req.risk,
      change_card: { kind: APPROVAL_CARD_KIND, request: req as unknown as JsonObject },
      author_agent: req.agentId,
    });
    return ticketFromRow(row);
  }

  async get(id: string): Promise<EmailApprovalTicket | undefined> {
    const row = await this.requests.get(id);
    return row ? ticketFromRow(row) : undefined;
  }

  async answer(id: string, answer: "yes" | "no", by: string): Promise<EmailApprovalTicket> {
    const row = await this.requests.mustGet(id);
    if (row.status === "answered") return ticketFromRow(row);
    const updated = await this.requests.answer(id, row.version, answer, by);
    return ticketFromRow(updated);
  }
}

/** In-memory approvals for tests: answers at once with `autoAnswer`, or stays pending. */
export class FakeApprovalPort implements EmailApprovalPort {
  readonly tickets = new Map<string, EmailApprovalTicket>();
  readonly asked: EmailApprovalRequest[] = [];
  private seq = 0;

  constructor(public autoAnswer: ApprovalAnswer = "pending") {}

  async ask(req: EmailApprovalRequest): Promise<EmailApprovalTicket> {
    this.asked.push(req);
    const ticket: EmailApprovalTicket = {
      id: `approval-${++this.seq}`,
      answer: this.autoAnswer,
      request: req,
      answeredBy: this.autoAnswer === "pending" ? null : "fake",
    };
    this.tickets.set(ticket.id, ticket);
    return ticket;
  }

  async get(id: string): Promise<EmailApprovalTicket | undefined> {
    return this.tickets.get(id);
  }

  async answer(id: string, answer: "yes" | "no", by: string): Promise<EmailApprovalTicket> {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new ForerunnerError("not_found", `no approval ${id}`);
    if (ticket.answer === "pending") {
      ticket.answer = answer;
      ticket.answeredBy = by;
    }
    return ticket;
  }
}

// ---------------------------------------------------------------------------------------------
// Rates, events, cloud sessions

export class FixedRate implements RatePort {
  constructor(private readonly rate: number) {}
  async chfPerUsd(): Promise<number> {
    return this.rate;
  }
}

export class StoreEventSink implements EventSink {
  constructor(
    private readonly events: EventRepo,
    private readonly authorAgent?: string,
  ) {}
  async append(sessionId: string, type: string, payload: JsonObject): Promise<void> {
    await this.events.append(sessionId, type, payload, 0, {
      redacted: true,
      authorAgent: this.authorAgent ?? null,
    });
  }
}

export class MemoryEventSink implements EventSink {
  readonly events: Array<{ sessionId: string; type: string; payload: JsonObject }> = [];
  async append(sessionId: string, type: string, payload: JsonObject): Promise<void> {
    this.events.push({ sessionId, type, payload });
  }
}

/** Records requests and returns a session id; tests inspect `started`. */
export class FakeCloudSessions implements StartCloudSessionPort {
  readonly started: CloudSessionRequest[] = [];
  private seq = 0;
  constructor(private readonly opts: { startsAt?: string; logUrl?: string; fail?: Error } = {}) {}
  async start(req: CloudSessionRequest): Promise<CloudSessionStarted> {
    if (this.opts.fail) throw this.opts.fail;
    this.started.push(req);
    const sessionId = `cloud-session-${++this.seq}`;
    return {
      sessionId,
      startsAt: this.opts.startsAt ?? "now",
      logUrl: this.opts.logUrl ?? `forerunner://sessions/${sessionId}`,
    };
  }
}
