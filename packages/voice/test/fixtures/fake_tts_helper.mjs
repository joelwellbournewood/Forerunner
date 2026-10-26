// Stand-in for python/fr_tts.py: same binary framing, emits three 100 ms silence chunks per
// request at 24 kHz. A cancel frame marks the id so later chunks are skipped. A request with
// the text "CRASH" writes 50 numbered lines to stderr (`trace 001` ...) and exits with code 70,
// as a helper whose native code faults does after Python's faulthandler wrote its traceback.
const SAMPLE_RATE = 24000;
let buf = Buffer.alloc(0);
const cancelled = new Set();

function frame(kind, id, payload = Buffer.alloc(0)) {
  const head = Buffer.alloc(9);
  head.writeUInt8(kind, 0);
  head.writeUInt32LE(id, 1);
  head.writeUInt32LE(payload.length, 5);
  process.stdout.write(Buffer.concat([head, payload]));
}

frame(3, 0, Buffer.from(JSON.stringify({ sample_rate: SAMPLE_RATE, engine: "fake" })));

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
      const req = JSON.parse(payload.toString("utf8"));
      if (req.text === "CRASH") {
        const lines = [];
        for (let i = 1; i <= 50; i++) lines.push(`trace ${String(i).padStart(3, "0")}`);
        process.stderr.write(`${lines.join("\n")}\n`, () => process.exit(70));
        return;
      }
      if (req.text === "FAIL") {
        frame(2, req.id, Buffer.from("synthesis failed: scripted"));
        continue;
      }
      const chunk = Buffer.alloc(SAMPLE_RATE * 0.1 * 2);
      for (let i = 0; i < 3; i++) {
        if (cancelled.has(req.id)) break;
        frame(0, req.id, chunk);
      }
      frame(1, req.id);
    } else if (kind === 1) {
      cancelled.add(JSON.parse(payload.toString("utf8")).id);
    } else if (kind === 2) {
      process.exit(0);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
