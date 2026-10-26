/**
 * scripts/email-live.ts (L.3 live check): the mail host inference and its overrides, the
 * provider-specific fixes for a refused login, the refusals before anything is written, and
 * the whole path offline in `--dry-run`: setup into a vault, the sending mode through the
 * registry's `email.mode.set` card confirmed on this PC's device row, the mailbox and the
 * commands through the daemon's PUT, `Mailbox.verify`, the check email through the policy,
 * the cloud runner's `EmailWatch` over the testenv mail server (DKIM, SPF,
 * Authentication-Results) and the handler's answer. A spoofed reply and no reply fail; no
 * secret appears in any printed line, the report or any file under the home; the credential
 * variables are gone from `process.env` afterwards.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { type ImapClientLike, ImapSmtpMailbox } from "@forerunner/capabilities/email/index";
import { join, systemClock } from "@forerunner/platform";
import { FakeProvider } from "@forerunner/testenv";
import { MemoryVault, SecretResolver } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import {
  CHECK_MODE,
  CHECK_SUBJECT,
  type EmailLiveReport,
  emailLive,
  HOME_MARKER,
  MAILBOX_SECRET,
  mailboxHint,
  mailboxSettings,
  mailHostProfile,
  PASSWORD_ENV,
  preflight,
  REPORT_FILE,
  RESULT_PREFIX,
  verifierChoice,
} from "./email-live.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");
const temps: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function lines() {
  const out: string[] = [];
  return { out, sink: (l: string) => void out.push(l) };
}
const resultOf = (out: string[]) =>
  out
    .find((l) => l.startsWith(RESULT_PREFIX))
    ?.slice(RESULT_PREFIX.length)
    .trim();

const AGENT = "fr.agent.check@gmail.com";
const HUMAN = "j@example.ch";
// Shaped like a Gmail app password at run time only, so the secret scan has nothing to flag.
const APP_PASSWORD = ["abcd", "efgh", "ijkl", "mnop"].join(" ");
const ANTHROPIC = ["sk", "ant", "api03", "k".repeat(40), "Zq7"].join("-");

describe("mailHostProfile: the hosts from the address, and the overrides", () => {
  it("infers Gmail, GMX and WEB.DE from the domain; any other domain gets the Gmail hosts", () => {
    const cases: Array<[string, string, string, string]> = [
      ["a@gmail.com", "gmail", "imap.gmail.com", "smtp.gmail.com"],
      ["a@googlemail.com", "gmail", "imap.gmail.com", "smtp.gmail.com"],
      ["a@gmx.net", "gmx", "imap.gmx.net", "mail.gmx.net"],
      ["a@gmx.ch", "gmx", "imap.gmx.net", "mail.gmx.net"],
      ["a@GMX.de", "gmx", "imap.gmx.net", "mail.gmx.net"],
      ["a@web.de", "webde", "imap.web.de", "smtp.web.de"],
      ["a@workspace.example", "gmail", "imap.gmail.com", "smtp.gmail.com"],
    ];
    for (const [address, provider, imap, smtp] of cases) {
      const { profile, problems } = mailHostProfile(address, {});
      expect(problems).toEqual([]);
      expect(profile).toMatchObject({
        provider,
        user: address,
        imap: { host: imap, port: 993, secure: true },
        smtp: { host: smtp, port: 465, secure: true },
      });
    }
    expect(mailHostProfile("a@workspace.example", {}).profile.source).toMatch(
      /not a known provider: the Gmail hosts/,
    );
  });

  it("the overrides win; 465 is implicit TLS, 587 STARTTLS; the provider follows the IMAP host", () => {
    const { profile, problems } = mailHostProfile("agent@gmx.ch", {
      FORERUNNER_MAILBOX_IMAP_HOST: "mail.example.org",
      FORERUNNER_MAILBOX_IMAP_PORT: "1993",
      FORERUNNER_MAILBOX_SMTP_HOST: "smtp.example.org",
      FORERUNNER_MAILBOX_SMTP_PORT: "587",
      FORERUNNER_MAILBOX_USER: "agent-login",
    });
    expect(problems).toEqual([]);
    expect(profile).toMatchObject({
      provider: "custom",
      user: "agent-login",
      imap: { host: "mail.example.org", port: 1993, secure: true },
      smtp: { host: "smtp.example.org", port: 587, secure: false },
    });
    expect(profile.source).toContain("overridden: FORERUNNER_MAILBOX_IMAP_HOST");
    // A Gmail address pointed at the GMX hosts gets GMX's hints.
    expect(
      mailHostProfile("a@gmail.com", { FORERUNNER_MAILBOX_IMAP_HOST: "imap.gmx.net" }).profile
        .provider,
    ).toBe("gmx");
    // Only the SMTP port: the inferred host stays.
    expect(
      mailHostProfile("a@web.de", { FORERUNNER_MAILBOX_SMTP_PORT: "587" }).profile.smtp,
    ).toEqual({ host: "smtp.web.de", port: 587, secure: false });
    expect(
      mailHostProfile("a@gmail.com", { FORERUNNER_MAILBOX_SMTP_PORT: "smtp" }).problems,
    ).toEqual(["FORERUNNER_MAILBOX_SMTP_PORT must be a port number (1 to 65535)."]);
  });

  it("the settings' mailbox names the password by reference only", () => {
    const { profile } = mailHostProfile("a@gmail.com", {});
    expect(mailboxSettings("a@gmail.com", profile)).toEqual({
      address: "a@gmail.com",
      imap: {
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        user: "a@gmail.com",
        passwordRef: `secret:${MAILBOX_SECRET}`,
        folder: "INBOX",
        draftsFolder: "Drafts",
      },
      smtp: {
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        user: "a@gmail.com",
        passwordRef: `secret:${MAILBOX_SECRET}`,
      },
    });
  });
});

describe("verifierChoice: the product's sender verifier for the mailbox", () => {
  it("Gmail believes mx.google.com's header; other hosts re-check with DNS; the runner's variables win", () => {
    expect(verifierChoice("gmail", {})).toMatchObject({ kind: "header", ids: ["mx.google.com"] });
    expect(verifierChoice("gmx", {})).toMatchObject({ kind: "mailauth" });
    expect(verifierChoice("custom", {})).toMatchObject({ kind: "mailauth" });
    expect(verifierChoice("gmail", { FORERUNNER_RUNNER_MAIL_VERIFIER: "mailauth" })).toMatchObject({
      kind: "mailauth",
    });
    expect(
      verifierChoice("webde", {
        FORERUNNER_RUNNER_MAIL_VERIFIER: "header",
        FORERUNNER_RUNNER_MAIL_AUTHSERV_IDS: "mx.example.org, mx2.example.org",
      }),
    ).toMatchObject({ kind: "header", ids: ["mx.example.org", "mx2.example.org"] });
    // header without the ids is never "trust any header": the default for the host applies.
    expect(verifierChoice("gmx", { FORERUNNER_RUNNER_MAIL_VERIFIER: "header" })).toMatchObject({
      kind: "mailauth",
    });
  });
});

describe("mailboxHint: the likely fix, by provider", () => {
  const where = { host: "imap.gmail.com", port: 993, address: AGENT };
  const auth = (serverText: string, code = "AUTHENTICATIONFAILED") => ({
    code,
    message: "Command failed",
    serverText,
    authFailed: true,
  });
  it("Gmail: app password missing, IMAP disabled, a web-login alert, 2-Step Verification off", () => {
    expect(
      mailboxHint(
        "gmail",
        "imap",
        auth(
          "[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)",
          "ALERT",
        ),
        where,
      ),
    ).toMatch(/app password.*2-Step Verification/);
    expect(
      mailboxHint(
        "gmail",
        "smtp",
        auth("534-5.7.9 Application-specific password required.", "EAUTH"),
        where,
      ),
    ).toMatch(/wants an app password/);
    expect(
      mailboxHint(
        "gmail",
        "imap",
        { ...auth("[ALERT] Your account is not enabled for IMAP use."), authFailed: false },
        where,
      ),
    ).toMatch(/Enable IMAP/);
    expect(
      mailboxHint("gmail", "imap", auth("[WEBALERT https://x] Web login required."), where),
    ).toMatch(/sign in to fr\.agent\.check@gmail\.com in a browser/);
    expect(
      mailboxHint(
        "gmail",
        "imap",
        auth("[AUTHENTICATIONFAILED] Invalid credentials (Failure)"),
        where,
      ),
    ).toMatch(/2-Step Verification is off/);
  });
  it("GMX and WEB.DE: enable POP3/IMAP-Abruf; another host: the generic login advice", () => {
    expect(mailboxHint("gmx", "imap", auth("authentication failed"), where)).toMatch(
      /GMX.*POP3\/IMAP-Abruf/,
    );
    expect(mailboxHint("webde", "smtp", auth("535 auth failed", "EAUTH"), where)).toMatch(
      /WEB\.DE.*POP3\/IMAP-Abruf/,
    );
    expect(mailboxHint("custom", "imap", auth("no"), where)).toMatch(/FORERUNNER_MAILBOX_USER/);
  });
  it("network and TLS failures name the host, the port and the override", () => {
    const net = (code: string) => ({ code, message: `connect ${code}`, authFailed: false });
    expect(mailboxHint("gmx", "smtp", net("ENOTFOUND"), where)).toMatch(
      /does not resolve.*FORERUNNER_MAILBOX_SMTP_HOST/,
    );
    expect(mailboxHint("gmail", "imap", net("ECONNREFUSED"), where)).toMatch(
      /Cannot reach imap\.gmail\.com:993/,
    );
    expect(
      mailboxHint(
        "custom",
        "smtp",
        { code: "ESOCKET", message: "wrong version number", authFailed: false },
        where,
      ),
    ).toMatch(/Cannot reach|TLS failed/);
  });
});

describe("email-live refuses before it writes anything", () => {
  const full = () => ({
    FORERUNNER_HOME: join(tempDir("fr-el-"), "home"),
    HOME: tempDir("fr-el-user-"),
    FORERUNNER_MAILBOX_ADDRESS: AGENT,
    FORERUNNER_MAILBOX_PASSWORD: APP_PASSWORD,
    FORERUNNER_HUMAN_EMAIL: HUMAN,
  });

  it("without FORERUNNER_HOME, or without each of the three mailbox variables", async () => {
    for (const [drop, why] of [
      ["FORERUNNER_HOME", /FORERUNNER_HOME is not set/],
      ["FORERUNNER_MAILBOX_ADDRESS", /FORERUNNER_MAILBOX_ADDRESS is not set/],
      ["FORERUNNER_MAILBOX_PASSWORD", /FORERUNNER_MAILBOX_PASSWORD is not set/],
      ["FORERUNNER_HUMAN_EMAIL", /FORERUNNER_HUMAN_EMAIL is not set/],
    ] as const) {
      const env: Record<string, string | undefined> = full();
      delete env[drop];
      const { out, sink } = lines();
      expect(await emailLive([], { env, out: sink })).toBe(2);
      expect(out.join("\n")).toMatch(why);
      expect(resultOf(out)).toMatch(/^FAIL refused: /);
      if (env.FORERUNNER_HOME) expect(existsSync(env.FORERUNNER_HOME)).toBe(false);
    }
  });

  it("the same address for agent and human, a bad address, the default profile, a bad wait, another install's store", () => {
    const base = full();
    const cases: Array<[Record<string, string>, string[], RegExp]> = [
      [{ FORERUNNER_HUMAN_EMAIL: AGENT }, [], /needs its own mailbox, never yours/],
      [{ FORERUNNER_MAILBOX_ADDRESS: "not-an-address" }, [], /is not an email address/],
      [{}, ["--profile", "default"], /--profile default/],
      [{}, ["--wait-minutes", "0"], /--wait-minutes/],
      [{ FORERUNNER_STATE_URL: "postgres://x@y/z" }, [], /FORERUNNER_STATE_URL is set/],
      [{ FORERUNNER_MAILBOX_IMAP_PORT: "99999" }, [], /IMAP_PORT must be a port number/],
    ];
    for (const [extra, argv, why] of cases) {
      const p = preflight(argv, { ...base, ...extra });
      expect(p.options).toBeNull();
      expect(p.refusals.join("\n")).toMatch(why);
    }
    expect(preflight([], base).options).toMatchObject({
      profile: "email-live",
      waitMs: 600_000,
      dryRun: false,
      address: AGENT,
      human: HUMAN,
    });
  });

  it("a home that is not dedicated: in use, or another profile's", () => {
    const env = full();
    const used = join(tempDir("fr-el-"), "used");
    mkdirSync(used, { recursive: true });
    writeFileSync(join(used, "handover-live.json"), "{}");
    expect(preflight([], { ...env, FORERUNNER_HOME: used }).refusals.join("\n")).toMatch(
      /not empty and was not made by this script/,
    );
    const mine = join(tempDir("fr-el-"), "mine");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, HOME_MARKER), JSON.stringify({ profile: "other" }));
    expect(preflight([], { ...env, FORERUNNER_HOME: mine }).refusals.join("\n")).toMatch(
      /belongs to profile other/,
    );
    expect(preflight([], { ...env, FORERUNNER_HOME: env.HOME }).refusals.join("\n")).toMatch(
      /home directory|overlaps/,
    );
  });

  it("a password passed as an argument is refused without echoing it", async () => {
    const { out, sink } = lines();
    const code = await emailLive(["--password", APP_PASSWORD], { env: full(), out: sink });
    expect(code).toBe(2);
    const text = out.join("\n");
    expect(text).not.toContain(APP_PASSWORD);
    expect(text).not.toContain("--password");
  });
});

// ---------------------------------------------------------------------------------------------
// The whole path offline

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}

describe("email-live --dry-run on the in-process mail server", () => {
  const compose = {
    registryDir: REGISTRY,
    sandboxDetection: {
      engine: "none" as const,
      reason: "test: no engine",
      checkedAt: new Date(0).toISOString(),
    },
  };
  const home = join(tempDir("fr-el-world-"), "install");
  const vault = new MemoryVault();
  const SECRET_KEYS = [
    "FORERUNNER_MAILBOX_PASSWORD",
    "FORERUNNER_ANTHROPIC_KEY",
    "FORERUNNER_HOME",
    "FORERUNNER_MAILBOX_ADDRESS",
    "FORERUNNER_HUMAN_EMAIL",
    "FORERUNNER_REGISTRY_DIR",
  ] as const;

  it("passes: setup, mode by command, mailbox, both logins, the check email, the reply verified and answered; the credentials leave the process env", async () => {
    // The entry point's shape: the run is handed process.env itself, so the clearing shows.
    const saved = Object.fromEntries(SECRET_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      FORERUNNER_HOME: home,
      FORERUNNER_MAILBOX_ADDRESS: AGENT,
      FORERUNNER_MAILBOX_PASSWORD: APP_PASSWORD,
      FORERUNNER_HUMAN_EMAIL: HUMAN,
      FORERUNNER_ANTHROPIC_KEY: ANTHROPIC,
      FORERUNNER_REGISTRY_DIR: REGISTRY,
    });
    const { out, sink } = lines();
    let code: number;
    try {
      code = await emailLive(["--dry-run"], {
        env: process.env,
        out: sink,
        openVault: async () => vault,
        compose,
      });
      expect(process.env[PASSWORD_ENV]).toBeUndefined();
      expect(process.env.FORERUNNER_ANTHROPIC_KEY).toBeUndefined();
    } finally {
      for (const k of SECRET_KEYS)
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
    }
    const text = out.join("\n");
    expect(resultOf(out), text).toBe("PASS");
    expect(code).toBe(0);
    // 7. Everything stopped before the result line, which is the last line.
    expect(out.at(-2)).toMatch(/^Stopped: .*nothing is left running\.$/);
    expect(out.at(-1)).toBe(`${RESULT_PREFIX} PASS`);
    expect(text).toMatch(/DRY RUN/);
    expect(text).toMatch(/IMAP imap\.gmail\.com:993 \(TLS\), SMTP smtp\.gmail\.com:465 \(TLS\)/);
    // 1. The mailbox password is in the vault, without Gmail's display spaces.
    expect(await vault.get(MAILBOX_SECRET)).toBe(APP_PASSWORD.replace(/ /g, ""));
    expect(text).toMatch(/stored in the vault: mailbox_password/);
    // 2. The registry's high-risk card, confirmed on this PC's device row.
    expect(text).toMatch(/change card \(email\.mode\.set, high risk\): .*From Off to Read only/);
    expect(text).toMatch(/confirming on this PC's paired device row/);
    expect(text).toMatch(/Changed the email mode of .* from Off to Read only/);
    expect(text).toMatch(/password secret:mailbox_password; mode read_only/);
    expect(text).toMatch(new RegExp(`email commands on, obeying ${HUMAN.replace(".", "\\.")}`));
    // 3. Both logins.
    expect(text).toMatch(
      /IMAP imap\.gmail\.com:993 \(the in-process stand-in\): logged in; folders: INBOX/,
    );
    expect(text).toMatch(/SMTP smtp\.gmail\.com:465 \(the in-process stand-in\): logged in/);
    // 4 and 5.
    expect(text).toContain(`sent to ${HUMAN}: "${CHECK_SUBJECT}"`);
    expect(text).toMatch(/DKIM pass for example\.ch, aligned with the From domain: yes, SPF pass/);
    expect(text).toMatch(
      /recognised as from the registered human j@example\.ch; routed as an email command: question/,
    );
    expect(text).toContain(`the agent answered by email: "Re: ${CHECK_SUBJECT}"`);
    // Steps print no message body: neither the check email's text nor the agent's answer.
    expect(text).not.toContain("Nothing else is needed");
    expect(text).not.toContain("agent email works");

    const report = JSON.parse(readFileSync(join(home, REPORT_FILE), "utf8")) as EmailLiveReport;
    expect(report).toMatchObject({
      result: "PASS",
      reason: null,
      dryRun: true,
      provider: "gmail",
      mode: CHECK_MODE,
      agentAddress: AGENT,
      humanAddress: HUMAN,
      checkEmail: { subject: CHECK_SUBJECT },
      reply: {
        subject: `Re: ${CHECK_SUBJECT}`,
        from: HUMAN,
        gate: { obeyed: true, reason: "ok" },
        auth: { dkim: "pass", aligned: true, spf: "pass" },
        outcome: "question",
        answerSubject: `Re: ${CHECK_SUBJECT}`,
      },
    });
    expect(report.steps.map((s) => [s.step, s.ok])).toEqual([
      [1, true],
      [2, true],
      [3, true],
      [4, true],
      [5, true],
    ]);
    expect(JSON.stringify(report)).not.toContain("yes\n");
  }, 120_000);

  it("a rerun on the same home keeps the mode (no second card) and passes again", async () => {
    const { out, sink } = lines();
    const code = await emailLive(["--dry-run"], {
      env: {
        FORERUNNER_HOME: home,
        HOME: tempDir("fr-el-user-"),
        FORERUNNER_MAILBOX_ADDRESS: AGENT,
        FORERUNNER_MAILBOX_PASSWORD: APP_PASSWORD,
        FORERUNNER_HUMAN_EMAIL: HUMAN,
        FORERUNNER_REGISTRY_DIR: REGISTRY,
      },
      out: sink,
      openVault: async () => vault,
      compose,
    });
    const text = out.join("\n");
    expect(text).toMatch(/sending mode already read_only \(a rerun\): no change/);
    expect(resultOf(out), text).toBe("PASS");
    expect(code).toBe(0);
  }, 120_000);

  it("a spoofed reply (unsigned, claiming the human's address) is not accepted: FAIL", async () => {
    const { out, sink } = lines();
    const code = await emailLive(["--dry-run"], {
      env: {
        FORERUNNER_HOME: join(tempDir("fr-el-"), "spoof"),
        HOME: tempDir("fr-el-user-"),
        FORERUNNER_MAILBOX_ADDRESS: AGENT,
        FORERUNNER_MAILBOX_PASSWORD: APP_PASSWORD,
        FORERUNNER_HUMAN_EMAIL: HUMAN,
        FORERUNNER_REGISTRY_DIR: REGISTRY,
      },
      out: sink,
      openVault: async () => new MemoryVault(),
      compose,
      dryRunReply: "spoofed",
    });
    const text = out.join("\n");
    expect(code, text).toBe(1);
    expect(resultOf(out)).toBe("FAIL reply: ignored by the sender check (dkim_fail)");
    expect(text).toMatch(/the reply was NOT accepted as yours: dkim_fail/);
  }, 120_000);

  it("no reply within the wait: FAIL naming the wait, the watcher stopped", async () => {
    const { out, sink } = lines();
    const dir = join(tempDir("fr-el-"), "silent");
    const code = await emailLive(["--dry-run", "--wait-minutes", "0.01"], {
      env: {
        FORERUNNER_HOME: dir,
        HOME: tempDir("fr-el-user-"),
        FORERUNNER_MAILBOX_ADDRESS: "agent@gmx.ch",
        FORERUNNER_MAILBOX_PASSWORD: "gmx password with spaces",
        FORERUNNER_HUMAN_EMAIL: HUMAN,
        FORERUNNER_REGISTRY_DIR: REGISTRY,
      },
      out: sink,
      openVault: async () => new MemoryVault(),
      compose,
      dryRunReply: "none",
    });
    const text = out.join("\n");
    expect(code, text).toBe(1);
    expect(text).toMatch(/IMAP imap\.gmx\.net:993 \(TLS\), SMTP mail\.gmx\.net:465 \(TLS\)/);
    expect(resultOf(out)).toMatch(/^FAIL reply: none within 1 s/);
    const report = JSON.parse(readFileSync(join(dir, REPORT_FILE), "utf8")) as EmailLiveReport;
    expect(report).toMatchObject({ result: "FAIL", provider: "gmx", reply: null });
    expect(report.steps.at(-1)).toMatchObject({ step: 5, ok: false });
  }, 120_000);

  it("live mode: the key is validated and stored, the password resolved from the vault by reference; a refused Gmail login stops at step 3 with the fix, nothing sent", async () => {
    const vaultLive = new MemoryVault();
    const logins: Array<{ host: string; port: number; user: string; pass: string }> = [];
    let sent = 0;
    const refused = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      serverResponseCode: "ALERT",
      responseText:
        "Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)",
    });
    const { out, sink } = lines();
    const dir = join(tempDir("fr-el-"), "live");
    const code = await emailLive([], {
      env: {
        FORERUNNER_HOME: dir,
        HOME: tempDir("fr-el-user-"),
        FORERUNNER_MAILBOX_ADDRESS: AGENT,
        FORERUNNER_MAILBOX_PASSWORD: APP_PASSWORD,
        FORERUNNER_HUMAN_EMAIL: HUMAN,
        FORERUNNER_ANTHROPIC_KEY: ANTHROPIC,
        FORERUNNER_REGISTRY_DIR: REGISTRY,
      },
      out: sink,
      openVault: async () => vaultLive,
      // The models endpoint the setup validates the key against, answered in process.
      setupFetch: (async (_url: unknown, init?: { headers?: Record<string, string> }) =>
        new Response(
          JSON.stringify(
            init?.headers?.["x-api-key"] === ANTHROPIC
              ? { data: [{ id: "claude-haiku-test" }, { id: "claude-sonnet-test" }] }
              : {},
          ),
          { status: init?.headers?.["x-api-key"] === ANTHROPIC ? 200 : 401 },
        )) as typeof fetch,
      compose: {
        ...compose,
        provider: new FakeProvider({ latency: "none", onNoMatch: "throw" }),
        // The product's IMAP/SMTP mailbox over the vault, with the network replaced.
        notifications: {
          mailboxFactory: async (config) =>
            new ImapSmtpMailbox({
              config,
              secrets: new SecretResolver(vaultLive),
              granted: new Set([MAILBOX_SECRET]),
              clock: systemClock,
              createImap: async (o) => {
                logins.push({ host: o.host, port: o.port, user: o.auth.user, pass: o.auth.pass });
                return {
                  connect: async () => {
                    throw refused;
                  },
                  logout: async () => undefined,
                } as unknown as ImapClientLike;
              },
              createTransport: async (o) => {
                logins.push({
                  host: o.host,
                  port: o.port,
                  user: o.auth?.user ?? "",
                  pass: o.auth?.pass ?? "",
                });
                return {
                  sendMail: async () => {
                    sent++;
                    return {};
                  },
                  verify: async () => true,
                };
              },
            }),
        },
      },
    });
    const text = out.join("\n");
    expect(code, text).toBe(1);
    expect(text).not.toMatch(/DRY RUN/);
    expect(text).toMatch(/anthropic: ok/);
    expect(await vaultLive.list()).toEqual(
      expect.arrayContaining(["anthropic_api_key", MAILBOX_SECRET]),
    );
    expect(logins).toEqual([
      { host: "imap.gmail.com", port: 993, user: AGENT, pass: APP_PASSWORD.replace(/ /g, "") },
      { host: "smtp.gmail.com", port: 465, user: AGENT, pass: APP_PASSWORD.replace(/ /g, "") },
    ]);
    expect(text).toMatch(/IMAP imap\.gmail\.com:993: FAILED \(ALERT\) Application-specific/);
    expect(text).toMatch(/fix: Gmail wants an app password/);
    expect(text).toMatch(/SMTP smtp\.gmail\.com:465: logged in/);
    expect(resultOf(out)).toBe("FAIL connections: IMAP login failed (see the fix above)");
    expect(sent).toBe(0);
    for (const secret of [APP_PASSWORD, APP_PASSWORD.replace(/ /g, ""), ANTHROPIC])
      expect(text).not.toContain(secret);
  }, 120_000);

  it("no secret value in any file under the homes: the store, the report, the logs", () => {
    const files = walk(join(home, ".."));
    expect(files.some((f) => f.endsWith("state.sqlite"))).toBe(true);
    expect(files.some((f) => f.endsWith(REPORT_FILE))).toBe(true);
    for (const secret of [APP_PASSWORD, APP_PASSWORD.replace(/ /g, ""), ANTHROPIC]) {
      for (const f of files) {
        const body = readFileSync(f);
        expect(body.includes(secret), f).toBe(false);
        expect(body.includes(Buffer.from(secret, "utf16le")), f).toBe(false);
      }
    }
  });
});
