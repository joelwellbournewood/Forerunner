import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { describeStateError, type RemoteCommandView } from "../../api/state-client.ts";
import { Badge, Button, ErrorBanner, INPUT_CLASS } from "../../components/ui.tsx";
import { IntentRefused, parseIntent } from "../intent.ts";
import { activeMobileProject, useMobileController, useMobileState } from "../store.tsx";

interface Turn {
  id: string;
  role: "you" | "agent" | "system";
  text: string;
  commandId?: string;
  status?: string;
}

function replyOf(row: RemoteCommandView): string | null {
  const r = row.result;
  if (typeof r === "string") return r;
  if (r && typeof r === "object") {
    const o = r as { reply?: unknown; text?: unknown; message?: unknown; error?: unknown };
    const line = [o.reply, o.text, o.message, o.error].find((v) => typeof v === "string");
    if (typeof line === "string") return line;
  }
  return null;
}

/**
 * Quick chat (spec J.1, R.5) relayed to the PC: each turn is one remote command of kind
 * `chat` that the PC's principal agent answers; the reply comes back as the command's
 * result (and as an inbox message). Text that is a change ("switch to…", "give it…") is
 * not chatted but previewed as a change card on the Remote screen (module Q). Voice is
 * phase-5 voice work (module O); this screen is text only.
 */
export function ChatScreen() {
  const controller = useMobileController();
  const navigate = useNavigate();
  const state = useMobileState((s) => s);
  const active = activeMobileProject(state);
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
    },
    [],
  );

  const watch = (commandId: string, turnId: string, attempt = 0) => {
    const t = setTimeout(
      () => {
        void controller.trackCommand(commandId).then((row) => {
          if (!row) return;
          const reply = replyOf(row);
          setTurns((prev) =>
            prev.map((turn) =>
              turn.id === turnId ? { ...turn, status: row.status, text: reply ?? turn.text } : turn,
            ),
          );
          if ((row.status === "pending" || row.status === "picked_up") && attempt < 60) {
            watch(commandId, turnId, attempt + 1);
          }
        });
      },
      Math.min(2000, 300 + attempt * 200),
    );
    timers.current.push(t);
  };

  const send = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setError(null);
    let intent: ReturnType<typeof parseIntent> | null = null;
    try {
      intent = parseIntent(words, {
        timezone: controller.env.timezone,
        now: controller.env.now(),
        activeProjectId: state.activeProjectId,
        projects: state.projects.map((p) => ({ id: p.id, name: p.name })),
        source: "chat",
      });
    } catch (e) {
      if (e instanceof IntentRefused) {
        setError(
          "That text looks like content from a page or an email; it is not treated as a request.",
        );
        return;
      }
    }
    if (intent && intent.commands.length > 0) {
      navigate("/remote", { state: { words } });
      return;
    }
    setBusy(true);
    const youId = `you-${Date.now()}`;
    setTurns((prev) => [...prev, { id: youId, role: "you", text: words }]);
    setText("");
    try {
      const row = await controller.sendChat(words, state.activeProjectId);
      const agentId = `agent-${row.id}`;
      setTurns((prev) => [
        ...prev,
        {
          id: agentId,
          role: "agent",
          text: "Sent to your PC; the reply arrives here and in the inbox.",
          commandId: row.id,
          status: row.status,
        },
      ]);
      watch(row.id, agentId);
    } catch (e) {
      setError(describeStateError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="m-chat-title" className="space-y-3">
      <div className="flex items-center gap-2">
        <h1 id="m-chat-title" className="text-xl font-semibold">
          Chat
        </h1>
        <Badge tone="info">{active ? active.name : "no project"}</Badge>
      </div>
      <p className="text-xs text-neutral-500">
        Text goes to your agent on the PC. Say what to change ("switch to…", "give it 15 francs
        until tomorrow") and you get a change card instead.
      </p>
      <ol className="space-y-2" data-testid="m-chat-log">
        {turns.map((t) => (
          <li
            key={t.id}
            className={`rounded px-3 py-2 text-sm ${
              t.role === "you"
                ? "ml-8 bg-blue-50 dark:bg-blue-950/40"
                : "mr-8 bg-neutral-100 dark:bg-neutral-900"
            }`}
            data-testid={t.role === "you" ? "m-chat-you" : "m-chat-reply"}
            data-status={t.status ?? ""}
          >
            {t.text}
            {t.status ? <span className="ml-2 text-xs text-neutral-500">({t.status})</span> : null}
          </li>
        ))}
      </ol>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          className={INPUT_CLASS}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask or say what to change…"
          aria-label="Message"
          data-testid="m-chat-input"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !text.trim()}
          data-testid="m-chat-send"
        >
          Send
        </Button>
      </form>
      {error ? <ErrorBanner message={error} testId="m-chat-error" /> : null}
    </section>
  );
}
