/**
 * Authentication-Results (RFC 8601) in the shape real providers write it. The local server
 * adds one to every delivered message; the email-command watcher parses the same shape from
 * Gmail or a domain mail host in production.
 */
import type { SpfResult } from "./spf.ts";

export type DkimVerdict = "pass" | "fail" | "none";

export interface AuthResults {
  dkim: DkimVerdict;
  dkimDomain?: string;
  dkimSelector?: string;
  dkimReason?: string;
  /** DKIM signing domain aligned with the From header domain (relaxed alignment). */
  aligned: boolean;
  spf: SpfResult;
  /** Domain the SPF verdict was evaluated for (envelope MAIL FROM, or From header). */
  spfDomain?: string;
  /** DMARC-style verdict: pass when DKIM passes aligned, or SPF passes for the From domain. */
  dmarc: "pass" | "fail" | "none";
  /** From header domain, used for alignment. */
  fromDomain?: string;
}

/** Format the header value, e.g. "mx.example.test; dkim=pass header.d=example.test; spf=pass ...". */
export function formatAuthenticationResults(authservId: string, r: AuthResults): string {
  const parts: string[] = [authservId];
  let dkim = `dkim=${r.dkim}`;
  if (r.dkim === "fail" && r.dkimReason) dkim += ` (${sanitizeComment(r.dkimReason)})`;
  if (r.dkimDomain) dkim += ` header.d=${r.dkimDomain}`;
  if (r.dkimSelector) dkim += ` header.s=${r.dkimSelector}`;
  parts.push(dkim);
  let spf = `spf=${r.spf}`;
  if (r.spfDomain) spf += ` smtp.mailfrom=${r.spfDomain}`;
  parts.push(spf);
  let dmarc = `dmarc=${r.dmarc}`;
  if (r.fromDomain) dmarc += ` header.from=${r.fromDomain}`;
  dmarc += ` (dkim.aligned=${r.aligned ? "yes" : "no"})`;
  parts.push(dmarc);
  return parts.join("; ");
}

function sanitizeComment(text: string): string {
  return text.replace(/[()\r\n]/g, " ").trim();
}

export interface ParsedAuthResults {
  authservId: string;
  dkim?: DkimVerdict;
  dkimDomain?: string;
  dkimSelector?: string;
  dkimReason?: string;
  spf?: SpfResult;
  spfDomain?: string;
  dmarc?: "pass" | "fail" | "none";
  fromDomain?: string;
  aligned?: boolean;
}

/** Parse a header value written by this module or by a real provider (comments tolerated). */
export function parseAuthenticationResults(value: string): ParsedAuthResults {
  const unfolded = value.replace(/\r\n[ \t]/g, " ").trim();
  const segments = unfolded.split(";").map((s) => s.trim());
  // Microsoft writes the methods without an authserv-id: a leading "method=result" means none.
  let authservId = "";
  const firstToken = (segments[0] ?? "").split(/\s+/)[0] ?? "";
  if (!/^[a-z0-9-]+=/i.test(firstToken)) {
    segments.shift();
    authservId = firstToken;
  }
  const out: ParsedAuthResults = { authservId };
  for (const segment of segments) {
    if (!segment) continue;
    const comments = [...segment.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]?.trim() ?? "");
    const stripped = segment
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const tokens = stripped.split(" ");
    const [method, verdict] = (tokens[0] ?? "").split("=");
    const props = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf("=");
      if (eq > 0) props.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1));
    }
    switch (method?.toLowerCase()) {
      case "dkim":
        out.dkim = asDkim(verdict);
        if (props.has("header.d")) out.dkimDomain = props.get("header.d");
        else if (props.has("header.i")) {
          // Gmail writes header.i=@domain (the i= tag) and may omit header.d.
          out.dkimDomain = (props.get("header.i") ?? "").replace(/^.*@/, "");
        }
        if (props.has("header.s")) out.dkimSelector = props.get("header.s");
        if (comments[0]) out.dkimReason = comments[0];
        break;
      case "spf":
        out.spf = asSpf(verdict);
        if (props.has("smtp.mailfrom")) {
          const mailfrom = props.get("smtp.mailfrom") ?? "";
          out.spfDomain = mailfrom.includes("@") ? mailfrom.split("@")[1] : mailfrom;
        }
        break;
      case "dmarc":
        out.dmarc = verdict === "pass" || verdict === "fail" ? verdict : "none";
        if (props.has("header.from")) out.fromDomain = props.get("header.from");
        for (const c of comments) {
          const m = c.match(/dkim\.aligned=(yes|no)/);
          if (m) out.aligned = m[1] === "yes";
        }
        break;
      default:
        break;
    }
  }
  return out;
}

function asDkim(v: string | undefined): DkimVerdict {
  return v === "pass" || v === "fail" ? v : "none";
}

function asSpf(v: string | undefined): SpfResult {
  switch (v) {
    case "pass":
    case "fail":
    case "softfail":
    case "neutral":
      return v;
    default:
      return "none";
  }
}
