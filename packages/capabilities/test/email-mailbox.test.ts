import { ForerunnerError, isForerunnerError, SimulatedClock } from "@forerunner/platform";
import { MemoryVault, SecretResolver } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildOutboundRaw,
  defaultSmtpFactory,
  type ImapClientLike,
  type ImapConnectOptions,
  ImapSmtpMailbox,
  type InboundEmail,
  isLoopbackHost,
  loopbackSmtpFactory,
  MailboxConfigSchema,
  pollLoop,
  recipientsOf,
  type SmtpConnectOptions,
  type SmtpTransportLike,
  TestMailbox,
} from "../src/email/index.ts";
import {
  AGENT,
  captureLogs,
  emailWorld,
  lastOutbox,
  OWNER,
  ownerSends,
  STRANGER,
  type World,
} from "./helpers/email-world.ts";

let world: World | undefined;

afterEach(async () => {
  await world?.stop();
  world = undefined;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Wait (real time, bounded) for asynchronous parsing to finish; the clock itself never moves. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Give pending parsing a chance to run, then assert nothing changed. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 2));
}

// ---------------------------------------------------------------------------------------------
// TestMailbox over the testenv mail server

describe("TestMailbox over the testenv server", () => {
  it("sends through the authenticated submission listener and records the receipt", async () => {
    world = await emailWorld();
    const receipt = await world.mailbox.send({
      to: [STRANGER],
      cc: [OWNER],
      subject: "Hello",
      text: "Body",
      inReplyTo: "<prev@external.test>",
      references: ["<r1@external.test>"],
    });
    expect(receipt.messageId).toMatch(/@example\.test$/);
    expect(world.mailbox.sent).toHaveLength(1);
    const out = lastOutbox(world);
    expect(out?.from).toBe(AGENT);
    expect(out?.envelope.rcptTo).toEqual([STRANGER]);
    expect(out?.parsed.messageId).toBe(`<${receipt.messageId}>`);
    expect(out?.parsed.inReplyTo).toBe("<prev@external.test>");
    // The cc on the local domain was delivered locally, signed by the host.
    expect(world.ownerBox.messages).toHaveLength(1);
    expect(world.ownerBox.messages[0]?.authResults.dkim).toBe("pass");
    expect(recipientsOf({ to: [" A@X.test "], cc: ["b@y.test"], subject: "", text: "" })).toEqual([
      "a@x.test",
      "b@y.test",
    ]);
  });

  it("lists unseen mail, fetches one message parsed as data, and marks it seen", async () => {
    world = await emailWorld();
    const stored = await ownerSends(world, { subject: "one", text: "first", marker: false });
    await ownerSends(world, { subject: "two", text: "second", marker: false });
    const unseen = await world.mailbox.listUnseen();
    expect(unseen.map((m) => m.subject)).toEqual(["one", "two"]);
    expect(unseen[0]?.untrusted).toContain("UNTRUSTED_CONTENT");
    const one = await world.mailbox.fetch(stored.id);
    expect(one?.subject).toBe("one");
    expect(one?.authResults?.dkim).toBe("pass");
    await world.mailbox.markSeen(stored.id);
    expect((await world.mailbox.listUnseen()).map((m) => m.subject)).toEqual(["two"]);
    expect((await world.mailbox.listUnseen({ limit: 1 })).map((m) => m.subject)).toEqual(["two"]);
    expect(await world.mailbox.fetch("nope")).toBeUndefined();
  });

  it("saves drafts without sending", async () => {
    world = await emailWorld();
    const draft = await world.mailbox.saveDraft({ to: [STRANGER], subject: "d", text: "x" });
    expect(world.mailbox.drafts).toHaveLength(1);
    expect(draft.raw).toContain("Subject: d");
    expect(world.server.outbox).toHaveLength(0);
  });

  it("watch delivers by push as soon as mail arrives (no clock advance)", async () => {
    world = await emailWorld();
    const got = deferred<InboundEmail>();
    const watch = await world.mailbox.watch(async (m) => got.resolve(m), {
      pollIntervalMs: 5 * 60 * 1000,
    });
    expect(watch.pushActive).toBe(true);
    await ownerSends(world, { subject: "pushed", text: "hi", marker: false });
    const message = await got.promise;
    expect(message.subject).toBe("pushed");
    await watch.stop();
    expect(watch.pushActive).toBe(false);
  });

  it("watch falls back to polling at the configured interval when push is unavailable", async () => {
    world = await emailWorld();
    const polling = new TestMailbox({
      server: world.server,
      address: AGENT,
      clock: world.clock,
      push: false,
    });
    const seen: string[] = [];
    const watch = await polling.watch(async (m) => void seen.push(m.subject), {
      pollIntervalMs: 60_000,
    });
    expect(watch.pushActive).toBe(false);
    await ownerSends(world, { subject: "polled", text: "hi", marker: false });
    await settle();
    expect(seen).toEqual([]);
    await world.clock.advance(59_000);
    await settle();
    expect(seen).toEqual([]);
    await world.clock.advance(1_000);
    await until(() => seen.length === 1, "the poll to deliver");
    expect(seen).toEqual(["polled"]);
    // Delivered once, not again on the next poll.
    await world.clock.advance(60_000);
    await settle();
    expect(seen).toEqual(["polled"]);
    await watch.stop();
  });
});

// ---------------------------------------------------------------------------------------------
// SMTP transport factories: the production one never sends credentials in the clear

/** nodemailer's transporter keeps the options it was created with. */
function optionsOf(transport: SmtpTransportLike): Record<string, unknown> {
  return (transport as unknown as { options: Record<string, unknown> }).options;
}

describe("SMTP transport factories", () => {
  it("the production factory requires STARTTLS on a plain port and never ignores TLS", async () => {
    const plain = await defaultSmtpFactory({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      auth: { user: "alice", pass: SMTP_PASSWORD },
    });
    try {
      const options = optionsOf(plain);
      expect(options.ignoreTLS).toBeUndefined();
      expect(options.requireTLS).toBe(true);
      expect(options.secure).toBe(false);
    } finally {
      plain.close?.();
    }
    const implicit = await defaultSmtpFactory({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      auth: { user: "alice", pass: SMTP_PASSWORD },
    });
    try {
      const options = optionsOf(implicit);
      expect(options.secure).toBe(true);
      expect(options.ignoreTLS).toBeUndefined();
    } finally {
      implicit.close?.();
    }
    // Even a loopback host gets no plaintext from the production factory.
    const local = await defaultSmtpFactory({ host: "127.0.0.1", port: 2525, secure: false });
    try {
      expect(optionsOf(local).ignoreTLS).toBeUndefined();
      expect(optionsOf(local).requireTLS).toBe(true);
    } finally {
      local.close?.();
    }
  });

  it("the loopback factory allows plaintext on 127.0.0.1 only and refuses any other host", async () => {
    const local = await loopbackSmtpFactory({ host: "127.0.0.1", port: 2525, secure: false });
    try {
      expect(optionsOf(local).ignoreTLS).toBe(true);
    } finally {
      local.close?.();
    }
    await expect(
      loopbackSmtpFactory({ host: "smtp.example.test", port: 587, secure: false }),
    ).rejects.toSatisfy((e: unknown) => isForerunnerError(e, "validation"));
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1.example.test")).toBe(false);
    expect(isLoopbackHost("smtp.example.test")).toBe(false);
  });

  it("ImapSmtpMailbox uses the production factory by default; TestMailbox the loopback one", async () => {
    world = await emailWorld();
    // A TestMailbox over the testenv listener (STARTTLS disabled) works with its default factory.
    const box = new TestMailbox({ server: world.server, address: AGENT, clock: world.clock });
    await box.send({ to: [STRANGER], subject: "plain on loopback", text: "ok" });
    expect(lastOutbox(world)?.parsed.subject).toBe("plain on loopback");
    // The same listener through ImapSmtpMailbox's default factory is refused: no STARTTLS.
    const { host, submissionPort } = world.server.address();
    const vault = new MemoryVault({ pw: world.agentBox.credentials.password });
    const production = new ImapSmtpMailbox({
      config: MailboxConfigSchema.parse({
        address: AGENT,
        imap: null,
        smtp: {
          host,
          port: submissionPort,
          secure: false,
          user: AGENT,
          passwordRef: "secret:pw",
        },
      }),
      secrets: new SecretResolver(vault),
      granted: new Set(["pw"]),
      clock: world.clock,
    });
    await expect(
      production.send({ to: [STRANGER], subject: "must not leave in the clear", text: "x" }),
    ).rejects.toSatisfy((e: unknown) => isForerunnerError(e, "provider_error"));
    expect(world.server.outbox.map((m) => m.parsed.subject)).toEqual(["plain on loopback"]);
  });
});

describe("pollLoop and buildOutboundRaw", () => {
  it("runs on the clock at the interval until cancelled, surviving a failing run", async () => {
    const clock = new SimulatedClock("2026-03-02T10:00:00.000Z");
    let runs = 0;
    const cancel = pollLoop(clock, 1000, async () => {
      runs++;
      if (runs === 2) throw new Error("boom");
    });
    await clock.advance(999);
    expect(runs).toBe(0);
    await clock.advance(1);
    expect(runs).toBe(1);
    await clock.advance(2000);
    expect(runs).toBe(3);
    cancel();
    await clock.advance(5000);
    expect(runs).toBe(3);
  });

  it("builds an RFC 5322 message with Message-ID, threading headers and CRLF endings", async () => {
    const receipt = await buildOutboundRaw(
      AGENT,
      {
        to: [OWNER],
        subject: "Re: x",
        text: "line1\nline2",
        inReplyTo: "<a@example.test>",
        references: ["r1@example.test", "<a@example.test>"],
        messageId: "<fixed@example.test>",
      },
      Date.parse("2026-03-02T10:00:00.000Z"),
    );
    expect(receipt.messageId).toBe("fixed@example.test");
    expect(receipt.raw).toContain("Message-ID: <fixed@example.test>\r\n");
    expect(receipt.raw).toContain("In-Reply-To: <a@example.test>\r\n");
    expect(receipt.raw).toContain("References: <r1@example.test> <a@example.test>\r\n");
    expect(receipt.raw).toContain("line1\r\nline2");
    expect(receipt.raw).not.toMatch(/[^\r]\n/);
  });
});

// ---------------------------------------------------------------------------------------------
// ImapSmtpMailbox with fake IMAP and SMTP clients, real vault resolver

const IMAP_PASSWORD = ["imap", "Secret", "Value", "9x7"].join("-"); // not-a-secret
const SMTP_PASSWORD = ["smtp", "Secret", "Value", "4q2"].join("-"); // not-a-secret

interface FakeStore {
  messages: Map<number, { raw: string; seen: boolean }>;
}

class FakeImapClient implements ImapClientLike {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly opened: string[] = [];
  readonly appended: Array<{ path: string; content: string; flags?: string[] }> = [];
  connected = false;
  constructor(
    readonly opts: ImapConnectOptions,
    private readonly store: FakeStore,
    private readonly behaviour: { connectError?: Error; searchError?: Error } = {},
  ) {}
  async connect(): Promise<void> {
    if (this.behaviour.connectError) throw this.behaviour.connectError;
    this.connected = true;
  }
  async logout(): Promise<void> {
    this.connected = false;
  }
  async mailboxOpen(path: string): Promise<unknown> {
    this.opened.push(path);
    return {};
  }
  async search(query: { seen?: boolean; all?: boolean }): Promise<number[]> {
    if (this.behaviour.searchError) throw this.behaviour.searchError;
    return [...this.store.messages]
      .filter(([, m]) => (query.seen === false ? !m.seen : true))
      .map(([uid]) => uid);
  }
  async fetchAll(range: number[] | string) {
    const uids = Array.isArray(range) ? range : [];
    return uids.map((uid) => ({
      uid,
      source: Buffer.from(this.store.messages.get(uid)?.raw ?? "", "utf8"),
      flags: new Set<string>(),
      internalDate: new Date("2026-03-02T10:00:00.000Z"),
    }));
  }
  async messageFlagsAdd(range: number[] | string): Promise<boolean> {
    for (const uid of Array.isArray(range) ? range : []) {
      const m = this.store.messages.get(uid);
      if (m) m.seen = true;
    }
    return true;
  }
  async append(path: string, content: string, flags?: string[]): Promise<unknown> {
    this.appended.push({ path, content, flags });
    return {};
  }
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }
}

class FakeTransport implements SmtpTransportLike {
  readonly sent: Array<{ envelope: { from: string; to: string[] }; raw: string }> = [];
  closed = false;
  constructor(readonly opts: SmtpConnectOptions) {}
  async sendMail(mail: {
    envelope: { from: string; to: string[] };
    raw: string;
  }): Promise<unknown> {
    this.sent.push(mail);
    return { accepted: mail.envelope.to };
  }
  close(): void {
    this.closed = true;
  }
}

const RAW_OWNER_MAIL = [
  `From: J <${OWNER}>`,
  `To: ${AGENT}`,
  "Subject: via imap",
  "Message-ID: <imap1@example.test>",
  "Date: Mon, 02 Mar 2026 10:00:00 +0000",
  "",
  "hello from imap",
  "",
].join("\r\n");

function imapWorld(opts: { granted?: string[]; behaviour?: FakeImapClient["opts"] } = {}) {
  const clock = new SimulatedClock("2026-03-02T10:00:00.000Z");
  const vault = new MemoryVault({ alice_imap: IMAP_PASSWORD, alice_smtp: SMTP_PASSWORD });
  const audited: string[] = [];
  const secrets = new SecretResolver(vault, (name) => audited.push(name));
  const store: FakeStore = { messages: new Map() };
  const clients: FakeImapClient[] = [];
  const transports: FakeTransport[] = [];
  let nextBehaviour: { connectError?: Error; searchError?: Error } | undefined;
  let failRemaining = 0;
  const config = MailboxConfigSchema.parse({
    address: AGENT,
    imap: { host: "imap.example.test", user: "alice", passwordRef: "secret:alice_imap" },
    smtp: { host: "smtp.example.test", user: "alice", passwordRef: "secret:alice_smtp" },
  });
  const mailbox = new ImapSmtpMailbox({
    config,
    secrets,
    granted: new Set(opts.granted ?? ["alice_imap", "alice_smtp"]),
    clock,
    createImap: async (o) => {
      const client = new FakeImapClient(o, store, failRemaining > 0 ? nextBehaviour : undefined);
      if (failRemaining > 0) failRemaining--;
      clients.push(client);
      return client;
    },
    createTransport: async (o) => {
      const t = new FakeTransport(o);
      transports.push(t);
      return t;
    },
  });
  return {
    clock,
    secrets,
    audited,
    store,
    clients,
    transports,
    mailbox,
    /** The next `times` IMAP clients the factory creates behave this way. */
    failNext(behaviour: { connectError?: Error; searchError?: Error }, times = 1) {
      nextBehaviour = behaviour;
      failRemaining = times;
    },
  };
}

describe("ImapSmtpMailbox: credentials by reference, resolved at call time", () => {
  it("resolves the IMAP password from the vault only when an operation runs", async () => {
    const w = imapWorld();
    w.store.messages.set(7, { raw: RAW_OWNER_MAIL, seen: false });
    expect(w.secrets.resolvedCount).toBe(0);
    expect(w.clients).toHaveLength(0);
    const unseen = await w.mailbox.listUnseen();
    expect(unseen).toHaveLength(1);
    expect(unseen[0]).toMatchObject({ id: "7", from: OWNER, subject: "via imap" });
    expect(w.secrets.resolvedCount).toBe(1);
    expect(w.audited).toEqual(["alice_imap"]);
    expect(w.clients[0]?.opts).toEqual({
      host: "imap.example.test",
      port: 993,
      secure: true,
      auth: { user: "alice", pass: IMAP_PASSWORD },
    });
    expect(w.clients[0]?.opened).toEqual(["INBOX"]);
    expect(w.clients[0]?.connected).toBe(false); // logged out after the operation
    await w.mailbox.markSeen("7");
    expect(w.store.messages.get(7)?.seen).toBe(true);
    expect(await w.mailbox.listUnseen()).toEqual([]);
    expect(await w.mailbox.fetch("7")).toMatchObject({ subject: "via imap" });
    expect(await w.mailbox.fetch("x")).toBeUndefined();
  });

  it("sends over SMTP with the resolved password and the computed envelope", async () => {
    const w = imapWorld();
    const receipt = await w.mailbox.send({ to: [STRANGER], cc: [OWNER], subject: "s", text: "t" });
    expect(w.transports).toHaveLength(1);
    expect(w.transports[0]?.opts).toEqual({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      auth: { user: "alice", pass: SMTP_PASSWORD },
    });
    expect(w.transports[0]?.sent[0]?.envelope).toEqual({ from: AGENT, to: [STRANGER, OWNER] });
    expect(w.transports[0]?.sent[0]?.raw).toBe(receipt.raw);
    expect(w.transports[0]?.closed).toBe(true);
    expect(w.audited).toEqual(["alice_smtp"]);
    const draft = await w.mailbox.saveDraft({ to: [STRANGER], subject: "d", text: "x" });
    expect(w.clients[0]?.appended[0]).toMatchObject({ path: "Drafts", flags: ["\\Draft"] });
    expect(w.clients[0]?.appended[0]?.content).toBe(draft.raw);
  });

  it("refuses to resolve a reference that was not granted, before touching the network", async () => {
    const w = imapWorld({ granted: ["alice_smtp"] });
    await expect(w.mailbox.listUnseen()).rejects.toSatisfy((e: unknown) =>
      isForerunnerError(e, "secret_not_granted"),
    );
    expect(w.clients).toHaveLength(0);
    expect(w.secrets.resolvedCount).toBe(0);
  });

  it("never lets a credential value into a log line, an error message or its JSON", async () => {
    const w = imapWorld();
    w.failNext({ connectError: new Error(`LOGIN alice ${IMAP_PASSWORD} rejected by server`) });
    const { result: error, lines } = await captureLogs(async () =>
      w.mailbox.listUnseen().then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    expect(error).toBeInstanceOf(ForerunnerError);
    const err = error as ForerunnerError;
    expect(err.code).toBe("provider_auth");
    expect(err.message).not.toContain(IMAP_PASSWORD);
    expect(String(err.cause)).not.toContain(IMAP_PASSWORD);
    expect(String(err.cause)).toContain("[REDACTED]");
    expect(JSON.stringify(err.toJSON())).not.toContain(IMAP_PASSWORD);
    for (const line of lines) expect(line).not.toContain(IMAP_PASSWORD);

    // An error thrown mid-operation by the library is scrubbed too.
    w.failNext({ searchError: new Error(`search failed; session ${IMAP_PASSWORD}`) });
    const { result: second, lines: more } = await captureLogs(async () =>
      w.mailbox.listUnseen().then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    expect((second as Error).message).toContain("[REDACTED]");
    expect((second as Error).message).not.toContain(IMAP_PASSWORD);
    for (const line of more) expect(line).not.toContain(IMAP_PASSWORD);

    // SMTP failures: same rule.
    const failing = new ImapSmtpMailbox({
      config: MailboxConfigSchema.parse({
        address: AGENT,
        imap: null,
        smtp: { host: "smtp.example.test", user: "alice", passwordRef: "secret:alice_smtp" },
      }),
      secrets: w.secrets,
      granted: new Set(["alice_smtp"]),
      clock: w.clock,
      createTransport: async () => ({
        async sendMail() {
          throw new Error(`535 auth failed for alice:${SMTP_PASSWORD}`);
        },
      }),
    });
    const { result: smtpError, lines: smtpLines } = await captureLogs(async () =>
      failing.send({ to: [STRANGER], subject: "s", text: "t" }).then(
        () => undefined,
        (e: unknown) => e,
      ),
    );
    expect(isForerunnerError(smtpError, "provider_error")).toBe(true);
    expect(String((smtpError as ForerunnerError).cause)).not.toContain(SMTP_PASSWORD);
    for (const line of smtpLines) expect(line).not.toContain(SMTP_PASSWORD);
  });

  it("watch delivers by IMAP IDLE push and by the polling fallback", async () => {
    const w = imapWorld();
    const seen: string[] = [];
    const watch = await w.mailbox.watch(async (m) => void seen.push(m.id), {
      pollIntervalMs: 60_000,
    });
    expect(watch.pushActive).toBe(true);
    const push = w.clients[0];
    expect(push?.connected).toBe(true);
    // Push: the server announces a new message; no clock advance needed.
    w.store.messages.set(1, { raw: RAW_OWNER_MAIL, seen: false });
    push?.emit("exists", { count: 1 });
    await until(() => seen.length === 1, "push delivery");
    expect(seen).toEqual(["1"]);
    expect(w.clients).toHaveLength(1); // the catch-up poll reused the push connection
    // The push connection drops: the poll loop still delivers at the interval.
    push?.emit("close");
    expect(watch.pushActive).toBe(false);
    w.store.messages.set(2, { raw: RAW_OWNER_MAIL.replace("imap1", "imap2"), seen: false });
    await w.clock.advance(59_999);
    await settle();
    expect(seen).toEqual(["1"]);
    await w.clock.advance(1);
    await until(() => seen.length === 2, "poll delivery");
    expect(seen).toEqual(["1", "2"]);
    // After a successful poll the push connection is re-established.
    await until(() => watch.pushActive, "push reconnect");
    await watch.stop();
    expect(watch.pushActive).toBe(false);
  });

  it("watch keeps polling when the push connection cannot be opened", async () => {
    const w = imapWorld();
    w.failNext({ connectError: new Error("IDLE not supported") });
    const seen: string[] = [];
    const { lines } = await captureLogs(async () => {
      const watch = await w.mailbox.watch(async (m) => void seen.push(m.id), {
        pollIntervalMs: 30_000,
        catchUp: false,
      });
      expect(watch.pushActive).toBe(false);
      expect(w.clients).toHaveLength(1);
      w.store.messages.set(3, { raw: RAW_OWNER_MAIL, seen: false });
      await settle();
      expect(seen).toEqual([]);
      await w.clock.advance(30_000);
      await until(() => seen.length === 1, "poll delivery without push");
      expect(seen).toEqual(["3"]);
      // Polling succeeded on a fresh connection, so push is tried again and now works.
      await until(() => watch.pushActive, "push retry");
      await watch.stop();
    });
    expect(lines.some((l) => l.includes("polling only"))).toBe(true);
  });

  it("a failing catch-up poll does not stop the watch", async () => {
    const w = imapWorld();
    // The push connection and the catch-up poll both fail; the interval poll then works.
    w.failNext({ connectError: new Error("busy") }, 2);
    const seen: string[] = [];
    const { lines } = await captureLogs(async () => {
      const watch = await w.mailbox.watch(async (m) => void seen.push(m.id), {
        pollIntervalMs: 30_000,
      });
      expect(watch.pushActive).toBe(false);
      expect(w.clients).toHaveLength(2);
      w.store.messages.set(4, { raw: RAW_OWNER_MAIL, seen: false });
      await w.clock.advance(30_000);
      await until(() => seen.length === 1, "poll after a failed start");
      await until(() => watch.pushActive, "push retry");
      await watch.stop();
    });
    expect(lines.some((l) => l.includes("polling only"))).toBe(true);
    expect(lines.some((l) => l.includes("catch-up poll failed"))).toBe(true);
  });
});
