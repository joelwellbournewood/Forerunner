/**
 * Plain sentences for the session log (U-074). The live view printed the event type and its raw
 * JSON for every type `describeEvent` had no line for (`peers.feed`, `queue.consumed`,
 * `docs.status_written`, `critic.review`, `memory.*`, `notification` and others), and spoke of
 * tiers, verdicts and USD. Every type a session writes has a sentence here or in
 * `describeEvent` (`views.ts`); an unknown one gets its type in words and its warning, never
 * JSON. Money is CHF at the day's rate.
 */
import { formatChf, usdToChfMicro } from "@forerunner/billing";
import { quotedWords, saidByName } from "@forerunner/critic";
import { AUTONOMY_NAMES } from "../enforcement/autonomy.ts";
import { sessionStatusText } from "../session/stop-words.ts";

type Payload = Record<string, unknown>;

const str = (p: Payload, k: string): string => (typeof p[k] === "string" ? (p[k] as string) : "");
const num = (p: Payload, k: string): number =>
  typeof p[k] === "number" && Number.isFinite(p[k]) ? (p[k] as number) : 0;
const list = (p: Payload, k: string): unknown[] => (Array.isArray(p[k]) ? (p[k] as unknown[]) : []);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------
// Person-level lines (core-experience design §3.7, §5)

export { type EventAudience, eventAudience } from "./event-audience.ts";

/** One line of text: no markdown, no stand-in tag, whitespace folded. */
export function plainLine(text: string): string {
  return text
    .replace(/\[stand-in model\]\s*/gi, "")
    .replace(/\*\*|__|`|^#+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A text cut at a word with "…" when longer than `max` (never mid-word). */
export function cutAtWord(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** '"Create the page skeleton in index.html"' with a long title cut at a word. */
function quoted(title: string, max = 60): string {
  return `"${cutAtWord(title.replace(/"/g, "'"), max)}"`;
}

/** The task an event names, in quotes, or "the task" for an event from before titles. */
function taskName(p: Payload): string {
  const t = str(p, "title");
  return t ? quoted(t) : "the task";
}

/** "the coder", "the writer" ("writer-marketing"), or "the specialist". */
function specialistWho(p: Payload): string {
  const who = saidByName(str(p, "specialist"));
  return who ? `the ${who}` : "the specialist";
}

const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "index.html", "a.js and b.js", "a.js, b.js, c.js and 4 more" (design §5 rule 5). */
export function namedList(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * A report says the work was not done: "I could not complete this task", "I was unable to",
 * "I cannot". The run itself ended without an error, so its outcome reads "done"; the line must
 * not (design §5, "Log line" before and after). Only the report's first sentence is read: "I
 * wrote index.html. I could not open it in a browser." did the work.
 */
const COULD_NOT =
  /\b(could not|couldn't|cannot|can't|was unable to|am unable to|unable to|did not (?:do|complete|finish))\b/i;

/** The report's own words for the line: one or two sentences, plain, at most `max`. */
function reportWords(summary: string, max = 120): string | null {
  const w = quotedWords(summary, max);
  if (!w) return null;
  // The heading words a report starts with ("Summary", "Files changed") are not what it said.
  return w.replace(/^(summary|report)\s*[:-]?\s*/i, "").trim() || null;
}

/**
 * When a run's report says it could not do the work: the sentence that says what stood in the
 * way, as the log quotes it ("The work needs X", "" when the report gives no reason); null when
 * the report does not say so. The runner writes it on the run's `task.finished` and on the
 * critic's verdict about that run (`couldNot`), so the critic's line can say it (design §5,
 * "Log line": 'The designer could not style the page: "…". Trying again.').
 */
export function couldNotWords(summary: string): string | null {
  const words = reportWords(summary, 200);
  if (!words) return null;
  const sentences = words.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [words];
  const first = sentences[0]?.trim() ?? "";
  if (!COULD_NOT.test(first)) return null;
  // "I could not complete this task. The work needs X." -> "The work needs X."
  const reason = sentences.length > 1 ? sentences[1]?.trim() : first;
  return reason
    ? cutAtWord(reason, 100)
        .replace(/"/g, "'")
        .replace(/[.\s]+$/, "")
    : "";
}

/** '<Who> could not do "<task>": "<what stood in the way>".' */
function couldNotLine(p: Payload, said: string): string {
  return `${capital(specialistWho(p))} could not do ${taskName(p)}${said ? `: "${said}"` : ""}.`;
}

/** The session's counts that happened, short: "2 done, 1 needs you" (no zero counts). */
function endedCounts(p: Payload): string {
  const parts: string[] = [];
  const add = (k: string, words: (n: number) => string) => {
    const n = num(p, k);
    if (n > 0) parts.push(words(n));
  };
  add("completed", (n) => `${n} done`);
  add("failed", (n) => `${n} failed`);
  add("needsHuman", (n) => `${n} need${n === 1 ? "s" : ""} you`);
  add("retried", (n) => `${n} sent back`);
  add("inReview", (n) => `${n} in review`);
  add("skipped", (n) => `${n} not started`);
  return parts.join(", ");
}

/** What a move the person made while a task ran did, in words. */
function movedWords(status: string): string {
  switch (status) {
    case "cancelled":
      return "cancelled it";
    case "needs_human":
      return "paused it";
    case "failed":
      return "marked it failed";
    case "done":
      return "marked it done";
    case "in_review":
      return "sent it to review";
    case "ready":
      return "put it back to ready";
    default:
      return "moved it";
  }
}

/**
 * The person-level line of an event (design §3.7, §5): one line, names not ids, no markdown,
 * cut at a word, "could not" for a run that reported it could not do the work. Null for a type
 * that has no person line of its own (its detail line is used).
 */
export function personLine(type: string, p: Payload, chfPerUsd: number): string | null {
  const s = (k: string) => str(p, k);
  const n = (k: string) => num(p, k);
  const chf = (k: string) => chfOf(n(k), chfPerUsd);
  switch (type) {
    case "session.started":
      return s("trigger") === "manual"
        ? `You started the session with a budget of ${chf("budgetCapUsdMicro")}.`
        : `The session started with a budget of ${chf("budgetCapUsdMicro")}.`;
    case "task.started":
      // A retry by another specialist (the ladder's "split, or with another specialist").
      if (p.again === true && s("handedFrom"))
        return `${capital(specialistWho(p))} takes over ${taskName(p)} from ${specialistWho({
          specialist: s("handedFrom"),
        })}.`;
      return `${capital(specialistWho(p))} started ${taskName(p)}${
        n("estimateUsdMicro") > 0 ? ` (about ${chf("estimateUsdMicro")})` : ""
      }.`;
    case "task.files": {
      const files = list(p, "files").map(String);
      return files.length ? `Changed ${namedList(files)}.` : "Changed no file.";
    }
    case "task.finished": {
      const outcome = s("outcome");
      const summary = s("summary");
      const who = specialistWho(p);
      const cost = n("costUsdMicro") >= 5_000 ? ` (${chf("costUsdMicro")})` : "";
      if (outcome === "failed") {
        const why = reportWords(summary, 100);
        return `${taskName(p)} failed${why ? `: ${why.replace(/[.\s]+$/, "")}` : ""}.`;
      }
      if (outcome === "timeout") return `${taskName(p)} ran out of time.`;
      if (outcome === "budget_exceeded") return `${taskName(p)} stopped: the budget is used.`;
      if (outcome === "killed") return `${capital(taskName(p))} was stopped.`;
      if (outcome === "needs_human")
        return `${capital(who)} has questions for you about ${taskName(p)} (Inbox).`;
      const said = couldNotWords(summary);
      if (said !== null) return couldNotLine(p, said);
      return `${capital(who)} finished ${taskName(p)}${cost}.`;
    }
    case "critic.verdict": {
      const decision = s("decision");
      const sentBack = decision === "revise" || decision === "retry" || s("verdict") === "revise";
      // The run said it could not do the work: what it said and what the critic did with it
      // are one line (design §5, "Log line"); the critic's "the worker reports it could not
      // do the work" would only say it again.
      if (typeof p.couldNot === "string") {
        const head = couldNotLine(p, p.couldNot);
        if (decision === "accepted") return `${head} The critic accepted it anyway.`;
        if (decision === "human") return `${head} It needs your decision (Inbox).`;
        if (decision === "blocked_by_findings")
          return `${head} It stays in review: an earlier finding is still open.`;
        if (sentBack) return `${head} Trying again.`;
        return `${head} The critic reviewed it.`;
      }
      const why = reportWords(s("summary"), 100)
        ?.replace(/^(sent back for rework|accepted)\s*:\s*/i, "")
        .replace(/[.\s]+$/, "");
      if (decision === "accepted") return `The critic accepted ${taskName(p)}.`;
      if (decision === "human") return `${capital(taskName(p))} needs your decision (Inbox).`;
      if (decision === "blocked_by_findings")
        return `${capital(taskName(p))} stays in review: an earlier finding is still open.`;
      if (sentBack)
        return `The critic sent ${taskName(p)} back${why ? `: ${why}` : ""}. Trying again.`;
      return `The critic reviewed ${taskName(p)}.`;
    }
    case "critic.review_failed":
      if (typeof p.couldNot === "string")
        return `${couldNotLine(p, p.couldNot)} Its review did not run; it waits in the Inbox.`;
      return `The review of ${taskName(p)} did not run; it waits in the Inbox.`;
    case "task.retrying":
    case "session.stopped":
      return s("text") ? cutAtWord(plainLine(s("text")), 200) : null;
    case "session.sandbox_waiting":
    case "task.sandbox_waiting": {
      const titles = list(p, "tasks")
        .map((t) => (t && typeof t === "object" ? str(t as Payload, "title") : ""))
        .filter(Boolean);
      if (s("title")) titles.push(s("title"));
      return titles.length
        ? `Waiting for Docker: ${namedList(titles.map((t) => quoted(t, 50)))} ${titles.length === 1 ? "needs" : "need"} a full review.`
        : "Waiting for Docker: a full review needs it.";
    }
    case "task.moved_while_running":
      return p.byPerson === false
        ? `Another agent moved ${taskName(p)} while it ran; the session goes on.`
        : `You ${movedWords(s("status"))} while ${taskName(p)} ran; the session goes on.`;
    case "task.blocked_by_findings":
      return `${capital(taskName(p))} stays in review: an earlier finding is still open.`;
    case "session.error": {
      const msg = plainLine(s("message"));
      return `The session stopped on an error${msg ? `: ${cutAtWord(msg, 100).replace(/[.\s]+$/, "")}` : ""}.`;
    }
    case "session.ended": {
      const counts = endedCounts(p);
      const status = sessionStatusText(s("status"), s("stopReason"));
      const head = status === "Done" ? "Session over" : status;
      return `${head}: ${counts || "nothing done"}. ${chf("spentUsdMicro")}.`;
    }
    case "session.plan_filed":
      return `The plan waits for your approval in the Inbox${p.changed ? "; it changed since you approved it, so nothing ran" : ""}.`;
    case "session.plan_approved":
      return `Running the plan you approved (${plural(n("items"), "task")}).`;
    case "session.paused":
      return `Paused${s("reason") ? `: ${plainLine(s("reason"))}` : ""}.`;
    default:
      return null;
  }
}

/** A USD micro amount as the person reads it: "CHF 1.20". */
export function chfOf(usdMicro: number, chfPerUsd: number): string {
  const usd = Math.max(0, Math.round(Number.isFinite(usdMicro) ? usdMicro : 0));
  return formatChf(usdToChfMicro(usd, chfPerUsd));
}

/**
 * What a review tier means (the critic's depth for a task), in plain words. Tier 0 is reviewed
 * as the light review (ADR 0104: no task closes on automatic checks alone).
 */
export function reviewLevel(tier: number): string {
  switch (tier) {
    case 0:
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
    // U-078 (ADR 0100): a credential met its usage limit; the sentence says what took over.
    case "billing.fallback":
      return s("sentence") || "A Claude credential reached its usage limit; the next one is used.";
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
    // Which channels were not set up is not the session's news (design §5, "Notification"):
    // the line names what was sent, never "telegram skipped (no Telegram chat id)".
    case "notification":
      return `Notified you: "${s("title")}".`;
    // The engine's step and replan lines carry their own words (`text`).
    case "task.step":
    case "session.replanned":
      return s("text") ? cutAtWord(plainLine(s("text")), 200) : null;
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
  return `${typeWords(type)}${said ? `: ${cutAtWord(plainLine(said), 200)}` : "."}`;
}
