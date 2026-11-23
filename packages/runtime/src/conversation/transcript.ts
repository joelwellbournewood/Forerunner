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
  /** C5-left-3: a hold reply's one-off press ("Use API key") with its consequence line. */
  oneOff?: { label: string; explain: string } | null;
  /**
   * fixup-l4-cred-screens (L4-creds-19): the app's own hold reply ("Your Claude subscription is
   * at its limit until 15:40, so I have not answered. ..."): the credential policy held the
   * question and no model wrote it. Set only when true.
   */
  hold?: boolean;
}

export interface TranscriptTurn {
  transcriptId: string;
  /** When the person said it (ISO-8601 UTC). */
  at: string;
  human: { text: string; source: string };
  /** Null while the reply is still coming, or when the turn failed before one was written. */
  reply: TranscriptReply | null;
  /**
   * The turn's number from the conversation's start (l4-chat-depth, L4-chat-205), kept on its
   * `chat.human` row as `turn`; absent on rows written before it.
   */
  index?: number;
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
    oneOff:
      typeof obj(p.oneOff).label === "string" && typeof obj(p.oneOff).explain === "string"
        ? { label: str(obj(p.oneOff).label), explain: str(obj(p.oneOff).explain) }
        : null,
    ...(p.hold === true ? { hold: true } : {}),
  };
}

/**
 * fixup-l4-cred-screens (L4-creds-19): whether a reply is the app's own hold reply, which no
 * model wrote: marked `hold`, or, on a row written before the mark, a notice with the one-off
 * press (only a hold reply carries it).
 */
export function isHoldReply(reply: TranscriptReply): boolean {
  return reply.hold === true || (reply.notice && !!reply.oneOff);
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
  // l4-cred-screens (L4-creds-19): a held turn the one-off press answered in its place (the
  // answering line's `replaces`): it is no turn of its own any more, here and after a restart.
  const replaced = new Set<string>();
  let scanned = 0;
  let hi = latest;
  const mine = (): string[] =>
    [...humans.keys()].filter(
      (t) => t !== opts.exclude && !replaced.has(t) && keyOf(t) === projectId,
    );
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
      if (e.type === "chat.human" && !humans.has(t)) {
        humans.set(t, e);
        const r = obj(e.payload).replaces;
        if (typeof r === "string" && r) replaced.add(r);
      } else if (e.type === "chat.reply" && !replies.has(t)) replies.set(t, e);
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
        ...(typeof hp.turn === "number" && Number.isInteger(hp.turn) && hp.turn >= 0
          ? { index: hp.turn }
          : {}),
      };
    })
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit)
    .map(({ seq: _seq, ...turn }) => turn);
}

/** Turns of the history a model turn carries at least, when there are that many. */
export const HISTORY_TURNS = 12;
/**
 * The history's window moves in steps of this many turns (l4-chat-depth, L4-chat-205): it holds
 * 12 to 17 turns and starts at the same turn for six turns in a row, so the prompt cache reads it.
 */
export const HISTORY_STEP_TURNS = 6;
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
 * How an earlier reply's read-back starts in the history (l4-chat-answers, L4-selftasks-118):
 * the runtime's question with Yes and No, said as the app's line. Before, the read-back was bare
 * assistant prose ("Make "X" high priority? …"), and live check 4's fast model copied it with no
 * tool call: a question with no buttons, whose typed yes met "Yes to what?".
 */
export const HISTORY_ASK_LEAD = "The app asked, with Yes and No: ";

/**
 * A line the model wrote that only the app writes (l4-chat-answers, L4-chat-112, a security rule):
 * "The app did: …" or "The app asked, with Yes and No: …", from the lead to the end of its line.
 * Live check 4's model began a reply "The app did: research … now reads only …" (copied from the
 * rules), and a forged one ("The app did: Updated the outcome of …" with no command) stayed in the
 * conversation and in every later turn's history as a change that never happened.
 */
const APP_MARKER_RE = /(?:^|(?<=[\s.!?]))The app (?:did|asked, with Yes and No):[^\n]*/g;
/**
 * l4-chat-carried (L4c-left-6, a security rule): the same line in any case ("the app did: …",
 * "THE APP DID: …"), where it stands as a line of its own: at a line's start (behind a short
 * bracketed lead too) or after a sentence. "what the app did: …" inside the model's own sentence
 * is its prose and stays.
 */
const APP_MARKER_ANY_CASE_RE =
  /(?:^|(?<=^[ \t]*\[[^\]\n]{1,40}\][ \t]*)|(?<=[.!?][ \t]+))the app (?:did|asked, with yes and no):[^\n]*/gim;

/**
 * A reply's own words without any line only the app writes (`APP_MARKER_RE`), its blank lines
 * kept: what the person is shown and what is stored. The app's own lines are added from the
 * stored row (`actionLines`), never from the model's text.
 */
export function withoutAppMarkers(text: string): string {
  if (!/the app /i.test(text)) return text;
  return text
    .replace(APP_MARKER_RE, "")
    .replace(APP_MARKER_ANY_CASE_RE, "")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A reply in the history: its text, then what it changed (`actionLines`). A reply that is only
 * the changes' own sentences (a command's reply, no model: "Paused "X". Undo.") is said once, as
 * the app's lines. l4-chat-answers: a read-back is the app's line too (`HISTORY_ASK_LEAD`), and
 * a marker line the model wrote is left out (`withoutAppMarkers`), so the app's lines are the
 * only marker lines a later turn reads.
 */
function replyInHistory(reply: TranscriptReply): string {
  let raw = withoutAppMarkers(reply.text.trim());
  // The read-back the reply ends with is the app's question, not the model's words.
  const asked =
    reply.readback && raw.endsWith(reply.readback.trim())
      ? `${HISTORY_ASK_LEAD}${reply.readback.trim()}`
      : "";
  if (asked) raw = raw.slice(0, raw.length - (reply.readback ?? "").trim().length).trim();
  if (asked && !raw) return cap(asked);
  if (asked)
    return [cap(replyInHistory({ ...reply, text: raw, readback: null })), cap(asked)]
      .filter(Boolean)
      .join("\n\n");
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
 * Each turn's number from the conversation's start: its own (`index`, kept on its row), else one
 * more than the turn before it; turns older than the first numbered one count back from it, and
 * a conversation with no numbered turn (rows written before the numbers) counts from its start.
 */
function turnNumbers(turns: readonly TranscriptTurn[]): number[] {
  const firstNumbered = turns.findIndex((t) => typeof t.index === "number");
  if (firstNumbered < 0) return turns.map((_, i) => i);
  let prev = (turns[firstNumbered]?.index ?? firstNumbered) - firstNumbered - 1;
  return turns.map((t) => {
    prev = typeof t.index === "number" ? t.index : prev + 1;
    return prev;
  });
}

/**
 * The number the next turn of a conversation gets (l4-chat-depth, L4-chat-205), kept on its
 * `chat.human` row: one more than the newest earlier turn's.
 */
export function nextTurnNumber(earlier: readonly TranscriptTurn[]): number {
  const numbers = turnNumbers(earlier);
  return earlier.length ? (numbers.at(-1) ?? earlier.length - 1) + 1 : 0;
}

/**
 * The earlier turns as alternating user and assistant messages, newest last, within
 * `maxTokens` (counted with the provider's counter on the text sent). A turn without a reply is
 * the person's line alone, merged with the next. A reply that changed something ends with what
 * the app did (`actionLines`).
 *
 * l4-chat-depth (L4-chat-205): the window is a pure function of the stored rows that moves in
 * steps of `HISTORY_STEP_TURNS`: it starts at the turn numbered floor((n - 12) / 6) * 6 (12 to 17
 * turns), and when they pass `maxTokens` whole steps are dropped from that same start, so the
 * first message stays the same turn after turn (and after a restart) and the prompt cache reads
 * the history. Before, the window slid by one turn and the token cap dropped one turn per call:
 * past 12 turns every line wrote its whole history to the cache again (live check 4, LC-C15).
 * Only when even the newest step passes the budget are its turns dropped one by one, as before.
 */
export function historyMessages(
  turns: readonly TranscriptTurn[],
  countTokens: (text: string) => number,
  maxTokens: number = DEFAULT_CHAT_HISTORY_TOKENS,
): { role: "user" | "assistant"; content: string }[] {
  const numbers = turnNumbers(turns);
  const n = turns.length ? (numbers.at(-1) ?? turns.length - 1) + 1 : 0;
  const first = Math.max(
    0,
    Math.floor((n - HISTORY_TURNS) / HISTORY_STEP_TURNS) * HISTORY_STEP_TURNS,
  );
  const from = (start: number) => turns.filter((_, i) => (numbers[i] ?? i) >= start);
  const build = (recent: readonly TranscriptTurn[]) => {
    const out: { role: "user" | "assistant"; content: string }[] = [];
    for (const t of recent) {
      const said = cap(t.human.text.trim());
      if (!said) continue;
      const last = out.at(-1);
      if (last?.role === "user") last.content = `${last.content}\n\n${said}`;
      else out.push({ role: "user", content: said });
      // fixup-l4-cred-screens (L4-creds-19): the app's own hold reply is no assistant turn (the
      // model never wrote it): the held question is the person's line alone, as a turn without
      // a reply. Before, a second held question's press showed the model "... so I have not
      // answered. I can still add and change tasks." as its own words.
      const reply = t.reply && !isHoldReply(t.reply) ? replyInHistory(t.reply) : "";
      if (reply) out.push({ role: "assistant", content: reply });
    }
    // The turn's own line follows as a user message: the history ends with the assistant.
    while (out.at(-1)?.role === "user") out.pop();
    return out;
  };
  const fits = (out: { content: string }[]) =>
    countTokens(out.map((m) => m.content).join("\n")) <= maxTokens;
  // Whole steps from the window's start.
  let start = first;
  for (; start < n; start += HISTORY_STEP_TURNS) {
    const out = build(from(start));
    if (fits(out)) return out;
  }
  // The newest step alone passes the budget: its turns one by one, oldest first.
  const last = from(start - HISTORY_STEP_TURNS);
  for (let k = 1; k < last.length; k++) {
    const out = build(last.slice(k));
    if (fits(out)) return out;
  }
  return [];
}
