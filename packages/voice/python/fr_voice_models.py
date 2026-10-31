#!/usr/bin/env python3
"""Forerunner voice install: download the local voice models with visible progress.

Run by `fr voice install` inside the managed venv, with HF_HOME pointing at the voice models
folder, before the helpers (fr_stt.py, fr_tts.py) are started to warm and verify them.
Downloads already complete are not repeated, so a second run (or a run after an interrupted
one) only fetches what is missing.

The speech recognition model goes into a plain folder of real files (--whisper-dir, U-024):
`download_model(..., output_dir=...)`, never the Hugging Face cache, whose snapshot entries are
links to blobs (or copies where Windows allows no links) and are skipped on a later run even
when an interrupted run left them broken. After the download the folder is checked (model.bin
and config.json present, real files, not empty, the size the Hub lists); a broken one is
deleted and fetched once more before the run reports a failure. What the check found is
written beside it (forerunner-model.json) so fr_stt.py can tell a short file without the
network, and the model's copy in the old cache (1.0.4) is removed once the folder is good.
Kokoro stays in the cache (HF_HOME) as before.

  fr_voice_models.py --whisper base --whisper-dir <models>/faster-whisper/base --kokoro-voice af_heart

stdout JSON lines:
  {"type":"start","what":"whisper"|"kokoro","repo":...}
  {"type":"progress","what":...,"bytes":n,"total":n|null}   about once a second while fetching
  {"type":"retry","what":"whisper","message":...}           a broken download, fetched once more
  {"type":"done","what":...,"bytes":n}
  {"type":"error","what":...,"message":...}
Exit 0 when both are present, 1 otherwise. Public models only: no token is read or needed.
"""

import argparse
import json
import os
import shutil
import sys
import threading

KOKORO_REPO = "hexgrad/Kokoro-82M"
KOKORO_FILES = ["config.json", "kokoro-v1_0.pth"]

# What a faster-whisper model folder needs to load (CTranslate2 opens model.bin, the tokenizer
# reads config.json); the other files download_model fetches are optional.
WHISPER_REQUIRED = ["model.bin", "config.json"]
# The check's record beside the model: {"repo": ..., "files": {name: bytes}}.
MODEL_MANIFEST = "forerunner-model.json"


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


def repo_sizes(repo):
    """{file name: bytes} from the Hub's file list; None when it cannot be read."""
    try:
        from huggingface_hub import HfApi

        info = HfApi().model_info(repo, files_metadata=True)
        return {s.rfilename: s.size for s in info.siblings if s.size is not None}
    except Exception:
        return None


def repo_total(repo, files=None):
    """Expected bytes from the Hub's file list; None when it cannot be read."""
    sizes = repo_sizes(repo)
    if not sizes:
        return None
    return sum(n for name, n in sizes.items() if files is None or name in files) or None


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


def file_problem(path, expected=None):
    """Why the speech library could not open this file, or None: a link (one that points
    nowhere, or any link: the folder holds real files), missing, not a file, empty, or not the
    size the Hub lists."""
    name = os.path.basename(path)
    if os.path.islink(path):
        if not os.path.exists(path):
            return "%s is a link to a file that is not there" % name
        return "%s is a link, not a file" % name
    if not os.path.exists(path):
        return "%s is missing" % name
    if not os.path.isfile(path):
        return "%s is not a file" % name
    size = os.path.getsize(path)
    if size == 0:
        return "%s is empty" % name
    if expected is not None and size != expected:
        return "%s has %d of %d bytes" % (name, size, expected)
    return None


def read_manifest(path):
    try:
        with open(os.path.join(path, MODEL_MANIFEST), encoding="utf-8") as f:
            files = json.load(f).get("files")
        return files if isinstance(files, dict) else None
    except Exception:
        return None


def model_dir_problem(path, expected=None):
    """Why the model folder cannot be loaded, or None. `expected`: {file: bytes} (the Hub's, or
    the manifest the last check wrote when none is given)."""
    sizes = expected if expected is not None else (read_manifest(path) or {})
    for name in WHISPER_REQUIRED:
        problem = file_problem(os.path.join(path, name), sizes.get(name))
        if problem:
            return problem
    return None


def write_manifest(path, repo):
    files = {}
    for name in sorted(os.listdir(path)):
        p = os.path.join(path, name)
        if name != MODEL_MANIFEST and os.path.isfile(p) and not os.path.islink(p):
            files[name] = os.path.getsize(p)
    tmp = os.path.join(path, MODEL_MANIFEST + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"repo": repo, "files": files}, f, indent=2)
    os.replace(tmp, os.path.join(path, MODEL_MANIFEST))


def hub_cache_dir(repo, home=None):
    """The model's folder in the Hugging Face cache under HF_HOME (where 1.0.4 put it)."""
    return os.path.join(home or models_home(), "hub", "models--" + repo.replace("/", "--"))


def download_whisper(model, path, expected=None, attempts=2, note=None):
    """Fetch the faster-whisper model into `path` as real files and check it. A broken result
    is deleted and fetched again, up to `attempts` downloads in all (the install: 2; fr_stt.py,
    which deleted the folder itself: 1); still broken, it raises with the reason."""
    from faster_whisper.utils import download_model

    repo = whisper_repo(model)
    problem = None
    for attempt in range(1, attempts + 1):
        download_model(model, output_dir=path)
        problem = model_dir_problem(path, expected)
        if problem is None:
            write_manifest(path, repo)
            return
        if attempt < attempts:
            if note:
                note(problem)
            shutil.rmtree(path, ignore_errors=True)
    raise RuntimeError(
        "the speech recognition model in %s cannot be opened after a fresh download: %s" % (path, problem)
    )


def fetch_whisper(model, path=None):
    from faster_whisper.utils import download_model

    repo = whisper_repo(model)
    if not path:
        # Without a folder (an older caller): the Hugging Face cache, as before.
        with_progress("whisper", repo, repo_total(repo), lambda: download_model(model))
        return
    sizes = repo_sizes(repo)
    expected = {k: v for k, v in (sizes or {}).items() if k in WHISPER_REQUIRED} or None

    def fetch():
        download_whisper(
            model,
            path,
            expected,
            attempts=2,
            note=lambda problem: emit({"type": "retry", "what": "whisper", "message": problem}),
        )

    with_progress("whisper", repo, repo_total(repo), fetch)
    # The folder is good: 1.0.4's copy in the cache is not used any more.
    shutil.rmtree(hub_cache_dir(repo), ignore_errors=True)


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
    ap.add_argument("--whisper-dir", default=None, help="plain folder the speech model goes to")
    ap.add_argument("--kokoro-voice", default="af_heart")
    args = ap.parse_args()
    ok = True
    steps = (
        ("whisper", lambda: fetch_whisper(args.whisper, args.whisper_dir)),
        ("kokoro", lambda: fetch_kokoro(args.kokoro_voice)),
    )
    for what, fn in steps:
        try:
            fn()
        except Exception as e:
            ok = False
            emit({"type": "error", "what": what, "message": str(e)})
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
