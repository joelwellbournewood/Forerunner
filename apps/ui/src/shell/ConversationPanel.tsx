import { type FormEvent, Fragment, useCallback, useEffect, useRef, useState } from "react";
import { streamChat } from "../api/chat-stream.ts";
import { describeError, type VoiceSessionView, type VoiceTurnView } from "../api/client.ts";
import { Dialog } from "../components/Dialog.tsx";
import { Badge, Button, INPUT_CLASS } from "../components/ui.tsx";
import type { AudioOutput } from "../lib/speech.ts";
import { useClient, useIdentity, useRealtime, useUiState, useUiStore } from "../store/context.tsx";
import type { VoiceReplyMode } from "../store/store.ts";
import type { MicCapture } from "./voice-capture.ts";
import { useCaptureFactory } from "./voice-capture.ts";
import {
  createVoiceOutput,
  followVoiceReply,
  type VoiceReplyPlayer,
  type VoiceStreamFrame,
} from "./voice-playback.ts";

/**
 * The conversation panel (spec O.1, ADR 0064): the global hotkey, the header's Talk button and
 * the palette open it. Each `voiceRequest` (a new number per hotkey press) toggles a
 * push-to-talk turn through the daemon's /voice routes: the first press opens a session in
 * push_to_talk mode, presses, and streams the microphone; the next press (or "Send") releases
 * and the turn's transcript and reply appear, the reply spoken as the daemon streams its audio
 * frames (`voice-playback.ts`, followed from the session's start until the panel closes). The
 * audio output is created and resumed synchronously when a turn starts (the Talk click, or the
 * hotkey press's render), before any await, and handed to the player; the release (Send or
 * the next press) tells the player to measure what the human hears of the reply. When voice is
 * unavailable (no provider, no model credential, no microphone) the panel says why and focuses
 * the text input, which talks to the same agent through /chat/stream.
 *
 * The text of a voice turn shows as it comes, from the frames of the same stream the player
 * follows (`onFrame`, each frame once whatever the reconnects): the human's words as the STT
 * recognises them (`transcript_partial`, then `transcript_final`), the reply as the model
 * generates it (`model_delta`; each finished `sentence` becomes its own span, the part of the
 * next one generated so far follows it), the sentence being heard marked (the player's
 * `onSpeaking`, when its first chunk starts at the speaker). When the reply is cut short
 * (a barge-in, a stop) its `turn_end` says what was heard and what was not: the unspoken part
 * is set apart and labelled; a text reply that was stopped says so. The turn's record
 * (`voice.turn`, or the polled session after the release) completes the lines and never adds
 * them twice (the lines of a voice turn are keyed by session and turn).
 *
 * "Reply: voice / text" (remembered per install, default voice) is sent with every press and
 * session start: in text the daemon calls no TTS and plays nothing, the reply streams as text
 * and the turn ends when it is complete. While a reply is generated or spoken Talk stays
 * available: the press is the barge-in (in text it stops the generation, as a typed stop does).
 */

export type VoicePhase = "idle" | "starting" | "listening" | "waiting" | "unavailable";

interface Line {
  id: string;
  role: "human" | "agent";
  text: string;
  via: "voice" | "text";
  error?: string;
  /** A voice turn's line: `<session>:<turn>:<role>`, so frames and the record update it. */
  key?: string;
  /** Human: the STT's partial transcript, not final yet. */
  partial?: boolean;
  /** Agent: the reply's finished sentences, by index (each its own span). */
  sentences?: string[];
  /** Agent: what the model generated after the last finished sentence. */
  tail?: string;
  /** Agent: the sentence being heard now. */
  speaking?: number | null;
  /** Agent: generated but never spoken (the reply was cut short); `text` is what was heard. */
  unspoken?: string;
  /** Agent: cut short with nothing left unspoken (a text reply stopped by a press). */
  stopped?: boolean;
  /** Agent: how the reply went out. */
  reply?: VoiceReplyMode;
  /** The turn's record has been applied. */
  done?: boolean;
}

/** The tail after a finished sentence: what follows it in the generated text. */
function consume(tail: string, sentence: string): string {
  const t = tail.replace(/\r\n?/g, "\n");
  const at = t.indexOf(sentence);
  return at < 0 ? "" : t.slice(at + sentence.length).trimStart();
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

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
  const uiStore = useUiStore();
  const replyMode = useUiState((s) => s.voiceReply);
  const replyRef = useRef<VoiceReplyMode>(replyMode);
  replyRef.current = replyMode;
  // Bumped by every turn start: a release still polling for its turn stops when a press
  // (a barge-in) started the next one.
  const waitRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sessionRef = useRef<VoiceSessionView | null>(null);
  const captureRef = useRef<MicCapture | null>(null);
  // Plays the session's reply audio (the daemon streams it; nothing else in the app plays it).
  const playerRef = useRef<VoiceReplyPlayer | null>(null);
  // An output made in the click or key handler, waiting for the session's player to take it.
  const outputRef = useRef<AudioOutput | null>(null);
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

  /** Update (or add at the end) the line of a voice turn's role. */
  const upsertTurnLine = useCallback(
    (sessionId: string, turn: number, role: Line["role"], patch: (l: Line | null) => Line | null) =>
      setLines((prev) => {
        const key = `${sessionId}:${turn}:${role}`;
        const at = prev.findIndex((l) => l.key === key);
        const next = patch(at < 0 ? null : (prev[at] as Line));
        if (!next) return prev;
        if (at < 0) return [...prev, { ...next, key }];
        const copy = [...prev];
        copy[at] = { ...next, key };
        return copy;
      }),
    [],
  );

  /** The turn's record (the `voice.turn` frame or the polled session): completes its lines. */
  const applyRecord = useCallback(
    (sessionId: string, turn: VoiceTurnView) => {
      upsertTurnLine(sessionId, turn.turn, "human", (l) =>
        l
          ? { ...l, text: turn.said || l.text || "(nothing heard)", partial: false, done: true }
          : {
              id: nextId(),
              role: "human",
              text: turn.said || "(nothing heard)",
              via: "voice",
              done: true,
            },
      );
      upsertTurnLine(sessionId, turn.turn, "agent", (l) => {
        const error = turn.error ? { error: turn.error.message } : {};
        if (l) return { ...l, ...error, reply: turn.replyMode, speaking: null, done: true };
        return {
          id: nextId(),
          role: "agent",
          text: turn.heard || turn.reply?.reply || "",
          via: "voice",
          reply: turn.replyMode,
          ...(turn.interrupted && turn.unspokenText ? { unspoken: turn.unspokenText } : {}),
          ...error,
          done: true,
        };
      });
    },
    [upsertTurnLine],
  );

  /** One frame of the session's stream: the text of its turns as it comes. */
  const onFrame = useCallback(
    (sessionId: string, f: VoiceStreamFrame) => {
      const turn = f.turn;
      if (turn === null) return;
      const data = (f.data ?? {}) as Record<string, unknown>;
      switch (f.type) {
        case "transcript_partial":
          upsertTurnLine(sessionId, turn, "human", (l) => {
            // A final line is never taken back to a partial.
            if (l && !l.partial) return null;
            return l
              ? { ...l, text: str(data.text) }
              : { id: nextId(), role: "human", text: str(data.text), via: "voice", partial: true };
          });
          return;
        case "transcript_final":
          upsertTurnLine(sessionId, turn, "human", (l) => ({
            ...(l ?? { id: nextId(), role: "human", via: "voice" }),
            text: str(data.text) || "(nothing heard)",
            partial: false,
          }));
          return;
        case "model_delta":
          upsertTurnLine(sessionId, turn, "agent", (l) => {
            const base: Line = l ?? {
              id: nextId(),
              role: "agent",
              text: "",
              via: "voice",
              sentences: [],
              tail: "",
              reply: replyRef.current,
            };
            if (base.done || base.unspoken !== undefined) return null;
            return { ...base, tail: (base.tail ?? "") + str(data.text) };
          });
          return;
        case "sentence": {
          const index = typeof data.index === "number" ? data.index : -1;
          const text = str(data.text);
          if (index < 0) return;
          upsertTurnLine(sessionId, turn, "agent", (l) => {
            const base: Line = l ?? {
              id: nextId(),
              role: "agent",
              text: "",
              via: "voice",
              sentences: [],
              tail: "",
              reply: replyRef.current,
            };
            if (base.done || base.unspoken !== undefined) return null;
            const sentences = [...(base.sentences ?? [])];
            sentences[index] = text;
            return { ...base, sentences, tail: consume(base.tail ?? "", text) };
          });
          return;
        }
        case "turn_end": {
          const entry = (data.entry ?? null) as { text?: unknown; interrupted?: unknown } | null;
          const latency = (data.latency ?? null) as { interrupted?: unknown } | null;
          const unspoken = str(data.unspokenText);
          const interrupted = latency?.interrupted === true || entry?.interrupted === true;
          const reply: VoiceReplyMode | undefined =
            data.replyMode === "text" || data.replyMode === "voice" ? data.replyMode : undefined;
          upsertTurnLine(sessionId, turn, "agent", (l) => {
            if (!l && !entry && !unspoken) return null;
            const base: Line = l ?? { id: nextId(), role: "agent", text: "", via: "voice" };
            const withMode = { ...base, speaking: null, ...(reply ? { reply } : {}) };
            if (unspoken) return { ...withMode, text: str(entry?.text), unspoken };
            if (interrupted) return { ...withMode, stopped: true };
            if (!withMode.sentences && entry) return { ...withMode, text: str(entry.text) };
            return withMode;
          });
          return;
        }
        case "voice.turn": {
          const record = (data as { record?: VoiceTurnView }).record;
          if (record) applyRecord(sessionId, record);
          return;
        }
        default:
          return;
      }
    },
    [applyRecord, upsertTurnLine],
  );

  const onSpeaking = useCallback(
    (sessionId: string, turn: number, sentenceIndex: number) =>
      upsertTurnLine(sessionId, turn, "agent", (l) =>
        l && !l.done && l.unspoken === undefined && !l.stopped
          ? { ...l, speaking: sentenceIndex }
          : null,
      ),
    [upsertTurnLine],
  );

  const startTurn = useCallback(async () => {
    waitRef.current += 1;
    const epoch = epochRef.current;
    const closed = () => epochRef.current !== epoch;
    // Before any await: a webview lets an AudioContext start only from the gesture's own task.
    // The session's player keeps its output; a new session gets the one made here.
    const keeps =
      playerRef.current !== null &&
      sessionRef.current !== null &&
      !sessionRef.current.endedAt &&
      playerRef.current.sessionId === sessionRef.current.id;
    // A press stops the reply this window still plays (the daemon's turn may already be over).
    playerRef.current?.interrupt();
    if (keeps) playerRef.current?.resume();
    else if (!outputRef.current) outputRef.current = createVoiceOutput(realtime?.audio);
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
          replyMode: replyRef.current,
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
        const output = outputRef.current ?? createVoiceOutput(realtime?.audio);
        outputRef.current = null;
        const sessionId = session.id;
        playerRef.current = followVoiceReply(client, session, {
          ...(realtime && "eventSource" in realtime ? { eventSource: realtime.eventSource } : {}),
          output,
          onFrame: (f) => onFrame(sessionId, f),
          onSpeaking: (turn, index) => onSpeaking(sessionId, turn, index),
          ...(realtime?.now ? { now: realtime.now } : {}),
        });
        // No EventSource: no player to own the output.
        if (!playerRef.current) void output?.close().catch(() => undefined);
      }
      turnsRef.current = session.turns;
      const id = session.id;
      // The reply mode goes with the press only when it changed since the session last said.
      const mode = replyRef.current;
      const pressedView = await client.voicePress(
        id,
        true,
        session.replyMode !== mode ? mode : undefined,
      );
      if (sessionRef.current?.id === id && pressedView?.replyMode) {
        sessionRef.current = { ...sessionRef.current, replyMode: pressedView.replyMode };
      }
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
  }, [
    activeProjectId,
    captureFactory,
    client,
    onFrame,
    onSpeaking,
    realtime,
    setPhaseBoth,
    unavailable,
  ]);

  const finishTurn = useCallback(async () => {
    // The release, as the human made it: what they hear of the reply is measured from here.
    playerRef.current?.turnEnded();
    const session = sessionRef.current;
    captureRef.current?.stop();
    captureRef.current = null;
    if (!session) {
      setPhaseBoth("idle");
      return;
    }
    setPhaseBoth("waiting");
    const wait = waitRef.current;
    // A press while the reply is generated or spoken (the barge-in) started the next turn.
    const superseded = () => waitRef.current !== wait || phaseRef.current !== "waiting";
    try {
      // Every chunk of the turn first: the daemon drops audio that arrives after the release.
      await audioRef.current;
      let view = await client.voicePress(session.id, false);
      for (let i = 0; i < TURN_POLLS; i++) {
        if (superseded()) return;
        if (view.turns > turnsRef.current && view.state === "idle") break;
        await sleep(TURN_POLL_MS);
        if (superseded()) return;
        view = await client.voiceSession(session.id);
      }
      if (superseded()) return;
      sessionRef.current = view;
      const turn = view.turns > turnsRef.current ? view.lastTurn : null;
      turnsRef.current = view.turns;
      // The stream usually showed the turn already; the record completes it (never twice).
      if (turn) applyRecord(session.id, turn);
      setPhaseBoth("idle");
    } catch (error) {
      if (superseded()) return;
      setReason(describeError(error));
      setPhaseBoth("idle");
    }
  }, [applyRecord, client, setPhaseBoth]);

  // Every new request toggles: start a turn, or end the one that is listening.
  const lastRequest = useRef(0);
  useEffect(() => {
    if (!open || voiceRequest === 0 || voiceRequest === lastRequest.current) return;
    lastRequest.current = voiceRequest;
    const current = phaseRef.current;
    if (current === "listening") void finishTurn();
    // While the reply is generated or spoken a press is the barge-in.
    else if (current === "idle" || current === "unavailable" || current === "waiting")
      void startTurn();
  }, [open, voiceRequest, startTurn, finishTurn]);

  // Closing ends the turn and the voice session.
  const endVoice = useCallback(() => {
    epochRef.current += 1;
    captureRef.current?.stop();
    captureRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    void outputRef.current?.close().catch(() => undefined);
    outputRef.current = null;
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
              disabled={phase === "starting"}
              data-testid="voice-talk"
              title={
                phase === "waiting"
                  ? replyMode === "text"
                    ? "Stop the reply and talk"
                    : "Interrupt the reply and talk"
                  : undefined
              }
            >
              Talk
            </Button>
          )}
          <Button
            onClick={() =>
              uiStore.dispatch({
                type: "voiceReply",
                mode: replyMode === "voice" ? "text" : "voice",
              })
            }
            aria-pressed={replyMode === "text"}
            title="How the agent replies to what you say: spoken, or as text only (no audio). Applies from your next turn."
            data-testid="voice-reply-mode"
          >
            Reply: {replyMode}
          </Button>
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
            <p
              key={l.id}
              data-testid={`conversation-${l.role}`}
              data-via={l.via}
              {...(l.partial ? { "data-partial": "true" } : {})}
              {...(l.reply ? { "data-reply": l.reply } : {})}
            >
              <span className="font-semibold">{l.role === "human" ? "You" : "Agent"}:</span>{" "}
              <LineText line={l} />
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

/**
 * A line's text: plain, or a voice reply's sentences (the one being heard marked) followed by
 * the part generated so far; a reply cut short shows what was heard, then what was not.
 */
function LineText({ line }: { line: Line }) {
  if (line.partial) return <span className="italic text-neutral-500">{line.text}…</span>;
  if (line.unspoken !== undefined) {
    return (
      <>
        {line.text ? <span>{line.text}</span> : null}{" "}
        <span
          className="text-neutral-500"
          data-testid="conversation-unspoken"
          title="Generated but not spoken: you interrupted the reply"
        >
          <span className="line-through decoration-neutral-400">{line.unspoken}</span>{" "}
          <span className="text-xs">(not spoken)</span>
        </span>
      </>
    );
  }
  const stopped = line.stopped ? (
    <span className="text-xs text-neutral-500" data-testid="conversation-stopped">
      {" "}
      (stopped)
    </span>
  ) : null;
  if (!line.sentences) {
    return (
      <>
        {line.text}
        {stopped}
      </>
    );
  }
  // Each sentence keeps its index from the stream (the audio frames' `sentenceIndex`).
  const sentences = line.sentences.flatMap((text, index) =>
    text === undefined ? [] : [{ index, text }],
  );
  const tail = line.tail ?? "";
  return (
    <>
      {sentences.map((s, n) => {
        const speaking = line.speaking === s.index;
        return (
          <Fragment key={s.index}>
            {n > 0 ? " " : null}
            <span
              {...(speaking ? { "data-speaking": "true" } : {})}
              className={speaking ? "rounded bg-amber-100 dark:bg-amber-900/40" : undefined}
            >
              {s.text}
            </span>
          </Fragment>
        );
      })}
      {tail ? (
        <span className="text-neutral-600 dark:text-neutral-400">
          {sentences.length > 0 ? " " : ""}
          {tail}
        </span>
      ) : null}
      {stopped}
    </>
  );
}
