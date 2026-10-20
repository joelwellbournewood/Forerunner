/**
 * The agent's own mailbox (S.15): read, watch, send, draft, mark seen. Two implementations:
 *
 * - ImapSmtpMailbox over imapflow and nodemailer. Credentials are secret references resolved
 *   from the vault at call time through the runtime's SecretsPort; a value never sits on the
 *   instance, in a log line or in a thrown error. `watch` uses IMAP IDLE push (imapflow's
 *   "exists" event) and a polling fallback at the configured interval (T.2).
 * - TestMailbox over the testenv LocalMailServer (structurally typed, so this file does not
 *   import the test package): sends through the real submission listener on 127.0.0.1 (plain
 *   text, loopback only: `loopbackSmtpFactory`) and reads the delivered copies with the
 *   server's push notification. The production factory never sends in the clear.
 *
 * Every inbound message goes through parseInboundEmail (inbound.ts): wrapped as untrusted data,
 * scanned for injection, links and attachments as references only.
 */
import { type Clock, ForerunnerError, log, newId } from "@forerunner/platform";
import type { SecretsPort } from "@forerunner/runtime";
import MailComposer from "nodemailer/lib/mail-composer";
import { domainOf } from "./auth.ts";
import { type InboundEmail, normalizeMessageId, parseInboundEmail } from "./inbound.ts";
import type { MailboxConfig } from "./types.ts";

const logger = log("capabilities:email:mailbox");

export interface OutboundMessage {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
  /** Pre-assigned Message-ID (without angle brackets); generated when absent. */
  messageId?: string;
  headers?: Record<string, string>;
}

export interface SendReceipt {
  messageId: string;
  raw: string;
}

export interface DraftReceipt {
  draftId: string;
  raw: string;
}

export interface MailboxWatch {
  stop(): Promise<void>;
  /** True while the push connection is alive; polling runs regardless. */
  readonly pushActive: boolean;
}

export interface WatchOptions {
  pollIntervalMs?: number;
  /** Deliver mail already unseen when the watch starts (default true). */
  catchUp?: boolean;
}

export type InboundHandler = (message: InboundEmail) => Promise<void> | void;

export interface Mailbox {
  readonly address: string;
  listUnseen(opts?: { limit?: number }): Promise<InboundEmail[]>;
  fetch(id: string): Promise<InboundEmail | undefined>;
  watch(onMessage: InboundHandler, opts?: WatchOptions): Promise<MailboxWatch>;
  send(message: OutboundMessage): Promise<SendReceipt>;
  saveDraft(message: OutboundMessage): Promise<DraftReceipt>;
  markSeen(id: string): Promise<void>;
}

/** Build the raw RFC 5322 message with nodemailer's composer; CRLF line endings. */
export async function buildOutboundRaw(
  from: string,
  message: OutboundMessage,
  now: number,
): Promise<SendReceipt> {
  const messageId = normalizeMessageId(
    message.messageId ?? `${newId(now)}@${domainOf(from) || "forerunner.local"}`,
  );
  const composer = new MailComposer({
    from,
    to: message.to,
    cc: message.cc,
    subject: message.subject,
    text: message.text,
    date: new Date(now),
    messageId: `<${messageId}>`,
    inReplyTo: message.inReplyTo ? `<${normalizeMessageId(message.inReplyTo)}>` : undefined,
    references: message.references?.map((r) => `<${normalizeMessageId(r)}>`).join(" "),
    headers: message.headers,
  });
  const built = await composer.compile().build();
  return { messageId, raw: built.toString("utf8").replace(/\r\n|\n|\r/g, "\r\n") };
}

export function recipientsOf(message: OutboundMessage): string[] {
  return [...message.to, ...(message.cc ?? [])].map((a) => a.trim().toLowerCase());
}

/** Repeating timer on a Clock; returns a cancel function. */
export function pollLoop(clock: Clock, intervalMs: number, fn: () => Promise<void>): () => void {
  let cancelled = false;
  let cancelTimer: (() => void) | null = null;
  const schedule = () => {
    if (cancelled) return;
    cancelTimer = clock.setTimeout(() => {
      fn()
        .catch((e: unknown) => logger.warn("poll failed", { error: String(e) }))
        .finally(schedule);
    }, intervalMs);
  };
  schedule();
  return () => {
    cancelled = true;
    cancelTimer?.();
  };
}

// ---------------------------------------------------------------------------------------------
// IMAP + SMTP

export interface ImapClientLike {
  connect(): Promise<void>;
  logout(): Promise<void>;
  mailboxOpen(path: string): Promise<unknown>;
  search(
    query: { seen?: boolean; all?: boolean },
    options: { uid: boolean },
  ): Promise<number[] | false | undefined>;
  fetchAll(
    range: number[] | string,
    query: { uid: boolean; source: boolean; flags: boolean; internalDate: boolean },
    options: { uid: boolean },
  ): Promise<
    Array<{ uid: number; source?: Buffer; flags?: Set<string>; internalDate?: Date | string }>
  >;
  messageFlagsAdd(
    range: number[] | string,
    flags: string[],
    options: { uid: boolean },
  ): Promise<boolean>;
  append(path: string, content: string, flags?: string[]): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  readonly usable?: boolean;
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

export type ImapFactory = (opts: ImapConnectOptions) => Promise<ImapClientLike>;

export interface SmtpTransportLike {
  sendMail(mail: { envelope: { from: string; to: string[] }; raw: string }): Promise<unknown>;
  close?(): void;
}

export interface SmtpConnectOptions {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
}

export type SmtpFactory = (opts: SmtpConnectOptions) => Promise<SmtpTransportLike>;

export const defaultImapFactory: ImapFactory = async (opts) => {
  const { ImapFlow } = await import("imapflow");
  return new ImapFlow({ ...opts, logger: false }) as unknown as ImapClientLike;
};

/**
 * The production SMTP transport. `secure` is implicit TLS (port 465); otherwise STARTTLS is
 * mandatory (`requireTLS`): a server that does not offer it gets neither the password nor the
 * message. Never `ignoreTLS`, whatever the host.
 */
export const defaultSmtpFactory: SmtpFactory = async (opts) => {
  const nodemailer = await import("nodemailer");
  return nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: opts.secure,
    ...(opts.secure ? {} : { requireTLS: true }),
    ...(opts.auth ? { auth: opts.auth } : {}),
  }) as unknown as SmtpTransportLike;
};

/** The loopback interface by name or literal address (IPv4, IPv6, bracketed IPv6). */
export function isLoopbackHost(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * Plaintext SMTP for the testenv submission listener, which disables STARTTLS. Only the
 * loopback interface is accepted; any other host is refused before a socket is opened. Used
 * by TestMailbox, never by ImapSmtpMailbox.
 */
export const loopbackSmtpFactory: SmtpFactory = async (opts) => {
  if (!isLoopbackHost(opts.host)) {
    throw new ForerunnerError(
      "validation",
      `plaintext SMTP is allowed on the loopback interface only, not ${opts.host}`,
    );
  }
  const nodemailer = await import("nodemailer");
  return nodemailer.createTransport({
    host: opts.host,
    port: opts.port,
    secure: false,
    ignoreTLS: true,
    ...(opts.auth ? { auth: opts.auth } : {}),
  }) as unknown as SmtpTransportLike;
};

/**
 * What the mailbox needs from the vault: resolve `secret:<name>` references to values at call
 * time and scrub those values out of any text. The runtime's SecretsPort and the vault's
 * SecretResolver both satisfy it.
 */
export type MailboxSecrets = Pick<SecretsPort, "resolve" | "redact">;

export interface ImapSmtpMailboxDeps {
  config: MailboxConfig;
  secrets: MailboxSecrets;
  /** Secret names (without "secret:") this mailbox may resolve. */
  granted: ReadonlySet<string>;
  clock: Clock;
  createImap?: ImapFactory;
  createTransport?: SmtpFactory;
  maxAttachmentBytes?: number;
}

export class ImapSmtpMailbox implements Mailbox {
  readonly address: string;
  private readonly createImap: ImapFactory;
  private readonly createTransport: SmtpFactory;

  constructor(private readonly deps: ImapSmtpMailboxDeps) {
    this.address = deps.config.address;
    this.createImap = deps.createImap ?? defaultImapFactory;
    this.createTransport = deps.createTransport ?? defaultSmtpFactory;
  }

  private async password(ref: string): Promise<string> {
    const resolved = (await this.deps.secrets.resolve({ pass: ref }, this.deps.granted)) as {
      pass: unknown;
    };
    if (typeof resolved.pass !== "string" || resolved.pass.length === 0) {
      throw new ForerunnerError("provider_auth", "mailbox credential did not resolve to a value");
    }
    return resolved.pass;
  }

  private async openImap(): Promise<{ client: ImapClientLike; folder: string; drafts: string }> {
    const imap = this.deps.config.imap;
    if (!imap) throw new ForerunnerError("validation", "mailbox has no IMAP configuration");
    const pass = await this.password(imap.passwordRef);
    const client = await this.createImap({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user, pass },
    });
    try {
      await client.connect();
    } catch (e) {
      throw new ForerunnerError("provider_auth", "IMAP connection failed", {
        details: { host: imap.host, port: imap.port },
        cause: this.deps.secrets.redact(e instanceof Error ? e.message : String(e)),
      });
    }
    return { client, folder: imap.folder, drafts: imap.draftsFolder };
  }

  /**
   * Errors from the mail libraries may echo connection details; anything that is not already
   * a ForerunnerError is rewrapped with its message scrubbed of resolved secret values.
   */
  private scrub(e: unknown, what: string): ForerunnerError {
    if (e instanceof ForerunnerError) return e;
    const message = e instanceof Error ? e.message : String(e);
    return new ForerunnerError("provider_error", `${what}: ${this.deps.secrets.redact(message)}`, {
      retryable: true,
    });
  }

  private async withImap<T>(
    fn: (client: ImapClientLike, folder: string, drafts: string) => Promise<T>,
  ): Promise<T> {
    const { client, folder, drafts } = await this.openImap();
    try {
      return await fn(client, folder, drafts);
    } catch (e) {
      throw this.scrub(e, "IMAP operation failed");
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  private async fetchUids(client: ImapClientLike, uids: number[]): Promise<InboundEmail[]> {
    if (uids.length === 0) return [];
    const rows = await client.fetchAll(
      uids,
      { uid: true, source: true, flags: true, internalDate: true },
      { uid: true },
    );
    const out: InboundEmail[] = [];
    for (const row of rows) {
      if (!row.source) continue;
      const received =
        row.internalDate instanceof Date
          ? row.internalDate.toISOString()
          : typeof row.internalDate === "string"
            ? new Date(row.internalDate).toISOString()
            : this.deps.clock.nowIso();
      out.push(
        await parseInboundEmail(
          row.source.toString("utf8"),
          { id: String(row.uid), receivedAt: received },
          { maxAttachmentBytes: this.deps.maxAttachmentBytes },
        ),
      );
    }
    return out;
  }

  private async unseenUids(client: ImapClientLike, folder: string): Promise<number[]> {
    await client.mailboxOpen(folder);
    const found = await client.search({ seen: false }, { uid: true });
    return Array.isArray(found) ? found : [];
  }

  async listUnseen(opts: { limit?: number } = {}): Promise<InboundEmail[]> {
    return this.withImap(async (client, folder) => {
      const uids = await this.unseenUids(client, folder);
      const slice = opts.limit !== undefined ? uids.slice(-opts.limit) : uids;
      return this.fetchUids(client, slice);
    });
  }

  async fetch(id: string): Promise<InboundEmail | undefined> {
    const uid = Number(id);
    if (!Number.isInteger(uid) || uid <= 0) return undefined;
    return this.withImap(async (client, folder) => {
      await client.mailboxOpen(folder);
      const [message] = await this.fetchUids(client, [uid]);
      return message;
    });
  }

  async markSeen(id: string): Promise<void> {
    const uid = Number(id);
    if (!Number.isInteger(uid) || uid <= 0) return;
    await this.withImap(async (client, folder) => {
      await client.mailboxOpen(folder);
      await client.messageFlagsAdd([uid], ["\\Seen"], { uid: true });
    });
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const smtp = this.deps.config.smtp;
    if (!smtp) throw new ForerunnerError("validation", "mailbox has no SMTP configuration");
    const receipt = await buildOutboundRaw(this.address, message, this.deps.clock.now());
    const pass = await this.password(smtp.passwordRef);
    const transport = await this.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass },
    });
    try {
      await transport.sendMail({
        envelope: { from: this.address, to: recipientsOf(message) },
        raw: receipt.raw,
      });
    } catch (e) {
      throw new ForerunnerError("provider_error", "SMTP submission failed", {
        details: { host: smtp.host, port: smtp.port },
        cause: this.deps.secrets.redact(e instanceof Error ? e.message : String(e)),
        retryable: true,
      });
    } finally {
      transport.close?.();
    }
    return receipt;
  }

  async saveDraft(message: OutboundMessage): Promise<DraftReceipt> {
    const receipt = await buildOutboundRaw(this.address, message, this.deps.clock.now());
    await this.withImap(async (client, _folder, drafts) => {
      await client.append(drafts, receipt.raw, ["\\Draft"]);
    });
    return { draftId: receipt.messageId, raw: receipt.raw };
  }

  async watch(onMessage: InboundHandler, opts: WatchOptions = {}): Promise<MailboxWatch> {
    const imap = this.deps.config.imap;
    if (!imap) throw new ForerunnerError("validation", "mailbox has no IMAP configuration");
    const interval = opts.pollIntervalMs ?? 5 * 60 * 1000;
    const delivered = new Set<number>();
    let push: ImapClientLike | null = null;
    let pushActive = false;
    let inFlight: Promise<void> | null = null;
    let stopped = false;

    const deliver = async (client: ImapClientLike, folder: string) => {
      const uids = (await this.unseenUids(client, folder)).filter((u) => !delivered.has(u));
      for (const message of await this.fetchUids(client, uids)) {
        delivered.add(Number(message.id));
        try {
          await onMessage(message);
        } catch (e) {
          logger.warn("inbound handler failed", { id: message.id, error: String(e) });
        }
      }
    };
    const run = (fn: () => Promise<void>) => {
      const next = (inFlight ?? Promise.resolve()).then(fn, fn);
      inFlight = next.finally(() => {
        if (inFlight === next) inFlight = null;
      });
      return inFlight;
    };
    const viaPush = () =>
      run(async () => {
        if (!push || !pushActive) return;
        await deliver(push, imap.folder);
      });
    const viaPoll = () =>
      run(async () => {
        if (stopped) return;
        if (push && pushActive) {
          await deliver(push, imap.folder);
          return;
        }
        await this.withImap((client, folder) => deliver(client, folder));
        if (!push) await connectPush();
      });
    const connectPush = async () => {
      try {
        const { client, folder } = await this.openImap();
        await client.mailboxOpen(folder);
        push = client;
        pushActive = true;
        client.on("exists", () => {
          viaPush().catch(() => undefined);
        });
        const drop = () => {
          pushActive = false;
          push = null;
        };
        client.on("close", drop);
        client.on("error", (e) => {
          logger.warn("push connection error", { error: this.scrub(e, "push").message });
          drop();
        });
      } catch (e) {
        pushActive = false;
        push = null;
        logger.warn("push connection failed; polling only", {
          error: this.scrub(e, "push connect").message,
        });
      }
    };

    await connectPush();
    if (opts.catchUp !== false) {
      // A transient failure here must not stop the watch: the poll loop retries.
      await viaPoll().catch((e: unknown) => {
        logger.warn("catch-up poll failed; retrying at the interval", {
          error: this.scrub(e, "poll").message,
        });
      });
    }
    const cancel = pollLoop(this.deps.clock, interval, viaPoll);
    return {
      get pushActive() {
        return pushActive;
      },
      async stop() {
        stopped = true;
        cancel();
        const client = push;
        push = null;
        pushActive = false;
        if (client) await client.logout().catch(() => undefined);
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Test mailbox over the testenv LocalMailServer (structural types; no import of the package)

export interface TestStoredMessageLike {
  id: string;
  raw: string;
  receivedAt: string;
  read: boolean;
}

export interface TestMailboxLike {
  readonly address: string;
  readonly messages: TestStoredMessageLike[];
  readonly credentials: { username: string; password: string };
  onNew(cb: (message: TestStoredMessageLike) => void): () => void;
  markRead(id: string): boolean;
  get(id: string): TestStoredMessageLike | undefined;
}

export interface TestMailServerLike {
  address(): { host: string; submissionPort: number };
  mailbox(address: string): TestMailboxLike | undefined;
}

export interface TestMailboxOptions {
  server: TestMailServerLike;
  address: string;
  clock: Clock;
  /** False simulates a host without IDLE: only the poll loop delivers. */
  push?: boolean;
  createTransport?: SmtpFactory;
  maxAttachmentBytes?: number;
}

export class TestMailbox implements Mailbox {
  readonly address: string;
  readonly drafts: DraftReceipt[] = [];
  readonly sent: SendReceipt[] = [];
  private readonly box: TestMailboxLike;
  private readonly createTransport: SmtpFactory;

  constructor(private readonly opts: TestMailboxOptions) {
    this.address = opts.address.trim().toLowerCase();
    const box = opts.server.mailbox(this.address);
    if (!box) throw new ForerunnerError("not_found", `no test mailbox ${this.address}`);
    this.box = box;
    this.createTransport = opts.createTransport ?? loopbackSmtpFactory;
  }

  private parse(stored: TestStoredMessageLike): Promise<InboundEmail> {
    return parseInboundEmail(
      stored.raw,
      { id: stored.id, receivedAt: stored.receivedAt },
      { maxAttachmentBytes: this.opts.maxAttachmentBytes },
    );
  }

  async listUnseen(opts: { limit?: number } = {}): Promise<InboundEmail[]> {
    const unread = this.box.messages.filter((m) => !m.read);
    const slice = opts.limit !== undefined ? unread.slice(-opts.limit) : unread;
    const out: InboundEmail[] = [];
    for (const m of slice) out.push(await this.parse(m));
    return out;
  }

  async fetch(id: string): Promise<InboundEmail | undefined> {
    const stored = this.box.get(id);
    return stored ? this.parse(stored) : undefined;
  }

  async markSeen(id: string): Promise<void> {
    this.box.markRead(id);
  }

  async send(message: OutboundMessage): Promise<SendReceipt> {
    const receipt = await buildOutboundRaw(this.address, message, this.opts.clock.now());
    const { host, submissionPort } = this.opts.server.address();
    const transport = await this.createTransport({
      host,
      port: submissionPort,
      secure: false,
      auth: { user: this.box.credentials.username, pass: this.box.credentials.password },
    });
    try {
      await transport.sendMail({
        envelope: { from: this.address, to: recipientsOf(message) },
        raw: receipt.raw,
      });
    } finally {
      transport.close?.();
    }
    this.sent.push(receipt);
    return receipt;
  }

  async saveDraft(message: OutboundMessage): Promise<DraftReceipt> {
    const receipt = await buildOutboundRaw(this.address, message, this.opts.clock.now());
    const draft = { draftId: receipt.messageId, raw: receipt.raw };
    this.drafts.push(draft);
    return draft;
  }

  async watch(onMessage: InboundHandler, opts: WatchOptions = {}): Promise<MailboxWatch> {
    const delivered = new Set<string>();
    let stopped = false;
    let inFlight: Promise<void> = Promise.resolve();
    const handle = (stored: TestStoredMessageLike) => {
      if (stopped || stored.read || delivered.has(stored.id)) return inFlight;
      delivered.add(stored.id);
      inFlight = inFlight.then(async () => {
        try {
          await onMessage(await this.parse(stored));
        } catch (e) {
          logger.warn("inbound handler failed", { id: stored.id, error: String(e) });
        }
      });
      return inFlight;
    };
    const sweep = async () => {
      for (const m of [...this.box.messages]) await handle(m);
    };
    const pushOn = this.opts.push !== false;
    const off = pushOn ? this.box.onNew((m) => void handle(m)) : () => undefined;
    if (opts.catchUp !== false) await sweep();
    const cancel = pollLoop(this.opts.clock, opts.pollIntervalMs ?? 5 * 60 * 1000, sweep);
    return {
      get pushActive() {
        return pushOn && !stopped;
      },
      async stop() {
        stopped = true;
        off();
        cancel();
        await inFlight;
      },
    };
  }
}
