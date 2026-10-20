import type { TransformContext, TransformResult } from "./types.ts";
import { unchanged } from "./types.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters by definition
const ANSI_SGR = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Lossless log collapsing: CRLF, ANSI, trailing spaces, progress bars, repeated lines, blank runs. */
export function collapseLogs(text: string, _ctx: TransformContext): TransformResult {
  try {
    if (!text) return unchanged(text);
    let out = text.replace(/\r\n/g, "\n").replace(ANSI_SGR, "");
    // Keep only the final segment of carriage-return progress lines.
    out = out
      .split("\n")
      .map((line) => (line.includes("\r") ? (line.split("\r").pop() ?? "") : line))
      .map((line) => line.replace(/[ \t]+$/g, ""))
      .join("\n");
    const lines = out.split("\n");
    const result: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      let j = i + 1;
      while (j < lines.length && lines[j] === line) j++;
      const run = j - i;
      if (run >= 3 && line.trim() !== "") {
        result.push(line, `... (repeated ${run} times)`);
      } else if (run >= 3) {
        result.push("");
      } else {
        for (let k = i; k < j; k++) result.push(line);
      }
      i = j;
    }
    out = result.join("\n").replace(/\n{3,}/g, "\n\n");
    return { text: out, changed: out !== text, note: out !== text ? "logs" : undefined };
  } catch {
    return unchanged(text);
  }
}
