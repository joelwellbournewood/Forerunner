/**
 * Tiny length-prefixed framing shared with the Python helpers.
 *
 * Node -> helper (stdin):   u8 kind | u32le length | payload
 * STT helper -> Node:       JSON lines (utf-8)
 * TTS helper -> Node:       u8 kind | u32le id | u32le length | payload
 */

/** STT frames; `decode` carries JSON decode options for the current utterance (fr_stt.py). */
export const STT_IN = { audio: 0, endOfSpeech: 1, close: 2, reset: 3, decode: 4 } as const;
export const TTS_IN = { request: 0, cancel: 1, close: 2 } as const;
export const TTS_OUT = { audio: 0, done: 1, error: 2, ready: 3 } as const;

export function encodeInFrame(kind: number, payload: Uint8Array = new Uint8Array(0)): Buffer {
  const out = Buffer.alloc(5 + payload.byteLength);
  out.writeUInt8(kind, 0);
  out.writeUInt32LE(payload.byteLength, 1);
  out.set(payload, 5);
  return out;
}

export interface OutFrame {
  kind: number;
  id: number;
  payload: Buffer;
}

/** Incremental parser for helper -> Node binary frames. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(data: Buffer): OutFrame[] {
    this.buf = this.buf.length === 0 ? Buffer.from(data) : Buffer.concat([this.buf, data]);
    const frames: OutFrame[] = [];
    for (;;) {
      if (this.buf.length < 9) break;
      const kind = this.buf.readUInt8(0);
      const id = this.buf.readUInt32LE(1);
      const len = this.buf.readUInt32LE(5);
      if (this.buf.length < 9 + len) break;
      frames.push({ kind, id, payload: Buffer.from(this.buf.subarray(9, 9 + len)) });
      this.buf = this.buf.subarray(9 + len);
    }
    return frames;
  }
}

/** Incremental line splitter for JSON-lines output (CRLF tolerant). */
export class LineReader {
  private rest = "";

  push(data: Buffer | string): string[] {
    this.rest += typeof data === "string" ? data : data.toString("utf8");
    const parts = this.rest.split(/\r?\n/);
    this.rest = parts.pop() ?? "";
    return parts.filter((l) => l.trim().length > 0);
  }

  flush(): string[] {
    const r = this.rest.trim();
    this.rest = "";
    return r ? [r] : [];
  }
}
