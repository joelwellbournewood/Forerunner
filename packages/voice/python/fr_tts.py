#!/usr/bin/env python3
"""Forerunner local TTS helper: Kokoro over stdin/stdout, one long-lived process.

Protocol (see packages/voice/src/providers/local/framing.ts):
  stdin  frames: u8 kind | u32le length | payload
         kind 0 = request, payload JSON {"id":int,"text":str,"voice":str?,"speed":float?,"lang":str?}
         kind 1 = cancel,  payload JSON {"id":int}
         kind 2 = close
  stdout frames: u8 kind | u32le id | u32le length | payload
         kind 0 = audio (int16 little-endian mono PCM at the ready frame's sample rate)
         kind 1 = done
         kind 2 = error (utf-8 message)
         kind 3 = ready (id 0, payload JSON {"sample_rate":24000,"engine":"kokoro"})

Requests are served one after another in arrival order; a cancel for a running request stops
it between chunks. Exit code 3 means the kokoro package is not importable.
"""

import argparse
import json
import queue
import struct
import sys
import threading

KIND_REQUEST = 0
KIND_CANCEL = 1
KIND_CLOSE = 2

OUT_AUDIO = 0
OUT_DONE = 1
OUT_ERROR = 2
OUT_READY = 3

SAMPLE_RATE = 24000


def write_frame(kind, req_id, payload=b""):
    out = sys.stdout.buffer
    out.write(struct.pack("<BII", kind, req_id, len(payload)))
    if payload:
        out.write(payload)
    out.flush()


def read_exact(stream, n):
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def reader_thread(stream, q, cancelled, lock):
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
        if kind == KIND_CANCEL:
            try:
                rid = int(json.loads(payload.decode("utf-8")).get("id", -1))
            except Exception:
                rid = -1
            with lock:
                cancelled.add(rid)
            continue
        q.put((kind, payload))
        if kind == KIND_CLOSE:
            return


class KokoroEngine:
    def __init__(self, lang, default_voice):
        from kokoro import KPipeline

        self.pipeline = KPipeline(lang_code=lang)
        self.default_voice = default_voice

    def chunks(self, text, voice, speed):
        import numpy as np

        for _gs, _ps, audio in self.pipeline(text, voice=voice or self.default_voice, speed=speed or 1.0):
            if audio is None:
                continue
            arr = np.asarray(audio, dtype=np.float32)
            pcm = np.clip(arr * 32767.0, -32768, 32767).astype("<i2").tobytes()
            # Split long segments into ~100 ms pieces so playback can start early.
            step = int(SAMPLE_RATE * 0.1) * 2
            for i in range(0, len(pcm), step):
                yield pcm[i : i + step]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lang", default="a", help="kokoro language code (a=American English, b=British, ...)")
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--selftest", action="store_true", help="print ready without loading a model")
    args = ap.parse_args()

    if args.selftest:
        write_frame(OUT_READY, 0, json.dumps({"sample_rate": SAMPLE_RATE, "engine": "selftest"}).encode("utf-8"))
        return 0

    try:
        engine = KokoroEngine(args.lang, args.voice)
    except ImportError as e:
        write_frame(OUT_ERROR, 0, ("kokoro not importable: %s" % e).encode("utf-8"))
        return 3
    except Exception as e:
        write_frame(OUT_ERROR, 0, ("model load failed: %s" % e).encode("utf-8"))
        return 4

    write_frame(OUT_READY, 0, json.dumps({"sample_rate": SAMPLE_RATE, "engine": "kokoro"}).encode("utf-8"))

    q = queue.Queue()
    cancelled = set()
    lock = threading.Lock()
    t = threading.Thread(target=reader_thread, args=(sys.stdin.buffer, q, cancelled, lock), daemon=True)
    t.start()

    while True:
        kind, payload = q.get()
        if kind == KIND_CLOSE:
            return 0
        if kind != KIND_REQUEST:
            continue
        try:
            req = json.loads(payload.decode("utf-8"))
            rid = int(req["id"])
        except Exception as e:
            write_frame(OUT_ERROR, 0, ("bad request: %s" % e).encode("utf-8"))
            continue
        with lock:
            if rid in cancelled:
                cancelled.discard(rid)
                write_frame(OUT_DONE, rid)
                continue
        try:
            for pcm in engine.chunks(req.get("text", ""), req.get("voice"), req.get("speed")):
                with lock:
                    if rid in cancelled:
                        cancelled.discard(rid)
                        break
                write_frame(OUT_AUDIO, rid, pcm)
            write_frame(OUT_DONE, rid)
        except Exception as e:
            write_frame(OUT_ERROR, rid, ("synthesis failed: %s" % e).encode("utf-8"))


if __name__ == "__main__":
    sys.exit(main())
