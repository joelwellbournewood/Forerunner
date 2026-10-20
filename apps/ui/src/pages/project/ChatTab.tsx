import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { streamChat } from "../../api/chat-stream.ts";
import { type ChatReplyView, describeError, type TaskView } from "../../api/client.ts";
import { Badge, Button, INPUT_CLASS, Money } from "../../components/ui.tsx";
import type { MoneyLike } from "../../lib/money.ts";
import { formatDuration } from "../../lib/time.ts";
import { useClient, useIdentity, useUiStore } from "../../store/context.tsx";
import { NewTaskDialog, seedFromMessage, type TaskSeed } from "./NewTaskDialog.tsx";

export interface ChatMessage {
  id: string;
  role: "human" | "agent";
  text: string;
  /** Agent messages: true until the final reply frame arrived. */
  streaming?: boolean;
  reply?: ChatReplyView;
  error?: string;
}

/** Text chat first token target from spec D.9. */
const TTFT_TARGET_MS = 1000;

let counter = 0;
const nextId = () => `m${++counter}-${Date.now()}`;

/**
 * Quick chat per project (spec J.1): read-only by default, streaming replies, "make this a
 * task", and read-back confirmations answered with Yes/No (sent as the words "yes"/"no").
 */
export function ChatTab({ projectId, reference }: { projectId: string; reference?: MoneyLike }) {
  const client = useClient();
  const store = useUiStore();
  const identity = useIdentity();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [seed, setSeed] = useState<TaskSeed | null>(null);
  const [created, setCreated] = useState<TaskView | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when the list grows
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const pending = [...messages].reverse().find((m) => m.reply?.pendingConfirmation)
    ?.reply?.pendingConfirmation;
  const lastReply = [...messages].reverse().find((m) => m.reply)?.reply;
  const confirmationOpen = Boolean(pending && lastReply?.pendingConfirmation?.id === pending.id);

  const send = async (text: string) => {
    if (!identity || busy || !text.trim()) return;
    const humanMessage: ChatMessage = { id: nextId(), role: "human", text: text.trim() };
    const agentId = nextId();
    setMessages((prev) => [
      ...prev,
      humanMessage,
      { id: agentId, role: "agent", text: "", streaming: true },
    ]);
    setBusy(true);
    try {
      const reply = await streamChat(
        client,
        {
          humanId: identity.humanId,
          agentId: identity.agentId,
          projectId,
          text: text.trim(),
          source: "text",
        },
        {
          onToken: (_token, soFar) =>
            setMessages((prev) => prev.map((m) => (m.id === agentId ? { ...m, text: soFar } : m))),
        },
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === agentId ? { ...m, text: reply.reply, streaming: false, reply } : m,
        ),
      );
      if (reply.activeProjectId && reply.activeProjectId !== store.getState().activeProjectId) {
        store.dispatch({ type: "activeProject", id: reply.activeProjectId });
      }
    } catch (err) {
      const message = describeError(err);
      setMessages((prev) =>
        prev.map((m) => (m.id === agentId ? { ...m, streaming: false, error: message } : m)),
      );
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = input;
    setInput("");
    void send(text);
  };

  return (
    <div className="flex h-full min-h-[24rem] flex-col gap-2" data-testid="chat">
      <p className="text-xs text-neutral-500">
        Quick chat is read-only by default: it answers from the project summary and docs on a fast
        model. Actions are read back and need your confirmation.
      </p>
      <div
        ref={listRef}
        className="flex-1 space-y-2 overflow-auto rounded border border-neutral-200 p-2 dark:border-neutral-800"
        data-testid="chat-messages"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="text-sm text-neutral-500">Ask anything about this project.</p>
        ) : null}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`max-w-[90%] rounded-lg px-3 py-2 text-sm ${
              m.role === "human"
                ? "ml-auto bg-blue-600 text-white"
                : "bg-neutral-100 dark:bg-neutral-800"
            }`}
            data-testid={`chat-${m.role}`}
            data-streaming={m.streaming ? "true" : "false"}
          >
            {m.streaming && m.text.length === 0 ? (
              <output className="text-neutral-500">Thinking… (waiting for the first token)</output>
            ) : (
              <span className="whitespace-pre-wrap">{m.text}</span>
            )}
            {m.streaming && m.text.length > 0 ? <span className="animate-pulse">▍</span> : null}
            {m.error ? (
              <div className="mt-1 text-xs text-red-700 dark:text-red-300">{m.error}</div>
            ) : null}
            {m.reply ? (
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                {m.reply.ttftMs !== null ? (
                  <Badge
                    tone={m.reply.ttftMs <= TTFT_TARGET_MS ? "good" : "warn"}
                    title="Time to first token against the 1 s target"
                  >
                    first token {formatDuration(m.reply.ttftMs)}
                  </Badge>
                ) : null}
                <Money value={m.reply.cost} />
                {m.reply.actions.map((a) => (
                  <Badge key={`${a.kind}-${a.id ?? a.summary}`} tone="info">
                    {a.kind}: {a.summary}
                  </Badge>
                ))}
              </div>
            ) : null}
            {m.reply?.pendingConfirmation &&
            confirmationOpen &&
            m.reply.pendingConfirmation.id === pending?.id ? (
              <div
                className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-neutral-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
                data-testid="pending-confirmation"
              >
                <p className="text-sm">{m.reply.pendingConfirmation.readback}</p>
                <p className="text-xs text-neutral-600 dark:text-neutral-300">
                  Estimated <Money value={m.reply.pendingConfirmation.estimate} />
                </p>
                <div className="mt-1 flex gap-2">
                  <Button
                    variant="primary"
                    onClick={() => void send("yes")}
                    disabled={busy}
                    data-testid="confirm-yes"
                  >
                    Yes
                  </Button>
                  <Button onClick={() => void send("no")} disabled={busy} data-testid="confirm-no">
                    No
                  </Button>
                </div>
              </div>
            ) : null}
            {!m.streaming && m.text ? (
              <div className="mt-1">
                <button
                  type="button"
                  className={`text-xs underline ${m.role === "human" ? "text-blue-100" : "text-blue-700 dark:text-blue-300"}`}
                  onClick={() => setSeed(seedFromMessage(m.text))}
                  data-testid="make-task"
                >
                  Make this a task
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {created ? (
        <output
          className="text-xs text-emerald-700 dark:text-emerald-300"
          data-testid="task-created"
        >
          Draft task created: {created.title} ·{" "}
          <Link to={`/projects/${encodeURIComponent(projectId)}/tasks`} className="underline">
            open tasks
          </Link>
        </output>
      ) : null}
      <form onSubmit={submit} className="flex gap-2">
        <input
          className={INPUT_CLASS}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={identity ? "Message your agent…" : "Waiting for the daemon…"}
          disabled={!identity}
          aria-label="Chat message"
          data-testid="chat-input"
        />
        <Button
          variant="primary"
          type="submit"
          disabled={!identity || busy || !input.trim()}
          data-testid="chat-send"
        >
          {busy ? "Sending…" : "Send"}
        </Button>
      </form>
      <NewTaskDialog
        open={seed !== null}
        onClose={() => setSeed(null)}
        projectId={projectId}
        seed={seed}
        reference={reference}
        onCreated={(task) => setCreated(task)}
      />
    </div>
  );
}
