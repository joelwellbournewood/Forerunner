import { describe, expect, it } from "vitest";
import { encodeInFrame, FrameReader, LineReader, STT_IN } from "../src/providers/local/framing.ts";

describe("framing", () => {
  it("encodes inbound frames with a kind byte and a little-endian length", () => {
    const f = encodeInFrame(STT_IN.audio, new Uint8Array([1, 2, 3]));
    expect(Array.from(f)).toEqual([0, 3, 0, 0, 0, 1, 2, 3]);
    expect(Array.from(encodeInFrame(STT_IN.endOfSpeech))).toEqual([1, 0, 0, 0, 0]);
  });

  it("reassembles outbound frames split across arbitrary byte boundaries", () => {
    const head = Buffer.alloc(9);
    head.writeUInt8(0, 0);
    head.writeUInt32LE(7, 1);
    head.writeUInt32LE(4, 5);
    const one = Buffer.concat([head, Buffer.from([9, 8, 7, 6])]);
    const two = Buffer.alloc(9);
    two.writeUInt8(1, 0);
    two.writeUInt32LE(7, 1);
    two.writeUInt32LE(0, 5);
    const all = Buffer.concat([one, two]);
    const reader = new FrameReader();
    const frames = [];
    for (let i = 0; i < all.length; i += 5) frames.push(...reader.push(all.subarray(i, i + 5)));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ kind: 0, id: 7 });
    expect(Array.from(frames[0]?.payload ?? [])).toEqual([9, 8, 7, 6]);
    expect(frames[1]).toMatchObject({ kind: 1, id: 7 });
  });

  it("splits JSON lines across chunks and tolerates CRLF", () => {
    const r = new LineReader();
    expect(r.push('{"a":1}\r\n{"b"')).toEqual(['{"a":1}']);
    expect(r.push(":2}\n\n")).toEqual(['{"b":2}']);
    expect(r.push('{"c":3}')).toEqual([]);
    expect(r.flush()).toEqual(['{"c":3}']);
  });
});
