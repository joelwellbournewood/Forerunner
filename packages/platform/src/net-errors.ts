import { redact } from "./log.ts";

/**
 * A failed request in words a person can act on (U-053). Node's fetch throws
 * `TypeError("fetch failed")` and keeps what happened in `cause` (a DNS failure, a refused
 * connection, a certificate a proxy put in front, a proxy's own answer); a message without the
 * cause leaves the person with nothing to check. This walks the cause chain, names the kind of
 * failure and keeps the code and the innermost message, redacted. An error about a header value
 * (a credential with a line break inside) is described without the value: that message quotes
 * the whole header, the credential included. `secrets` are cut out of the text as well.
 */
export function describeNetworkError(e: unknown, secrets: readonly string[] = []): string {
  const chain: unknown[] = [];
  for (let c: unknown = e; c !== undefined && c !== null && chain.length < 6; ) {
    chain.push(c);
    c = (c as { cause?: unknown }).cause;
  }
  const messages = chain.map((c) => (c instanceof Error ? c.message : String(c)));
  const all = messages.join(" | ");
  if (/invalid header value|invalid character in header|header content contains invalid/i.test(all))
    return "a credential has a character that cannot be sent, such as a line break inside it; copy it again in one piece and paste it";
  const code = chain
    .map((c) => (c as { code?: unknown }).code)
    .find((x): x is string => typeof x === "string" && x.length > 0);
  const kind = kindOf(code, all);
  const innermost = messages[messages.length - 1] ?? "";
  let detail = [code, innermost && innermost !== code ? innermost : ""].filter(Boolean).join(": ");
  for (const s of secrets) if (s) detail = detail.split(s).join("[REDACTED]");
  detail = redact(detail);
  return detail ? `${kind} (${detail})` : kind;
}

function kindOf(code: string | undefined, text: string): string {
  const c = code ?? "";
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL)$/.test(c))
    return "could not find the server (DNS): check the internet connection and the address";
  if (c === "ECONNREFUSED")
    return "the server refused the connection: nothing answers at that address (a stopped proxy or a firewall?)";
  if (
    /^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/.test(
      c,
    )
  )
    return "the server did not answer in time (no network, or a firewall dropping the connection)";
  if (/^(ENETUNREACH|EHOSTUNREACH|ENETDOWN)$/.test(c))
    return "no route to the server: this computer seems to be offline";
  if (/CERT|SSL|TLS|UNABLE_TO_VERIFY|SELF_SIGNED|DEPTH_ZERO|UNABLE_TO_GET_ISSUER/.test(c))
    return "the server's certificate was not trusted (TLS): a proxy or antivirus that inspects HTTPS may stand in between; add its certificate to the system or exclude this address";
  if (/proxy/i.test(text))
    return "the proxy refused the connection: check the proxy settings (HTTPS_PROXY) and its sign-in";
  if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|ECONNABORTED)$/.test(c))
    return "the connection was cut (a proxy or firewall in between?)";
  return "the request failed";
}
