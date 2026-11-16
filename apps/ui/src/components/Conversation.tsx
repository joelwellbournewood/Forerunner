import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { streamChat } from "../api/chat-stream.ts";
import { type ConversationTurnView, describeError } from "../api/client.ts";
import { systemClock, useNow } from "../lib/clock.ts";
import { inAppText, withoutUndoWord } from "../lib/plain-words.ts";
import { useClient, useIdentity, useUiState, useUiStore } from "../store/context.tsx";
import {
  type ConversationState,
  conversationKey,
  EMPTY_CONVERSATION,
  loadConversation,
} from "../store/conversation.ts";
import { RichText } from "./RichText.tsx";
import { Button, INPUT_CLASS, Money } from "./ui.tsx";

/** The chat's commands that may switch Stop all on or off. */
const KILL_COMMANDS = new Set(["session.stop", "session.resume"]);

/** The three example phrases under the input (design §3.9). */
export const EXAMPLE_PHRASES = ["what is left?", "add a task: …", "stop after this task"] as const;

/** d1109-chat-depth: Stop's consequence line (its title; the daemon's `STOP_EXPLAIN`). */
export const STOP_EXPLAIN = "Stops this answer. Changes it already made stay, each with Undo.";
/** Answer now's consequence line. */
export const ANSWER_NOW_EXPLAIN = "Answers at once from what it has looked up so far.";
/** A line Forerunner closed on before answering (a restart); Ask again sends it again. */
export const CLOSED_LINE = "Forerunner closed before answering this.";
/** A line whose answer failed while Forerunner ran. */
export const FAILED_LINE = "I could not answer this.";
/** The waiting line before the first step. */
export const THINKING = "Thinking…";
/** The waiting line once Stop was pressed. */
export const STOPPING = "Stopping…";

/** " · 7 s" after the waiting line, from 3 seconds on (design §3.9: what it is doing, and for how long). */
export function secondsSince(since: string | null | undefined, nowMs: number): string {
  if (!since) return "";
  const t = Date.parse(since);
  if (!Number.isFinite(t)) return "";
  const s = Math.floor((nowMs - t) / 1000);
  return s >= 3 ? ` · ${s} s` : "";
}

/**
 * C2-left-7: where a record the reply rests on opens. Only the app's pages that show the record
 * it names: a task in the Tasks drawer (`?task=`), a document in Files (`?path=`), a session's own
 * page. Any other link opens a page that does not show that record (or no page at all, as
 * "/talk"), so the record is named without a link.
 */
export function recordLink(link: string | null): string | null {
  if (!link) return null;
  if (/^\/sessions\/[^/?#]+$/.test(link)) return link;
  if (/^\/projects\/[^/?#]+\/(?:tasks\?task=|files\?path=)/.test(link)) return link;
  return null;
}

/**
 * One conversation (design §3.9): the project Chat tab and Talk both render this, from the
 * turns the daemon keeps, so they show the same lines and the same Yes/No card, after a reload
 * or a restart too. A reply's changes read as plain sentences with one Undo each (no "first
 * token" badge, no `task.create:` chips, no "Undo." as text); the change waiting for a yes is
 * one card with Yes and No until it is answered, whatever is typed in between; "Make this a
 * task" is offered under the person's own lines only. `testIds` names the elements: `chat`
 * in the Chat tab, `conversation` in Talk.
 *
 * d1109-chat-depth (the owner's words of 2026-11-09: "There should be something indicating what
 * the chat is doing when waiting"): while an answer is made its bubble says what chat is doing
 * (the daemon's step lines, then " · 7 s"), Send becomes Stop, and a longer answer also has
 * Answer now; a reload or the other surface shows the same from the daemon (`answering`). Under
 * an answer: its footer (model, time, CHF), the line it offers with Go ahead or Think it
 * through, the records it rests on (the From line), and for a line with no answer why, with
 * Ask again.
 */
export function Conversation({
  projectId,
  testIds = "chat",
  onMakeTask,
  inputRef,
  hideVoiceSince,
  readOnly = false,
}: {
  /** The project this conversation is about; null for the one outside any project. */
  projectId: string | null;
  testIds?: "chat" | "conversation";
  /** "Make this a task" under the person's own lines; absent, not offered. */
  onMakeTask?: (text: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  /**
   * Talk shows its own spoken lines as they come: stored spoken turns from this moment on
   * (ISO time) are left to it, so a spoken turn is not shown twice.
   */
  hideVoiceSince?: string;
  /**
   * OJ-06 (d1109-onerepo-join): the conversation of a closed project, kept to read: its turns
   * without the message box and the examples (the Chat tab says where to ask instead).
   */
  readOnly?: boolean;
}) {
  const client = useClient();
  const store = useUiStore();
  const identity = useIdentity();
  const key = conversationKey(projectId);
  const state = useUiState((s) => s.conversations[key]) ?? EMPTY_CONVERSATION;
  const [input, setInput] = useState("");
  const [undoNotes, setUndoNotes] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  // The answer being made: this screen's own line, or (after a reload, or on the other surface)
  // the daemon's `answering`.
  const answering = state.view?.answering ?? null;
  const live = state.live;
  const liveBusy = live !== null && live.error === null;
  const busy = liveBusy || answering !== null;
  const turnId = (liveBusy ? live?.turnId : null) ?? answering?.turnId ?? null;
  const stopping = live?.stopping === true || answering?.step === STOPPING;
  const deep = (liveBusy ? live?.depth : answering?.depth) ?? "quick";

  useEffect(() => {
    const controller = new AbortController();
    void loadConversation(client, store, projectId, controller.signal);
    return () => controller.abort();
  }, [client, store, projectId]);

  // The seconds after the waiting line tick while an answer is made (the UI's clock, AGENTS.md).
  const nowMs = useNow(systemClock, 1000, busy);

  const turns = (state.view?.turns ?? []).filter(
    (t) =>
      !(hideVoiceSince && t.source === "voice" && t.at >= hideVoiceSince) &&
      // The line this screen is sending shows as its live bubble, not twice.
      !(liveBusy && live?.turnId && t.id === live.turnId),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the list grows
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, state.live?.text]);

  const update = useCallback(
    (fn: (c: ConversationState) => ConversationState) =>
      store.dispatch({ type: "conversation", key, update: fn }),
    [store, key],
  );

  const send = async (text: string, extra: { offer?: string; depth?: "longer" } = {}) => {
    const said = text.trim();
    if (!identity || busy || !said) return;
    update((c) => ({
      ...c,
      live: { said, text: "", error: null, turnId: null, step: null, since: null, depth: null },
    }));
    try {
      const reply = await streamChat(
        client,
        {
          humanId: identity.humanId,
          agentId: identity.agentId,
          ...(projectId ? { projectId, projectTab: true } : {}),
          text: said,
          source: "text",
          ...extra,
        },
        {
          onTurn: (t) =>
            update((c) =>
              c.live ? { ...c, live: { ...c.live, turnId: t.turnId, since: t.startedAt } } : c,
            ),
          // L3-left-9: a step with reset drops what streamed before it (a hand-over, or the
          // claim guard's true line), so no taken-back text stays on screen.
          onStep: (s) =>
            update((c) =>
              c.live
                ? {
                    ...c,
                    live: {
                      ...c.live,
                      step: c.live.stopping ? STOPPING : s.text,
                      ...(s.reset ? { text: "", depth: "longer" } : {}),
                    },
                  }
                : c,
            ),
          onToken: (_token, soFar) =>
            update((c) => (c.live ? { ...c, live: { ...c.live, text: soFar } } : c)),
        },
      );
      await loadConversation(client, store, projectId);
      update((c) => ({ ...c, live: null }));
      // "stop everything" (Stop all) and "resume" switch the kill state: the header's bar
      // follows at once (before, it read the kill state only at start, so the bar came with
      // the next reload).
      if (reply.actions.some((a) => a.kind.split("+").some((k) => KILL_COMMANDS.has(k)))) {
        void client
          .health()
          .then((health) => store.dispatch({ type: "killActive", active: health.killActive }))
          .catch(() => {});
      }
      if (reply.activeProjectId && reply.activeProjectId !== store.getState().activeProjectId) {
        store.dispatch({ type: "activeProject", id: reply.activeProjectId });
      }
    } catch (err) {
      const message = describeError(err);
      update((c) => (c.live ? { ...c, live: { ...c.live, error: message } } : c));
    }
  };

  /** Stop: the answer ends; what it changed stays with its Undo. */
  const stop = async () => {
    if (!turnId) return;
    update((c) => (c.live ? { ...c, live: { ...c.live, stopping: true, step: STOPPING } } : c));
    try {
      await client.stopChatTurn(turnId);
    } catch {
      // The answer may have ended meanwhile; its reply comes as always.
    }
    if (!liveBusy) await loadConversation(client, store, projectId);
  };

  const answerNow = async () => {
    if (!turnId) return;
    try {
      await client.answerNow(turnId);
    } catch {
      // Nothing to do: the answer comes as always.
    }
  };

  const undo = async (changeId: string) => {
    try {
      const result = await client.undoChange(changeId);
      setUndoNotes((n) => ({
        ...n,
        [changeId]:
          result.status === "done" || result.status === "partial"
            ? result.sentence
              ? withoutUndoWord(result.sentence).text
              : "Undone."
            : result.status === "pending"
              ? (result.readback ?? "That undo waits for your yes.")
              : `Not undone: ${result.reason ?? "the change cannot be undone any more"}.`,
      }));
    } catch (err) {
      setUndoNotes((n) => ({ ...n, [changeId]: `Not undone: ${describeError(err)}` }));
    }
    await loadConversation(client, store, projectId);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    // While an answer is made, Enter neither stops it nor drops the line typed meanwhile: Stop
    // ends an answer only on its own press (fixup-d1109-chat-depth; nothing ends by accident).
    if (busy) return;
    const text = input;
    setInput("");
    void send(text);
  };

  const waiting = state.view?.waiting ?? null;
  const waitingLine = (step: string | null | undefined, since: string | null | undefined) =>
    `${stopping ? STOPPING : step || THINKING}${secondsSince(since, nowMs)}`;

  return (
    <div
      className="flex h-full min-h-[18rem] flex-col gap-2"
      data-testid={testIds === "chat" ? "chat" : `${testIds}-thread`}
    >
      <div
        ref={listRef}
        className="flex-1 space-y-2 overflow-auto rounded border border-neutral-200 p-2 dark:border-neutral-800"
        data-testid={`${testIds}-messages`}
        aria-live="polite"
      >
        {turns.length === 0 && !state.live ? (
          <p className="text-sm text-neutral-500" data-testid={`${testIds}-empty`}>
            {readOnly
              ? "Nothing was said here."
              : projectId
                ? "Ask what is going on, or tell me what to change."
                : "Ask about your projects, or tell me what to change."}
          </p>
        ) : null}
        {state.error ? (
          <p className="text-xs text-red-700 dark:text-red-300">
            The conversation did not load: {state.error}{" "}
            <button
              type="button"
              className="underline"
              onClick={() => void loadConversation(client, store, projectId)}
            >
              Retry
            </button>
          </p>
        ) : null}
        {turns.map((t, i) => (
          <Turn
            key={t.id}
            turn={t}
            newest={!readOnly && i === turns.length - 1}
            readOnly={readOnly}
            testIds={testIds}
            onMakeTask={onMakeTask}
            undoNotes={undoNotes}
            onUndo={(id) => void undo(id)}
            onAnswer={(word) => void send(word)}
            onGoAhead={() => void send("Go ahead.", { offer: t.id })}
            onThink={() => void send("Think it through.", { offer: t.id, depth: "longer" })}
            onAskAgain={() => void send(t.said)}
            waitingEstimate={waiting && t.reply?.waiting ? waiting.estimate : null}
            busy={busy}
            answeringLine={
              !liveBusy && answering?.turnId === t.id
                ? waitingLine(answering.step, answering.since)
                : null
            }
          />
        ))}
        {state.live ? (
          <>
            <Bubble who="human" testIds={testIds} via="text">
              <span className="whitespace-pre-wrap">{state.live.said}</span>
            </Bubble>
            <Bubble who="agent" testIds={testIds} via="text" streaming={state.live.error === null}>
              {state.live.text.length === 0 && state.live.error === null ? (
                <output className="text-neutral-500" data-testid={`${testIds}-waiting`}>
                  {waitingLine(state.live.step, state.live.since)}
                </output>
              ) : (
                <>
                  {state.live.step && state.live.error === null ? (
                    <output
                      className="block text-xs text-neutral-500"
                      data-testid={`${testIds}-waiting`}
                    >
                      {waitingLine(state.live.step, state.live.since)}
                    </output>
                  ) : null}
                  <RichText text={withoutUndoWord(state.live.text).text} />
                </>
              )}
              {state.live.error ? (
                <div className="mt-1 text-xs text-red-700 dark:text-red-300">
                  {state.live.error}
                </div>
              ) : null}
            </Bubble>
          </>
        ) : null}
      </div>
      {readOnly ? null : (
        <form onSubmit={submit} className="flex gap-2">
          <input
            ref={inputRef}
            className={INPUT_CLASS}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={identity ? "Message your agent…" : "Waiting for the daemon…"}
            disabled={!identity}
            aria-label="Chat message"
            data-testid={`${testIds}-input`}
          />
          {busy && deep !== "quick" && !stopping ? (
            <Button
              type="button"
              className="whitespace-nowrap"
              onClick={() => void answerNow()}
              disabled={!turnId}
              title={ANSWER_NOW_EXPLAIN}
              data-testid={`${testIds}-answer-now`}
            >
              Answer now
            </Button>
          ) : null}
          {busy ? (
            <Button
              variant="primary"
              type="button"
              className="whitespace-nowrap"
              onClick={() => void stop()}
              disabled={!turnId || stopping}
              title={STOP_EXPLAIN}
              data-testid={`${testIds}-stop`}
            >
              Stop
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              disabled={!identity || !input.trim()}
              data-testid={`${testIds}-send`}
            >
              Send
            </Button>
          )}
        </form>
      )}
      {readOnly ? null : (
        <div className="flex flex-wrap gap-2 text-xs" data-testid={`${testIds}-examples`}>
          <span className="text-neutral-500">Try:</span>
          {EXAMPLE_PHRASES.map((p) => (
            <button
              key={p}
              type="button"
              className="rounded-full border border-neutral-300 px-2 py-0.5 text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              onClick={() => {
                setInput(p.replace("…", ""));
                inputRef?.current?.focus();
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Bubble({
  who,
  testIds,
  via,
  streaming = false,
  children,
}: {
  who: "human" | "agent";
  testIds: string;
  via: string;
  streaming?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
        who === "human" ? "ml-auto bg-blue-600 text-white" : "bg-neutral-100 dark:bg-neutral-800"
      }`}
      data-testid={`${testIds}-${who}`}
      data-via={via}
      data-streaming={streaming ? "true" : "false"}
    >
      {children}
    </div>
  );
}

/**
 * A line the person wrote as a request or a question (one a task can be made of): not a
 * command that already acted, a read-back's yes or no, or an undo.
 */
function isOwnRequest(turn: ConversationTurnView): boolean {
  const r = turn.reply;
  if (r && (r.actions.length > 0 || r.readback)) return false;
  return !/^\s*(?:yes|no|ok|undo|stop|cancel|resume|go ahead|think it through)\b[.!]?\s*$/i.test(
    turn.said,
  );
}

function Turn({
  turn,
  newest,
  readOnly,
  testIds,
  onMakeTask,
  undoNotes,
  onUndo,
  onAnswer,
  onGoAhead,
  onThink,
  onAskAgain,
  waitingEstimate,
  busy,
  answeringLine,
}: {
  turn: ConversationTurnView;
  newest: boolean;
  /** OJ-06: kept to read (a closed project): no answer, Yes or No, Undo or question options. */
  readOnly: boolean;
  testIds: string;
  onMakeTask: ((text: string) => void) | undefined;
  undoNotes: Record<string, string>;
  onUndo: (changeId: string) => void;
  onAnswer: (word: string) => void;
  onGoAhead: () => void;
  onThink: () => void;
  onAskAgain: () => void;
  waitingEstimate: { usdMicro: number; chfMicro: number } | null;
  busy: boolean;
  /** This line's answer is being made (after a reload): the waiting line. */
  answeringLine: string | null;
}) {
  const r = turn.reply;
  const via = turn.source === "voice" ? "voice" : "text";
  // A reply that is only its changes' sentences shows them once, as the changes below; L3-left-10:
  // also when it is all of them joined (the claim guard's true line on a turn of two changes).
  const sentences = (r?.actions ?? []).map((a) => withoutUndoWord(a.sentence).text);
  const text = r ? withoutUndoWord(r.text).text : "";
  const showText =
    text &&
    !(
      r?.actions.length &&
      (sentences.includes(text) || sentences.join(" ").trim() === text.trim())
    );
  const offer = r?.offer ?? null;
  const sources = r?.sources ?? [];
  const noAnswer = !r && !answeringLine && (turn.interrupted || turn.failed);
  return (
    <>
      <Bubble who="human" testIds={testIds} via={via}>
        <span className="whitespace-pre-wrap">{turn.said}</span>
        {onMakeTask && isOwnRequest(turn) ? (
          <div className="mt-1">
            <button
              type="button"
              className="text-xs text-blue-100 underline"
              onClick={() => onMakeTask(turn.said)}
              data-testid="make-task"
            >
              Make this a task
            </button>
          </div>
        ) : null}
      </Bubble>
      {answeringLine ? (
        <Bubble who="agent" testIds={testIds} via={via} streaming>
          <output className="text-neutral-500" data-testid={`${testIds}-waiting`}>
            {answeringLine}
          </output>
        </Bubble>
      ) : null}
      {noAnswer ? (
        <Bubble who="agent" testIds={testIds} via={via}>
          <p
            className="text-neutral-600 dark:text-neutral-300"
            data-testid={`${testIds}-no-answer`}
          >
            {turn.interrupted ? CLOSED_LINE : FAILED_LINE}
          </p>
          {newest ? (
            <Button
              className="mt-1 px-2 py-0.5 text-xs"
              onClick={onAskAgain}
              disabled={busy}
              data-testid={`${testIds}-ask-again`}
            >
              Ask again
            </Button>
          ) : null}
        </Bubble>
      ) : null}
      {r ? (
        <Bubble who="agent" testIds={testIds} via={via}>
          {showText ? <RichText text={inAppText(text)} /> : null}
          {turn.failed && newest ? (
            <Button
              className="mt-1 px-2 py-0.5 text-xs"
              onClick={onAskAgain}
              disabled={busy}
              data-testid={`${testIds}-ask-again`}
            >
              Ask again
            </Button>
          ) : null}
          {r.actions.map((a) => (
            <div
              key={`${a.changeId ?? a.kind}-${a.sentence}`}
              className="mt-1 flex flex-wrap items-center gap-2"
              data-testid={`${testIds}-action`}
            >
              {a.sentence ? (
                <span className="whitespace-pre-wrap">{withoutUndoWord(a.sentence).text}</span>
              ) : null}
              {a.sessionId ? (
                <Link
                  to={`/sessions/${encodeURIComponent(a.sessionId)}`}
                  className="text-xs underline"
                  data-testid={`${testIds}-session-link`}
                >
                  Open the session
                </Link>
              ) : null}
              {!readOnly && a.canUndo && a.changeId && !undoNotes[a.changeId] ? (
                <Button
                  variant="ghost"
                  className="px-2 py-0.5 text-xs"
                  onClick={() => onUndo(a.changeId as string)}
                  disabled={busy}
                  data-testid={`${testIds}-undo`}
                >
                  Undo
                </Button>
              ) : null}
              {a.changeId && undoNotes[a.changeId] ? (
                <output className="block text-xs" data-testid={`${testIds}-undo-note`}>
                  {undoNotes[a.changeId]}
                </output>
              ) : null}
            </div>
          ))}
          {!readOnly && r.question?.options.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {r.question.options.map((o) => (
                <Button
                  key={o}
                  className="px-2 py-0.5 text-xs"
                  onClick={() => onAnswer(o)}
                  disabled={busy}
                >
                  {o}
                </Button>
              ))}
            </div>
          ) : null}
          {r.readback ? (
            r.waiting && !readOnly ? (
              <div
                className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-neutral-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                data-testid="pending-confirmation"
              >
                <p className="text-sm">{inAppText(r.readback)}</p>
                {/* One figure, once (wave 2: "Estimated CHF 5.00" under "(up to CHF 5)?"): the
                    estimate only when the question names no amount of its own. */}
                {waitingEstimate && waitingEstimate.usdMicro > 0 && !/CHF\s?\d/.test(r.readback) ? (
                  <p className="text-xs text-neutral-600 dark:text-neutral-300">
                    Estimated <Money value={waitingEstimate} />
                  </p>
                ) : null}
                <div className="mt-1 flex gap-2">
                  <Button
                    variant="primary"
                    onClick={() => onAnswer("yes")}
                    disabled={busy}
                    data-testid="confirm-yes"
                  >
                    Yes
                  </Button>
                  <Button onClick={() => onAnswer("no")} disabled={busy} data-testid="confirm-no">
                    No
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mt-1 text-xs text-neutral-500" data-testid="readback-closed">
                {inAppText(r.readback)}{" "}
                {r.card === "yes"
                  ? "(you said yes)"
                  : r.card === "no"
                    ? "(you said no)"
                    : "(not answered; ask again if you still want it)"}
              </p>
            )
          ) : null}
          {sources.length ? (
            <p className="mt-1 text-xs text-neutral-500" data-testid={`${testIds}-from`}>
              From:{" "}
              {sources.map((s, i) => {
                const link = recordLink(s.link);
                const name = `${s.title} (${s.date})`;
                return (
                  <span key={`${s.kind}-${s.title}-${s.date}`}>
                    {i > 0 ? ", " : ""}
                    {link ? (
                      <Link to={link} className="underline" data-testid={`${testIds}-from-link`}>
                        {name}
                      </Link>
                    ) : (
                      name
                    )}
                  </span>
                );
              })}
            </p>
          ) : null}
          {offer?.line ? (
            <p className="mt-1 text-sm" data-testid={`${testIds}-offer`}>
              {offer.line}
            </p>
          ) : null}
          {offer?.action === "go_ahead" && newest ? (
            <Button
              variant="primary"
              className="mt-1 px-2 py-0.5 text-xs"
              onClick={onGoAhead}
              disabled={busy}
              data-testid={`${testIds}-go-ahead`}
            >
              Go ahead
            </Button>
          ) : null}
          {offer?.action === "think" && newest && via === "text" ? (
            <div className="mt-1">
              <Button
                className="px-2 py-0.5 text-xs"
                onClick={onThink}
                disabled={busy}
                title={offer.explain ?? undefined}
                data-testid={`${testIds}-think`}
              >
                Think it through
              </Button>
              {offer.explain ? (
                <span
                  className="ml-2 text-xs text-neutral-500"
                  data-testid={`${testIds}-think-explain`}
                >
                  {offer.explain}
                </span>
              ) : null}
            </div>
          ) : null}
          {r.footer ? (
            <p className="mt-1 text-xs text-neutral-500" data-testid={`${testIds}-footer`}>
              {r.footer}
            </p>
          ) : null}
        </Bubble>
      ) : null}
    </>
  );
}
