import type { HumanRequestRepo } from "@forerunner/state";
import { isYes } from "../wiring/state-ports.ts";
import type {
  CapabilityGrantRequest,
  ExtensionApprovalPort,
  GrantAnswer,
  GrantOutcome,
} from "./types.ts";

/**
 * Granting a new capability always needs a human (spec Security). In production the question
 * is a HumanRequest of kind `approval`, risk `high`, blocking, with the review as its options;
 * the inbox answers it and the registry picks the answer up (`syncApprovals`, or the
 * orchestrator calls `approve`/`deny`). A connector that is not a built-in catalog entry asks
 * twice: `discovery` (start it once, with the secrets it names) and then `grant`. Tests use
 * the in-memory port.
 */
export class HumanRequestExtensionApprovals implements ExtensionApprovalPort {
  constructor(private readonly requests: HumanRequestRepo) {}

  async ask(req: CapabilityGrantRequest): Promise<GrantAnswer> {
    const row = await this.requests.insert({
      human_id: req.humanId,
      kind: "approval",
      why: req.why,
      steps: [
        `Extension: ${req.name} (${req.kind})`,
        `Step: ${req.stage === "discovery" ? "start once for discovery (nothing granted yet)" : "grant"}`,
        ...(req.sourceUrl ? [`Source: ${req.sourceUrl}`] : []),
        ...req.review.summary,
      ],
      options: [
        {
          choice: "approve",
          stage: req.stage,
          permissions: req.permissions as never,
          review: req.review as never,
        },
        { choice: "deny" },
      ],
      blocking: true,
      risk: "high",
      change_card: {
        key: `extension:${req.extensionId}:${req.stage}`,
        extensionId: req.extensionId,
        stage: req.stage,
        kind: req.kind,
        name: req.name,
        permissions: req.permissions as never,
        previous: (req.previous ?? null) as never,
      },
    });
    return { outcome: "pending", requestId: row.id };
  }

  async status(requestId: string): Promise<GrantOutcome> {
    const row = await this.requests.get(requestId);
    if (!row) return "denied";
    if (row.status === "answered") return isYes(row.answer) ? "approved" : "denied";
    if (row.status === "open") return "pending";
    return "denied";
  }
}

/** Scripted port for tests: answers at once, or stays pending until `answer()` is called. */
export class MemoryExtensionApprovals implements ExtensionApprovalPort {
  readonly requests: (CapabilityGrantRequest & { requestId: string })[] = [];
  private readonly answers = new Map<string, GrantOutcome>();
  private counter = 0;

  constructor(private mode: GrantOutcome = "pending") {}

  setMode(mode: GrantOutcome): void {
    this.mode = mode;
  }

  async ask(req: CapabilityGrantRequest): Promise<GrantAnswer> {
    const requestId = `hr-${++this.counter}`;
    this.requests.push({ ...req, requestId });
    this.answers.set(requestId, this.mode);
    return { outcome: this.mode, requestId };
  }

  async status(requestId: string): Promise<GrantOutcome> {
    return this.answers.get(requestId) ?? "denied";
  }

  /** The human answers a pending question. */
  answer(requestId: string, yes: boolean): void {
    this.answers.set(requestId, yes ? "approved" : "denied");
  }

  last(): (CapabilityGrantRequest & { requestId: string }) | undefined {
    return this.requests[this.requests.length - 1];
  }
}
