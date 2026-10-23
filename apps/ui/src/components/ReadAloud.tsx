import type { SpeakView } from "@forerunner/runtime/daemon/api-types";
import { useEffect, useRef, useState } from "react";
import { ApiError, describeError } from "../api/client.ts";
import { type PlaybackOptions, playSpeech, type SpeechPlayback } from "../lib/speech.ts";
import { useClient } from "../store/context.tsx";
import { Button } from "./ui.tsx";

/** The sentences with a stable key each (a sentence may repeat within one text). */
function sentencesOf(view: SpeakView): Array<{ key: string; index: number; text: string }> {
  return view.sentences.map((text, index) => ({ key: `${index}:${text}`, index, text }));
}

function webSpeechAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined"
  );
}

/**
 * "Read aloud" (spec A.6 "readable aloud", L.6): the daemon reads the text through the voice
 * provider (`start` calls `POST /projects/:id/speak` or `POST /sessions/:id/speak`), this
 * follows the utterance and plays its frames, shows the text being read (the daemon echoes
 * it) and stops it with one click. When the daemon has no usable voice provider (503) the
 * browser's own speech synthesis reads `fallbackText` where it exists; otherwise the reason is
 * shown. The daemon's playback is the same path the voice loop's replies take.
 */
export function ReadAloud({
  start,
  fallbackText,
  testId = "read-aloud",
  playback,
}: {
  start: () => Promise<SpeakView>;
  fallbackText?: string;
  testId?: string;
  playback?: PlaybackOptions;
}) {
  const client = useClient();
  const [current, setCurrent] = useState<SpeakView | null>(null);
  const [sentence, setSentence] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [webSpeaking, setWebSpeaking] = useState(false);
  const playing = useRef<SpeechPlayback | null>(null);

  useEffect(() => {
    return () => {
      playing.current?.stop();
      if (webSpeechAvailable()) window.speechSynthesis.cancel();
    };
  }, []);

  const stop = async () => {
    const id = current?.id;
    playing.current?.stop();
    playing.current = null;
    setCurrent(null);
    setSentence(-1);
    if (webSpeaking && webSpeechAvailable()) {
      window.speechSynthesis.cancel();
      setWebSpeaking(false);
    }
    if (id) await client.cancelSpeak(id).catch(() => undefined);
  };

  const speakInBrowser = (text: string) => {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => setWebSpeaking(false);
    utterance.onerror = () => setWebSpeaking(false);
    setWebSpeaking(true);
    synth.speak(utterance);
  };

  const begin = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const view = await start();
      setCurrent(view);
      const pb = playSpeech(client, view.id, {
        ...(playback ?? {}),
        onSentence: (i) => {
          setSentence(i);
          playback?.onSentence?.(i);
        },
      });
      playing.current = pb;
      void pb.done.then(() => {
        if (playing.current !== pb) return;
        playing.current = null;
        setCurrent(null);
        setSentence(-1);
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 503 && fallbackText) {
        if (webSpeechAvailable()) {
          setNotice("Voice provider unavailable; using the browser's speech.");
          speakInBrowser(fallbackText);
        } else {
          setNotice(`Voice unavailable: ${error.message}`);
        }
      } else {
        setNotice(describeError(error));
      }
    } finally {
      setBusy(false);
    }
  };

  const reading = current !== null || webSpeaking;
  return (
    <span className="inline-flex flex-col items-end gap-1" data-testid={`${testId}-control`}>
      <Button
        onClick={() => (reading ? void stop() : void begin())}
        disabled={busy}
        title={reading ? "Stop reading" : "Read aloud through the voice provider"}
        data-testid={testId}
        aria-pressed={reading}
      >
        {reading ? "Stop reading" : "Read aloud"}
      </Button>
      {current ? (
        <span
          className="max-w-prose text-right text-xs text-neutral-600 dark:text-neutral-400"
          data-testid={`${testId}-text`}
          aria-live="polite"
        >
          {sentencesOf(current).map((item) => (
            <span
              key={item.key}
              className={
                item.index === sentence
                  ? "font-semibold text-neutral-900 dark:text-neutral-100"
                  : ""
              }
            >
              {item.text}{" "}
            </span>
          ))}
        </span>
      ) : null}
      {notice ? (
        <span
          className="text-xs text-amber-700 dark:text-amber-300"
          data-testid={`${testId}-notice`}
        >
          {notice}
        </span>
      ) : null}
    </span>
  );
}
