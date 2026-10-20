// Stand-in for python/fr_stt.py: speaks the same framing and JSON-lines protocol, no model.
// Emits one partial after the first audio frame and a final naming the byte count on end.
let buf = Buffer.alloc(0);
let audioBytes = 0;
let partialSent = false;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

emit({ type: "ready", model: "fake" });

process.stdin.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    if (buf.length < 5) break;
    const kind = buf.readUInt8(0);
    const len = buf.readUInt32LE(1);
    if (buf.length < 5 + len) break;
    const payload = buf.subarray(5, 5 + len);
    buf = buf.subarray(5 + len);
    if (kind === 0) {
      audioBytes += payload.length;
      if (!partialSent) {
        partialSent = true;
        emit({ type: "partial", text: "hello", at_ms: 10 });
      }
    } else if (kind === 1) {
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
