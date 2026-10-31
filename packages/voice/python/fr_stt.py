#!/usr/bin/env python3
"""Forerunner local STT helper: streaming-ish faster-whisper over stdin/stdout.

Protocol (see packages/voice/src/providers/local/framing.ts):
  stdin  frames: u8 kind | u32le length | payload
         kind 0 = audio (int16 little-endian mono PCM at --sample-rate)
         kind 1 = end of speech (transcribe everything, emit final)
         kind 2 = close (exit)
         kind 3 = reset (start a new utterance, drop buffered audio)
         kind 4 = decode options for the current utterance, JSON {"beam_size":1,"temperature":[0]}
                  (partials and final; cleared by the next reset or final). The Node side
                  sends it when it retries an utterance whose helper crashed.
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

Crashes: faulthandler is on from the first line, so a fault in native code (an access
violation, 0xC0000005 on Windows, SIGSEGV elsewhere) writes the Python traceback of every
thread to stderr before the process dies; the Node side puts the stderr's last lines in its
crash warning and in the turn's error details.

All native work (model load, warm-up, every transcription) runs on the main thread, one call
at a time; the reader thread only reads stdin. The audio handed to faster-whisper is a fresh
float32 array copied out of the utterance buffer (pcm_to_float), which nothing else touches.

Model (U-024): with --model-dir the model is loaded from that plain folder of real files, where
the install put it (fr_voice_models.py); an install from before, whose folder holds no model
yet, loads --model by name from the Hugging Face cache as it did. A folder the last check's
record (forerunner-model.json) says is broken (a link, a missing or short file), or a model
CTranslate2 answers "Unable to open file" for, is deleted and fetched once more into the folder
before the load fails; the stderr line says so.
"""

import argparse
import ctypes
import faulthandler
import json
import math
import os
import queue
import re
import shutil
import site
import struct
import sys
import threading
import time

# Before anything loads native code (faster_whisper, ctranslate2 and numpy are imported later).
faulthandler.enable(file=sys.stderr, all_threads=True)

KIND_AUDIO = 0
KIND_END = 1
KIND_CLOSE = 2
KIND_RESET = 3
KIND_DECODE = 4


def parse_decode(payload):
    """A decode frame's options: {"beam_size": int >= 1, "temperature": a finite float >= 0 or a
    non-empty list of them}, both optional. Anything else is refused with ValueError."""
    try:
        raw = json.loads(payload.decode("utf-8"))
    except Exception as e:
        raise ValueError("not JSON: %s" % e)
    if not isinstance(raw, dict):
        raise ValueError("not an object")
    out = {}
    for key, value in raw.items():
        if key == "beam_size":
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError("beam_size must be an integer >= 1")
            out[key] = value
        elif key == "temperature":
            values = value if isinstance(value, list) else [value]
            # json reads NaN and Infinity: a temperature is a finite number >= 0.
            if not values or any(
                isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0
                for v in values
            ):
                raise ValueError("temperature must be a finite number >= 0 or a list of them")
            out[key] = [float(v) for v in values] if isinstance(value, list) else float(value)
        else:
            raise ValueError("unknown option %s" % key)
    return out


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


def model_source(model_name, model_dir):
    """The plain folder when it holds a model (a broken one included: it is fetched again), else
    the name, which faster-whisper resolves in the Hugging Face cache (an install from before)."""
    if model_dir and os.path.lexists(os.path.join(model_dir, "model.bin")):
        return model_dir
    return model_name


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
    def __init__(
        self,
        model_name,
        device,
        compute_type,
        language,
        beam_size,
        cpu_fallback=False,
        warm=False,
        model_dir=None,
    ):
        self.model_name = model_name
        self.model_dir = model_dir
        self.source = model_source(model_name, model_dir)
        self.refetched = False
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

        problem = self._folder_problem()
        if problem is None:
            try:
                return WhisperModel(self.source, device=device, compute_type=compute_type)
            except Exception as e:
                if not self._may_refetch(e):
                    raise
                problem = str(e)
        self._refetch(problem)
        return WhisperModel(self.source, device=device, compute_type=compute_type)

    def _folder_problem(self):
        """Why the plain model folder cannot be loaded as it is (a link, a missing, empty or short
        file against the install's record), checked before CTranslate2 opens it; None when it
        looks whole, after a refetch, or when the model is loaded by name."""
        if self.refetched or not self.model_dir or self.source != self.model_dir:
            return None
        from fr_voice_models import model_dir_problem

        return model_dir_problem(self.model_dir)

    def _may_refetch(self, e):
        return bool(self.model_dir) and not self.refetched and "unable to open file" in str(e).lower()

    def _refetch(self, problem):
        """Delete the model's folder and fetch it once more into it (U-024); a model loaded from
        the old cache that cannot be opened is fetched into the folder and its cache copy dropped.
        Raises when the fresh copy is still broken: the load then fails with that reason."""
        from fr_voice_models import WHISPER_REQUIRED, download_whisper, hub_cache_dir, repo_sizes, whisper_repo

        self.refetched = True
        sys.stderr.write(
            "fr_stt: the speech model cannot be opened (%s); fetching it once more into %s\n"
            % (problem, self.model_dir)
        )
        sys.stderr.flush()
        from_cache = self.source != self.model_dir
        shutil.rmtree(self.model_dir, ignore_errors=True)
        repo = whisper_repo(self.model_name)
        sizes = repo_sizes(repo) or {}
        expected = {k: v for k, v in sizes.items() if k in WHISPER_REQUIRED} or None
        download_whisper(self.model_name, self.model_dir, expected, attempts=1)
        if from_cache:
            shutil.rmtree(hub_cache_dir(repo), ignore_errors=True)
        self.source = self.model_dir

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

    def run(self, audio, sample_rate, final, decode=None):
        try:
            return self._run(audio, final, decode)
        except Exception as e:
            if not self._may_fall_back(e):
                raise
            self._fall_back(e)
            return self._run(audio, final, decode)

    def _run(self, audio, final, decode=None):
        """`decode` (from a decode frame, parse_decode) overrides the beam size of partials and
        final alike, and gives faster-whisper an explicit temperature list."""
        if len(audio) == 0:
            return "", 0.0, 0.0, self.language
        kwargs = {}
        beam_size = self.beam_size if final else 1
        if decode:
            beam_size = decode.get("beam_size", beam_size)
            if "temperature" in decode:
                kwargs["temperature"] = decode["temperature"]
        segments, info = self.model.transcribe(
            audio,
            language=self.language,
            beam_size=beam_size,
            vad_filter=False,
            condition_on_previous_text=False,
            **kwargs,
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
    ap.add_argument(
        "--model-dir",
        default=None,
        help="plain folder holding the model (the install's); fetched once more when it cannot be opened",
    )
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
            model_dir=args.model_dir,
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
    decode = None
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
            decode = None
            continue
        if kind == KIND_DECODE:
            try:
                decode = parse_decode(payload)
            except ValueError as e:
                emit({"type": "error", "message": "bad decode options: %s" % e})
            continue
        if kind == KIND_AUDIO:
            buffered.extend(payload)
            since_partial += len(payload)
            # Only transcribe a partial when no newer audio is already waiting.
            if since_partial >= partial_bytes and q.empty():
                since_partial = 0
                try:
                    text, _s, _e, _lang = transcriber.run(
                        pcm_to_float(bytes(buffered)), args.sample_rate, False, decode
                    )
                except Exception as e:
                    emit({"type": "error", "message": "partial failed: %s" % e})
                    continue
                if text:
                    emit({"type": "partial", "text": text, "at_ms": now_ms()})
            continue
        if kind == KIND_END:
            try:
                text, start, end, lang = transcriber.run(
                    pcm_to_float(bytes(buffered)), args.sample_rate, True, decode
                )
            except Exception as e:
                emit({"type": "error", "message": "final failed: %s" % e})
                buffered = bytearray()
                decode = None
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
            decode = None


if __name__ == "__main__":
    sys.exit(main())
