/**
 * The one human decision this module asks for: allowing an application that is not on the
 * human's allowlist, for the current session only. Widening permissions always needs a human
 * (spec Security: "changing permissions ... at any autonomy level"), so the gate never allows
 * an app on its own; without a port it simply refuses. Production backs the port with
 * HumanRequestRepo (a blocking approval request the inbox shows); tests use the fake.
 */
import type { ApprovalOutcome } from "@forerunner/runtime";
import type { HumanRequestRepo, HumanRequestRow } from "@forerunner/state";
import { type DesktopApprovalRequest, summarize } from "./types.ts";

export interface DesktopApprovalPort {
  ask(request: DesktopApprovalRequest): Promise<ApprovalOutcome>;
}

export function desktopApprovalKey(req: Pick<DesktopApprovalRequest, "app">): string {
  return `desktop_allow_app:${req.app.exe}|${req.app.windowClass.toLowerCase()}`;
}

export class FakeDesktopApprovals implements DesktopApprovalPort {
  readonly requests: DesktopApprovalRequest[] = [];
  constructor(
    private readonly answer:
      | ApprovalOutcome
      | ((req: DesktopApprovalRequest) => ApprovalOutcome | Promise<ApprovalOutcome>) = "denied",
  ) {}
  async ask(req: DesktopApprovalRequest): Promise<ApprovalOutcome> {
    this.requests.push(req);
    return typeof this.answer === "function" ? this.answer(req) : this.answer;
  }
}

function isYes(answer: unknown): boolean {
  if (typeof answer === "boolean") return answer;
  if (typeof answer === "string")
    return /^(y|yes|ok|approve|approved|ja|oui|sí|si|confirm|confirmed)$/i.test(answer.trim());
  if (answer && typeof answer === "object")
    return isYes(
      (answer as { choice?: unknown; answer?: unknown }).choice ??
        (answer as { answer?: unknown }).answer,
    );
  return false;
}

/**
 * A request for the same app in the same session that was answered "yes" counts as approved,
 * "no" as denied; otherwise one blocking request is opened and the answer is "pending" (the
 * tool call fails with `approval_required` until the human answers and the run retries).
 */
export class HumanRequestDesktopApprovals implements DesktopApprovalPort {
  constructor(private readonly requests: Pick<HumanRequestRepo, "list" | "insert">) {}

  async ask(req: DesktopApprovalRequest): Promise<ApprovalOutcome> {
    const key = desktopApprovalKey(req);
    const rows: HumanRequestRow[] = await this.requests.list(
      { session_id: req.sessionId, kind: "approval" },
      { orderBy: [{ column: "created_at", direction: "desc" }] },
    );
    const same = rows.find((r) => (r.change_card as { key?: string } | null)?.key === key);
    if (same) {
      if (same.status === "answered") return isYes(same.answer) ? "approved" : "denied";
      if (same.status === "open") return "pending";
    }
    await this.requests.insert({
      human_id: req.humanId,
      project_id: req.projectId ?? null,
      task_id: req.taskId ?? null,
      session_id: req.sessionId,
      kind: "approval",
      why: req.why,
      // The exe, class and title come from the application: bounded, one line, never trusted.
      steps: [
        `Application: ${summarize(req.app.exe, 80)} (${summarize(req.app.windowClass, 80)})`,
        `Window: ${summarize(req.app.title, 120)}`,
        "Answer yes to allow this application for the rest of this session only.",
        "To allow it permanently, add it to the desktop allowlist in Settings.",
      ],
      options: ["yes", "no"],
      blocking: true,
      risk: "high",
      change_card: {
        key,
        tool: req.tool,
        actionClass: req.actionClass,
        reason: req.reason,
        app: req.app,
        input: req.input as never,
      },
      author_agent: req.agentId,
    });
    return "pending";
  }
}
