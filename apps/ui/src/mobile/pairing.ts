/**
 * What a pairing QR or deep link carries (spec R.2). The desktop shows the one-time code
 * with the service URL; the phone scans it (barcode plugin) or the camera app opens the
 * `fr://` deep link, or the human types the code and the URL. Accepted forms:
 *   fr://pair?u=<service url>&c=<code>[&h=<human id>]
 *   https://<any>/pair?u=...&c=...            (the same query on a web link)
 *   {"v":1,"code":"...","url":"...","humanId":"..."}   (the service's `qr` object plus url)
 *   ABCD2345                                   (a bare code; the URL is entered separately)
 */
export interface PairingPayload {
  code: string;
  serviceUrl: string | null;
  humanId: string | null;
}

/** The service issues 8 characters from an alphabet without look-alikes. */
const CODE_RE = /^[A-Z0-9]{8}$/i;

export function normalizePairingCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

export function isPairingCode(raw: string): boolean {
  return CODE_RE.test(normalizePairingCode(raw));
}

function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function parsePairingPayload(text: string): PairingPayload | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("{")) {
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      const code = typeof obj.code === "string" ? normalizePairingCode(obj.code) : "";
      if (!CODE_RE.test(code)) return null;
      const url = typeof obj.url === "string" ? obj.url : typeof obj.u === "string" ? obj.u : null;
      return {
        code,
        serviceUrl: normalizeUrl(url),
        humanId: typeof obj.humanId === "string" ? obj.humanId : null,
      };
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) {
    let u: URL;
    try {
      // `fr://pair?...` parses as a URL with host "pair"; a web link has the path /pair.
      u = new URL(t);
    } catch {
      return null;
    }
    const isPair =
      (u.protocol === "fr:" && (u.host === "pair" || u.pathname.replace(/^\/+/, "") === "pair")) ||
      /\/pair\/?$/.test(u.pathname);
    if (!isPair) return null;
    const code = normalizePairingCode(u.searchParams.get("c") ?? u.searchParams.get("code") ?? "");
    if (!CODE_RE.test(code)) return null;
    return {
      code,
      serviceUrl: normalizeUrl(u.searchParams.get("u") ?? u.searchParams.get("url")),
      humanId: u.searchParams.get("h") ?? u.searchParams.get("humanId"),
    };
  }
  const code = normalizePairingCode(t);
  if (CODE_RE.test(code)) return { code, serviceUrl: null, humanId: null };
  return null;
}

/** The deep link the desktop encodes in its QR (also what `fr://` opens on the phone). */
export function buildPairingLink(serviceUrl: string, code: string, humanId?: string): string {
  const u = new URL("fr://pair");
  u.searchParams.set("u", serviceUrl);
  u.searchParams.set("c", normalizePairingCode(code));
  if (humanId) u.searchParams.set("h", humanId);
  return u.toString();
}
