import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "../api/chat-stream.ts";
import { describeError, type VoiceSessionView } from "../api/client.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Badge, Button, INPUT_CLASS } from "../components/ui.tsx";
import { useClient, useIdentity, useRealtime, useUiState } from "../store/context.tsx";
import type { MicCapture } from "./voice-capture.ts";
import { useCaptureFactory } from "./voice-capture.ts";
import { followVoiceReply, type VoiceReplyPlayer } from "./voice-playback.ts";

/**
 * The conversation panel (spec O.1, ADR 0064): the global hotkey, the header's Talk button and
 * the palette open it. Each `voiceRequest` (a new number per hotkey press) toggles a
 * push-to-talk turn through the daemon's /voice routes: the first press opens a session in
 * push_to_talk mode, presses, and streams the microphone; the next press (or "Send") releases
 * and the turn's transcript and reply appear, the reply spoken as the daemon streams its audio
 * frames (`voice-playback.ts`, followed from the session's start until the panel closes). When voice is unavailable (no provider, no model
 * credential, no microphone) the panel says why and focuses the text input, which talks to
 * the same agent through /chat/stream.
 */

export type VoicePhase = "idle" | "starting" | "listening" | "waiting" | "unavailable";

interface Line {
  id: string;
  role: "human" | "agent";
  text: string;
  via: "voice" | "text";
  error?: string;
}

let counter = 0;
const nextId = () => `c${++counter}`;

/** How long to wait for a released turn to finish: 120 polls of 500 ms. */
const TURN_POLLS = 120;
const TURN_POLL_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function ConversationPanel({
  open,
  onClose,
  voiceRequest,
  chordLabel,
}: {
  open: boolean;
  onClose: () => void;
  /** Increments on every hotkey press (or Talk click); 0 opens without voice. */
  voiceRequest: number;
  /** The hotkey as it reads on this platform, null when there is none. */
  chordLabel: string | null;
}) {
  const client = useClient();
  const identity = useIdentity();
  const activeProjectId = useUiState((s) => s.activeProjectId);
  const captureFactory = useCaptureFactory();
  const realtime = useRealtime();
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [reason, setReason] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<VoiceSessionView | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  // Plays the session's reply audio (the daemon streams it; nothing else in the app plays it).
  const playerRef = useRef<VoiceReplyPlayer | null>(null);
  const phaseRef = useRef<VoicePhase>("idle");
  const turnsRef = useRef(0);
  // Bumped when the panel closes or unmounts: a turn that is still starting (status, session,
  // press, the microphone prompt) sees it after every await and undoes what it began, so the
  // microphone never stays on behind a closed panel.
  const epochRef = useRef(0);
  // The turn's audio posts, one after the other: the daemon appends chunks in arrival order and
  // drops audio that arrives after the release, so the release waits for this chain.
  const audioRef = useRef<Promise<void>>(Promise.resolve());

  const setPhaseBoth = useCallback((p: VoicePhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const focusInput = useCallback(() => {
    // After the dialog rendered.
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const unavailable = useCallback(
    (why: string) => {
      setReason(why);
      setPhaseBoth("unavailable");
      focusInput();
    },
    [focusInput, setPhaseBoth],
  );

  const startTurn = useCallback(async () => {
    const epoch = epochRef.current;
    const closed = () => epochRef.current !== epoch;
    setPhaseBoth("starting");
    setReason(null);
    const capture = captureFactory();
    if (!capture) {
      unavailable("voice is unavailable: this window cannot capture audio. Type instead.");
      return;
    }
    try {
      const status = await client.voiceStatus();
      if (closed()) return;
      if (!status.available) {
        unavailable(`voice is unavailable: ${status.reason}. Type instead.`);
        return;
      }
      let session = sessionRef.current;
      if (!session || session.endedAt) {
        session = await client.startVoiceSession({
          mode: "push_to_talk",
          ...(activeProjectId ? { projectId: activeProjectId } : {}),
        });
        if (closed()) {
          // The panel closed while the session started: nobody will use it.
          void client.stopVoiceSession(session.id).catch(() => {});
          return;
        }
        sessionRef.current = session;
      }
      if (playerRef.current?.sessionId !== session.id) {
        playerRef.current?.close();
        playerRef.current = followVoiceReply(client, session, {
          ...(realtime && "eventSource" in realtime ? { eventSource: realtime.eventSource } : {}),
          ...(realtime?.audio ? { audio: realtime.audio } : {}),
        });
      }
      turnsRef.current = session.turns;
      const id = session.id;
      await client.voicePress(id, true);
      // Closing stopped the session (it was in sessionRef by then); nothing else to undo.
      if (closed()) return;
      audioRef.current = Promise.resolve();
      try {
        await capture.start((chunk) => {
          if (closed()) return;
          audioRef.current = audioRef.current
            .then(() => client.voiceAudio(id, chunk))
            .then(
              () => {},
              () => {},
            );
        });
      } catch (error) {
        if (closed()) return;
        await client.voicePress(id, false).catch(() => {});
        unavailable(`the microphone is unavailable (${describeError(error)}). Type instead.`);
        return;
      }
      if (closed()) {
        // The microphone opened after the panel closed: turn it off at once.
        capture.stop();
        return;
      }
      captureRef.current = capture;
      setPhaseBoth("listening");
    } catch (error) {
      if (closed()) return;
      unavailable(`voice is unavailable: ${describeError(error)}. Type instead.`);
    }
  }, [activeProjectId, captureFactory, client, realtime, setPhaseBoth, unavailable]);

  const finishTurn = useCallback(async () => {
    const session = sessionRef.current;
    captureRef.current?.stop();
    captureRef.current = null;
    if (!session) {
      setPhaseBoth("idle");
      return;
    }
    setPhaseBoth("waiting");
    try {
      // Every chunk of the turn first: the daemon drops audio that arrives after the release.
      await audioRef.current;
      let view = await client.voicePress(session.id, false);
      for (let i = 0; i < TURN_POLLS; i++) {
        if (view.turns > turnsRef.current && view.state === "idle") break;
        await sleep(TURN_POLL_MS);
        if (phaseRef.current !== "waiting") return;
        view = await client.voiceSession(session.id);
      }
      sessionRef.current = view;
      const turn = view.turns > turnsRef.current ? view.lastTurn : null;
      turnsRef.current = view.turns;
      if (turn) {
        setLines((prev) => [
          ...prev,
          { id: nextId(), role: "human", text: turn.said || "(nothing heard)", via: "voice" },
          {
            id: nextId(),
            role: "agent",
            text: turn.heard || turn.reply?.reply || "",
            via: "voice",
            ...(turn.error ? { error: turn.error.message } : {}),
          },
        ]);
      }
      setPhaseBoth("idle");
    } catch (error) {
      setReason(describeError(error));
      setPhaseBoth("idle");
    }
  }, [client, setPhaseBoth]);

  // Every new request toggles: start a turn, or end the one that is listening.
  const lastRequest = useRef(0);
  useEffect(() => {
    if (!open || voiceRequest === 0 || voiceRequest === lastRequest.current) return;
    lastRequest.current = voiceRequest;
    const current = phaseRef.current;
    if (current === "listening") void finishTurn();
    else if (current === "idle" || current === "unavailable") void startTurn();
  }, [open, voiceRequest, startTurn, finishTurn]);

  // Closing ends the turn and the voice session.
  const endVoice = useCallback(() => {
    epochRef.current += 1;
    captureRef.current?.stop();
    captureRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    if (session && !session.endedAt) void client.stopVoiceSession(session.id).catch(() => {});
  }, [client]);

  const close = useCallback(() => {
    endVoice();
    setPhaseBoth("idle");
    setReason(null);
    onClose();
  }, [endVoice, onClose, setPhaseBoth]);

  // Unmounting (the shell goes away) ends the capture and the session like closing does.
  const endVoiceRef = useRef(endVoice);
  endVoiceRef.current = endVoice;
  useEffect(() => () => endVoiceRef.current(), []);

  const send = async (text: string) => {
    if (!identity || busy || !text.trim()) return;
    const agentLine = nextId();
    setLines((prev) => [
      ...prev,
      { id: nextId(), role: "human", text: text.trim(), via: "text" },
      { id: agentLine, role: "agent", text: "", via: "text" },
    ]);
    setBusy(true);
    try {
      const reply = await streamChat(
        client,
        {
          humanId: identity.humanId,
          agentId: identity.agentId,
          ...(activeProjectId ? { projectId: activeProjectId } : {}),
          text: text.trim(),
          source: "text",
        },
        {
          onToken: (_token, soFar) =>
            setLines((prev) => prev.map((l) => (l.id === agentLine ? { ...l, text: soFar } : l))),
        },
      );
      setLines((prev) => prev.map((l) => (l.id === agentLine ? { ...l, text: reply.reply } : l)));
    } catch (error) {
      const message = describeError(error);
      setLines((prev) => prev.map((l) => (l.id === agentLine ? { ...l, error: message } : l)));
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

  const phaseText: Record<VoicePhase, string> = {
    idle: chordLabel ? `Press ${chordLabel} or Talk to speak` : "Press Talk to speak",
    starting: "Starting voice…",
    listening: chordLabel ? `Listening… press ${chordLabel} or Send when done` : "Listening…",
    waiting: "Thinking…",
    unavailable: "Voice unavailable",
  };

  return (
    <Dialog open={open} onClose={close} title="Talk to your agent" testId="conversation" wide>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            tone={phase === "listening" ? "good" : phase === "unavailable" ? "warn" : "neutral"}
            testId="voice-phase"
          >
            {phaseText[phase]}
          </Badge>
          {phase === "listening" ? (
            <Button variant="primary" onClick={() => void finishTurn()} data-testid="voice-send">
              Send
            </Button>
          ) : (
            <Button
              onClick={() => void startTurn()}
              disabled={phase === "starting" || phase === "waiting"}
              data-testid="voice-talk"
            >
              Talk
            </Button>
          )}
        </div>
        {reason ? (
          <output
            className="block text-xs text-amber-800 dark:text-amber-300"
            data-testid="voice-reason"
          >
            {reason}
          </output>
        ) : null}
        <div
          className="max-h-80 min-h-[6rem] space-y-1 overflow-auto rounded border border-neutral-200 p-2 dark:border-neutral-800"
          data-testid="conversation-lines"
        >
          {lines.length === 0 ? (
            <p className="text-xs text-neutral-500">
              Speak or type: the same agent answers, with the same approval rules.
            </p>
          ) : null}
          {lines.map((l) => (
            <p key={l.id} data-testid={`conversation-${l.role}`} data-via={l.via}>
              <span className="font-semibold">{l.role === "human" ? "You" : "Agent"}:</span>{" "}
              {l.text}
              {l.error ? (
                <span className="text-red-700 dark:text-red-300"> ({l.error})</span>
              ) : null}
            </p>
          ))}
        </div>
        <form onSubmit={submit} className="flex gap-2">
          <input
            ref={inputRef}
            className={INPUT_CLASS}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type to your agent"
            aria-label="Message"
            data-testid="conversation-input"
          />
          <Button type="submit" disabled={busy || !identity || !input.trim()}>
            Send text
          </Button>
        </form>
      </div>
    </Dialog>
  );
}
