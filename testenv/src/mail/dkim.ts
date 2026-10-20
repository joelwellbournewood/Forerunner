/**
 * DKIM (RFC 6376) signing and verification with node:crypto only.
 *
 * Supports rsa-sha256 with relaxed or simple canonicalization for headers and body. The
 * verifier reports, besides pass/fail, whether the signing domain (d=) aligns with the domain
 * of the From header, which is what the email-command rules in the spec rely on: a signature
 * that verifies for domain A says nothing about a From address at domain B.
 */
import {
  createHash,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from "node:crypto";
import { ForerunnerError } from "@forerunner/platform";
import {
  addressDomain,
  CRLF,
  foldHeaderValue,
  type HeaderField,
  headersNamed,
  parseAddresses,
  splitMessage,
  toCrlf,
  unfold,
} from "./message.ts";

export type DkimCanonicalization =
  | "relaxed/relaxed"
  | "relaxed/simple"
  | "simple/simple"
  | "simple/relaxed";

export type DkimAlgorithm = "rsa-sha256";

export interface DkimKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface DkimSignOptions {
  privateKeyPem: string;
  domain: string;
  selector: string;
  /** Header names to sign, in order; duplicates sign the next instance from the bottom. */
  headers?: string[];
  canonicalization?: DkimCanonicalization;
  algorithm?: DkimAlgorithm;
  /** Signature timestamp (t=) in seconds since the epoch; omitted when not given. */
  timestamp?: number;
  /** Signature expiry (x=) in seconds since the epoch; omitted when not given. */
  expires?: number;
}

export interface DkimVerifyResult {
  pass: boolean;
  domain?: string;
  selector?: string;
  reason?: string;
  /** True when a signature passed and its d= domain aligns with the From header domain. */
  alignedWithFrom: boolean;
  fromDomain?: string;
  signedHeaders?: string[];
}

export interface DkimVerifyOptions {
  /** Current time in milliseconds (from a Clock), used for the x= expiry tag. */
  now?: number;
}

export type DkimKeyResolver = (selector: string, domain: string) => Promise<string | null>;

export const DEFAULT_DKIM_HEADERS: readonly string[] = [
  "from",
  "to",
  "subject",
  "date",
  "message-id",
];

export function generateDkimKeyPair(modulusLength = 2048): DkimKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/** The TXT record value a real DNS would publish at `<selector>._domainkey.<domain>`. */
export function dkimDnsRecord(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return `v=DKIM1; k=rsa; p=${der.toString("base64")}`;
}

/** Inverse of dkimDnsRecord; null when the record carries no usable key (p= empty = revoked). */
export function publicKeyFromDnsRecord(txt: string): string | null {
  const tags = parseTags(txt);
  const p = tags.get("p");
  if (!p) return null;
  try {
    return createPublicKey({ key: Buffer.from(p, "base64"), type: "spki", format: "der" })
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Canonicalization (RFC 6376 section 3.4)

/** Relaxed header canonicalization: lower-case name, unfold, collapse WSP, trim, no WSP at colon. */
export function canonicalizeHeaderRelaxed(name: string, value: string): string {
  const v = unfold(value)
    .replace(/[ \t]+/g, " ")
    .replace(/^ /, "")
    .replace(/ $/, "");
  return `${name.toLowerCase().trim()}:${v}${CRLF}`;
}

/** Simple header canonicalization: the field exactly as it appears. */
export function canonicalizeHeaderSimple(raw: string): string {
  return `${raw}${CRLF}`;
}

/** Relaxed body canonicalization: strip trailing WSP per line, collapse WSP, drop trailing empty lines. */
export function canonicalizeBodyRelaxed(body: string): string {
  const lines = toCrlf(body)
    .split(CRLF)
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join(CRLF)}${CRLF}`;
}

/** Simple body canonicalization: drop trailing empty lines; an empty body is a single CRLF. */
export function canonicalizeBodySimple(body: string): string {
  const lines = toCrlf(body).split(CRLF);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.length === 0 ? CRLF : `${lines.join(CRLF)}${CRLF}`;
}

function canonicalizeBody(body: string, mode: "relaxed" | "simple"): string {
  return mode === "relaxed" ? canonicalizeBodyRelaxed(body) : canonicalizeBodySimple(body);
}

function canonicalizeHeader(field: HeaderField, mode: "relaxed" | "simple"): string {
  return mode === "relaxed"
    ? canonicalizeHeaderRelaxed(field.name, field.value)
    : canonicalizeHeaderSimple(field.raw);
}

function parseCanonicalization(c: string | undefined): {
  header: "relaxed" | "simple";
  body: "relaxed" | "simple";
} {
  if (!c) return { header: "simple", body: "simple" };
  const [h, b] = c.split("/");
  const header = h === "relaxed" ? "relaxed" : "simple";
  const body = b === undefined ? "simple" : b === "relaxed" ? "relaxed" : "simple";
  return { header, body };
}

/**
 * Select the header instances covered by an h= list: for each listed name, the next unused
 * instance counting from the bottom of the message (RFC 6376 section 5.4.2). Names with no
 * remaining instance contribute nothing.
 */
function selectSignedHeaders(
  fields: HeaderField[],
  names: string[],
  exclude?: HeaderField,
): HeaderField[] {
  const used = new Set<HeaderField>();
  const selected: HeaderField[] = [];
  for (const name of names) {
    const candidates = headersNamed(fields, name).filter((f) => f !== exclude);
    for (let i = candidates.length - 1; i >= 0; i--) {
      const candidate = candidates[i];
      if (candidate && !used.has(candidate)) {
        used.add(candidate);
        selected.push(candidate);
        break;
      }
    }
  }
  return selected;
}

function parseTags(value: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const part of unfold(value).split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (key.length > 0 && !tags.has(key)) tags.set(key, val);
  }
  return tags;
}

/** The DKIM-Signature value with the b= tag emptied, as the hash input requires. */
function stripSignatureValue(value: string): string {
  return value.replace(/(^|;)(\s*)b=[^;]*/, "$1$2b=");
}

function hashInput(
  signed: HeaderField[],
  signatureField: HeaderField,
  headerMode: "relaxed" | "simple",
): Buffer {
  let input = "";
  for (const field of signed) input += canonicalizeHeader(field, headerMode);
  const stripped: HeaderField = {
    name: signatureField.name,
    value: stripSignatureValue(signatureField.value),
    raw: `${signatureField.name}:${stripSignatureValue(signatureField.value)}`,
  };
  input += canonicalizeHeader(stripped, headerMode).replace(/\r\n$/, "");
  return Buffer.from(input, "utf8");
}

// ---------------------------------------------------------------------------------------------
// Signing

/** Sign `rawMessage` and return it with a DKIM-Signature header prepended (CRLF-normalised). */
export function signDkim(options: DkimSignOptions, rawMessage: string): string {
  const algorithm = options.algorithm ?? "rsa-sha256";
  if (algorithm !== "rsa-sha256") {
    throw new ForerunnerError("not_supported", `DKIM algorithm ${algorithm} is not supported`);
  }
  const canonicalization = options.canonicalization ?? "relaxed/relaxed";
  const modes = parseCanonicalization(canonicalization);
  const names = (options.headers ?? [...DEFAULT_DKIM_HEADERS]).map((h) => h.toLowerCase().trim());
  if (!names.includes("from")) {
    throw new ForerunnerError("validation", "DKIM must sign the From header");
  }
  const raw = toCrlf(rawMessage);
  const { headers, body } = splitMessage(raw);
  const bodyHash = createHash("sha256")
    .update(canonicalizeBody(body, modes.body), "utf8")
    .digest("base64");

  const tags = [
    "v=1",
    `a=${algorithm}`,
    `c=${canonicalization}`,
    `d=${options.domain.toLowerCase()}`,
    `s=${options.selector}`,
    ...(options.timestamp !== undefined ? [`t=${Math.floor(options.timestamp)}`] : []),
    ...(options.expires !== undefined ? [`x=${Math.floor(options.expires)}`] : []),
    `h=${names.join(":")}`,
    `bh=${bodyHash}`,
  ];
  const unsignedValue = ` ${foldHeaderValue(`${tags.join("; ")}; b=`)}`;
  const signatureField: HeaderField = {
    name: "DKIM-Signature",
    value: unsignedValue,
    raw: `DKIM-Signature:${unsignedValue}`,
  };
  const signed = selectSignedHeaders(headers, names);
  const signature = cryptoSign(
    "sha256",
    hashInput(signed, signatureField, modes.header),
    options.privateKeyPem,
  ).toString("base64");
  const foldedSignature = signature.match(/.{1,72}/g)?.join(`${CRLF}\t`) ?? signature;
  return `${signatureField.raw}${foldedSignature}${CRLF}${raw}`;
}

// ---------------------------------------------------------------------------------------------
// Verification

/**
 * Verify the DKIM-Signature header(s) of `rawMessage`. The first signature that verifies wins;
 * otherwise the result describes why the first signature failed. `resolvePublicKey` stands in
 * for the DNS lookup of `<selector>._domainkey.<domain>` and returns a PEM public key.
 */
export async function verifyDkim(
  rawMessage: string,
  resolvePublicKey: DkimKeyResolver,
  options: DkimVerifyOptions = {},
): Promise<DkimVerifyResult> {
  const raw = toCrlf(rawMessage);
  const { headers, body } = splitMessage(raw);
  const fromFields = headersNamed(headers, "from");
  const fromDomain = addressDomain(parseAddresses(fromFields[0]?.value)[0] ?? "");
  const base: DkimVerifyResult = {
    pass: false,
    alignedWithFrom: false,
    ...(fromDomain ? { fromDomain } : {}),
  };
  if (fromFields.length > 1) {
    return { ...base, reason: "multiple From headers" };
  }
  const signatures = headersNamed(headers, "dkim-signature");
  if (signatures.length === 0) return { ...base, reason: "no DKIM-Signature header" };

  let first: DkimVerifyResult | null = null;
  for (const field of signatures) {
    const result = await verifyOne(field, headers, body, fromDomain, resolvePublicKey, options);
    if (result.pass) return result;
    first ??= result;
  }
  return first ?? { ...base, reason: "no DKIM-Signature header" };
}

async function verifyOne(
  field: HeaderField,
  headers: HeaderField[],
  body: string,
  fromDomain: string,
  resolvePublicKey: DkimKeyResolver,
  options: DkimVerifyOptions,
): Promise<DkimVerifyResult> {
  const tags = parseTags(field.value);
  const domain = tags.get("d")?.toLowerCase();
  const selector = tags.get("s");
  const fail = (reason: string): DkimVerifyResult => ({
    pass: false,
    alignedWithFrom: false,
    reason,
    ...(domain ? { domain } : {}),
    ...(selector ? { selector } : {}),
    ...(fromDomain ? { fromDomain } : {}),
  });
  if (tags.get("v") !== "1") return fail("unsupported version");
  const algorithm = tags.get("a");
  if (algorithm !== "rsa-sha256") return fail(`unsupported algorithm ${algorithm ?? "(none)"}`);
  if (!domain || !selector) return fail("missing d= or s= tag");
  const h = tags.get("h");
  const bh = tags.get("bh")?.replace(/\s+/g, "");
  const b = tags.get("b")?.replace(/\s+/g, "");
  if (!h || !bh || !b) return fail("missing h=, bh= or b= tag");
  const names = h.split(":").map((n) => n.trim().toLowerCase());
  if (!names.includes("from")) return fail("From header not signed");
  const expires = tags.get("x");
  if (expires !== undefined && options.now !== undefined) {
    const x = Number(expires);
    if (Number.isFinite(x) && options.now > x * 1000) return fail("signature expired");
  }
  const modes = parseCanonicalization(tags.get("c"));

  let canonicalBody = canonicalizeBody(body, modes.body);
  const l = tags.get("l");
  if (l !== undefined) {
    const length = Number(l);
    if (!Number.isInteger(length) || length < 0) return fail("invalid l= tag");
    canonicalBody = Buffer.from(canonicalBody, "utf8").subarray(0, length).toString("utf8");
  }
  const computedBh = createHash("sha256").update(canonicalBody, "utf8").digest("base64");
  if (computedBh !== bh) return fail("body hash mismatch");

  const publicKeyPem = await resolvePublicKey(selector, domain);
  if (!publicKeyPem) return fail(`no public key for ${selector}._domainkey.${domain}`);

  const signed = selectSignedHeaders(headers, names, field);
  let ok = false;
  try {
    ok = cryptoVerify(
      "sha256",
      hashInput(signed, field, modes.header),
      publicKeyPem,
      Buffer.from(b, "base64"),
    );
  } catch (e) {
    return fail(`signature check error: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!ok) return fail("signature does not verify");
  return {
    pass: true,
    domain,
    selector,
    alignedWithFrom: domainsAlign(domain, fromDomain),
    ...(fromDomain ? { fromDomain } : {}),
    signedHeaders: names,
  };
}

/** Relaxed alignment: equal, or one is a subdomain of the other. */
export function domainsAlign(signingDomain: string, fromDomain: string): boolean {
  const a = signingDomain.toLowerCase();
  const b = fromDomain.toLowerCase();
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}
