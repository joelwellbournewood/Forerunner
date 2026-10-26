#!/usr/bin/env python3
"""Forerunner local STT helper: streaming-ish faster-whisper over stdin/stdout.

Protocol (see packages/voice/src/providers/local/framing.ts):
  stdin  frames: u8 kind | u32le length | payload
         kind 0 = audio (int16 little-endian mono PCM at --sample-rate)
         kind 1 = end of speech (transcribe everything, emit final)
         kind 2 = close (exit)
         kind 3 = reset (start a new utterance, drop buffered audio)
  stdout JSON lines:
         {"type":"ready","model":...}
         {"type":"partial","text":...,"at_ms":...}
         {"type":"final","text":...,"start_ms":...,"end_ms":...,"language":...}
         {"type":"error","message":...}

Partials are produced by re-transcribing the whole utterance every --partial-interval-ms of
new audio (faster-whisper has no true incremental mode); the final transcript is one pass
over the complete utterance. Exit code 3 means faster_whisper is not importable.
"""

import argparse
import json
import queue
import struct
import sys
import threading
import time

KIND_AUDIO = 0
KIND_END = 1
KIND_CLOSE = 2
KIND_RESET = 3


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def read_exact(stream, n):
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def reader_thread(stream, q):
    while True:
        head = read_exact(stream, 5)
        if head is None:
            q.put((KIND_CLOSE, b""))
            return
        kind, length = struct.unpack("<BI", head)
        payload = read_exact(stream, length) if length else b""
        if payload is None:
            q.put((KIND_CLOSE, b""))
            return
        q.put((kind, payload))
        if kind == KIND_CLOSE:
            return


def pcm_to_float(raw):
    import numpy as np

    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


CUDA_ERROR_MARKS = ("cublas", "cudnn", "cudart", "cuda")


def is_cuda_runtime_error(e):
    """A GPU the runtime sees but cannot use (no cuBLAS / cuDNN / driver): the CPU still works."""
    msg = str(e).lower()
    return any(m in msg for m in CUDA_ERROR_MARKS)


class Transcriber:
    # device "auto" picks CUDA wherever ctranslate2 sees an NVIDIA GPU, even when the CUDA
    # libraries are missing; that fails at load or at the first transcription ("Library
    # cublas64_12.dll is not found"). Either way the helper falls back to the CPU once.
    def __init__(self, model_name, device, compute_type, language, beam_size):
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.beam_size = beam_size
        try:
            self.model = self._load(device, compute_type)
        except Exception as e:
            if device == "cpu" or not is_cuda_runtime_error(e):
                raise
            self._fall_back(e)

    def _load(self, device, compute_type):
        from faster_whisper import WhisperModel

        return WhisperModel(self.model_name, device=device, compute_type=compute_type)

    def _fall_back(self, e):
        sys.stderr.write("fr_stt: %s; falling back to the CPU\n" % e)
        sys.stderr.flush()
        self.device = "cpu"
        self.compute_type = "int8"
        self.model = self._load("cpu", "int8")

    def run(self, audio, sample_rate, final):
        try:
            return self._run(audio, final)
        except Exception as e:
            if self.device == "cpu" or not is_cuda_runtime_error(e):
                raise
            self._fall_back(e)
            return self._run(audio, final)

    def _run(self, audio, final):
        if len(audio) == 0:
            return "", 0.0, 0.0, self.language
        segments, info = self.model.transcribe(
            audio,
            language=self.language,
            beam_size=self.beam_size if final else 1,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        texts = []
        start = None
        end = 0.0
        for seg in segments:
            texts.append(seg.text.strip())
            if start is None:
                start = seg.start
            end = seg.end
        return " ".join(t for t in texts if t), (start or 0.0), end, getattr(info, "language", self.language)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sample-rate", type=int, default=16000)
    ap.add_argument("--model", default="base")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--compute-type", default="default")
    ap.add_argument("--language", default=None)
    ap.add_argument("--beam-size", type=int, default=5)
    ap.add_argument("--partial-interval-ms", type=int, default=1000)
    ap.add_argument("--selftest", action="store_true", help="print ready without loading a model")
    args = ap.parse_args()

    if args.selftest:
        emit({"type": "ready", "model": None, "selftest": True})
        return 0

    try:
        transcriber = Transcriber(args.model, args.device, args.compute_type, args.language, args.beam_size)
    except ImportError as e:
        emit({"type": "error", "message": "faster_whisper not importable: %s" % e})
        return 3
    except Exception as e:  # model download or load failure
        emit({"type": "error", "message": "model load failed: %s" % e})
        return 4

    emit({"type": "ready", "model": args.model})

    q = queue.Queue()
    t = threading.Thread(target=reader_thread, args=(sys.stdin.buffer, q), daemon=True)
    t.start()

    buffered = bytearray()
    since_partial = 0
    bytes_per_ms = args.sample_rate * 2 / 1000.0
    partial_bytes = int(args.partial_interval_ms * bytes_per_ms)
    started = time.monotonic()

    def now_ms():
        return int((time.monotonic() - started) * 1000)

    while True:
        kind, payload = q.get()
        if kind == KIND_CLOSE:
            return 0
        if kind == KIND_RESET:
            buffered = bytearray()
            since_partial = 0
            continue
        if kind == KIND_AUDIO:
            buffered.extend(payload)
            since_partial += len(payload)
            # Only transcribe a partial when no newer audio is already waiting.
            if since_partial >= partial_bytes and q.empty():
                since_partial = 0
                try:
                    text, _s, _e, _lang = transcriber.run(pcm_to_float(bytes(buffered)), args.sample_rate, False)
                except Exception as e:
                    emit({"type": "error", "message": "partial failed: %s" % e})
                    continue
                if text:
                    emit({"type": "partial", "text": text, "at_ms": now_ms()})
            continue
        if kind == KIND_END:
            try:
                text, start, end, lang = transcriber.run(pcm_to_float(bytes(buffered)), args.sample_rate, True)
            except Exception as e:
                emit({"type": "error", "message": "final failed: %s" % e})
                buffered = bytearray()
                continue
            emit(
                {
                    "type": "final",
                    "text": text,
                    "start_ms": int(start * 1000),
                    "end_ms": int(end * 1000),
                    "language": lang,
                    "at_ms": now_ms(),
                }
            )
            buffered = bytearray()
            since_partial = 0


if __name__ == "__main__":
    sys.exit(main())
