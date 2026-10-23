/**
 * The one place a Cloudflare deploy asks a human. Production: `human_request` rows through
 * `HumanRequestRepo`; tests: `FakeCloudflareApprovals`. The orchestrator wires it.
 *
 * A "yes" to a money action (plan change, paid resource) is spent by that action: the row is
 * marked consumed and never approves a second deploy. It is marked consumed when `ask()`
 * hands it out, before the write is sent, so a write that then fails (network, 5xx after the
 * retries) has spent the answer and the human answers afresh: conservative on purpose, since
 * spending real money always needs a human. A "yes" to a production deploy is
 * answered per request key (operation plus input), so a changed script asks again. When the
 * runtime hooks already asked for the same tool call with the same action class (the row the
 * `StateApprovals` port files), that answer is reused so the human is not asked twice.
 */
import { type Clock, ForerunnerError } from "@forerunner/platform";
import {
  type ApprovalOutcome,
  type ApprovalPort,
  type ApprovalRequest,
  approvalKey,
  isYes,
} from "@forerunner/runtime";
import type { HumanRequestRepo } from "@forerunner/state";

export type DeployEnv = "staging" | "production";

export interface CloudflareApprovalRequest extends ApprovalRequest {
  /** `deploy_worker`, `deploy_pages`, `dns_upsert`, `change_plan`. */
  operation: string;
  /** Scope the action touches, e.g. `account:abc zone:def`. */
  scope: string;
  env?: DeployEnv;
  /** True for the always-human money class: the answer is spent by one action. */
  oneShot: boolean;
}

export type CloudflareApprovalAnswer = ApprovalOutcome;

export interface CloudflareApprovalPort {
  ask(request: CloudflareApprovalRequest): Promise<CloudflareApprovalAnswer>;
}

interface CloudflareChangeCard {
  key?: string;
  actionClass?: string;
  consumedAt?: string;
}

/** The hooks store the input as shown on the card: strings cut at 2000 characters. */
function displayForm(v: unknown): unknown {
  if (typeof v === "string") return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  if (Array.isArray(v)) return v.map(displayForm);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = displayForm(val);
    return out;
  }
  return v;
}

/**
 * The key of the tool call: the caller's `req.key` when it has one (the hooks' key, computed
 * on the input before secret references were resolved, handed to the tool as
 * `ToolExecutionContext.approvalKey`), else the hash of `req.input`. The tool sees the resolved
 * input, so without the hooks' key a deploy whose input carries a `secret:` reference would
 * never match the hooks' row and the human would be asked twice.
 */
function callKey(req: CloudflareApprovalRequest): string {
  return approvalKey({ tool: req.tool, input: req.input, key: req.key });
}

/** The key under which this module files its own requests. */
export function cloudflareApprovalKey(req: CloudflareApprovalRequest): string {
  const kind = req.oneShot ? "money" : "autonomy";
  return `cloudflare:${req.operation}:${kind}:${req.scope}:${callKey(req)}`;
}

/**
 * Approvals as `human_request` rows (kind "approval"). The first ask files the request and
 * returns "pending"; the deploy stops with an "awaiting approval" outcome and the model
 * retries after the human answered. An answered "yes" is handed out once for one-shot
 * requests (money) and marked spent in `change_card.consumedAt`, durable across restarts.
 */
export class HumanRequestCloudflareApprovals implements CloudflareApprovalPort {
  constructor(
    private readonly requests: HumanRequestRepo,
    private readonly clock: Pick<Clock, "nowIso">,
  ) {}

  async ask(req: CloudflareApprovalRequest): Promise<CloudflareApprovalAnswer> {
    const key = cloudflareApprovalKey(req);
    const existing = await this.requests.list(
      { session_id: req.sessionId, kind: "approval" },
      { orderBy: [{ column: "created_at", direction: "desc" }] },
    );
    const same = existing.find((r) => (r.change_card as CloudflareChangeCard | null)?.key === key);
    if (same) {
      if (same.status === "open") return "pending";
      if (same.status === "answered") {
        if (!isYes(same.answer)) return "denied";
        if (!req.oneShot) return "approved";
        const card = same.change_card as CloudflareChangeCard | null;
        if (!card?.consumedAt) {
          try {
            await this.requests.update(same.id, same.version, {
              change_card: { ...(same.change_card ?? {}), consumedAt: this.clock.nowIso() },
            });
            return "approved";
          } catch (e) {
            if (!(e instanceof ForerunnerError && e.code === "version_conflict")) throw e;
            // another consumer took the "yes": ask afresh below
          }
        }
      }
      // withdrawn, expired or spent: file a new request
    }
    if (!req.oneShot) {
      // The runtime hooks may have asked for this very tool call already (same action class).
      // Their row is keyed on the parsed input before secret resolution (the card's cut copy
      // is display only), which `req.key` carries when the tool was handed it; a long script
      // body and a `secret:` reference match too.
      const hookKey = callKey(req);
      const hookRow = existing.find((r) => {
        const card = r.change_card as CloudflareChangeCard | null;
        return card?.key === hookKey && card.actionClass === req.actionClass;
      });
      if (hookRow?.status === "answered") return isYes(hookRow.answer) ? "approved" : "denied";
      if (hookRow?.status === "open") return "pending";
    }
    await this.requests.insert({
      human_id: req.humanId,
      project_id: req.projectId ?? null,
      task_id: req.taskId ?? null,
      session_id: req.sessionId,
      kind: "approval",
      why: req.why,
      steps: [
        `Operation: ${req.operation}`,
        `Scope: ${req.scope}`,
        ...(req.env ? [`Environment: ${req.env}`] : []),
        `Action class: ${req.actionClass}`,
        ...(req.oneShot ? ["This answer is used for one action only."] : []),
      ],
      options: ["yes", "no"],
      blocking: true,
      risk: req.risk,
      change_card: {
        key,
        tool: req.tool,
        operation: req.operation,
        scope: req.scope,
        env: req.env ?? null,
        actionClass: req.actionClass,
        oneShot: req.oneShot,
        input: JSON.parse(JSON.stringify(displayForm(req.input) ?? null)),
      },
      author_agent: req.agentId,
    });
    return "pending";
  }
}

/** In-memory approvals for tests: a fixed answer or a function of the request. */
export class FakeCloudflareApprovals implements CloudflareApprovalPort {
  readonly requests: CloudflareApprovalRequest[] = [];
  constructor(
    private readonly answer:
      | CloudflareApprovalAnswer
      | ((
          req: CloudflareApprovalRequest,
        ) => CloudflareApprovalAnswer | Promise<CloudflareApprovalAnswer>) = "approved",
  ) {}
  async ask(req: CloudflareApprovalRequest): Promise<CloudflareApprovalAnswer> {
    this.requests.push(req);
    return typeof this.answer === "function" ? this.answer(req) : this.answer;
  }
}

/** Route Cloudflare approvals through the runtime's own approval port. */
export function cloudflareApprovalsFromRuntime(port: ApprovalPort): CloudflareApprovalPort {
  return { ask: (req) => port.request(req) };
}
