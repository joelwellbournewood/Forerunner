/**
 * Sender verification for email commands (T.3): the mail must pass DKIM for a domain aligned
 * with the From header and pass SPF. Verification goes through the AuthVerifier port:
 *
 * - AuthResultsHeaderVerifier reads the Authentication-Results header the receiving provider
 *   wrote (Gmail, a domain mail host, the testenv server). Only headers from a trusted
 *   authserv-id count, because a sender can add its own forged header; the topmost header is
 *   the one our MX added. A claimed dkim=pass also needs a DKIM-Signature header on the
 *   message. Hosts not known to strip foreign headers should use MailauthVerifier.
 * - MailauthVerifier re-verifies DKIM and SPF itself with `mailauth` (DNS lookups) for hosts
 *   that do not stamp results. SPF uses the client IP from the Received chain.
 * - StaticAuthVerifier returns fixed verdicts for tests of the gate's branches.
 *
 * Every verdict says why it failed, and the gate logs it as data.
 */
import { log } from "@forerunner/platform";
import type { AuthMethodResult, InboundEmail } from "./inbound.ts";

const logger = log("capabilities:email:auth");

export interface AuthVerdict {
  dkim: "pass" | "fail" | "none";
  /** DKIM signing domain aligned (relaxed) with the From header domain. */
  aligned: boolean;
  dkimDomain?: string;
  spf: AuthMethodResult;
  fromDomain?: string;
  /** Where the verdict came from. */
  source: "header" | "mailauth" | "static";
  /** Set when nothing trustworthy was found; the gate reports it. */
  reason?: string;
}

export interface AuthVerifier {
  verify(message: InboundEmail): Promise<AuthVerdict>;
}

export function domainOf(address: string | null | undefined): string {
  if (!address) return "";
  const at = address.lastIndexOf("@");
  return at === -1
    ? ""
    : address
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

/** Relaxed DMARC alignment: equal, or one a subdomain of the other. */
export function domainsAligned(signing: string | undefined, from: string): boolean {
  if (!signing || !from) return false;
  const s = signing.toLowerCase();
  const f = from.toLowerCase();
  return s === f || s.endsWith(`.${f}`) || f.endsWith(`.${s}`);
}

export const FAILED_VERDICT: AuthVerdict = {
  dkim: "none",
  aligned: false,
  spf: "none",
  source: "header",
};

export interface AuthResultsHeaderVerifierOptions {
  /**
   * authserv-id values whose header is believed (e.g. "mx.google.com"). Empty means "trust
   * the topmost header", which is only safe when the mail host strips foreign headers.
   */
  trustedAuthservIds: string[];
}

export class AuthResultsHeaderVerifier implements AuthVerifier {
  private readonly trusted: Set<string>;

  constructor(opts: AuthResultsHeaderVerifierOptions) {
    this.trusted = new Set(opts.trustedAuthservIds.map((s) => s.trim().toLowerCase()));
  }

  async verify(message: InboundEmail): Promise<AuthVerdict> {
    const fromDomain = domainOf(message.from);
    if (message.fromAll.length !== 1) {
      return { ...FAILED_VERDICT, fromDomain, reason: "From header must name exactly one address" };
    }
    const parsed = message.authResults;
    if (!parsed) {
      return { ...FAILED_VERDICT, fromDomain, reason: "no Authentication-Results header" };
    }
    if (this.trusted.size > 0 && !this.trusted.has(parsed.authservId.toLowerCase())) {
      return {
        ...FAILED_VERDICT,
        fromDomain,
        reason: `Authentication-Results from untrusted authserv-id "${parsed.authservId}"`,
      };
    }
    // A header can claim dkim=pass for a message that carries no signature at all (a forged
    // header on a host that does not strip foreign ones): without a DKIM-Signature header the
    // claim is refused.
    if (parsed.dkim === "pass" && !message.hasDkimSignature) {
      return {
        ...FAILED_VERDICT,
        spf: parsed.spf ?? "none",
        fromDomain,
        reason:
          "Authentication-Results claims dkim=pass but the message has no DKIM-Signature header",
      };
    }
    const dkim: AuthVerdict["dkim"] =
      parsed.dkim === "pass"
        ? "pass"
        : parsed.dkim === undefined || parsed.dkim === "none"
          ? "none"
          : "fail";
    const aligned =
      dkim === "pass" &&
      (parsed.aligned !== undefined
        ? parsed.aligned
        : domainsAligned(parsed.dkimDomain, fromDomain));
    const spf = parsed.spf ?? "none";
    const verdict: AuthVerdict = {
      dkim,
      aligned,
      ...(parsed.dkimDomain ? { dkimDomain: parsed.dkimDomain } : {}),
      spf,
      fromDomain,
      source: "header",
    };
    if (dkim !== "pass") verdict.reason = `dkim=${dkim}`;
    else if (!aligned)
      verdict.reason = `dkim signed for ${parsed.dkimDomain ?? "?"}, From is ${fromDomain}`;
    else if (spf !== "pass") verdict.reason = `spf=${spf}`;
    return verdict;
  }
}

/** What MailauthVerifier needs from `mailauth`'s authenticate(); injected so tests need no DNS. */
export type AuthenticateFn = (
  raw: string,
  opts: { trustReceived: boolean; mta?: string },
) => Promise<{
  dkim: {
    results: Array<{
      signingDomain?: string;
      status: { result: string; aligned?: string | false };
    }>;
  };
  spf: { status: { result: string } } | false;
}>;

export class MailauthVerifier implements AuthVerifier {
  constructor(
    private readonly authenticate: AuthenticateFn,
    private readonly opts: { mta?: string } = {},
  ) {}

  /** Lazily loads `mailauth`; the dependency is only touched in production. */
  static async create(opts: { mta?: string } = {}): Promise<MailauthVerifier> {
    const mod = await import("mailauth");
    return new MailauthVerifier(mod.authenticate as unknown as AuthenticateFn, opts);
  }

  async verify(message: InboundEmail): Promise<AuthVerdict> {
    const fromDomain = domainOf(message.from);
    if (message.fromAll.length !== 1) {
      return {
        ...FAILED_VERDICT,
        fromDomain,
        source: "mailauth",
        reason: "From header must name exactly one address",
      };
    }
    try {
      const result = await this.authenticate(message.raw, {
        trustReceived: true,
        ...(this.opts.mta ? { mta: this.opts.mta } : {}),
      });
      const passing = result.dkim.results.find((r) => r.status.result === "pass");
      const alignedResult = result.dkim.results.find(
        (r) =>
          r.status.result === "pass" &&
          (r.status.aligned ? true : domainsAligned(r.signingDomain, fromDomain)),
      );
      const dkim: AuthVerdict["dkim"] = passing
        ? "pass"
        : result.dkim.results.length === 0
          ? "none"
          : "fail";
      const spfResult = result.spf ? result.spf.status.result : "none";
      const spf: AuthMethodResult =
        spfResult === "pass" ||
        spfResult === "fail" ||
        spfResult === "softfail" ||
        spfResult === "neutral" ||
        spfResult === "none"
          ? spfResult
          : "other";
      const verdict: AuthVerdict = {
        dkim,
        aligned: alignedResult !== undefined,
        ...(alignedResult?.signingDomain ? { dkimDomain: alignedResult.signingDomain } : {}),
        spf,
        fromDomain,
        source: "mailauth",
      };
      if (dkim !== "pass") verdict.reason = `dkim=${dkim}`;
      else if (!alignedResult) verdict.reason = "no DKIM signature aligned with the From domain";
      else if (spf !== "pass") verdict.reason = `spf=${spf}`;
      return verdict;
    } catch (e) {
      logger.warn("mailauth verification failed", { error: String(e) });
      return {
        ...FAILED_VERDICT,
        fromDomain,
        source: "mailauth",
        reason: `verification error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
}

/** Fixed verdicts for tests; `byMessageId` overrides the default per message. */
export class StaticAuthVerifier implements AuthVerifier {
  readonly byMessageId = new Map<string, Partial<AuthVerdict>>();
  constructor(private readonly base: Partial<AuthVerdict> = {}) {}
  async verify(message: InboundEmail): Promise<AuthVerdict> {
    const override = message.messageId ? this.byMessageId.get(message.messageId) : undefined;
    return {
      dkim: "pass",
      aligned: true,
      spf: "pass",
      fromDomain: domainOf(message.from),
      source: "static",
      ...this.base,
      ...(override ?? {}),
    };
  }
}
