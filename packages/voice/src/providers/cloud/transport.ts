/**
 * Injected transports for the cloud providers. Production uses `ws` and the global fetch;
 * tests inject fakes that replay captured-shaped messages. Keys travel only in headers set
 * here and are never part of a URL unless a provider explicitly opts in.
 */
import WebSocket from "ws";

export interface WsSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}

export interface WsConnectOptions {
  headers?: Record<string, string>;
  protocols?: string[];
}

export type WsFactory = (url: string, opts: WsConnectOptions) => WsSocket;

export interface HttpStreamRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface HttpStreamResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export type HttpStreamFn = (url: string, init: HttpStreamRequest) => Promise<HttpStreamResponse>;

/** WebSocket factory over the `ws` package. */
export function wsFactory(): WsFactory {
  return (url, opts) => {
    const sock = new WebSocket(url, opts.protocols ?? [], { headers: opts.headers ?? {} });
    return {
      send: (data) => sock.send(data),
      close: (code, reason) => {
        try {
          sock.close(code, reason);
        } catch {
          sock.terminate();
        }
      },
      onOpen: (cb) => sock.on("open", cb),
      onMessage: (cb) =>
        sock.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
          const buf = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data;
          cb(isBinary ? new Uint8Array(buf) : buf.toString("utf8"));
        }),
      onClose: (cb) =>
        sock.on("close", (code: number, reason: Buffer) => cb(code, reason.toString())),
      onError: (cb) => sock.on("error", cb),
    };
  };
}

/** Streaming HTTP over the global fetch (Node 22). */
export function fetchStream(): HttpStreamFn {
  return async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = res.body ?? emptyStream();
    return { status: res.status, headers, body: iterateBody(body) };
  };
}

async function* emptyStream(): AsyncGenerator<Uint8Array> {
  // nothing
}

async function* iterateBody(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  if (Symbol.asyncIterator in body) {
    for await (const chunk of body as AsyncIterable<Uint8Array>) yield chunk;
    return;
  }
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Resolves a secret reference name (e.g. "secret:deepgram_api_key") to its value. */
export type SecretResolver = (ref: string) => Promise<string | undefined>;

/** Collects the bytes of an HTTP body for error reporting, capped and never logged raw. */
export async function readBodyText(body: AsyncIterable<Uint8Array>, cap = 2000): Promise<string> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const c of body) {
    if (size >= cap) break;
    parts.push(c);
    size += c.byteLength;
  }
  return Buffer.concat(parts).toString("utf8").slice(0, cap);
}
