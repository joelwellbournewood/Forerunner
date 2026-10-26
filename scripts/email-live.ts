#!/usr/bin/env -S pnpm exec tsx
/**
 * email-live: the live check of agent email (L.3; spec "Agent email" and "Email commands") on
 * a real mailbox and a dedicated install, in one command.
 *
 * Usage (from the repository root, credentials in the environment only):
 *   pnpm email:live [--profile <name>] [--wait-minutes <n>] [--dry-run]
 *
 * Environment: FORERUNNER_HOME (required, a directory used for nothing else),
 * FORERUNNER_MAILBOX_ADDRESS (the agent's own mailbox), FORERUNNER_MAILBOX_PASSWORD (its app
 * password or password), FORERUNNER_HUMAN_EMAIL (the human's own address),
 * FORERUNNER_ANTHROPIC_KEY (or FORERUNNER_SUBSCRIPTION_TOKEN) for the command classifier.
 * Optional: FORERUNNER_MAILBOX_IMAP_HOST, FORERUNNER_MAILBOX_IMAP_PORT,
 * FORERUNNER_MAILBOX_SMTP_HOST, FORERUNNER_MAILBOX_SMTP_PORT, FORERUNNER_MAILBOX_USER (default:
 * the address). Without overrides the hosts come from the address domain (Gmail, GMX, WEB.DE;
 * any other domain gets the Gmail hosts, as a Google Workspace address would).
 *
 * Steps, each through the code the product itself uses:
 *  1. refuses unless FORERUNNER_HOME is a dedicated directory and the profile is one of its
 *     own; `runSetup` non-interactively (`fr setup --non-interactive --email <human>`); the
 *     mailbox password goes into the profile's vault as `mailbox_password`, and every
 *     credential variable is then removed from the environment;
 *  2. the sending mode `read_only` through the registry's `email.mode.set` on the daemon app
 *     in process (`POST /commands/execute`, a high-risk change card, confirmed on this PC's
 *     paired device row); the mailbox (by reference, `secret:mailbox_password`) and the
 *     command settings (on, the human's address registered) through the daemon's
 *     `PUT /agents/:id/email/settings`;
 *  3. `Mailbox.verify` on the agent's mailbox: IMAP login and folder list, SMTP login; a
 *     refusal is printed with the likely fix for the provider;
 *  4. one email to the human through `EmailPolicy.send` (the signature, the sent log);
 *  5. the cloud runner's own watcher (`EmailWatch`: IMAP IDLE push and a 30 s poll, the
 *     command gate, the handler) until the human's reply arrives or the wait ends: the reply
 *     must come from the registered address, pass DKIM aligned with its From domain and SPF
 *     (the gate's rules, through `verifierChoice`: Gmail's own Authentication-Results by
 *     default for a Gmail mailbox, `mailauth` with DNS otherwise, or what
 *     FORERUNNER_RUNNER_MAIL_VERIFIER names), and continue the check email's thread (or the
 *     gate ignores it); the handler then answers it
 *     by email. No project exists on this install and the cloud-session port refuses, so a
 *     reply read as a task can only ask which project; nothing runs;
 *  6. prints each step and `EMAIL RESULT: PASS` or `EMAIL RESULT: FAIL <reason>`, and writes
 *     `email-live-report.json` in the home (subject lines only, never a body or a secret);
 *  7. stops the watcher and closes the runtime: nothing keeps running.
 *
 * `--dry-run` runs the same steps offline: an in-process testenv mail server hosts both
 * addresses (DKIM, SPF, Authentication-Results), a scripted human replies "yes", the fake
 * provider classifies, and the vault is in memory. Nothing leaves the machine.
 *
 * Exit code 0 on PASS, 1 on FAIL after the run started, 2 when it refused to run.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type {
  AuthVerdict,
  AuthVerifier,
  CommandOutcome,
  InboundEmail,
  Mailbox,
  MailboxCheck,
  MailboxCheckError,
  MailboxConfig,
  StartCloudSessionPort,
} from "@forerunner/capabilities/email/index";
import { appDirs, errorMessage, isInside, join, Logger, resolve } from "@forerunner/platform";
import type { ModelProvider } from "@forerunner/runtime";
import type { ComposeOptions, RuntimeApp } from "@forerunner/runtime/daemon/compose";
import { readConfig, runSetup, SUBSCRIPTION_TOKEN_ENV } from "@forerunner/runtime/setup/wizard";
import { MemoryVault, openVault, type Vault } from "@forerunner/vault";

export const ADDRESS_ENV = "FORERUNNER_MAILBOX_ADDRESS";
export const PASSWORD_ENV = "FORERUNNER_MAILBOX_PASSWORD";
export const HUMAN_ENV = "FORERUNNER_HUMAN_EMAIL";
export const OVERRIDE_ENV = {
  imapHost: "FORERUNNER_MAILBOX_IMAP_HOST",
  imapPort: "FORERUNNER_MAILBOX_IMAP_PORT",
  smtpHost: "FORERUNNER_MAILBOX_SMTP_HOST",
  smtpPort: "FORERUNNER_MAILBOX_SMTP_PORT",
  user: "FORERUNNER_MAILBOX_USER",
} as const;

/** Every variable whose value is a secret: scrubbed from output, removed once stored. */
export const SECRET_ENV = [
  PASSWORD_ENV,
  "FORERUNNER_ANTHROPIC_KEY",
  SUBSCRIPTION_TOKEN_ENV,
  "FORERUNNER_GITHUB_TOKEN",
] as const;

/** Variables that would point the run at another install's store or human; refused. */
export const FOREIGN_INSTALL_ENV = ["FORERUNNER_STATE_URL", "FORERUNNER_HUMAN"] as const;

/** Written into FORERUNNER_HOME on the first run: the directory belongs to this script. */
export const HOME_MARKER = "email-live.json";
export const REPORT_FILE = "email-live-report.json";
export const RESULT_PREFIX = "EMAIL RESULT:";
/** The vault name of the mailbox password; the settings name it as `secret:mailbox_password`. */
export const MAILBOX_SECRET = "mailbox_password";
export const CHECK_SUBJECT = "Forerunner email check: reply to this email with the word yes";
export const CHECK_TEXT = [
  "This is a check of your Forerunner agent's own mailbox.",
  "Reply to this email with the word yes. Nothing else is needed.",
  "The agent will answer your reply by email.",
].join("\n");
/** The least-permissive mode in which the agent can write to its human and answer commands. */
export const CHECK_MODE = "read_only";
export const DEFAULT_PROFILE = "email-live";
export const DEFAULT_WAIT_MINUTES = 10;
const POLL_MS = 30_000;

const USAGE =
  "usage: pnpm email:live [--profile <name>] [--wait-minutes <n>] [--dry-run]  (credentials in the environment only)";
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ADDRESS_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

// ---------------------------------------------------------------------------------------------
// Mail host profiles

export type MailProvider = "gmail" | "gmx" | "webde" | "custom";

export interface MailHostProfile {
  provider: MailProvider;
  /** How the hosts were picked, for the output. */
  source: string;
  user: string;
  imap: { host: string; port: number; secure: true };
  /** `secure` is implicit TLS (465); otherwise STARTTLS, which the product requires. */
  smtp: { host: string; port: number; secure: boolean };
}

const KNOWN: Record<
  Exclude<MailProvider, "custom">,
  { label: string; imap: string; smtp: string; domains: string[] }
> = {
  gmail: {
    label: "Gmail",
    imap: "imap.gmail.com",
    smtp: "smtp.gmail.com",
    domains: ["gmail.com", "googlemail.com"],
  },
  gmx: {
    label: "GMX",
    imap: "imap.gmx.net",
    smtp: "mail.gmx.net",
    domains: ["gmx.net", "gmx.ch", "gmx.de"],
  },
  webde: { label: "WEB.DE", imap: "imap.web.de", smtp: "smtp.web.de", domains: ["web.de"] },
};

function providerOfHost(host: string): MailProvider {
  const h = host.trim().toLowerCase();
  for (const [name, k] of Object.entries(KNOWN)) if (k.imap === h) return name as MailProvider;
  return "custom";
}

function port(env: NodeJS.ProcessEnv, name: string, fallback: number, problems: string[]): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    problems.push(`${name} must be a port number (1 to 65535).`);
    return fallback;
  }
  return n;
}

/**
 * The mailbox hosts for an address: the overrides first, else the provider the domain names
 * (Gmail, GMX, WEB.DE), else the Gmail hosts (a Google Workspace domain). IMAP is implicit TLS;
 * SMTP on 465 is implicit TLS, on any other port STARTTLS (required by the product).
 */
export function mailHostProfile(
  address: string,
  env: NodeJS.ProcessEnv,
): { profile: MailHostProfile; problems: string[] } {
  const problems: string[] = [];
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const known = (
    Object.entries(KNOWN) as [Exclude<MailProvider, "custom">, (typeof KNOWN)["gmail"]][]
  ).find(([, k]) => k.domains.includes(domain));
  const [baseName, base] = known ?? ["gmail", KNOWN.gmail];
  const imapHost = env[OVERRIDE_ENV.imapHost]?.trim() || base.imap;
  const smtpHost = env[OVERRIDE_ENV.smtpHost]?.trim() || base.smtp;
  const imapPort = port(env, OVERRIDE_ENV.imapPort, 993, problems);
  const smtpPort = port(env, OVERRIDE_ENV.smtpPort, 465, problems);
  const overridden = [
    OVERRIDE_ENV.imapHost,
    OVERRIDE_ENV.imapPort,
    OVERRIDE_ENV.smtpHost,
    OVERRIDE_ENV.smtpPort,
    OVERRIDE_ENV.user,
  ].filter((k) => !!env[k]?.trim());
  const source = known
    ? `${base.label}, from the address domain ${domain}`
    : `${domain} is not a known provider: the Gmail hosts (as for a Google Workspace address)`;
  return {
    profile: {
      provider: env[OVERRIDE_ENV.imapHost]?.trim() ? providerOfHost(imapHost) : baseName,
      source: overridden.length ? `${source}; overridden: ${overridden.join(", ")}` : source,
      user: env[OVERRIDE_ENV.user]?.trim() || address,
      imap: { host: imapHost, port: imapPort, secure: true },
      smtp: { host: smtpHost, port: smtpPort, secure: smtpPort === 465 },
    },
    problems,
  };
}

/** The settings' mailbox block for a profile: the password by reference only. */
export function mailboxSettings(address: string, p: MailHostProfile): MailboxConfig {
  const passwordRef = `secret:${MAILBOX_SECRET}`;
  return {
    address,
    imap: { ...p.imap, user: p.user, passwordRef, folder: "INBOX", draftsFolder: "Drafts" },
    smtp: { ...p.smtp, user: p.user, passwordRef },
  };
}

/**
 * The plain-language fix for a failed connection check, by provider. Matches the servers' own
 * words (Gmail's "Application-specific password required", "not enabled for IMAP", web-login
 * alerts) and the libraries' codes (EAUTH, ENOTFOUND, ECONNREFUSED, TLS errors).
 */
export function mailboxHint(
  provider: MailProvider,
  side: "imap" | "smtp",
  error: MailboxCheckError,
  where: { host: string; port: number; address: string },
): string {
  const text = `${error.code} ${error.message} ${error.serverText ?? ""}`;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text))
    return `The host name ${where.host} does not resolve: check ${side === "imap" ? OVERRIDE_ENV.imapHost : OVERRIDE_ENV.smtpHost} (or leave it unset) and that this PC is online.`;
  if (
    /ECONNREFUSED|ETIMEDOUT|ECONNRESET|ESOCKET|ETIMEOUT|ECONNECTION|EHOSTUNREACH|timed? ?out/i.test(
      text,
    )
  )
    return `Cannot reach ${where.host}:${where.port}: check the port (IMAP 993; SMTP 465 or 587) and that no firewall, VPN or antivirus mail shield blocks it.`;
  if (/certificate|self[- ]signed|wrong version number|SSL|TLS/i.test(text) && !error.authFailed)
    return `TLS failed with ${where.host}:${where.port}: IMAP needs implicit TLS (993); SMTP uses implicit TLS on 465 and STARTTLS on 587. Check the port override.`;
  if (provider === "gmail") {
    if (/application-specific password required|InvalidSecondFactor|5\.7\.9/i.test(text))
      return "Gmail wants an app password: this looks like the account's normal password. Turn on 2-Step Verification, create an app password (Google Account > Security > 2-Step Verification > App passwords) and put its 16 letters in FORERUNNER_MAILBOX_PASSWORD.";
    if (/not enabled for IMAP|IMAP access is disabled|IMAP is disabled/i.test(text))
      return "IMAP is disabled for this Gmail account: Gmail > Settings > See all settings > Forwarding and POP/IMAP > Enable IMAP, save, then run again.";
    if (
      /WEBALERT|web ?login required|log ?in via your web browser|sign in via your web browser/i.test(
        text,
      )
    )
      return `Google blocked the sign-in: sign in to ${where.address} in a browser on this PC, confirm the security alert, then run again with an app password.`;
    if (error.authFailed)
      return "Gmail refused the login. Usual causes: 2-Step Verification is off (app passwords exist only while it is on, and turning it off deletes them), the app password was mistyped or revoked, or the account password was used. Turn on 2-Step Verification, create a new app password and put it in FORERUNNER_MAILBOX_PASSWORD (the spaces Google shows are optional).";
  }
  if (provider === "gmx" && error.authFailed)
    return 'GMX refused the login. In GMX: E-Mail > Einstellungen > POP3/IMAP-Abruf, tick "POP3 und IMAP Zugriff erlauben" and save. Use the account password (an application-specific password if two-factor authentication is on); the user is the full address.';
  if (provider === "webde" && error.authFailed)
    return 'WEB.DE refused the login. In WEB.DE: E-Mail > Einstellungen > POP3/IMAP-Abruf, tick "POP3 und IMAP Zugriff erlauben" and save. Use the account password (an application-specific password if two-factor authentication is on); the user is the full address.';
  if (error.authFailed)
    return `The server refused the login: check ${OVERRIDE_ENV.user} (default: the address), the password, and that IMAP and SMTP access are enabled for the account at the provider.`;
  return `The ${side.toUpperCase()} check failed: ${error.message}${error.serverText ? ` (${error.serverText})` : ""}.`;
}

/**
 * Which of the product's sender verifiers the check runs (the cloud runner's two, ADR 0013):
 * `FORERUNNER_RUNNER_MAIL_VERIFIER` (with `FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS` for `header`)
 * as the runner reads it; unset, a Gmail mailbox believes the header Gmail's own MX stamps
 * (`mx.google.com`, the wiring email.md names for Gmail) and any other host gets `mailauth`,
 * which re-checks DKIM and SPF with DNS (the runner's default).
 */
export function verifierChoice(
  provider: MailProvider,
  env: NodeJS.ProcessEnv,
): { kind: "header"; ids: string[]; name: string } | { kind: "mailauth"; name: string } {
  const kind = env.FORERUNNER_RUNNER_MAIL_VERIFIER?.trim().toLowerCase();
  const ids = (env.FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const header = (list: string[]) => ({
    kind: "header" as const,
    ids: list,
    name: `the Authentication-Results header stamped by ${list.join(", ")} (DKIM aligned with the From domain, SPF)`,
  });
  const mailauth = {
    kind: "mailauth" as const,
    name: "mailauth: DKIM (aligned with the From domain) and SPF re-checked with DNS",
  };
  if (kind === "header" && ids.length > 0) return header(ids);
  if (kind === "mailauth") return mailauth;
  return provider === "gmail" ? header(["mx.google.com"]) : mailauth;
}

// ---------------------------------------------------------------------------------------------
// Preflight

export interface EmailLiveOptions {
  home: string;
  profile: string;
  waitMs: number;
  dryRun: boolean;
  address: string;
  human: string;
  hosts: MailHostProfile;
}

/**
 * The checks before anything is written: the reasons the run is refused (empty: go). Pure
 * apart from reading the directory and the normal install's config.
 */
export function preflight(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): { options: EmailLiveOptions | null; refusals: string[]; help: boolean } {
  const refusals: string[] = [];
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        profile: { type: "string" },
        "wait-minutes": { type: "string" },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    // An unknown flag (a password passed as --password, say) is refused without echoing it.
    const msg = errorMessage(e).split("\n")[0] ?? "bad arguments";
    return {
      options: null,
      refusals: [`${msg.replace(/'[^']*'/g, "an option")}. ${USAGE}`],
      help: false,
    };
  }
  if (values.help) return { options: null, refusals: [], help: true };

  const profile = typeof values.profile === "string" ? values.profile.trim() : DEFAULT_PROFILE;
  if (!profile) refusals.push("--profile needs a name (a profile of its own for this run).");
  else if (profile === "default")
    refusals.push("--profile default is the normal install's vault; pick a profile of its own.");
  else if (!PROFILE_RE.test(profile))
    refusals.push("--profile takes letters, digits, '-' and '_' (at most 64).");

  const homeRaw = env.FORERUNNER_HOME?.trim();
  let home = "";
  if (!homeRaw) {
    refusals.push(
      "FORERUNNER_HOME is not set: point it at a directory used for nothing but this check, so the normal install is never touched.",
    );
  } else {
    home = resolve(homeRaw);
    const { FORERUNNER_HOME: _drop, ...normalEnv } = env;
    const normal = appDirs({ env: normalEnv });
    if (Object.values(normal).some((d) => isInside(d, home) || isInside(home, d)))
      refusals.push(
        `FORERUNNER_HOME ${home} overlaps the normal install's directories; use a separate directory.`,
      );
    const userHome = env.HOME ?? env.USERPROFILE;
    if (userHome && isInside(home, userHome))
      refusals.push("FORERUNNER_HOME is your home directory; use a directory of its own.");
    if (existsSync(home)) {
      const entries = readdirSync(home);
      const markerPath = join(home, HOME_MARKER);
      if (entries.length > 0 && !existsSync(markerPath))
        refusals.push(
          `FORERUNNER_HOME ${home} is not empty and was not made by this script (no ${HOME_MARKER}); use an empty or new directory.`,
        );
      else if (existsSync(markerPath)) {
        try {
          const m = JSON.parse(readFileSync(markerPath, "utf8")) as { profile?: unknown };
          if (m.profile !== profile)
            refusals.push(
              `FORERUNNER_HOME ${home} belongs to profile ${String(m.profile)}, not ${profile}.`,
            );
        } catch {
          refusals.push(`${markerPath} is unreadable; use an empty or new directory.`);
        }
      }
    }
    const normalConfig = readConfig(normal);
    if (normalConfig && normalConfig.profile === profile)
      refusals.push(
        `profile ${profile} is the normal install's profile; pick a profile of its own.`,
      );
  }

  const address = env[ADDRESS_ENV]?.trim().toLowerCase() ?? "";
  const human = env[HUMAN_ENV]?.trim().toLowerCase() ?? "";
  if (!address) refusals.push(`${ADDRESS_ENV} is not set: the agent's own mailbox address.`);
  else if (!ADDRESS_RE.test(address)) refusals.push(`${ADDRESS_ENV} is not an email address.`);
  if (!env[PASSWORD_ENV]?.trim())
    refusals.push(`${PASSWORD_ENV} is not set: the mailbox's app password (or password).`);
  if (!human)
    refusals.push(`${HUMAN_ENV} is not set: your own address, which the agent writes to.`);
  else if (!ADDRESS_RE.test(human)) refusals.push(`${HUMAN_ENV} is not an email address.`);
  if (address && address === human)
    refusals.push(
      `${ADDRESS_ENV} and ${HUMAN_ENV} are the same address: the agent needs its own mailbox, never yours.`,
    );

  let waitMs = DEFAULT_WAIT_MINUTES * 60_000;
  if (typeof values["wait-minutes"] === "string") {
    const n = Number(values["wait-minutes"]);
    if (!Number.isFinite(n) || n <= 0 || n > 60)
      refusals.push("--wait-minutes must be a number of minutes above 0 and at most 60.");
    else waitMs = Math.round(n * 60_000);
  }

  for (const name of FOREIGN_INSTALL_ENV)
    if (env[name]?.trim())
      refusals.push(`${name} is set: it would bind the run to another install; unset it.`);

  const { profile: hosts, problems } = mailHostProfile(address || "x@gmail.com", env);
  refusals.push(...problems);

  if (refusals.length > 0) return { options: null, refusals, help: false };
  return {
    options: { home, profile, waitMs, dryRun: values["dry-run"] === true, address, human, hosts },
    refusals,
    help: false,
  };
}

// ---------------------------------------------------------------------------------------------
// The run

export interface StepRecord {
  step: number;
  name: string;
  ok: boolean;
  lines: string[];
}

export interface EmailLiveReport {
  result: "PASS" | "FAIL";
  reason: string | null;
  dryRun: boolean;
  profile: string;
  provider: MailProvider;
  agentAddress: string;
  humanAddress: string;
  mode: typeof CHECK_MODE;
  startedAt: string;
  finishedAt: string;
  steps: StepRecord[];
  checkEmail: { subject: string; messageId: string } | null;
  reply: {
    subject: string;
    from: string | null;
    receivedAt: string;
    gate: { obeyed: boolean; reason: string; via: string | null };
    auth: {
      dkim: string;
      aligned: boolean;
      spf: string;
      source: string;
      dkimDomain: string | null;
    };
    mailHost: {
      authservId: string;
      dkim: string | null;
      spf: string | null;
      dmarc: string | null;
    } | null;
    outcome: string;
    answerSubject: string | null;
  } | null;
}

/** How the dry run's scripted human answers (tests pick the other two). */
export type DryRunReply = "genuine" | "spoofed" | "none";

export interface EmailLiveDeps {
  /** The environment (credentials included); the entry point passes `process.env`. */
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  /** The profile's vault; default `openVault` live, a MemoryVault in a dry run. */
  openVault?: (profile: string, env: NodeJS.ProcessEnv) => Promise<Vault>;
  /** fetch for the setup's credential check (tests point it at a stand-in). */
  setupFetch?: typeof fetch;
  /** Extra compose options (tests: no container probe). */
  compose?: Partial<ComposeOptions>;
  /** Dry run only: what the scripted human does with the check email. */
  dryRunReply?: DryRunReply;
}

/** Every secret value in `env` (empty ones ignored), longest first. */
function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = SECRET_ENV.flatMap((k) => {
    const v = env[k]?.trim();
    return v ? [v, v.replace(/\s+/g, "")] : [];
  });
  return [...new Set(values)].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
}

function scrub(line: string, secrets: readonly string[]): string {
  let s = line;
  for (const v of secrets) s = s.split(v).join("[REDACTED]");
  return s;
}

/** The ids a reply names as its direct parent (the gate's rule): In-Reply-To, else the last Reference. */
function parentIds(message: InboundEmail): string[] {
  const clean = (s: string) => s.trim().replace(/^<|>$/g, "").toLowerCase();
  const direct = (message.inReplyTo ?? "").split(/\s+/).map(clean).filter(Boolean);
  if (direct.length) return direct;
  const last = message.references.at(-1);
  return last ? [clean(last)] : [];
}

/** Outcomes that answer the human by email and are the right reading of a "yes". */
const ANSWERED = new Set(["question", "unclear", "task_needs_project", "note"]);

function outcomeReply(o: CommandOutcome): string | null {
  if ("replyMessageId" in o) return o.replyMessageId ?? null;
  if ("ackMessageId" in o) return o.ackMessageId ?? null;
  return null;
}

/** The dry run's mail world: one in-process server hosting both addresses. */
interface DryWorld {
  mailbox: () => Promise<Mailbox>;
  verifier: AuthVerifier;
  provider: ModelProvider;
  humanReplies: (checkMessageId: string) => Promise<void>;
  stop: () => Promise<void>;
}

async function dryWorld(
  o: EmailLiveOptions,
  clock: RuntimeApp["clock"],
  mode: DryRunReply,
): Promise<DryWorld> {
  const testenv = await import("@forerunner/testenv");
  const { TestMailbox, AuthResultsHeaderVerifier } = await import(
    "@forerunner/capabilities/email/index"
  );
  const domains = [...new Set([o.address, o.human].map((a) => a.slice(a.indexOf("@") + 1)))];
  const server = await testenv.LocalMailServer.start({
    domains,
    dkim: { selector: "fr1", ...testenv.generateDkimKeyPair(1024) },
    clock,
  });
  // Stand-in passwords, never the real one: the stand-in has no reason to see it.
  const pw = (who: string) => ["dry", who, String(clock.now())].join("-");
  server.createMailbox(o.address, pw("agent"));
  server.createMailbox(o.human, pw("human"));
  const provider = new testenv.FakeProvider({
    clock,
    latency: "none",
    onNoMatch: "throw",
    replies: [
      testenv.textReply(
        JSON.stringify({
          kind: "question",
          project: null,
          title: "Email check",
          summary: "The owner confirms the email check.",
          answer: "Thanks, your reply reached me and I could answer it: agent email works.",
        }),
        { times: Number.POSITIVE_INFINITY },
      ),
    ],
  });
  return {
    mailbox: async () => new TestMailbox({ server, address: o.address, clock }),
    verifier: new AuthResultsHeaderVerifier({ trustedAuthservIds: [server.authservId] }),
    provider,
    humanReplies: async (checkMessageId) => {
      if (mode === "none") return;
      const reply = {
        from: o.human,
        to: o.address,
        subject: `Re: ${CHECK_SUBJECT}`,
        text: `yes\n\nOn the check email, the agent wrote:\n> ${CHECK_TEXT.split("\n").join("\n> ")}\n`,
        inReplyTo: `<${checkMessageId}>`,
        references: [`<${checkMessageId}>`],
      };
      if (mode === "spoofed") await server.inject(reply, { skipSigning: true });
      else await server.sendFrom(o.human, { ...reply });
    },
    stop: () => server.stop(),
  };
}

export async function emailLive(argv: readonly string[], deps: EmailLiveDeps): Promise<number> {
  const secrets = secretValues(deps.env);
  const out = (line: string) => deps.out(scrub(line, secrets));
  const final = (pass: boolean, reason: string | null, code: number): number => {
    out(`${RESULT_PREFIX} ${pass ? "PASS" : "FAIL"}${reason ? ` ${reason}` : ""}`);
    return code;
  };

  let pre: ReturnType<typeof preflight>;
  try {
    pre = preflight(argv, deps.env);
  } catch (e) {
    out(`refused: the checks before the run failed: ${errorMessage(e)}`);
    return final(false, "refused: the checks before the run failed", 2);
  }
  if (pre.help) {
    out(USAGE);
    return 0;
  }
  if (!pre.options) {
    for (const r of pre.refusals) out(`refused: ${r}`);
    return final(false, `refused: ${pre.refusals[0] ?? "see above"}`, 2);
  }
  const o = pre.options;
  out(
    `Live email check (L.3)${o.dryRun ? " - DRY RUN, in-process mail server, nothing leaves this machine" : ""}`,
  );
  out(`  install home: ${o.home} (profile ${o.profile})`);
  out(`  agent mailbox: ${o.address}; your address: ${o.human}`);
  out(
    `  mail hosts: IMAP ${o.hosts.imap.host}:${o.hosts.imap.port} (TLS), SMTP ${o.hosts.smtp.host}:${o.hosts.smtp.port} (${o.hosts.smtp.secure ? "TLS" : "STARTTLS"}), user ${o.hosts.user}`,
  );
  out(
    `    (${o.hosts.source}${o.dryRun ? "; the dry run talks to an in-process stand-in instead" : ""})`,
  );
  out(
    `  sending mode: ${CHECK_MODE} (the agent can write to you only; your mail can be a command)`,
  );

  const steps: StepRecord[] = [];
  const step = (n: number, name: string): StepRecord => {
    const s: StepRecord = { step: n, name, ok: false, lines: [] };
    steps.push(s);
    out(`${n}. ${name}`);
    return s;
  };
  const say = (s: StepRecord, line: string) => {
    s.lines.push(scrub(line, secrets));
    out(`   ${line}`);
  };

  const runtimeEnv: NodeJS.ProcessEnv = { ...deps.env, FORERUNNER_HOME: o.home };
  let rt: RuntimeApp | null = null;
  let world: DryWorld | null = null;
  let watch: { stop(): Promise<void> } | null = null;
  let stopTicker: (() => void) | null = null;
  const report: Omit<EmailLiveReport, "result" | "reason" | "finishedAt"> = {
    dryRun: o.dryRun,
    profile: o.profile,
    provider: o.hosts.provider,
    agentAddress: o.address,
    humanAddress: o.human,
    mode: CHECK_MODE,
    startedAt: "",
    steps,
    checkEmail: null,
    reply: null,
  };
  let reportPath: string | null = null;
  const finish = (pass: boolean, reason: string | null, code: number): number => {
    if (reportPath && rt) {
      const full: EmailLiveReport = {
        ...report,
        result: pass ? "PASS" : "FAIL",
        reason,
        finishedAt: rt.clock.nowIso(),
      };
      try {
        writeFileSync(reportPath, `${scrub(JSON.stringify(full, null, 2), secrets)}\n`);
        out(`Report: ${reportPath}`);
      } catch (e) {
        out(`the report could not be written: ${errorMessage(e)}`);
      }
    }
    // The result line is printed after the cleanup (finally), so it is the last line.
    verdict = { pass, reason };
    return code;
  };
  let verdict: { pass: boolean; reason: string | null } | null = null;

  try {
    mkdirSync(o.home, { recursive: true });
    const markerPath = join(o.home, HOME_MARKER);
    if (!existsSync(markerPath))
      writeFileSync(
        markerPath,
        `${JSON.stringify({ profile: o.profile, purpose: "scripts/email-live.ts (L.3 live check)" }, null, 2)}\n`,
      );
    const dirs = appDirs({ env: runtimeEnv });

    // 1. Setup, the vault, and the environment cleared.
    const s1 = step(1, "fr setup --non-interactive; the mailbox password into the vault");
    const vault = deps.openVault
      ? await deps.openVault(o.profile, runtimeEnv)
      : o.dryRun
        ? new MemoryVault()
        : await openVault({ profile: o.profile, env: runtimeEnv });
    // The check needs the model credential (the command classifier) and nothing of GitHub; a
    // dry run hands setup no credential at all, so it makes no network call.
    const setupEnv: NodeJS.ProcessEnv = { ...runtimeEnv };
    delete setupEnv.FORERUNNER_GITHUB_TOKEN;
    delete setupEnv[PASSWORD_ENV];
    if (o.dryRun) {
      delete setupEnv.FORERUNNER_ANTHROPIC_KEY;
      delete setupEnv[SUBSCRIPTION_TOKEN_ENV];
    }
    const setup = await runSetup(vault, {
      nonInteractive: true,
      profile: o.profile,
      humanEmail: o.human,
      env: setupEnv,
      dirs,
      ...(deps.setupFetch ? { fetchImpl: deps.setupFetch } : {}),
    });
    const rawPassword = deps.env[PASSWORD_ENV]?.trim() ?? "";
    // Gmail shows an app password in four groups of four; the spaces are not part of it.
    const password = o.hosts.provider === "gmail" ? rawPassword.replace(/\s+/g, "") : rawPassword;
    await vault.set(MAILBOX_SECRET, password);
    for (const k of SECRET_ENV) {
      delete runtimeEnv[k];
      if (deps.env === process.env) delete process.env[k];
    }
    say(s1, `config ${setup.configPath}; vault ${vault.backend}`);
    for (const [k, r] of Object.entries(setup.results))
      say(s1, `${k}: ${r.ok ? "ok" : "needs changes"} - ${r.summary}`);
    say(
      s1,
      `stored in the vault: ${[...setup.stored, MAILBOX_SECRET].join(", ")} (values never printed)`,
    );
    say(
      s1,
      `credential variables removed from this process's environment: ${SECRET_ENV.join(", ")}`,
    );
    const hasModel = setup.sources.apiKey || setup.sources.subscription;
    if (!o.dryRun && !hasModel) {
      say(
        s1,
        "no Anthropic credential: set FORERUNNER_ANTHROPIC_KEY in .env.build (the agent needs it to read your reply)",
      );
      return finish(false, "setup: no Anthropic credential stored", 2);
    }
    s1.ok = true;

    // The runtime, as every `fr` one-shot composes it, with this PC as a paired device so the
    // high-risk mode change can be confirmed on it.
    const { composeRuntime } = await import("@forerunner/runtime/daemon/compose");
    const { createDaemonApp } = await import("@forerunner/runtime/daemon/server");
    const { systemClock } = await import("@forerunner/platform");
    world = o.dryRun
      ? await dryWorld(o, deps.compose?.clock ?? systemClock, deps.dryRunReply ?? "genuine")
      : null;
    const dry = world;
    rt = await composeRuntime({
      env: runtimeEnv,
      dirs,
      vault,
      startServices: false,
      remote: { enabled: true },
      ...(dry
        ? {
            provider: dry.provider,
            notifications: { mailboxFactory: () => dry.mailbox() },
          }
        : {}),
      ...deps.compose,
    });
    const app = rt;
    report.startedAt = app.clock.nowIso();
    reportPath = join(o.home, REPORT_FILE);
    const agentId = app.agent.id;
    const { app: daemon, token } = createDaemonApp(app);
    const call = async (path: string, method: string, body?: unknown) => {
      const res = await daemon.request(path, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: res.status, json };
    };
    const errText = (j: Record<string, unknown>) => {
      const e = j.error as { message?: unknown } | undefined;
      return String(e?.message ?? j.reason ?? j.sentence ?? JSON.stringify(j));
    };

    // 2. The mode through the registry, then the mailbox and the commands through the route.
    const s2 = step(
      2,
      `configure the agent's mailbox, sending mode ${CHECK_MODE}, your address for commands`,
    );
    const settingsPath = `/agents/${agentId}/email/settings`;
    const before = await call(settingsPath, "GET");
    const currentMode = (before.json.settings as { mode?: unknown } | undefined)?.mode;
    if (currentMode === CHECK_MODE)
      say(s2, `sending mode already ${CHECK_MODE} (a rerun): no change`);
    else {
      const pending = await call("/commands/execute", "POST", {
        commands: [{ name: "email.mode.set", params: { mode: CHECK_MODE, agent: agentId } }],
        wordsUsed: `email live check: email mode to ${CHECK_MODE}`,
        source: "ui",
      });
      if (pending.json.status !== "pending" || pending.json.decision !== "needs_device") {
        say(
          s2,
          `email.mode.set answered ${pending.status} ${String(pending.json.status)}: ${errText(pending.json)}`,
        );
        return finish(false, "configure: the mode change was not offered as a change card", 1);
      }
      say(
        s2,
        `change card (email.mode.set, high risk): ${String(pending.json.readback ?? pending.json.sentence ?? "email mode")}`,
      );
      say(s2, "confirming on this PC's paired device row (the confirmation the spec asks for)");
      const done = await call(`/commands/${String(pending.json.pendingId)}/confirm`, "POST", {
        answer: "device",
      });
      if (done.json.status !== "done") {
        say(s2, `the confirmation answered ${String(done.json.status)}: ${errText(done.json)}`);
        return finish(false, "configure: the mode change was refused", 1);
      }
      say(s2, String(done.json.sentence ?? `mode set to ${CHECK_MODE}`));
    }
    const put = await call(settingsPath, "PUT", {
      settings: { mailbox: mailboxSettings(o.address, o.hosts) },
      commands: { enabled: true, registeredHumanAddress: o.human },
    });
    if (put.status !== 200) {
      say(s2, `PUT ${settingsPath} answered ${put.status}: ${errText(put.json)}`);
      return finish(false, "configure: the mailbox settings were refused", 1);
    }
    const stored = put.json as {
      settings?: { mode?: string; mailbox?: { address?: string } | null };
      commands?: { enabled?: boolean; registeredHumanAddress?: string | null };
    };
    say(
      s2,
      `mailbox ${stored.settings?.mailbox?.address ?? "?"}, password secret:${MAILBOX_SECRET}; mode ${stored.settings?.mode ?? "?"}`,
    );
    say(
      s2,
      `email commands ${stored.commands?.enabled ? "on" : "off"}, obeying ${stored.commands?.registeredHumanAddress ?? "nobody"}`,
    );
    if (stored.settings?.mode !== CHECK_MODE || !stored.commands?.enabled) {
      return finish(false, "configure: the settings read back differ", 1);
    }
    s2.ok = true;

    // 3. Both connections.
    const s3 = step(3, "check the connections: IMAP login and folder list, SMTP login");
    const mailbox = await app.capabilities.email.ports.mailboxFor(agentId);
    if (!mailbox.verify) return finish(false, "connections: this mailbox cannot be checked", 1);
    const check = await mailbox.verify();
    const describe = (side: "imap" | "smtp", c: MailboxCheck) => {
      const where = side === "imap" ? o.hosts.imap : o.hosts.smtp;
      const at = dry
        ? `${where.host}:${where.port} (the in-process stand-in)`
        : `${where.host}:${where.port}`;
      if (c.ok) {
        say(
          s3,
          side === "imap"
            ? `IMAP ${at}: logged in; folders: ${(c.folders ?? []).join(", ") || "(none listed)"}`
            : `SMTP ${at}: logged in`,
        );
        return;
      }
      const e = c.error ?? { code: "error", message: "unknown", authFailed: false };
      say(
        s3,
        `${side.toUpperCase()} ${where.host}:${where.port}: FAILED (${e.code}) ${e.serverText ?? e.message}`,
      );
      say(s3, `fix: ${mailboxHint(o.hosts.provider, side, e, { ...where, address: o.address })}`);
    };
    describe("imap", check.imap);
    describe("smtp", check.smtp);
    if (!check.imap.ok || !check.smtp.ok) {
      const failed = [!check.imap.ok ? "IMAP" : "", !check.smtp.ok ? "SMTP" : ""].filter(Boolean);
      return finish(
        false,
        `connections: ${failed.join(" and ")} login failed (see the fix above)`,
        1,
      );
    }
    s3.ok = true;

    // 5 (started before 4, so nothing that arrives is missed): the runner's watcher.
    const { EmailWatch } = await import("@forerunner/cloud-runner/email-watch");
    const { MailauthVerifier, AuthResultsHeaderVerifier, pollLoop } = await import(
      "@forerunner/capabilities/email/index"
    );
    const { modelIdFor, pricingFor } = await import("@forerunner/runtime");
    const provider = app.provider;
    if (!provider) return finish(false, "watch: no model provider to read the reply with", 1);
    const verdicts = new WeakMap<InboundEmail, AuthVerdict>();
    const choice = verifierChoice(o.hosts.provider, runtimeEnv);
    let base: AuthVerifier;
    let verifierName: string;
    if (dry) {
      base = dry.verifier;
      verifierName = "the stand-in's Authentication-Results header";
    } else if (choice.kind === "header") {
      base = new AuthResultsHeaderVerifier({ trustedAuthservIds: choice.ids });
      verifierName = choice.name;
    } else {
      let m: Promise<InstanceType<typeof MailauthVerifier>> | null = null;
      base = {
        verify: async (msg) => {
          m ??= MailauthVerifier.create();
          return (await m).verify(msg);
        },
      };
      verifierName = choice.name;
    }
    const verifier: AuthVerifier = {
      verify: async (msg) => {
        const v = await base.verify(msg);
        verdicts.set(msg, v);
        return v;
      },
    };
    const refusingCloud: StartCloudSessionPort = {
      start: async () => {
        throw new Error("the email live check starts no cloud session");
      },
    };
    let checkMessageId = "";
    let others = 0;
    let resolveReply: (r: { outcome: CommandOutcome; message: InboundEmail }) => void = () =>
      undefined;
    const replied = new Promise<{ outcome: CommandOutcome; message: InboundEmail }>((r) => {
      resolveReply = r;
    });
    const watcher = new EmailWatch({
      store: app.store,
      clock: app.clock,
      vault,
      provider,
      agentId,
      humanId: app.human.id,
      cloud: refusingCloud,
      pricing:
        provider.name === "anthropic"
          ? pricingFor(modelIdFor("sonnet", provider.name))
          : { estimate: (i, x) => i + x, cost: (u) => u.input_tokens + u.output_tokens },
      estimateModel: modelIdFor("sonnet", provider.name),
      classifierModel: modelIdFor("haiku", provider.name),
      rates: { chfPerUsd: async () => app.chfPerUsd() },
      dataDir: dirs.data,
      pollIntervalMs: POLL_MS,
      push: true,
      verifier,
      ...(dry ? { mailboxFactory: () => dry.mailbox() } : {}),
      onOutcome: (outcome, message) => {
        if (
          checkMessageId &&
          message.from === o.human &&
          parentIds(message).includes(checkMessageId)
        )
          resolveReply({ outcome, message });
        else others++;
      },
    });
    watch = watcher;

    // 4. The check email.
    const s4 = step(4, "send the check email to you");
    const state = await watcher.start();
    if (state.state !== "watching") {
      say(s4, `the mailbox watcher did not start: ${state.reason}`);
      return finish(false, `watch: ${state.reason}`, 1);
    }
    const sent = await app.capabilities.email.ports.policy.send(
      { to: [o.human], subject: CHECK_SUBJECT, text: CHECK_TEXT },
      { agentId, humanId: app.human.id },
    );
    if (sent.status !== "sent") {
      say(s4, `not sent: ${sent.status} (${"reason" in sent ? String(sent.reason) : ""})`);
      return finish(false, `send: the policy answered ${sent.status}`, 1);
    }
    checkMessageId = sent.messageId.toLowerCase();
    report.checkEmail = { subject: CHECK_SUBJECT, messageId: sent.messageId };
    say(
      s4,
      `sent to ${o.human}: "${CHECK_SUBJECT}" (Message-ID ${sent.messageId}, signature on, logged in the sent log)`,
    );
    s4.ok = true;

    // 5. The reply.
    const span =
      o.waitMs >= 60_000
        ? `${Math.round(o.waitMs / 60_000)} min`
        : `${Math.max(1, Math.round(o.waitMs / 1000))} s`;
    const s5 = step(5, `wait up to ${span} for your reply and answer it`);
    say(
      s5,
      `watching ${o.address} (push ${state.pushActive ? "on" : "off"}, a poll every ${POLL_MS / 1000} s); sender check: ${verifierName}`,
    );
    if (!dry) say(s5, `open the email "${CHECK_SUBJECT}" in ${o.human} and reply with: yes`);
    let cancelTimeout: () => void = () => undefined;
    const timedOut = new Promise<null>((r) => {
      cancelTimeout = app.clock.setTimeout(() => r(null), o.waitMs);
    });
    const startedWait = app.clock.now();
    if (!dry)
      stopTicker = pollLoop(app.clock, 60_000, async () => {
        const left = Math.max(0, Math.round((o.waitMs - (app.clock.now() - startedWait)) / 60_000));
        out(`   still waiting for your reply (about ${left} min left)`);
      });
    if (dry) await dry.humanReplies(sent.messageId);
    const got = await Promise.race([replied, timedOut]);
    cancelTimeout();
    stopTicker?.();
    stopTicker = null;
    if (!got) {
      const more =
        others > 0
          ? `; ${others} other message${others === 1 ? "" : "s"} arrived and were handled as data or earlier mail`
          : "";
      say(s5, `no reply to the check email within ${span}${more}`);
      return finish(
        false,
        `reply: none within ${span} (reply to the check email itself, from ${o.human})`,
        1,
      );
    }
    const { outcome, message } = got;
    const v = verdicts.get(message);
    const auth = v
      ? {
          dkim: v.dkim,
          aligned: v.aligned,
          spf: v.spf,
          source: v.source,
          dkimDomain: v.dkimDomain ?? null,
        }
      : { dkim: "none", aligned: false, spf: "none", source: "none", dkimDomain: null };
    const host = message.authResults
      ? {
          authservId: message.authResults.authservId,
          dkim: message.authResults.dkim ?? null,
          spf: message.authResults.spf ?? null,
          dmarc: message.authResults.dmarc ?? null,
        }
      : null;
    const obeyed = outcome.kind !== "ignored";
    const answer = outcomeReply(outcome);
    report.reply = {
      subject: message.subject,
      from: message.from,
      receivedAt: message.receivedAt,
      gate: {
        obeyed,
        reason: outcome.kind === "ignored" ? outcome.reason : "ok",
        via: obeyed ? "thread" : null,
      },
      auth,
      mailHost: host,
      outcome: outcome.kind,
      // The handler's own rule: a subject that starts with "Re:" is kept as it is.
      answerSubject: answer
        ? /^re:/i.test(message.subject.trim())
          ? message.subject.trim()
          : `Re: ${message.subject.trim()}`
        : null,
    };
    say(
      s5,
      `received: "${message.subject}" from ${message.from ?? "?"}, a reply in the check email's thread`,
    );
    say(
      s5,
      `sender check (${auth.source}): DKIM ${auth.dkim}${auth.dkimDomain ? ` for ${auth.dkimDomain}` : ""}, aligned with the From domain: ${auth.aligned ? "yes" : "no"}, SPF ${auth.spf}`,
    );
    if (host)
      say(
        s5,
        `the mail host's own Authentication-Results (${host.authservId}, shown as data): dkim=${host.dkim ?? "-"} spf=${host.spf ?? "-"} dmarc=${host.dmarc ?? "-"}`,
      );
    if (outcome.kind === "ignored") {
      say(s5, `the reply was NOT accepted as yours: ${outcome.reason}`);
      return finish(false, `reply: ignored by the sender check (${outcome.reason})`, 1);
    }
    say(
      s5,
      `recognised as from the registered human ${o.human}; routed as an email command: ${outcome.kind}`,
    );
    if (!ANSWERED.has(outcome.kind) || !answer) {
      say(s5, answer ? `answered, but as ${outcome.kind}` : "the agent's answer was not sent");
      return finish(
        false,
        `reply: handled as ${outcome.kind}${answer ? "" : ", no answer sent"}`,
        1,
      );
    }
    say(s5, `the agent answered by email: "${report.reply.answerSubject}" (Message-ID ${answer})`);
    s5.ok = true;
    return finish(true, null, 0);
  } catch (e) {
    out(`error: ${errorMessage(e)}`);
    return finish(false, `error: ${errorMessage(e).split("\n")[0]}`, rt ? 1 : 2);
  } finally {
    // 7. Nothing keeps running: the ticker, the watcher (its IDLE connection and poll), the
    // runtime (the store), and the dry run's mail server.
    stopTicker?.();
    await watch?.stop().catch(() => undefined);
    await rt?.close().catch(() => undefined);
    await world?.stop().catch(() => undefined);
    if (rt)
      out("Stopped: the mailbox watcher and the runtime are closed; nothing is left running.");
    const v = verdict as { pass: boolean; reason: string | null } | null;
    final(v?.pass ?? false, v ? v.reason : "error", 0);
  }
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  // The steps are the output; the runtime's own info and warning lines (no container engine,
  // unmapped specialist tools) are noise here. FORERUNNER_LOG_LEVEL still wins when set.
  if (!process.env.FORERUNNER_LOG_LEVEL) Logger.setLevel("error");
  emailLive(process.argv.slice(2), { env: process.env, out: (l) => console.log(l) }).then(
    (code) => {
      process.exitCode = code;
      // Everything was stopped and closed; a socket a library still holds must not keep the
      // launcher's window waiting. The timer does not itself keep the process alive.
      setTimeout(() => {
        console.log("note: a connection was still open after the check; exiting anyway");
        process.exit(code);
      }, 5_000).unref();
    },
    // emailLive catches everything it runs; this last resort never echoes the error.
    () => {
      console.log(`${RESULT_PREFIX} FAIL error`);
      process.exitCode = 2;
    },
  );
}
