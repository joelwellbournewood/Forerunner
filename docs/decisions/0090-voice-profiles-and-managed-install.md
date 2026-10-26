# 0090 — Voice profiles: none, cpu or gpu, installed into a managed venv per profile with pinned packages, verified on the device, switchable from setup, Settings and the CLI

Date: 2026-10-26
Status: accepted

## Context

ADR 0012 made the local voice helpers (`fr_stt.py` with faster-whisper, `fr_tts.py` with
Kokoro) Python processes found through `FORERUNNER_PYTHON` or the interpreters on `PATH`.
Nothing installed them: the human ran `pip install faster-whisper kokoro soundfile` into some
environment. On the human's Windows PC (an RTX card with its driver) the voice-run launcher
did exactly that, which gave a CPU-only PyTorch, and faster-whisper on device `auto` picked
CUDA and failed with "Library cublas64_12.dll is not found or cannot be loaded": ctranslate2
loads cuBLAS 12 at run time, pip puts the NVIDIA wheels' DLLs under
`site-packages/nvidia/*/bin`, and that folder is on no search path. The helper now falls back
to the CPU for `auto`, but the GPU was never usable and nothing said which device ran.

The human asked to choose voice support at install time, with three options (none, CPU, GPU),
each with its disk size and trade-off, the GPU detected and preferred when present, and the
choice changeable later from Settings and the CLI.

Inspected for this decision (2026-10-26): ctranslate2 4.8 wheels are built for CUDA 12 (PyPI
classifier 12.4); the Linux library links `libcublas.so.12` and not cuDNN; the Windows wheel
links `cublas64_12.dll` and bundles only the 266 KB `cudnn64_9.dll` loader, whose parts must
come from elsewhere. PyTorch 2.11.0+cu128 requires `nvidia-cudnn-cu12==9.19.0.56` and
`nvidia-cublas-cu12==12.8.4.1` (through `cuda-toolkit 12.8.1`) on Linux and bundles its own
cuBLAS and cuDNN DLLs on Windows. Kokoro 0.9.4 declares Python `>=3.10,<3.13` and, asked for
`device="cuda"` on a CPU-only torch, raises "CUDA requested but not available". espeak-ng
(Kokoro's phonemizer for English) keeps at most 159 characters of its data folder's path on
Linux (230 on Windows) and exits on the first sentence when the path is longer.

## Decision

1. **A voice profile: `none`, `cpu` or `gpu`**, stored in `<config>/voice.json` (beside
   `config.json`, which `runSetup` rewrites field by field) with what was installed and what
   the last check verified (device and compute type per side, and `fallback`: why the CPU
   stands in). No `voice.json` means "never chosen": the helpers behave as before profiles
   (whatever Python is found, device `auto`), so existing installs and voice-run homes keep
   working.
2. **One managed venv per profile** under the data directory, `<data>/voice/venv-cpu` and
   `<data>/voice/venv-gpu` (under `FORERUNNER_HOME/data` when that is set), and the models in
   `<data>/voice/models` (the helpers' `HF_HOME`, never the human's global cache). A switch
   builds the new venv beside the old one and deletes the old one only after the new one is
   verified, so a failed switch leaves voice working and a running helper's files are never
   rewritten (Windows locks loaded DLLs). The base interpreter is **Python 3.12**: the pinned
   numpy 2.5.4 declares `>=3.12` and kokoro 0.9.4 `<3.13`. It is found in a fixed order
   (`py -3.12`, `python`, `python3` on Windows; `python3.12`, `python3`, `python` on Linux) or
   given with `--python`; without one the install stops with the `winget` or `apt` line.
   **`FORERUNNER_PYTHON` wins in every case at run time**: with a profile installed the helpers
   use it with the profile's devices; with profile `none`, or a profile whose venv is gone, they
   run as before profiles (that interpreter, device `auto`) instead of reporting voice off. The
   install warns that the venv it makes will not be used.
3. **Hashed pins per profile in the repo, PyTorch apart** (`packages/voice/python`):
   - `torch-<profile>.txt`: `torch==2.11.0+cpu` / `+cu128` alone with the sha256 of its cp312
     Windows and Linux x86_64 wheels, installed with
     `--no-deps --require-hashes --index-url https://download.pytorch.org/whl/cpu|cu128`.
   - `requirements-<profile>.txt`: a universal lock (`uv pip compile --universal
     --generate-hashes`) of `requirements-<profile>.in` from PyPI only, installed with
     `--no-deps --require-hashes --index-url https://pypi.org/simple`. The `.in` holds the exact
     top-level pins (faster-whisper, ctranslate2, kokoro, misaki[en], transformers,
     huggingface-hub, soundfile, numpy, on gpu `nvidia-cublas-cu12` and `nvidia-cudnn-cu12`), the
     spaCy English model by URL with `#sha256=` (misaki otherwise pip-installs it at first use),
     and torch's own Requires-Dist copied from its wheel metadata (on gpu the CUDA 12.8 wheels
     and triton, Linux only), because torch is installed without its dependencies.
   - `pip.txt`: pip 26.2.2, hashed. `requires-python.json`: every pin's Requires-Python from the
     index metadata, which a unit test checks against the accepted Python offline.
   - `pnpm voice:lock` (`scripts/voice-lock.ts`, needs uv and the network) regenerates all of
     them. `pip check` runs after the install. pip gets no `PIP_EXTRA_INDEX_URL` or
     `PIP_FIND_LINKS` from the environment. A hash over the three files in the venv's marker
     decides whether pip runs again.
4. **The install is resumable and idempotent and streams progress.** Each step emits events
   (`step`, `log`, `progress` with bytes and total, `warning`, `error`, `result`). pip runs with
   `--progress-bar raw --resume-retries 5` and its cache; `fr_voice_models.py` fetches the
   models with byte progress and skips what is cached; the marker and `voice.json` are written
   only after their step succeeded, so running the install again finishes an interrupted one. A
   lock file keeps the CLI and the daemon from installing at the same time (a refusal names the
   lock file). No argument carries a secret (the models are public). The venv's espeak-ng data
   path is checked against the espeak-ng limit before anything is downloaded. A run can be
   cancelled: the daemon's job has an AbortController, reached by `POST /voice/install/cancel`
   and by the daemon's shutdown; the running process is killed and nothing is recorded.
5. **Verification runs the real helpers on the profile's device**: STT on 0.5 s of silence
   (`--device cuda --compute-type float16` on gpu, `cpu`/`int8` on cpu) and Kokoro on one
   sentence (`--device cuda|cpu`). The ready line and frame now say the device in use. On gpu
   the check runs without `--cpu-fallback` so a CUDA failure is seen; it then falls back
   loudly: a warning naming the error, the CPU checked instead, the reason recorded in
   `voice.json`, exit code 2 (0 done, 1 failed). At run time the gpu profile starts STT with
   `--cpu-fallback` and Kokoro with `--device cuda --cpu-fallback`; a side whose check fell back
   starts on the CPU directly. Kokoro on an explicit cuda synthesises one short sentence at
   start, so a CUDA error that torch raises only at the first matmul falls back there (loudly,
   with `--cpu-fallback`) instead of at the human's first sentence.
6. **CUDA libraries from pip wheels are made loadable by `fr_stt.py`** before ctranslate2 is
   imported: on Windows each `site-packages/nvidia/*/bin` goes to `os.add_dll_directory` and
   first on `PATH` (ctranslate2 loads cuBLAS with a plain `LoadLibrary`); on Linux cuBLAS and
   the cuDNN loader are loaded by absolute path with `RTLD_GLOBAL`, since `LD_LIBRARY_PATH` is
   read only at process start. A device other than the CPU also warms the model with a silent
   transcription, so a missing cuBLAS shows at load.
7. **Three ways in, one installer** (`packages/runtime/src/voice/install.ts`):
   `fr setup` asks (interactive) with each profile's size and trade-off and the detected GPU's
   profile as the default, or takes `--voice none|cpu|gpu` (non-interactive; without the flag
   nothing changes); `fr voice install [--cpu|--gpu] [--python <path>]`, `fr voice remove` and
   `fr voice status`; and Settings → Voice through `POST /voice/install` with the job's
   progress on `GET /voice/install/events` (SSE with the bearer header, or JSON). The daemon
   route was chosen over "run this command" because the human asked for a button and the
   installer already streams events: the route is a thin job wrapper (one job at a time,
   refused while a voice session is open, the helpers stopped right before an old venv is
   deleted). `scripts/voice-install.ts` (`pnpm voice:install`) is the same for the voice-run
   launcher, refusing without `FORERUNNER_HOME` as voice-run does.
8. **The daemon's local providers follow `voice.json` at every use** (`LocalVoice` in
   `local-profile.ts`): a change from the CLI or the card applies at the next voice session
   without a restart; the old helper processes are stopped. Profile `none` reports local voice
   unavailable with the way to turn it on; cloud providers are unaffected. `voice.json` is
   written atomically (a temporary file renamed over it) because a running daemon reads it.
9. **Live sessions are never cut by a switch.** `LocalVoice` counts the open STT sessions and
   the sentences being synthesised; while any is in use a changed `voice.json` waits and the old
   helpers keep serving, and the swap happens at the first use after they end. While an install
   runs, new local sessions and new sentences (read-aloud included) are refused with the reason;
   the install itself is refused while a voice session is open or local voice is in use. A
   disposed provider never starts its helper again (`FasterWhisperStt` / `KokoroTts`
   `ensureProcess` rejects after `dispose()`), so a session holding the old provider cannot
   respawn a helper from the old venv. A voice session using only cloud providers is not
   refused during an install: it does not touch the venv.

## Consequences

- Sizes shown to the human are measured: cpu about 2.3 GB on disk (Linux: 1.8 GB venv and
  0.45 GB models) and about 1 GB to download; gpu about 8 GB on disk and about 4.5 GB to
  download (torch 2.11.0+cu128 unpacks to 4.4 GB on Windows, cuBLAS 0.8 GB, cuDNN 1 GB). The
  human's estimate for gpu was 5 to 6 GB; the pinned wheels are larger.
- On Windows the CUDA torch wheel already carries cuBLAS and cuDNN; the separate NVIDIA wheels
  add about 1.7 GB there. They are kept as the human specified, so ctranslate2 does not depend
  on torch's packaging. Pointing `fr_stt.py` at `torch/lib` instead would save the space; a
  later decision can make that change once it has been tried on a GPU.
- Two venvs exist for a moment during a switch (disk for both). On Windows, a venv still held by
  a helper the CLI could not stop is left and removed at the next install, with a warning.
- A data directory whose path is too long for espeak-ng is refused with the reason;
  `FORERUNNER_HOME` has to be shorter there.
- The GPU path is unit-tested with fake processes and a stub faster-whisper; on hardware it is
  unverified until it runs on the human's PC (`fr voice install --gpu`, then
  `pnpm voice:run check`).
- Python 3.10 and 3.11 are refused: with them the pinned numpy would not install. Supporting
  them would need a second numpy pin behind a marker; one supported Python keeps the lock and
  the test small.
- Supply chain, what remains: every file pip installs is pinned by hash, PyTorch only from the
  PyTorch index and everything else only from PyPI, so a same-named package on another index
  cannot be picked. The trust is in those two indexes and in the hashes recorded when
  `pnpm voice:lock` ran (it trusts what the indexes served then; nobody reviews wheel
  contents). The lock is universal, so its hashes cover every platform's wheels, including
  macOS and aarch64 ones the installer never uses. The models from Hugging Face are fetched by
  name and revision `main`, not by hash; `fr_voice_models.py` could pin revisions later. The
  venv's own pip bootstrap (`ensurepip`) comes from the system Python.

## Alternatives considered

- **One venv, packages swapped in place.** Fewer gigabytes during a switch, but pip rewrites
  torch under a running helper (impossible on Windows while its DLLs are loaded) and a failed
  switch leaves neither profile working.
- **Bundling Python and the packages in the installer.** Far larger downloads for everyone
  including "none", a release per pin change, and per-OS packaging work; the managed venv uses
  the system Python the human already has or installs with one command.
- **Setting `PATH` / `LD_LIBRARY_PATH` for the helper process from Node.** Works on Windows for
  `PATH`, but every spawner (daemon, voice-run, tests) would need to know the venv's layout;
  doing it inside `fr_stt.py` keeps it next to the import that needs it, and on Linux the
  loader path cannot be changed after start anyway.
- **"Run this command" in Settings instead of a route.** Smaller, but the human asked for a
  button; the progress events made the route small.
- **Requirements files with `--extra-index-url` for PyTorch** (the first version of this
  decision). Simpler, but pip then takes any package from whichever index offers the best
  version, and nothing was hashed. Replaced by the torch-alone file and the PyPI-only lock.
- **A second numpy pin for Python 3.10 and 3.11.** Possible with markers; rejected for one
  supported Python (above).
