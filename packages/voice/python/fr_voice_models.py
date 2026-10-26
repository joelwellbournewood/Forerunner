#!/usr/bin/env python3
"""Forerunner voice install: download the local voice models with visible progress.

Run by `fr voice install` inside the managed venv, with HF_HOME pointing at the voice models
folder, before the helpers (fr_stt.py, fr_tts.py) are started to warm and verify them. The
helpers then load from that cache. Downloads already complete are not repeated, so a second
run (or a run after an interrupted one) only fetches what is missing.

  fr_voice_models.py --whisper base --kokoro-voice af_heart

stdout JSON lines:
  {"type":"start","what":"whisper"|"kokoro","repo":...}
  {"type":"progress","what":...,"bytes":n,"total":n|null}   about once a second while fetching
  {"type":"done","what":...,"bytes":n}
  {"type":"error","what":...,"message":...}
Exit 0 when both are present, 1 otherwise. Public models only: no token is read or needed.
"""

import argparse
import json
import os
import sys
import threading

KOKORO_REPO = "hexgrad/Kokoro-82M"
KOKORO_FILES = ["config.json", "kokoro-v1_0.pth"]


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def tree_bytes(path):
    """Bytes of the regular files under `path`, links not followed: the cache layout differs
    between huggingface_hub versions (per-repo blobs, shared blobs, xet chunks), so progress is
    the growth of the whole models folder while one model is fetched."""
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            p = os.path.join(root, f)
            try:
                if not os.path.islink(p):
                    total += os.path.getsize(p)
            except OSError:
                pass
    return total


def models_home():
    from huggingface_hub.constants import HF_HOME

    return HF_HOME


def repo_total(repo, files=None):
    """Expected bytes from the Hub's file list; None when it cannot be read."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo, files_metadata=True)
        sizes = [s.size or 0 for s in info.siblings if files is None or s.rfilename in files]
        return sum(sizes) or None
    except Exception:
        return None


def with_progress(what, repo, total, fetch):
    emit({"type": "start", "what": what, "repo": repo, "total": total})
    home = models_home()
    base = tree_bytes(home)
    stop = threading.Event()

    def tick():
        while not stop.wait(1.0):
            emit({"type": "progress", "what": what, "bytes": tree_bytes(home) - base, "total": total})

    t = threading.Thread(target=tick, daemon=True)
    t.start()
    try:
        fetch()
    finally:
        stop.set()
        t.join()
    emit({"type": "done", "what": what, "bytes": tree_bytes(home) - base})


def whisper_repo(model):
    try:
        from faster_whisper.utils import _MODELS

        return _MODELS.get(model, model)
    except Exception:
        return model


def fetch_whisper(model):
    from faster_whisper.utils import download_model

    repo = whisper_repo(model)
    with_progress("whisper", repo, repo_total(repo), lambda: download_model(model))


def fetch_kokoro(voice):
    from huggingface_hub import hf_hub_download

    files = KOKORO_FILES + ["voices/%s.pt" % voice]

    def fetch():
        for f in files:
            hf_hub_download(repo_id=KOKORO_REPO, filename=f)

    with_progress("kokoro", KOKORO_REPO, repo_total(KOKORO_REPO, files), fetch)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--whisper", default="base", help="faster-whisper model name")
    ap.add_argument("--kokoro-voice", default="af_heart")
    args = ap.parse_args()
    ok = True
    for what, fn, arg in (("whisper", fetch_whisper, args.whisper), ("kokoro", fetch_kokoro, args.kokoro_voice)):
        try:
            fn(arg)
        except Exception as e:
            ok = False
            emit({"type": "error", "what": what, "message": str(e)})
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
