/**
 * Plain sentences for the session log (U-074). The live view printed the event type and its raw
 * JSON for every type `describeEvent` had no line for (`peers.feed`, `queue.consumed`,
 * `docs.status_written`, `critic.review`, `memory.*`, `notification` and others), and spoke of
 * tiers, verdicts and USD. Every type a session writes has a sentence here or in
 * `describeEvent` (`views.ts`); an unknown one gets its type in words and its warning, never
 * JSON. Money is CHF at the day's rate.
 */
import { formatChf, usdToChfMicro } from "@forerunner/billing";
import { AUTONOMY_NAMES } from "../enforcement/autonomy.ts";

type Payload = Record<string, unknown>;

const str = (p: Payload, k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
const num = (p: Payload, k: string): number =>
  typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : 0;
const list = (p: Payload, k: string): unknown[] => (Array.isArray(p[k]) ? (p[k] as unknown[]) : []);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A USD micro amount as the person reads it: "CHF 1.20". */
export function chfOf(usdMicro: number, chfPerUsd: number): string {
  const usd = Math.max(0, Math.round(Number.isFinite(usdMicro) ? usdMicro : 0));
  return formatChf(usdToChfMicro(usd, chfPerUsd));
}

/** What a review tier means (the critic's depth for a task): plain words, the tier in brackets. */
export function reviewLevel(tier: number): string {
  switch (tier) {
    case 0:
      return "automatic checks only";
    case 1:
      return "a light review";
    case 2:
      return "a full review";
    case 3:
      return "a full review and your sign-off";
    default:
      return `review level ${tier}`;
  }
}

/** The critic's verdict as a person reads it. */
export function verdictWords(verdict: string): string {
  switch (verdict) {
    case "accept":
      return "accepted";
    case "revise":
      return "sent back for changes";
    case "escalate":
      return "sent back for another try";
    case "human":
      return "needs you";
    default:
      return verdict || "no answer";
  }
}

/** What the verdict did to the task. */
export function decisionWords(decision: string): string {
  switch (decision) {
    case "accepted":
      return "the task is done";
    case "revise":
    case "retry":
      return "the task goes back for another attempt";
    case "human":
      return "the task waits for you";
    case "blocked_by_findings":
      return "open findings keep the task in review";
    default:
      return decision ? `the task is ${decision.replace(/_/g, " ")}` : "nothing changed";
  }
}

/** The next step of the retry ladder, in words (U-074: "improve_brief", "ladder"). */
export function retryWords(retry: string): string {
  switch (retry) {
    case "improve_brief":
      return "again with a clearer brief";
    case "split_or_change_specialist":
      return "split, or with another specialist";
    case "escalate":
      return "on a stronger model";
    case "human":
      return "you decide";
    default:
      return retry.replace(/_/g, " ");
  }
}

/** "Standard (level 2)". */
export function autonomyWords(level: number): string {
  const name = AUTONOMY_NAMES[level as keyof typeof AUTONOMY_NAMES];
  return name ? `${name} (level ${level})` : `level ${level}`;
}

const SKIP_REASONS: Record<string, string> = {
  peer_in_flight: "another agent is working on the same task or files",
  held_by: "another agent holds it",
  not_ready: "it is not ready",
  not_found: "it no longer exists",
};

/** Why a planned task was skipped, in words. */
export function skipReason(reason: string): string {
  return SKIP_REASONS[reason] ?? (reason ? reason.replace(/_/g, " ") : "no reason given");
}

function overlapWords(p: Payload): string {
  const who = str(p, "peerName") || "another agent";
  switch (str(p, "kind")) {
    case "task_claimed":
      return `${who} holds the claim on a task this session planned`;
    case "task_pr_open":
      return `${who} has a pull request open for a task this session planned`;
    case "task_in_flight":
      return `${who} lists a task this session planned as in flight`;
    case "files":
      return `${who} has files in flight that a planned task touches (${list(p, "files").join(", ")})`;
    default:
      return `${who} works near a planned task`;
  }
}

function deliveryWords(p: Payload): string {
  const parts = list(p, "deliveries")
    .filter((d): d is Payload => !!d && typeof d === "object")
    .map(
      (d) =>
        `${str(d, "channel")} ${str(d, "status")}${str(d, "reason") ? ` (${str(d, "reason")})` : ""}`,
    )
    .filter((t) => t.trim().length > 0);
  return parts.length ? `: ${parts.join(", ")}` : "";
}

/** "peers.feed" -> "Peers feed": an unknown type in words. */
function typeWords(type: string): string {
  const words = type.replace(/[._]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : "Event";
}

/**
 * The sentence for the event types `describeEvent` leaves to this file; null for a type it
 * does not know, which `fallbackLine` words.
 */
export function moreEventLines(type: string, p: Payload, chfPerUsd: number): string | null {
  const s = (k: string) => str(p, k);
  const n = (k: string) => num(p, k);
  switch (type) {
    case "peers.feed": {
      const peers = list(p, "peers").filter((x): x is Payload => !!x && typeof x === "object");
      if (peers.length === 0) return "No other agent works on this project right now.";
      const online = peers.filter((x) => x.online === true).length;
      return `Other agents on this project: ${peers.map((x) => str(x, "name") || "an agent").join(", ")} (${online} online).`;
    }
    case "queue.consumed": {
      const count = n("count") || list(p, "ids").length;
      const head =
        count > 0
          ? `Took ${plural(count, "item")} from the next-session queue into this session.`
          : "Nothing waited in the next-session queue.";
      return s("warning") ? `${head} ${s("warning")}.` : head;
    }
    case "docs.status_written": {
      const where = s("path") || "docs/status.md";
      const on = s("prUrl") ? ` on ${s("prUrl")}` : s("branch") ? ` on branch ${s("branch")}` : "";
      return `${p.created === true ? "Created" : "Updated"} the project status in ${where}${on}.`;
    }
    case "docs.status_skipped":
      return `No status update written: ${s("reason") || "nothing changed"}.`;
    case "docs.status_failed":
      return `The status update was not written: ${s("warning")}`;
    case "notification":
      return `Notified you: "${s("title")}"${deliveryWords(p)}.`;
    case "critic.review":
      return `Critic review of the ${s("subject") || "work"} (${reviewLevel(n("tier"))}): ${verdictWords(s("verdict"))}, grade ${n("grade")}, ${plural(n("findings"), "finding")}, ${chfOf(n("costUsdMicro"), chfPerUsd)}.`;
    case "critic.session_review_failed":
      return `The session review did not run: ${s("warning")}`;
    case "memory.lessons_rejected":
      return `Memory: ${s("warning") || `${plural(n("count"), "proposed lesson")} not stored`}.`;
    case "memory.promotion":
      return `Shared memory: a lesson proposed for every project was reviewed: ${verdictWords(s("verdict"))} (grade ${n("grade")}; it is ${s("status") || "pending"}${n("offers") ? `, offered to ${plural(n("offers"), "project")}` : ""}).${s("warning") ? ` ${s("warning")}.` : ""}`;
    case "memory.promotion_failed":
      return `Shared memory: ${s("warning")}`;
    case "inbox.acted":
      return `Took in a ${s("type") || "message"} from the inbox${p.replied ? " and it has its reply" : ""}.`;
    case "inbox.unacknowledged":
      return `${plural(n("count"), "message")} this agent sent ${n("count") === 1 ? "is" : "are"} not acknowledged yet.`;
    case "inbox.heard":
      return `Took in what you said (${s("source") || "chat"}).`;
    case "inbox.recheck_failed":
    case "inbox.carry_failed":
      return `Inbox: ${s("warning")}`;
    case "inbox.carried_forward":
      return `Passed ${plural(list(p, "ids").length, "message")} read at the last session's end on to the next one.`;
    case "session.end_inbox": {
      const read = list(p, "read").length;
      return `Read ${plural(read, "message")} before writing the session's end${p.stopped === true ? "; a stop or pause in them ended the session" : ""}.`;
    }
    case "peer.overlap":
      return `Overlap: ${overlapWords(p)}.`;
    case "task.heard":
      return `Gave this task ${plural(list(p, "ids").length, "line")} you said.`;
    case "task.files": {
      const files = list(p, "files").map(String);
      return `Changed ${plural(files.length, "file")}${files.length ? `: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}` : ""}.`;
    }
    case "pr.merged":
      return `Merged the reviewed pull request ${s("prUrl")}.`;
    case "pr.left_open":
      return `Left the pull request ${s("prUrl")} open for you: ${s("reason") || "it was not merged"}.`;
    case "pr.merge_failed":
      return `${s("warning") || "The merge step failed; the pull request stays open."}`;
    case "context.headroom_unavailable":
      return `Context compression: ${s("warning")}`;
    case "chat.forwarded":
      return "Passed your message to the running session.";
    case "voice.turn": {
      const said = s("said") || s("heard");
      return said ? `Voice: you said "${said}".` : "Voice: a turn ended with nothing heard.";
    }
    case "voice.heard":
      return `Voice: you heard the reply after ${Math.round(n("heardFirstAudioMs"))} ms.`;
    case "voice.approval":
      return "Voice: a change was read back for your yes.";
    case "voice.speak":
      return `Read aloud: ${s("subject") || "a text"} (${s("state") || "done"}).`;
    case "email_blocked":
      return `An email was not sent: ${s("reason")}.`;
    case "email_queued":
      return `An email waits to be sent: "${s("subject")}".`;
    case "email_approval_requested":
      return "An email waits for your approval in the Inbox.";
    case "email_sent":
      return `Sent an email${s("subject") ? `: "${s("subject")}"` : ""}.`;
    case "email_command":
      return `Email command "${s("subject")}": ${s("outcome") || "received"}.`;
    case "mirror.sync":
      return s("error")
        ? `GitHub Projects mirror failed: ${s("error")}`
        : `Updated the GitHub Projects board${s("github_project_url") ? ` ${s("github_project_url")}` : ""}.`;
    case "budget.warning":
      return `Budget: ${s("warning") || s("message") || "the session is near its cap"}.`;
    default:
      return null;
  }
}

/**
 * An event type no sentence knows: its type in words and what it says (a warning, a message,
 * a reason or a summary), never its JSON.
 */
export function fallbackLine(type: string, p: Payload): string {
  const said = ["warning", "message", "reason", "summary", "text"]
    .map((k) => str(p, k))
    .find((v) => v.length > 0);
  return `${typeWords(type)}${said ? `: ${said.slice(0, 200)}` : "."}`;
}
