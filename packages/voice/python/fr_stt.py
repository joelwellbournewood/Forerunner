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

Device: --device auto|cpu|cuda with --compute-type. On a device other than the CPU the CUDA 12
libraries that pip installs as wheels (nvidia-cublas-cu12, nvidia-cudnn-cu12) are made
loadable first (setup_cuda_libraries), and the model is warmed with a short silent
transcription so a missing cuBLAS shows at load, not at the first utterance. The ready line
says which device and compute type are in use, and carries `fallback` when CUDA failed and the
CPU took over (device "auto", or an explicit device with --cpu-fallback).
"""

import argparse
import ctypes
import json
import os
import queue
import re
import site
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


CUDA_ERROR_MARKS = (
    "cublas",
    "cudnn",
    "cudart",
    "cannot be loaded",
    "no cuda-capable device",
    "cuda driver",
)


def is_cuda_runtime_error(e):
    """A GPU the runtime sees but cannot use (no cuBLAS / cuDNN / driver): the CPU still works.
    Out of memory on a working GPU is not one of them (transient; the GPU is kept)."""
    msg = str(e).lower()
    if "out of memory" in msg:
        return False
    return any(m in msg for m in CUDA_ERROR_MARKS)


CUDA_LIBRARY_FILE = re.compile(r"^lib(cublasLt|cublas|cudnn)\.so\.\d+$")


def nvidia_library_dirs(site_dirs, platform=None):
    """The library folders of the pip-installed NVIDIA wheels: site-packages/nvidia/<pkg>/bin
    on Windows (cublas64_12.dll, the cuDNN 9 parts), site-packages/nvidia/<pkg>/lib on Linux."""
    plat = platform or sys.platform
    sub = "bin" if plat == "win32" else "lib"
    out = []
    for base in site_dirs:
        root = os.path.join(base, "nvidia")
        if not os.path.isdir(root):
            continue
        for name in sorted(os.listdir(root)):
            d = os.path.join(root, name, sub)
            if os.path.isdir(d) and d not in out:
                out.append(d)
    return out


def default_site_dirs():
    dirs = []
    try:
        dirs.extend(site.getsitepackages())
    except Exception:
        pass
    try:
        dirs.append(site.getusersitepackages())
    except Exception:
        pass
    dirs.extend(p for p in sys.path if p.endswith("site-packages"))
    out = []
    for d in dirs:
        if d and d not in out:
            out.append(d)
    return out


def setup_cuda_libraries(site_dirs=None, platform=None, add_dll_directory=None, environ=None, preload=None):
    """Make the NVIDIA wheels' libraries loadable before ctranslate2 is imported.

    Windows: the DLLs sit under site-packages/nvidia/*/bin, which is on no search path, so
    ctranslate2 reports "Library cublas64_12.dll is not found or cannot be loaded". Each folder
    goes to os.add_dll_directory and first on PATH (ctranslate2 loads cuBLAS lazily with a
    plain LoadLibrary, which searches PATH). Linux: the loader reads LD_LIBRARY_PATH only at
    process start, so cuBLAS and the cuDNN loader (which opens its parts from its own folder)
    are loaded by absolute path instead; a later dlopen("libcublas.so.12") finds them loaded.
    Returns the folders used."""
    plat = platform or sys.platform
    dirs = nvidia_library_dirs(default_site_dirs() if site_dirs is None else site_dirs, plat)
    if not dirs:
        return []
    if plat == "win32":
        add = add_dll_directory if add_dll_directory is not None else getattr(os, "add_dll_directory", None)
        env = os.environ if environ is None else environ
        for d in dirs:
            if add is not None:
                try:
                    add(d)
                except OSError:
                    pass
        rest = [p for p in env.get("PATH", "").split(os.pathsep) if p and p not in dirs]
        env["PATH"] = os.pathsep.join(dirs + rest)
    else:
        load = preload if preload is not None else (lambda p: ctypes.CDLL(p, mode=ctypes.RTLD_GLOBAL))
        for d in dirs:
            for f in sorted(os.listdir(d)):
                if CUDA_LIBRARY_FILE.match(f):
                    try:
                        load(os.path.join(d, f))
                    except OSError:
                        pass
    return dirs


def _silence():
    import numpy as np

    return np.zeros(1600, dtype=np.float32)


class Transcriber:
    # device "auto" picks CUDA wherever ctranslate2 sees an NVIDIA GPU, even when the CUDA
    # libraries are missing; that fails at load or at the first transcription ("Library
    # cublas64_12.dll is not found"). With device "auto", or an explicit device and
    # cpu_fallback (the voice profile "gpu"), the helper then falls back to the CPU once and
    # says so on stderr and in `fallback`; an explicit device without cpu_fallback is kept.
    # `warm` runs a short silent transcription on a non-CPU device so the failure shows at load.
    def __init__(self, model_name, device, compute_type, language, beam_size, cpu_fallback=False, warm=False):
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self.beam_size = beam_size
        self.cpu_fallback = cpu_fallback
        self.fallback = None
        try:
            self.model = self._load(device, compute_type)
            if warm and device != "cpu":
                self._run(_silence(), False)
        except Exception as e:
            if not self._may_fall_back(e):
                raise
            self._fall_back(e)

    def _may_fall_back(self, e):
        if self.device == "cpu" or not is_cuda_runtime_error(e):
            return False
        return self.device == "auto" or self.cpu_fallback

    def _load(self, device, compute_type):
        from faster_whisper import WhisperModel

        return WhisperModel(self.model_name, device=device, compute_type=compute_type)

    def _fall_back(self, e):
        sys.stderr.write("fr_stt: CUDA failed on device %s: %s; falling back to the CPU (int8)\n" % (self.device, e))
        sys.stderr.flush()
        self.fallback = str(e)
        self.model = self._load("cpu", "int8")
        self.device = "cpu"
        self.compute_type = "int8"

    def resolved_device(self):
        """The device the model runs on: "auto" resolved when ctranslate2 says which."""
        inner = getattr(self.model, "model", None)
        dev = getattr(inner, "device", None)
        return dev if isinstance(dev, str) and dev else self.device

    def run(self, audio, sample_rate, final):
        try:
            return self._run(audio, final)
        except Exception as e:
            if not self._may_fall_back(e):
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
    ap.add_argument(
        "--cpu-fallback",
        action="store_true",
        help="with an explicit --device: fall back to the CPU when CUDA fails (said on stderr and in ready)",
    )
    ap.add_argument("--selftest", action="store_true", help="print ready without loading a model")
    args = ap.parse_args()

    if args.selftest:
        emit({"type": "ready", "model": None, "selftest": True})
        return 0

    if args.device != "cpu":
        setup_cuda_libraries()

    try:
        transcriber = Transcriber(
            args.model,
            args.device,
            args.compute_type,
            args.language,
            args.beam_size,
            cpu_fallback=args.cpu_fallback,
            warm=True,
        )
    except ImportError as e:
        emit({"type": "error", "message": "faster_whisper not importable: %s" % e})
        return 3
    except Exception as e:  # model download or load failure
        emit({"type": "error", "message": "model load failed: %s" % e})
        return 4

    ready = {
        "type": "ready",
        "model": args.model,
        "device": transcriber.resolved_device(),
        "compute_type": transcriber.compute_type,
    }
    if transcriber.fallback:
        ready["fallback"] = transcriber.fallback
    emit(ready)

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
