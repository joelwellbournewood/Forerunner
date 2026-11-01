import type { EventRow, StateStore } from "@forerunner/state";

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
  };
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
 * The earlier turns as alternating user and assistant messages, newest last, within
 * `maxTokens` (counted with the provider's counter on the text sent): the oldest turns are
 * dropped first. A turn without a reply is the person's line alone, merged with the next.
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
      const reply = cap((t.reply?.text ?? "").trim());
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
