import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "../api/chat-stream.ts";
import { type ConversationTurnView, describeError } from "../api/client.ts";
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

/**
 * One conversation (design §3.9): the project Chat tab and Talk both render this, from the
 * turns the daemon keeps, so they show the same lines and the same Yes/No card, after a reload
 * or a restart too. A reply's changes read as plain sentences with one Undo each (no "first
 * token" badge, no `task.create:` chips, no "Undo." as text); the change waiting for a yes is
 * one card with Yes and No until it is answered, whatever is typed in between; "Make this a
 * task" is offered under the person's own lines only. `testIds` names the elements: `chat`
 * in the Chat tab, `conversation` in Talk.
 */
export function Conversation({
  projectId,
  testIds = "chat",
  onMakeTask,
  inputRef,
  hideVoiceSince,
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
}) {
  const client = useClient();
  const store = useUiStore();
  const identity = useIdentity();
  const key = conversationKey(projectId);
  const state = useUiState((s) => s.conversations[key]) ?? EMPTY_CONVERSATION;
  const [input, setInput] = useState("");
  const [undoNotes, setUndoNotes] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);
  const busy = state.live !== null && state.live.error === null;

  useEffect(() => {
    const controller = new AbortController();
    void loadConversation(client, store, projectId, controller.signal);
    return () => controller.abort();
  }, [client, store, projectId]);

  const turns = (state.view?.turns ?? []).filter(
    (t) => !(hideVoiceSince && t.source === "voice" && t.at >= hideVoiceSince),
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

  const send = async (text: string) => {
    const said = text.trim();
    if (!identity || busy || !said) return;
    update((c) => ({ ...c, live: { said, text: "", error: null } }));
    try {
      const reply = await streamChat(
        client,
        {
          humanId: identity.humanId,
          agentId: identity.agentId,
          ...(projectId ? { projectId, projectTab: true } : {}),
          text: said,
          source: "text",
        },
        {
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
    const text = input;
    setInput("");
    void send(text);
  };

  const waiting = state.view?.waiting ?? null;

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
            {projectId
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
        {turns.map((t) => (
          <Turn
            key={t.id}
            turn={t}
            testIds={testIds}
            onMakeTask={onMakeTask}
            undoNotes={undoNotes}
            onUndo={(id) => void undo(id)}
            onAnswer={(word) => void send(word)}
            waitingEstimate={waiting && t.reply?.waiting ? waiting.estimate : null}
            busy={busy}
          />
        ))}
        {state.live ? (
          <>
            <Bubble who="human" testIds={testIds} via="text">
              <span className="whitespace-pre-wrap">{state.live.said}</span>
            </Bubble>
            <Bubble who="agent" testIds={testIds} via="text" streaming={state.live.error === null}>
              {state.live.text.length === 0 && state.live.error === null ? (
                <output className="text-neutral-500">Thinking…</output>
              ) : (
                <RichText text={withoutUndoWord(state.live.text).text} />
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
        <Button
          variant="primary"
          type="submit"
          disabled={!identity || busy || !input.trim()}
          data-testid={`${testIds}-send`}
        >
          {busy ? "Sending…" : "Send"}
        </Button>
      </form>
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
  return !/^\s*(?:yes|no|ok|undo|stop|cancel|resume)\b[.!]?\s*$/i.test(turn.said);
}

function Turn({
  turn,
  testIds,
  onMakeTask,
  undoNotes,
  onUndo,
  onAnswer,
  waitingEstimate,
  busy,
}: {
  turn: ConversationTurnView;
  testIds: string;
  onMakeTask: ((text: string) => void) | undefined;
  undoNotes: Record<string, string>;
  onUndo: (changeId: string) => void;
  onAnswer: (word: string) => void;
  waitingEstimate: { usdMicro: number; chfMicro: number } | null;
  busy: boolean;
}) {
  const r = turn.reply;
  const via = turn.source === "voice" ? "voice" : "text";
  // A reply that is only its changes' sentences shows them once, as the changes below.
  const sentences = new Set((r?.actions ?? []).map((a) => withoutUndoWord(a.sentence).text));
  const text = r ? withoutUndoWord(r.text).text : "";
  const showText = text && !(r?.actions.length && sentences.has(text));
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
      {r ? (
        <Bubble who="agent" testIds={testIds} via={via}>
          {showText ? <RichText text={inAppText(text)} /> : null}
          {r.actions.map((a) => (
            <div
              key={`${a.changeId ?? a.kind}-${a.sentence}`}
              className="mt-1 flex flex-wrap items-center gap-2"
              data-testid={`${testIds}-action`}
            >
              {a.sentence ? (
                <span className="whitespace-pre-wrap">{withoutUndoWord(a.sentence).text}</span>
              ) : null}
              {a.canUndo && a.changeId && !undoNotes[a.changeId] ? (
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
          {r.question?.options.length ? (
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
            r.waiting ? (
              <div
                className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-neutral-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                data-testid="pending-confirmation"
              >
                <p className="text-sm">{inAppText(r.readback)}</p>
                {waitingEstimate && waitingEstimate.usdMicro > 0 ? (
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
        </Bubble>
      ) : null}
    </>
  );
}
