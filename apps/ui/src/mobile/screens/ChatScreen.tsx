import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { describeStateError, type RemoteCommandView } from "../../api/state-client.ts";
import { Badge, Button, ErrorBanner, INPUT_CLASS } from "../../components/ui.tsx";
import { IntentRefused, parseIntent } from "../intent.ts";
import { activeMobileProject, useMobileController, useMobileState } from "../store.tsx";
import { VOICE_RELAY_MAX_MS } from "../voice.ts";

interface Turn {
  id: string;
  role: "you" | "agent" | "system";
  text: string;
  commandId?: string;
  status?: string;
  voice?: boolean;
}

/** What the PC heard in a voice turn (its transcript), when the result says. */
function saidOf(row: RemoteCommandView): string | null {
  const r = row.result;
  if (r && typeof r === "object" && typeof (r as { said?: unknown }).said === "string") {
    return (r as { said: string }).said;
  }
  return null;
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
 * not chatted but previewed as a change card on the Remote screen (module Q).
 *
 * Push-to-talk (ADR 0080): hold the button, speak, release; the recording (at most
 * `VOICE_RELAY_MAX_MS`, released automatically then) goes to the PC's voice loop as one
 * remote command of kind `voice`, the PC transcribes and answers, and the reply is shown and
 * spoken here. Where the page cannot record (the Android shell today, a refused microphone)
 * the typed line is relayed as the voice turn instead.
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

  const recorder = controller.env.recorder ?? null;
  const speaker = controller.env.speaker ?? null;
  const [recording, setRecording] = useState(false);
  const [micFailed, setMicFailed] = useState(false);
  const recordingRef = useRef(false);
  const autoRelease = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canRecord = recorder !== null && !micFailed;

  useEffect(
    () => () => {
      if (autoRelease.current) clearTimeout(autoRelease.current);
      if (recordingRef.current) recorder?.cancel();
      speaker?.stop();
    },
    [recorder, speaker],
  );

  const watch = (
    commandId: string,
    turnId: string,
    attempt = 0,
    onSettled?: (row: RemoteCommandView) => void,
  ) => {
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
            watch(commandId, turnId, attempt + 1, onSettled);
          } else {
            onSettled?.(row);
          }
        });
      },
      Math.min(2000, 300 + attempt * 200),
    );
    timers.current.push(t);
  };

  /** Relay one voice turn to the PC and speak its reply once it is back. */
  const relayVoice = async (
    input: Parameters<typeof controller.sendVoice>[0],
    label: string,
  ): Promise<void> => {
    setBusy(true);
    const youId = `you-voice-${Date.now()}`;
    setTurns((prev) => [...prev, { id: youId, role: "you", text: label, voice: true }]);
    try {
      const row = await controller.sendVoice(input, state.activeProjectId);
      const agentId = `agent-${row.id}`;
      setTurns((prev) => [
        ...prev,
        {
          id: agentId,
          role: "agent",
          text: "Sent to your PC's voice loop; the reply is spoken here.",
          commandId: row.id,
          status: row.status,
          voice: true,
        },
      ]);
      watch(row.id, agentId, 0, (done) => {
        const said = saidOf(done);
        if (said) {
          setTurns((prev) => prev.map((t) => (t.id === youId ? { ...t, text: said } : t)));
        }
        const reply = replyOf(done);
        if (done.status === "done" && reply) speaker?.speak(reply);
        if (done.status === "failed") {
          setError(`Your PC could not take the voice turn: ${reply ?? "failed"}`);
        }
      });
    } catch (e) {
      setError(describeStateError(e));
    } finally {
      setBusy(false);
    }
  };

  const startTalking = async () => {
    if (!recorder || recordingRef.current || busy) return;
    setError(null);
    speaker?.stop();
    recordingRef.current = true;
    setRecording(true);
    try {
      await recorder.start();
    } catch {
      recordingRef.current = false;
      setRecording(false);
      setMicFailed(true);
      setError(
        "The microphone is not available here: type the line and tap Say it to send it as a voice turn.",
      );
      return;
    }
    // A press longer than the relay carries is released for the human.
    autoRelease.current = setTimeout(() => void stopTalking(), VOICE_RELAY_MAX_MS);
  };

  const stopTalking = async () => {
    if (!recorder || !recordingRef.current) return;
    recordingRef.current = false;
    setRecording(false);
    if (autoRelease.current) clearTimeout(autoRelease.current);
    autoRelease.current = null;
    let recorded: Awaited<ReturnType<typeof recorder.stop>>;
    try {
      recorded = await recorder.stop();
    } catch (e) {
      setError(describeStateError(e));
      return;
    }
    if (recorded.pcm.length === 0) {
      setError("Nothing was recorded; hold the button while you speak.");
      return;
    }
    const seconds = Math.min(recorded.durationMs, VOICE_RELAY_MAX_MS) / 1000;
    await relayVoice({ recorded }, `Voice turn (${seconds.toFixed(1)} s)`);
  };

  const sayTyped = async () => {
    const words = text.trim();
    if (!words || busy) return;
    setError(null);
    setText("");
    await relayVoice({ transcript: words }, words);
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
      <div className="flex flex-wrap items-center gap-2" data-testid="m-voice">
        {canRecord ? (
          <Button
            variant={recording ? "danger" : "secondary"}
            onPointerDown={(e) => {
              e.preventDefault();
              void startTalking();
            }}
            onPointerUp={() => void stopTalking()}
            onPointerLeave={() => void stopTalking()}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                e.preventDefault();
                void startTalking();
              }
            }}
            onKeyUp={(e) => {
              if (e.key === " " || e.key === "Enter") void stopTalking();
            }}
            disabled={busy && !recording}
            aria-pressed={recording}
            data-testid="m-ptt"
          >
            {recording ? "Release to send" : "Hold to talk"}
          </Button>
        ) : (
          <Button
            onClick={() => void sayTyped()}
            disabled={busy || !text.trim()}
            data-testid="m-ptt-typed"
          >
            Say it
          </Button>
        )}
        <span className="text-xs text-neutral-500" data-testid="m-voice-mode">
          {canRecord
            ? `Push to talk: up to ${VOICE_RELAY_MAX_MS / 1000} s, answered by your PC's voice.`
            : "No microphone here: the typed line goes to your PC's voice loop."}
        </span>
      </div>
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
