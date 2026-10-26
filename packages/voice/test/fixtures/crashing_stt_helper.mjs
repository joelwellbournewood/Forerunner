// Stand-in for python/fr_stt.py that crashes mid-transcription: the first `--crash-times`
// processes (counted in the file named by `--crash-file`) exit with `--crash-code` when the
// end-of-speech frame arrives, as faster-whisper did on Windows with an access violation
// (0xC0000005) under heavy CPU load. Later processes answer like fake_stt_helper.mjs.
// The ready line reports the device and compute type from argv as fr_stt.py does ("auto"
// resolves to "cpu": no GPU here). A decode frame (kind 4, JSON) sets the decode options of the
// current utterance until the next reset or final; `--record-file` gets one JSON line per final
// with this process's pid, device, compute type, decode options and audio bytes.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const crashFile = arg("--crash-file", "");
const crashTimes = Number(arg("--crash-times", "1"));
const crashCode = Number(arg("--crash-code", "70"));
// "end": at the end-of-speech frame; "audio": at the first audio frame, before the end of speech.
const crashAt = arg("--crash-at", "end");
// Die in the middle of a stdout line, as a process killed while it writes can.
const partialLine = process.argv.includes("--partial-line");
// Write this many numbered lines to stderr before dying (`trace 001` ...), as Python's
// faulthandler writes its traceback when native code faults.
const stderrLines = Number(arg("--stderr-lines", "0"));
const recordFile = arg("--record-file", "");
const requested = arg("--device", "auto");
const device = requested === "auto" ? "cpu" : requested;
const computeType = arg("--compute-type", "default");
const crashed = crashFile && existsSync(crashFile) ? Number(readFileSync(crashFile, "utf8")) : 0;
const willCrash = crashFile !== "" && crashed < crashTimes;
if (willCrash) writeFileSync(crashFile, String(crashed + 1));

let buf = Buffer.alloc(0);
let audioBytes = 0;
let partialSent = false;
let decode = null;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let dying = false;
function crash() {
  dying = true;
  if (stderrLines > 0) {
    const lines = [];
    for (let i = 1; i <= stderrLines; i++) lines.push(`trace ${String(i).padStart(3, "0")}`);
    process.stderr.write(`${lines.join("\n")}\n`, () => exitNow());
    return;
  }
  exitNow();
}

function exitNow() {
  if (partialLine) process.stdout.write('{"type":"partial","te', () => process.exit(crashCode));
  else process.exit(crashCode);
}

emit({ type: "ready", model: "fake", device, compute_type: computeType });

process.stdin.on("data", (d) => {
  if (dying) return;
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 5) break;
    const kind = buf.readUInt8(0);
    const len = buf.readUInt32LE(1);
    if (buf.length < 5 + len) break;
    const payload = buf.subarray(5, 5 + len);
    buf = buf.subarray(5 + len);
    if (kind === 0) {
      if (willCrash && crashAt === "audio") return crash();
      audioBytes += payload.length;
      if (!partialSent) {
        partialSent = true;
        emit({ type: "partial", text: "hello", at_ms: 10 });
      }
    } else if (kind === 1) {
      if (willCrash) return crash();
      if (recordFile)
        appendFileSync(
          recordFile,
          `${JSON.stringify({ pid: process.pid, device, computeType, decode, audioBytes })}\n`,
        );
      emit({
        type: "final",
        text: `hello world ${audioBytes}`,
        start_ms: 0,
        end_ms: Math.round(audioBytes / 32),
        language: "en",
        at_ms: 20,
      });
      audioBytes = 0;
      partialSent = false;
      decode = null;
    } else if (kind === 2) {
      process.exit(0);
    } else if (kind === 3) {
      audioBytes = 0;
      partialSent = false;
      decode = null;
    } else if (kind === 4) {
      decode = JSON.parse(payload.toString("utf8"));
    }
  }
});
process.stdin.on("end", () => process.exit(0));
