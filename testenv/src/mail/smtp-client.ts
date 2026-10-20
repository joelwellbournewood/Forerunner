/**
 * A minimal SMTP submission client over node:net (EHLO, AUTH PLAIN, MAIL, RCPT, DATA, QUIT).
 * Used by LocalMailServer.sendFrom so the server's own convenience path needs nothing beyond
 * node built-ins; tests also exercise the submission listener with nodemailer.
 */
import { createConnection, type Socket } from "node:net";
import { ForerunnerError } from "@forerunner/platform";
import { CRLF, toCrlf } from "./message.ts";

export interface SmtpSubmitOptions {
  host: string;
  port: number;
  /** Envelope sender (MAIL FROM). */
  from: string;
  /** Envelope recipients (RCPT TO). */
  to: string[];
  /** The raw message; line endings are normalised and dot-stuffed before sending. */
  raw: string;
  auth?: { user: string; pass: string };
  timeoutMs?: number;
  /** Name sent with EHLO. */
  clientName?: string;
}

export interface SmtpSubmitResult {
  /** The server's final reply to DATA, e.g. "250 OK: queued as 1234". */
  response: string;
}

interface SmtpReply {
  code: number;
  lines: string[];
  text: string;
}

class LineReader {
  private buffer = "";
  private waiting: Array<(line: string) => void> = [];
  private pending: string[] = [];
  private closed: Error | null = null;

  constructor(socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      let idx = this.buffer.indexOf(CRLF);
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + CRLF.length);
        const waiter = this.waiting.shift();
        if (waiter) waiter(line);
        else this.pending.push(line);
        idx = this.buffer.indexOf(CRLF);
      }
    });
    const fail = (err: Error) => {
      this.closed = err;
      for (const w of this.waiting.splice(0)) w(`\u0000${err.message}`);
    };
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("connection closed")));
  }

  line(): Promise<string> {
    const queued = this.pending.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise((resolveLine, reject) => {
      this.waiting.push((line) => {
        if (line.startsWith("\u0000")) reject(new Error(line.slice(1)));
        else resolveLine(line);
      });
    });
  }

  async reply(): Promise<SmtpReply> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.line();
      lines.push(line);
      if (!/^\d{3}-/.test(line)) break;
    }
    const last = lines[lines.length - 1] ?? "";
    return { code: Number(last.slice(0, 3)), lines, text: lines.join("\n") };
  }
}

function dotStuff(raw: string): string {
  const normalised = toCrlf(raw);
  const body = normalised.endsWith(CRLF) ? normalised : `${normalised}${CRLF}`;
  return body
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
}

/** Submit one message. Rejects with a ForerunnerError carrying the SMTP reply on refusal. */
export async function smtpSubmit(options: SmtpSubmitOptions): Promise<SmtpSubmitResult> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const socket = createConnection({ host: options.host, port: options.port });
  const reader = new LineReader(socket);
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("smtp timeout")));
  await new Promise<void>((resolveConnect, reject) => {
    socket.once("connect", resolveConnect);
    socket.once("error", reject);
  });

  const send = (line: string) =>
    new Promise<void>((resolveWrite, reject) => {
      socket.write(`${line}${CRLF}`, (err) => (err ? reject(err) : resolveWrite()));
    });
  const expect = async (ok: number[], step: string): Promise<SmtpReply> => {
    const reply = await reader.reply();
    if (!ok.includes(reply.code)) {
      socket.destroy();
      const code = reply.code === 535 || reply.code === 530 ? "provider_auth" : "validation";
      throw new ForerunnerError(code, `SMTP ${step} refused: ${reply.text}`, {
        details: { step, smtpCode: reply.code, response: reply.text },
      });
    }
    return reply;
  };

  try {
    await expect([220], "greeting");
    await send(`EHLO ${options.clientName ?? "forerunner.testenv"}`);
    await expect([250], "EHLO");
    if (options.auth) {
      const token = Buffer.from(
        `\u0000${options.auth.user}\u0000${options.auth.pass}`,
        "utf8",
      ).toString("base64");
      await send(`AUTH PLAIN ${token}`);
      await expect([235], "AUTH");
    }
    await send(`MAIL FROM:<${options.from}>`);
    await expect([250], "MAIL FROM");
    for (const rcpt of options.to) {
      await send(`RCPT TO:<${rcpt}>`);
      await expect([250, 251], "RCPT TO");
    }
    await send("DATA");
    await expect([354], "DATA");
    await send(`${dotStuff(options.raw)}.`);
    const final = await expect([250], "message");
    await send("QUIT");
    await reader.reply().catch(() => undefined);
    return { response: final.text };
  } finally {
    socket.end();
    socket.destroy();
  }
}
