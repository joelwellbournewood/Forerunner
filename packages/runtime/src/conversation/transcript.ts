import type { EventRow, StateStore } from "@forerunner/state";
import { scanForInjection } from "../injection/scan.ts";

/**
 * One conversation per project (design §3.9, core-experience.md): the chat lines live as events
 * on the principal agent's conversation session (`chat.human`, `chat.reply`), each marked with
 * the project of the conversation it belongs to (`conversationProjectId`, null for the
 * conversation outside any project). The Chat tab and Talk read the same turns from here (the
 * daemon's `GET /projects/:id/conversation`), and every model turn carries the recent ones, so
 * the chat remembers what was said, across reloads and restarts.
 *
 * Before (the 2026-11-01 walks), every model call held one user message (the facts and the
 * current line): "yes" or "what did I just ask?" reached the model with nothing before it, and
 * the Chat tab kept its lines in the browser while Talk kept its own, so the two disagreed.
 */

/** One action a reply made (a change in the change log). */
export interface TranscriptAction {
  kind: string;
  summary: string;
  /** The change log id. */
  id?: string;
  /** The change log id while the change could be undone when the reply was written. */
  undoToken?: string | null;
}

export interface TranscriptReply {
  text: string;
  actions: TranscriptAction[];
  question: { text: string; options: string[] } | null;
  /** The change card this reply read back and waits a yes for, if any. */
  pendingId: string | null;
  /** That card's read-back, as the reply's text ends with it. */
  readback: string | null;
  /**
   * The card this turn answered here (a yes, a no, or a stop that cancelled it): a later "yes"
   * with nothing waiting is "Yes to what?", not a sentence about the Inbox or an expiry.
   */
  answered: string | null;
  /** A reply about the app (no model, a refusal), not an answer. */
  notice: boolean;
  /** What the turn cost (micro-USD); 0 for a command or a yes. */
  costUsdMicro: number;
  /**
   * The records the reply rests on (d1109-chat-recall: `sources.records` on the chat.reply row,
   * at most three); empty for a reply that opened none.
   */
  sources: { kind: string; title: string; date: string; link: string | null }[];
  /** How deep the answer went (d1109-chat-depth): "quick", or a longer pass's rung. */
  depth?: string;
  /** The line under a longer answer, or the stopped line; null for none. */
  footer?: string | null;
  /** The offer under the answer (an ask line with Go ahead, or a closer look with Think it through). */
  offer?: {
    line: string;
    action: "go_ahead" | "think";
    rung: "longer" | "stronger" | "best";
    question: string;
    estimateUsdMicro: number;
    atMostUsdMicro: number;
    model: string;
  } | null;
  /** Think it through's figures under a quick model answer of a typed turn; null otherwise. */
  closer?: {
    estimateUsdMicro: number;
    atMostUsdMicro: number;
    seconds: number;
    model: string;
  } | null;
  /** A cap line under the answer ("A closer look would pass this month's cap, …"). */
  capLine?: string | null;
  /** The person stopped this answer. */
  stopped?: boolean;
  /** The answer failed while Forerunner ran ("I could not answer this."). */
  failed?: boolean;
}

export interface TranscriptTurn {
  transcriptId: string;
  /** When the person said it (ISO-8601 UTC). */
  at: string;
  human: { text: string; source: string };
  /** Null while the reply is still coming, or when the turn failed before one was written. */
  reply: TranscriptReply | null;
}

/** The most recent turns a conversation shows and a model turn may carry. */
export const TRANSCRIPT_SHOW_LIMIT = 100;
/** Events read at most when looking back for a conversation's turns. */
const SCAN_LIMIT = 5000;
const PAGE = 400;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The conversation an event names: its own mark, else unknown (`undefined`). */
function conversationOf(p: Record<string, unknown>): string | null | undefined {
  if ("conversationProjectId" in p) {
    const v = p.conversationProjectId;
    return typeof v === "string" && v ? v : null;
  }
  return undefined;
}

function actionsOf(p: Record<string, unknown>): TranscriptAction[] {
  const details = p.actionDetails;
  if (Array.isArray(details))
    return details
      .map(obj)
      .filter((a) => typeof a.kind === "string")
      .map((a) => ({
        kind: str(a.kind),
        summary: str(a.summary),
        ...(typeof a.id === "string" ? { id: a.id } : {}),
        undoToken: typeof a.undoToken === "string" ? a.undoToken : null,
      }));
  // Rows written before the details were kept name the commands only.
  const kinds = Array.isArray(p.actions) ? p.actions.filter((k) => typeof k === "string") : [];
  return kinds.map((k) => ({ kind: String(k), summary: "", undoToken: null }));
}

function replyOf(p: Record<string, unknown>): TranscriptReply {
  const q = obj(p.question);
  return {
    text: str(p.text),
    actions: actionsOf(p),
    question:
      typeof q.text === "string"
        ? {
            text: q.text,
            options: Array.isArray(q.options) ? q.options.filter((o) => typeof o === "string") : [],
          }
        : null,
    pendingId: typeof p.pendingId === "string" ? p.pendingId : null,
    readback: typeof p.readback === "string" && p.readback ? p.readback : null,
    answered: typeof p.answeredId === "string" && p.answeredId ? p.answeredId : null,
    notice: p.notice === true,
    costUsdMicro: typeof p.costUsdMicro === "number" ? p.costUsdMicro : 0,
    sources: sourcesOf(obj(p.sources).records),
    depth: str(p.depth) || "quick",
    footer: typeof p.footer === "string" && p.footer ? p.footer : null,
    offer: offerOf(p.offer),
    closer: closerOf(p.closer),
    capLine: typeof p.capLine === "string" && p.capLine ? p.capLine : null,
    stopped: p.stopped === true,
    failed: p.failed === true,
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The offer a chat.reply row keeps (d1109-chat-depth), or null when it is not whole. */
function offerOf(v: unknown): NonNullable<TranscriptReply["offer"]> | null {
  const o = obj(v);
  const rung = o.rung === "longer" || o.rung === "stronger" || o.rung === "best" ? o.rung : null;
  const action = o.action === "go_ahead" || o.action === "think" ? o.action : null;
  if (!rung || !action || typeof o.line !== "string") return null;
  return {
    line: o.line,
    action,
    rung,
    question: str(o.question),
    estimateUsdMicro: num(o.estimateUsdMicro),
    atMostUsdMicro: num(o.atMostUsdMicro),
    model: str(o.model),
  };
}

function closerOf(v: unknown): NonNullable<TranscriptReply["closer"]> | null {
  const o = obj(v);
  if (typeof o.atMostUsdMicro !== "number") return null;
  return {
    estimateUsdMicro: num(o.estimateUsdMicro),
    atMostUsdMicro: num(o.atMostUsdMicro),
    seconds: num(o.seconds),
    model: str(o.model),
  };
}

/** The records a chat.reply row keeps (`sources.records`), each with its four fields. */
function sourcesOf(v: unknown): TranscriptReply["sources"] {
  if (!Array.isArray(v)) return [];
  return v
    .map(obj)
    .filter((s) => typeof s.kind === "string" && typeof s.title === "string")
    .slice(0, 3)
    .map((s) => ({
      kind: str(s.kind),
      title: str(s.title),
      date: str(s.date),
      link: typeof s.link === "string" && s.link ? s.link : null,
    }));
}

/**
 * The turns of one conversation (`projectId`, or null for the one outside any project), oldest
 * first, at most `limit` of the newest. A turn written before conversations were kept per
 * project carries no mark: it belongs where its reply's `projectId` says (the model path wrote
 * it), else to the conversation outside any project.
 */
export async function readTranscript(
  store: Pick<StateStore, "event">,
  sessionId: string,
  projectId: string | null,
  opts: { limit?: number; exclude?: string } = {},
): Promise<TranscriptTurn[]> {
  const limit = opts.limit ?? TRANSCRIPT_SHOW_LIMIT;
  if (limit <= 0) return [];
  const latest = await store.event.latestSeq(sessionId);
  const humans = new Map<string, EventRow>();
  const replies = new Map<string, EventRow>();
  let scanned = 0;
  let hi = latest;
  const mine = (): string[] =>
    [...humans.keys()].filter((t) => t !== opts.exclude && keyOf(t) === projectId);
  const keyOf = (transcriptId: string): string | null => {
    const h = humans.get(transcriptId);
    const r = replies.get(transcriptId);
    const own = h ? conversationOf(obj(h.payload)) : undefined;
    if (own !== undefined) return own;
    const fromReply = r ? conversationOf(obj(r.payload)) : undefined;
    if (fromReply !== undefined) return fromReply;
    const legacy = r ? obj(r.payload).projectId : undefined;
    return typeof legacy === "string" && legacy ? legacy : null;
  };
  while (hi > 0 && scanned < SCAN_LIMIT) {
    const from = Math.max(0, hi - PAGE);
    const rows = await store.event.list(sessionId, from, hi - from);
    if (!rows.length) break;
    for (const e of rows) {
      if (e.seq > hi) continue;
      const t = str(obj(e.payload).transcriptId);
      if (!t) continue;
      if (e.type === "chat.human" && !humans.has(t)) humans.set(t, e);
      else if (e.type === "chat.reply" && !replies.has(t)) replies.set(t, e);
    }
    scanned += rows.length;
    hi = from;
    if (mine().length >= limit) break;
  }
  return mine()
    .map((t) => {
      const h = humans.get(t) as EventRow;
      const r = replies.get(t);
      const hp = obj(h.payload);
      return {
        transcriptId: t,
        at: h.created_at,
        seq: h.seq,
        human: { text: str(hp.text), source: str(hp.source) || "text" },
        reply: r ? replyOf(obj(r.payload)) : null,
      };
    })
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit)
    .map(({ seq: _seq, ...turn }) => turn);
}

/** Turns of the history a model turn carries at most. */
export const HISTORY_TURNS = 12;
/** Tokens of history a model turn carries at most (oldest turns go first). */
export const DEFAULT_CHAT_HISTORY_TOKENS = 3000;
/** The longest one line of the history is (longer ones end with "…"). */
const HISTORY_LINE_CHARS = 2000;

const cap = (s: string) =>
  s.length > HISTORY_LINE_CHARS ? `${s.slice(0, HISTORY_LINE_CHARS - 1)}…` : s;

/**
 * How an earlier reply's changes start in the history (l3-chat-claims): "The app did: <the
 * change's sentence>". The conversation agent's rules tell the model what the line means.
 */
export const HISTORY_ACTION_LEAD = "The app did: ";

/**
 * A change named in words when its result kept no sentence (L3-left-6, d1109-chat-recall): before,
 * the history fell back to the command's name ("The app did: task.create."), which the model then
 * read as a word of the person's. One map; an unknown command is "Made a change".
 */
const CHANGE_WORDS: Record<string, string> = {
  "task.create": "added a task",
  "task.update": "changed a task",
  "task.transition": "changed a task's status",
  "task.reopen": "reopened a task",
  "task.retry": "tried a task again",
  "task.depends": "changed what a task waits for",
  "session.start": "started a session",
  "session.stop": "stopped the work",
  "session.resume": "allowed sessions to start again",
  "settings.set": "changed a setting",
  "budget.set": "changed a budget",
  "note.add": "left a note for the next session",
  "memory.record": "kept a lesson",
  "request.answer": "answered a card",
  "project.switch": "switched the project",
  "project.create": "created a project",
  undo: "undid a change",
};

/** A change's sentence as the history says it: without its "Undo." (the change log's own words). */
function changeSentence(a: TranscriptAction): string {
  const said = a.summary
    .trim()
    .replace(/\s*\bUndo\.?$/, "")
    .trim();
  if (said && said !== "done") return said;
  const words = a.kind.split("+").map((k) => CHANGE_WORDS[k] ?? "made a change");
  const joined = [...new Set(words)].join(" and ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/**
 * What the history says in place of an earlier reply's own words when the injection scan reads
 * instructions in them (L3-left-6, d1109-chat-recall): a reply that quoted a record (a report, a
 * card, a recall hit) would otherwise carry the record's words into every later turn, which then
 * reads back every change while it stays in the history. Left out, the words reach no later
 * model call; the reply's "The app did:" lines stay and are scanned as before (they are the app's
 * own sentences, which can quote a title an agent wrote).
 */
export const QUOTED_RECORD_LEFT_OUT =
  "(This reply quoted a record whose words read like instructions; they are left out here.)";

/**
 * What an earlier reply changed, one line per change, in the change log's own sentence without
 * its "Undo." (l3-chat-claims, live check 3's L3-run-1). Before, the history carried the model's
 * prose alone ("Done. For the Reading rules project, research may now only read …"): a change
 * that read as claimed in words, which the model copied one turn later with no tool ("I've asked
 * for confirmation"). Every reply that changed something gets its lines, so a reply without one
 * changed nothing (what the model is told); a reply that changed nothing gets none. From the
 * stored row only, so the history is the same bytes on every turn and after a restart (the
 * prompt cache keeps its prefix).
 */
export function actionLines(reply: TranscriptReply): string[] {
  const out: string[] = [];
  for (const a of reply.actions) {
    const line = `${HISTORY_ACTION_LEAD}${changeSentence(a)}`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/**
 * A reply in the history: its text, then what it changed (`actionLines`). A reply that is only
 * the changes' own sentences (a command's reply, no model: "Paused "X". Undo.") is said once, as
 * the app's lines.
 */
function replyInHistory(reply: TranscriptReply): string {
  const raw = reply.text.trim();
  const did = actionLines(reply);
  // The reply's own words, unless they quote instructions (the action lines are kept apart).
  let prose = raw;
  for (const a of reply.actions) prose = prose.split(changeSentence(a)).join(" ");
  const text = scanForInjection(prose, "agent_output").suspicious ? QUOTED_RECORD_LEFT_OUT : raw;
  if (!did.length) return cap(text);
  let rest = text;
  for (const a of reply.actions) rest = rest.split(changeSentence(a)).join(" ");
  const own = rest.replace(/\bUndo\.?/g, " ").replace(/[\s.]+/g, "");
  return [own ? cap(text) : "", ...did.map(cap)].filter(Boolean).join("\n\n");
}

/**
 * The earlier turns as alternating user and assistant messages, newest last, within
 * `maxTokens` (counted with the provider's counter on the text sent): the oldest turns are
 * dropped first. A turn without a reply is the person's line alone, merged with the next. A
 * reply that changed something ends with what the app did (`actionLines`).
 */
export function historyMessages(
  turns: readonly TranscriptTurn[],
  countTokens: (text: string) => number,
  maxTokens: number = DEFAULT_CHAT_HISTORY_TOKENS,
): { role: "user" | "assistant"; content: string }[] {
  const recent = turns.slice(-HISTORY_TURNS);
  const build = (from: number) => {
    const out: { role: "user" | "assistant"; content: string }[] = [];
    for (const t of recent.slice(from)) {
      const said = cap(t.human.text.trim());
      if (!said) continue;
      const last = out.at(-1);
      if (last?.role === "user") last.content = `${last.content}\n\n${said}`;
      else out.push({ role: "user", content: said });
      const reply = t.reply ? replyInHistory(t.reply) : "";
      if (reply) out.push({ role: "assistant", content: reply });
    }
    // The turn's own line follows as a user message: the history ends with the assistant.
    while (out.at(-1)?.role === "user") out.pop();
    return out;
  };
  for (let from = 0; from < recent.length; from++) {
    const out = build(from);
    const tokens = countTokens(out.map((m) => m.content).join("\n"));
    if (tokens <= maxTokens) return out;
  }
  return [];
}
