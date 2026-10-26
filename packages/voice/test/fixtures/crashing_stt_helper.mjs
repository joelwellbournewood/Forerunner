// Stand-in for python/fr_stt.py that crashes mid-transcription: the first `--crash-times`
// processes (counted in the file named by `--crash-file`) exit with `--crash-code` when the
// end-of-speech frame arrives, as faster-whisper did on Windows with an access violation
// (0xC0000005) under heavy CPU load. Later processes answer like fake_stt_helper.mjs.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

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
const crashed = crashFile && existsSync(crashFile) ? Number(readFileSync(crashFile, "utf8")) : 0;
const willCrash = crashFile !== "" && crashed < crashTimes;
if (willCrash) writeFileSync(crashFile, String(crashed + 1));

let buf = Buffer.alloc(0);
let audioBytes = 0;
let partialSent = false;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

let dying = false;
function crash() {
  dying = true;
  if (partialLine) process.stdout.write('{"type":"partial","te', () => process.exit(crashCode));
  else process.exit(crashCode);
}

emit({ type: "ready", model: "fake" });

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
    } else if (kind === 2) {
      process.exit(0);
    } else if (kind === 3) {
      audioBytes = 0;
      partialSent = false;
    }
  }
});
process.stdin.on("end", () => process.exit(0));
