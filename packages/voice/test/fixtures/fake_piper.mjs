// Stand-in for the piper binary: `node fake_piper.mjs --model <path> --output-raw ...` reads
// one line of text from stdin and writes raw 16-bit PCM at 22050 Hz, 50 ms per character.
import { existsSync } from "node:fs";

const args = process.argv.slice(2);
const modelIdx = args.indexOf("--model");
const model = modelIdx >= 0 ? args[modelIdx + 1] : null;
if (!model || !existsSync(model)) {
  process.stderr.write("fake piper: model not found\n");
  process.exit(1);
}
if (!args.includes("--output-raw")) {
  process.stderr.write("fake piper: expected --output-raw\n");
  process.exit(2);
}

let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  text += d;
});
process.stdin.on("end", () => {
  const chars = text.trim().length;
  const samples = Math.round(22050 * 0.05 * chars);
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) out.writeInt16LE(Math.round(Math.sin(i / 10) * 8000), i * 2);
  process.stdout.write(out, () => process.exit(0));
});
