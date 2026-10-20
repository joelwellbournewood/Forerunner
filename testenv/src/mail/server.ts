/**
 * LocalMailServer: an in-process stand-in for the agent mailboxes' mail host.
 *
 * Two SMTP listeners on 127.0.0.1 (both ephemeral by default):
 *  - inbound: the "MX" the internet talks to. Any sender, no auth. Mail for local domains is
 *    delivered after DKIM and SPF are evaluated and recorded in an Authentication-Results
 *    header, exactly the way the email-command watcher sees mail in production.
 *  - submission: what the agent's own mail client uses. AUTH with per-mailbox passwords,
 *    outgoing mail is DKIM-signed for local domains, local recipients are delivered locally and
 *    everything else is captured in `outbox` instead of going to the internet.
 *
 * Push delivery (`Mailbox.onNew`) stands in for IMAP IDLE / Gmail push.
 */
import { timingSafeEqual } from "node:crypto";
import { type Clock, ForerunnerError, log, newId } from "@forerunner/platform";
import { type ParsedMail, simpleParser } from "mailparser";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import { type AuthResults, formatAuthenticationResults } from "./auth-results.ts";
import {
  type DkimKeyPair,
  type DkimVerifyResult,
  generateDkimKeyPair,
  signDkim,
  verifyDkim,
} from "./dkim.ts";
import {
  addressDomain,
  type BuildAttachment,
  type BuildMessageOptions,
  buildRawMessage,
  headerValue,
  normalizeAddress,
  parseAddresses,
  prependHeader,
  rfc5322Date,
  splitMessage,
  toCrlf,
} from "./message.ts";
import { smtpSubmit } from "./smtp-client.ts";
import { checkSpf, normalizeIp, type SpfDomainPolicy, type SpfPolicy } from "./spf.ts";

const logger = log("testenv:mail");

/** TEST-NET-1 (RFC 5737): the address the local domains' default SPF policy designates. */
export const DEFAULT_PUBLIC_IP = "192.0.2.25";
/** TEST-NET-1: the address `inject` reports when the caller gives none ("somewhere on the internet"). */
export const DEFAULT_INJECT_IP = "192.0.2.100";

export interface DkimServerKey {
  selector: string;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface LocalMailServerOptions {
  /** Inbound (MX) port; 0 or omitted picks an ephemeral port. */
  smtpPort?: number;
  /** Authenticated submission port; 0 or omitted picks an ephemeral port. */
  submissionPort?: number;
  /** Bind address; the loopback address by default and in every test. */
  host?: string;
  /** Domains this server hosts mailboxes for. */
  domains: string[];
  /** Signing key for the local domains. */
  dkim: DkimServerKey;
  /** SPF policies by domain; local domains default to `{ allowedIps: [publicIp], all: "fail" }`. */
  spfPolicy?: SpfPolicy;
  /** The "public" address outgoing mail appears to come from; see DEFAULT_PUBLIC_IP. */
  publicIp?: string;
  clock: Clock;
  /** Maximum message size in bytes for both listeners. */
  maxMessageBytes?: number;
}

export type DeliveryPath = "inbound" | "submission" | "inject";

export interface Envelope {
  mailFrom: string | null;
  rcptTo: string[];
}

export interface StoredMessage {
  id: string;
  /** The message as stored: Received and Authentication-Results headers on top of what arrived. */
  raw: string;
  parsed: ParsedMail;
  receivedAt: string;
  read: boolean;
  authResults: AuthResults;
  fromIp: string;
  envelope: Envelope;
  via: DeliveryPath;
  /** Mailbox address this copy was delivered to. */
  mailbox: string;
}

export interface OutboxEntry {
  id: string;
  raw: string;
  parsed: ParsedMail;
  envelope: Envelope;
  sentAt: string;
  /** Authenticated mailbox that submitted the message. */
  from: string;
}

export interface MailboxCredentials {
  username: string;
  password: string;
}

export class Mailbox {
  readonly messages: StoredMessage[] = [];
  private readonly listeners = new Set<(message: StoredMessage) => void>();

  constructor(
    readonly address: string,
    readonly credentials: MailboxCredentials,
  ) {}

  unread(): StoredMessage[] {
    return this.messages.filter((m) => !m.read);
  }

  get(id: string): StoredMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  markRead(id: string): boolean {
    const message = this.get(id);
    if (!message) return false;
    message.read = true;
    return true;
  }

  delete(id: string): boolean {
    const index = this.messages.findIndex((m) => m.id === id);
    if (index === -1) return false;
    this.messages.splice(index, 1);
    return true;
  }

  /** Push notification on delivery (the stand-in for IMAP IDLE). Returns an unsubscribe. */
  onNew(cb: (message: StoredMessage) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Resolves with the next delivered message (optionally the next one matching `predicate`). */
  nextMessage(predicate?: (message: StoredMessage) => boolean): Promise<StoredMessage> {
    return new Promise((resolveNext) => {
      const off = this.onNew((message) => {
        if (predicate && !predicate(message)) return;
        off();
        resolveNext(message);
      });
    });
  }

  /** @internal */
  deliver(message: StoredMessage): void {
    this.messages.push(message);
    for (const cb of [...this.listeners]) {
      try {
        cb(message);
      } catch (e) {
        logger.warn("onNew listener threw", { mailbox: this.address, error: String(e) });
      }
    }
  }
}

export interface InjectOptions {
  /** Connecting address recorded for SPF; DEFAULT_INJECT_IP when omitted. */
  fromIp?: string;
  /** Deliver as is, with no DKIM signature (a spoof). */
  skipSigning?: boolean;
  /** Sign for this domain instead of the From domain (valid signature, not aligned). */
  dkimAs?: string;
  /** Envelope recipients; defaults to the local addresses in To and Cc. */
  rcptTo?: string[];
  /** Envelope sender; defaults to the From header address. */
  mailFrom?: string | null;
}

export type InjectMessage = Omit<BuildMessageOptions, "date"> & { date?: number | Date };

export interface SendFromOptions {
  to: string | string[];
  cc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string | string[];
  attachments?: BuildAttachment[];
  headers?: Record<string, string>;
}

export interface SendResult {
  messageId: string;
  /** Local copies delivered (one per local recipient mailbox). */
  delivered: StoredMessage[];
  /** The captured outbound message when at least one recipient was not local. */
  outbox: OutboxEntry | null;
}

export interface ServerAddress {
  host: string;
  smtpPort: number;
  submissionPort: number;
}

interface ReceiveInput {
  raw: string;
  fromIp: string;
  envelope: Envelope;
  via: DeliveryPath;
}

function smtpError(code: number, message: string): Error {
  return Object.assign(new Error(message), { responseCode: code });
}

function readStream(stream: SMTPServerDataStream): Promise<string> {
  return new Promise((resolveRaw, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolveRaw(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

export class LocalMailServer {
  readonly mailboxes = new Map<string, Mailbox>();
  readonly outbox: OutboxEntry[] = [];
  readonly domains: string[];
  readonly host: string;
  readonly publicIp: string;
  readonly authservId: string;
  private readonly dkimKeys = new Map<string, DkimServerKey>();
  private readonly publicKeys = new Map<string, string>();
  private readonly outboundListeners = new Set<(entry: OutboxEntry) => void>();
  private readonly spfOverrides: SpfPolicy;
  private readonly clock: Clock;
  private readonly maxMessageBytes: number;
  private readonly requestedSmtpPort: number;
  private readonly requestedSubmissionPort: number;
  private inbound: SMTPServer | null = null;
  private submission: SMTPServer | null = null;
  private boundSmtpPort = 0;
  private boundSubmissionPort = 0;

  constructor(options: LocalMailServerOptions) {
    if (options.domains.length === 0) {
      throw new ForerunnerError("validation", "LocalMailServer needs at least one domain");
    }
    this.domains = options.domains.map((d) => d.toLowerCase());
    this.host = options.host ?? "127.0.0.1";
    this.publicIp = options.publicIp ?? DEFAULT_PUBLIC_IP;
    this.authservId = `mx.${this.domains[0]}`;
    this.clock = options.clock;
    this.maxMessageBytes = options.maxMessageBytes ?? 25 * 1024 * 1024;
    this.requestedSmtpPort = options.smtpPort ?? 0;
    this.requestedSubmissionPort = options.submissionPort ?? 0;
    this.spfOverrides = { ...(options.spfPolicy ?? {}) };
    for (const domain of this.domains) {
      this.dkimKeys.set(domain, options.dkim);
      this.registerDkimKey(domain, options.dkim.selector, options.dkim.publicKeyPem);
    }
  }

  /** Construct and start in one call. */
  static async start(options: LocalMailServerOptions): Promise<LocalMailServer> {
    const server = new LocalMailServer(options);
    await server.start();
    return server;
  }

  get smtpPort(): number {
    return this.boundSmtpPort;
  }

  get submissionPort(): number {
    return this.boundSubmissionPort;
  }

  get running(): boolean {
    return this.inbound !== null;
  }

  address(): ServerAddress {
    if (!this.running) throw new ForerunnerError("unavailable", "mail server is not running");
    return { host: this.host, smtpPort: this.smtpPort, submissionPort: this.submissionPort };
  }

  async start(): Promise<this> {
    if (this.running) return this;
    this.inbound = new SMTPServer({
      name: this.authservId,
      authOptional: true,
      disabledCommands: ["AUTH", "STARTTLS"],
      disableReverseLookup: true,
      size: this.maxMessageBytes,
      closeTimeout: 500,
      logger: false,
      onRcptTo: (address, _session, callback) => {
        const rcpt = address.address.toLowerCase();
        if (!this.isLocalDomain(addressDomain(rcpt))) {
          return callback(smtpError(554, `Relay access denied for ${rcpt}`));
        }
        if (!this.mailboxes.has(rcpt)) return callback(smtpError(550, `No such mailbox ${rcpt}`));
        callback();
      },
      onData: (stream, session, callback) => {
        this.handleInboundData(stream, session)
          .then((id) => callback(null, `OK: queued as ${id}`))
          .catch((e: unknown) => callback(e instanceof Error ? e : new Error(String(e))));
      },
    });
    this.submission = new SMTPServer({
      name: `submission.${this.domains[0]}`,
      authOptional: false,
      allowInsecureAuth: true,
      authMethods: ["PLAIN", "LOGIN"],
      disabledCommands: ["STARTTLS"],
      disableReverseLookup: true,
      size: this.maxMessageBytes,
      closeTimeout: 500,
      logger: false,
      onAuth: (auth, _session, callback) => {
        const mailbox = this.mailboxes.get((auth.username ?? "").toLowerCase());
        const given = Buffer.from(auth.password ?? "", "utf8");
        const expected = Buffer.from(mailbox?.credentials.password ?? "", "utf8");
        const ok =
          mailbox !== undefined &&
          given.length === expected.length &&
          given.length > 0 &&
          timingSafeEqual(given, expected);
        if (!ok || !mailbox) return callback(smtpError(535, "Invalid username or password"));
        callback(null, { user: mailbox.address });
      },
      onMailFrom: (address, session, callback) => {
        const sender = address.address.toLowerCase();
        if (!session.user || sender !== session.user) {
          return callback(smtpError(553, "Sender address must match the authenticated mailbox"));
        }
        callback();
      },
      onData: (stream, session, callback) => {
        this.handleSubmissionData(stream, session)
          .then((id) => callback(null, `OK: accepted as ${id}`))
          .catch((e: unknown) => callback(e instanceof Error ? e : new Error(String(e))));
      },
    });
    this.inbound.on("error", (err) =>
      logger.warn("inbound listener error", { error: err.message }),
    );
    this.submission.on("error", (err) =>
      logger.warn("submission listener error", { error: err.message }),
    );
    this.boundSmtpPort = await listen(this.inbound, this.requestedSmtpPort, this.host);
    this.boundSubmissionPort = await listen(
      this.submission,
      this.requestedSubmissionPort,
      this.host,
    );
    logger.info("mail server started", {
      host: this.host,
      smtpPort: this.boundSmtpPort,
      submissionPort: this.boundSubmissionPort,
      domains: this.domains,
    });
    return this;
  }

  async stop(): Promise<void> {
    const servers = [this.inbound, this.submission].filter((s): s is SMTPServer => s !== null);
    this.inbound = null;
    this.submission = null;
    await Promise.all(
      servers.map((s) => new Promise<void>((resolveClose) => s.close(() => resolveClose()))),
    );
    this.boundSmtpPort = 0;
    this.boundSubmissionPort = 0;
    logger.info("mail server stopped");
  }

  // -------------------------------------------------------------------------------------------
  // Mailboxes, keys and policy

  isLocalDomain(domain: string): boolean {
    return this.domains.includes(domain.toLowerCase());
  }

  createMailbox(address: string, password: string): Mailbox {
    const normalised = normalizeAddress(address);
    if (!this.isLocalDomain(addressDomain(normalised))) {
      throw new ForerunnerError("validation", `${normalised} is not on a local domain`, {
        details: { domains: this.domains },
      });
    }
    if (password.length === 0) {
      throw new ForerunnerError("validation", "mailbox password must not be empty");
    }
    const mailbox = new Mailbox(normalised, { username: normalised, password });
    this.mailboxes.set(normalised, mailbox);
    return mailbox;
  }

  mailbox(address: string): Mailbox | undefined {
    return this.mailboxes.get(address.trim().toLowerCase());
  }

  /** Publish a public key as if `<selector>._domainkey.<domain>` existed in DNS. */
  registerDkimKey(domain: string, selector: string, publicKeyPem: string): void {
    this.publicKeys.set(`${selector}._domainkey.${domain.toLowerCase()}`, publicKeyPem);
  }

  /** The DNS stand-in the verifier uses; also useful for verifying outbox messages in tests. */
  readonly resolvePublicKey = async (selector: string, domain: string): Promise<string | null> =>
    this.publicKeys.get(`${selector}._domainkey.${domain.toLowerCase()}`) ?? null;

  /**
   * Signing key for a domain: the configured key for local domains, a lazily generated and
   * published key pair for any other domain (so injected "legitimate" external mail verifies).
   */
  dkimKeyFor(domain: string): DkimServerKey {
    const lower = domain.toLowerCase();
    const existing = this.dkimKeys.get(lower);
    if (existing) return existing;
    const pair: DkimKeyPair = generateDkimKeyPair();
    const key: DkimServerKey = { selector: "testenv", ...pair };
    this.dkimKeys.set(lower, key);
    this.registerDkimKey(lower, key.selector, key.publicKeyPem);
    return key;
  }

  setSpfPolicy(domain: string, policy: SpfDomainPolicy): void {
    this.spfOverrides[domain.toLowerCase()] = policy;
  }

  /** Effective SPF policy: local domains designate `publicIp` unless overridden. */
  get spfPolicy(): SpfPolicy {
    const policy: SpfPolicy = {};
    for (const domain of this.domains)
      policy[domain] = { allowedIps: [this.publicIp], all: "fail" };
    return { ...policy, ...this.spfOverrides };
  }

  onOutbound(cb: (entry: OutboxEntry) => void): () => void {
    this.outboundListeners.add(cb);
    return () => {
      this.outboundListeners.delete(cb);
    };
  }

  // -------------------------------------------------------------------------------------------
  // Direct injection and convenience sending

  /**
   * Deliver a message to local mailboxes without SMTP. By default the message is DKIM-signed
   * for its From domain (a legitimate sender); `skipSigning` leaves it unsigned (a spoof) and
   * `dkimAs` signs for another domain (valid but not aligned).
   */
  async inject(
    rawOrOptions: string | InjectMessage,
    options: InjectOptions = {},
  ): Promise<StoredMessage[]> {
    let raw =
      typeof rawOrOptions === "string"
        ? toCrlf(rawOrOptions)
        : await buildRawMessage({ ...rawOrOptions, date: rawOrOptions.date ?? this.clock.now() });
    const { headers } = splitMessage(raw);
    const fromAddress = parseAddresses(headerValue(headers, "from"))[0];
    if (!fromAddress) throw new ForerunnerError("validation", "message has no From address");
    const fromDomain = addressDomain(fromAddress);
    if (!options.skipSigning) {
      const key = this.dkimKeyFor(options.dkimAs ?? fromDomain);
      raw = signDkim(
        {
          privateKeyPem: key.privateKeyPem,
          domain: options.dkimAs ?? fromDomain,
          selector: key.selector,
        },
        raw,
      );
    }
    const rcptTo = (
      options.rcptTo ?? [
        ...parseAddresses(headerValue(headers, "to")),
        ...parseAddresses(headerValue(headers, "cc")),
      ]
    ).map((a) => a.toLowerCase());
    const local = rcptTo.filter((a) => this.isLocalDomain(addressDomain(a)));
    if (local.length === 0) {
      throw new ForerunnerError("validation", "inject: no recipient on a local domain", {
        details: { rcptTo, domains: this.domains },
      });
    }
    for (const rcpt of local) {
      if (!this.mailboxes.has(rcpt)) {
        throw new ForerunnerError("not_found", `inject: no mailbox ${rcpt}`);
      }
    }
    return this.receive({
      raw,
      fromIp: options.fromIp ?? DEFAULT_INJECT_IP,
      envelope: {
        mailFrom: options.mailFrom === undefined ? fromAddress : options.mailFrom,
        rcptTo: local,
      },
      via: "inject",
    });
  }

  /** Send from a local mailbox through the submission listener, so the message gets signed. */
  async sendFrom(address: string, options: SendFromOptions): Promise<SendResult> {
    if (!this.running) throw new ForerunnerError("unavailable", "mail server is not running");
    const sender = normalizeAddress(address);
    const mailbox = this.mailboxes.get(sender);
    if (!mailbox) throw new ForerunnerError("not_found", `no mailbox ${sender}`);
    const messageId = `<${newId(this.clock.now())}@${addressDomain(sender)}>`;
    const raw = await buildRawMessage({
      ...options,
      from: sender,
      date: this.clock.now(),
      messageId,
    });
    const recipients = [
      ...parseAddresses(Array.isArray(options.to) ? options.to.join(", ") : options.to),
      ...parseAddresses(Array.isArray(options.cc) ? options.cc.join(", ") : options.cc),
    ];
    await smtpSubmit({
      host: this.host,
      port: this.submissionPort,
      from: sender,
      to: recipients,
      raw,
      auth: { user: mailbox.credentials.username, pass: mailbox.credentials.password },
    });
    const delivered: StoredMessage[] = [];
    for (const box of this.mailboxes.values()) {
      for (const message of box.messages) {
        if (message.parsed.messageId === messageId && message.via === "submission") {
          delivered.push(message);
        }
      }
    }
    const outbox = this.outbox.find((e) => e.parsed.messageId === messageId) ?? null;
    return { messageId, delivered, outbox };
  }

  // -------------------------------------------------------------------------------------------
  // Listener handlers

  private async handleInboundData(
    stream: SMTPServerDataStream,
    session: SMTPServerSession,
  ): Promise<string> {
    const raw = await readStream(stream);
    if (stream.sizeExceeded) throw smtpError(552, "Message exceeds the maximum size");
    const envelope: Envelope = {
      mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address.toLowerCase() : null,
      rcptTo: session.envelope.rcptTo.map((r) => r.address.toLowerCase()),
    };
    const delivered = await this.receive({
      raw,
      fromIp: normalizeIp(session.remoteAddress),
      envelope,
      via: "inbound",
    });
    return delivered[0]?.id ?? newId(this.clock.now());
  }

  private async handleSubmissionData(
    stream: SMTPServerDataStream,
    session: SMTPServerSession,
  ): Promise<string> {
    const raw = toCrlf(await readStream(stream));
    if (stream.sizeExceeded) throw smtpError(552, "Message exceeds the maximum size");
    const user = session.user;
    if (!user) throw smtpError(530, "Authentication required");
    const { headers } = splitMessage(raw);
    const fromAddress = parseAddresses(headerValue(headers, "from"))[0];
    if (fromAddress === undefined || fromAddress !== user) {
      throw smtpError(553, "From header must be the authenticated mailbox");
    }
    const fromDomain = addressDomain(fromAddress);
    const key = this.dkimKeys.get(fromDomain);
    const signed = key
      ? signDkim(
          { privateKeyPem: key.privateKeyPem, domain: fromDomain, selector: key.selector },
          raw,
        )
      : raw;
    const rcptTo = session.envelope.rcptTo.map((r) => r.address.toLowerCase());
    const local = rcptTo.filter((a) => this.isLocalDomain(addressDomain(a)));
    const remote = rcptTo.filter((a) => !this.isLocalDomain(addressDomain(a)));
    const envelope: Envelope = { mailFrom: user, rcptTo };
    const id = newId(this.clock.now());
    if (local.length > 0) {
      await this.receive({
        raw: signed,
        fromIp: this.publicIp,
        envelope: { mailFrom: user, rcptTo: local },
        via: "submission",
      });
    }
    if (remote.length > 0) {
      const entry: OutboxEntry = {
        id,
        raw: signed,
        parsed: await simpleParser(signed),
        envelope: { ...envelope, rcptTo: remote },
        sentAt: this.clock.nowIso(),
        from: user,
      };
      this.outbox.push(entry);
      logger.debug("outbound captured", { id, from: user, rcptTo: remote });
      for (const cb of [...this.outboundListeners]) cb(entry);
    }
    return id;
  }

  // -------------------------------------------------------------------------------------------
  // Delivery pipeline shared by every path

  private async receive(input: ReceiveInput): Promise<StoredMessage[]> {
    const raw = toCrlf(input.raw);
    const now = this.clock.now();
    const dkim = await verifyDkim(raw, this.resolvePublicKey, { now });
    const { headers } = splitMessage(raw);
    const fromDomain = addressDomain(parseAddresses(headerValue(headers, "from"))[0] ?? "");
    const spfDomain = input.envelope.mailFrom ? addressDomain(input.envelope.mailFrom) : fromDomain;
    const spf = checkSpf({ ip: input.fromIp, mailFromDomain: spfDomain, policy: this.spfPolicy });
    const authResults = buildAuthResults(dkim, spf, spfDomain, fromDomain);
    const id = newId(now);
    const received = `from [${input.fromIp}] by ${this.authservId} (forerunner-testenv) with ESMTP id ${id}; ${rfc5322Date(now)}`;
    let stored = prependHeader(
      raw,
      "Authentication-Results",
      formatAuthenticationResults(this.authservId, authResults),
    );
    stored = prependHeader(stored, "Received", received);
    const parsed = await simpleParser(stored);
    const delivered: StoredMessage[] = [];
    for (const rcpt of input.envelope.rcptTo) {
      const mailbox = this.mailboxes.get(rcpt);
      if (!mailbox) continue;
      const message: StoredMessage = {
        id: delivered.length === 0 ? id : newId(now),
        raw: stored,
        parsed,
        receivedAt: new Date(now).toISOString(),
        read: false,
        authResults,
        fromIp: input.fromIp,
        envelope: input.envelope,
        via: input.via,
        mailbox: rcpt,
      };
      mailbox.deliver(message);
      delivered.push(message);
    }
    logger.debug("delivered", {
      id,
      via: input.via,
      to: delivered.map((m) => m.mailbox),
      dkim: authResults.dkim,
      spf: authResults.spf,
      aligned: authResults.aligned,
    });
    return delivered;
  }
}

function buildAuthResults(
  dkim: DkimVerifyResult,
  spf: AuthResults["spf"],
  spfDomain: string,
  fromDomain: string,
): AuthResults {
  const verdict: AuthResults["dkim"] = dkim.pass
    ? "pass"
    : dkim.reason === "no DKIM-Signature header"
      ? "none"
      : "fail";
  const spfAligned = spf === "pass" && spfDomain.length > 0 && spfDomain === fromDomain;
  const dmarc: AuthResults["dmarc"] =
    (dkim.pass && dkim.alignedWithFrom) || spfAligned
      ? "pass"
      : verdict === "none" && spf === "none"
        ? "none"
        : "fail";
  return {
    dkim: verdict,
    ...(dkim.domain ? { dkimDomain: dkim.domain } : {}),
    ...(dkim.selector ? { dkimSelector: dkim.selector } : {}),
    ...(!dkim.pass && dkim.reason ? { dkimReason: dkim.reason } : {}),
    aligned: dkim.pass && dkim.alignedWithFrom,
    spf,
    ...(spfDomain ? { spfDomain } : {}),
    dmarc,
    ...(fromDomain ? { fromDomain } : {}),
  };
}

function listen(server: SMTPServer, port: number, host: string): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.server.address();
      if (address && typeof address === "object") resolvePort(address.port);
      else reject(new ForerunnerError("internal", "listener reported no address"));
    });
  });
}
