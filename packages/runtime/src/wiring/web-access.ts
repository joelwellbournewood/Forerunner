/**
 * "Web pages research may read" (the owner's decision of 2026-11-02, 'sites'; ADR 0107 amended):
 * one per-project setting, `project.settings.web_access`, the same on both credentials.
 *
 * - `mode: "any"` (the default): any public website, except the `never` list.
 * - `mode: "only"`: only the websites on the `only` list (it may not be empty, or research would
 *   be stuck), still minus the `never` list.
 *
 * Each entry covers the site and all its subdomains. Whatever the lists say, research never reads
 * this computer or the home or office network (the page reader's rules, `web/policy.ts`).
 *
 * One clean-up for every place an entry is typed or read (the Settings row shows it back before
 * saving, `settings.set` stores it, the reader and the server search read it): lowercase; the
 * scheme, path, port, a trailing dot and a leading `www.` taken off; an international name as its
 * ASCII (punycode) form; an IP address, a name on this computer or the local network, and in the
 * "only" list a public suffix such as `co.uk` or `github.io` refused in words. Nothing is dropped
 * silently: an entry is either cleaned (and shown cleaned) or refused with its reason.
 *
 * One stored block list: `web_access.never`. Blocks written before this setting existed, through
 * `PUT /projects/:id/settings` as `browser.blockedDomains`, are read here too until the project's
 * settings are written again (the route then takes them into `web_access.never`), so every block
 * in force is enforced and shown. `browser.allowedDomains` is the agent browser's and the
 * sandbox's network list: it changes nothing research reads and never becomes "only".
 *
 * Pure (no `node:` import): the UI imports it for the Settings row's clean-up and the project
 * page's line.
 */

/** The project setting's key (`settings.set web_access`). */
export const WEB_ACCESS_SETTING = "web_access";

/** The older home of the block list (`settings.browser.blockedDomains`, ADR 0047). */
const BROWSER_KEY = "browser";

export type WebAccessMode = "any" | "only";

export interface WebAccess {
  mode: WebAccessMode;
  /** "Only these websites" (mode `only`): each covers the site and its subdomains. */
  only: string[];
  /** "Never these websites", in either mode: each covers the site and its subdomains. */
  never: string[];
}

export const DEFAULT_WEB_ACCESS: WebAccess = Object.freeze({
  mode: "any",
  only: [],
  never: [],
}) as WebAccess;

/** Which list an entry is typed into: a public suffix is refused only in the "only" list. */
export type SiteList = "only" | "never";

export type CleanedSite =
  | { ok: true; entry: string; site: string }
  | { ok: false; entry: string; why: string };

export interface CleanedList {
  /** The cleaned sites, in the order typed, each once. */
  sites: string[];
  /** Each entry that was changed by the clean-up, with what it became ("https://x.org/a" -> "x.org"). */
  changed: { entry: string; site: string }[];
  /** Each entry refused, with its reason in words. */
  refused: { entry: string; why: string }[];
}

/**
 * Suffixes under which anyone can have a site of their own: an "only" list entry this broad would
 * open every one of them (the owner's decision: "co.uk" or "github.io" are refused there). A
 * curated part of the Public Suffix List (country second levels and the hosting platforms people
 * paste most); a single label (`com`) is refused anyway as a name without a dot.
 */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // Country second levels.
  "co.uk",
  "org.uk",
  "me.uk",
  "ltd.uk",
  "plc.uk",
  "net.uk",
  "ac.uk",
  "gov.uk",
  "sch.uk",
  "nhs.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "gov.au",
  "id.au",
  "asn.au",
  "co.nz",
  "net.nz",
  "org.nz",
  "ac.nz",
  "govt.nz",
  "geek.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "ad.jp",
  "ed.jp",
  "gr.jp",
  "lg.jp",
  "co.kr",
  "or.kr",
  "ne.kr",
  "ac.kr",
  "go.kr",
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "edu.br",
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "com.tw",
  "org.tw",
  "net.tw",
  "edu.tw",
  "gov.tw",
  "com.hk",
  "org.hk",
  "net.hk",
  "edu.hk",
  "gov.hk",
  "com.sg",
  "org.sg",
  "net.sg",
  "edu.sg",
  "gov.sg",
  "com.my",
  "org.my",
  "net.my",
  "edu.my",
  "gov.my",
  "co.in",
  "net.in",
  "org.in",
  "firm.in",
  "gen.in",
  "ind.in",
  "ac.in",
  "edu.in",
  "gov.in",
  "co.za",
  "org.za",
  "net.za",
  "gov.za",
  "ac.za",
  "web.za",
  "com.mx",
  "org.mx",
  "net.mx",
  "gob.mx",
  "edu.mx",
  "com.ar",
  "org.ar",
  "net.ar",
  "gob.ar",
  "edu.ar",
  "com.tr",
  "org.tr",
  "net.tr",
  "gov.tr",
  "edu.tr",
  "com.ua",
  "org.ua",
  "net.ua",
  "gov.ua",
  "in.ua",
  "co.il",
  "org.il",
  "net.il",
  "ac.il",
  "gov.il",
  "co.id",
  "or.id",
  "web.id",
  "ac.id",
  "go.id",
  "com.ph",
  "org.ph",
  "net.ph",
  "gov.ph",
  "edu.ph",
  "com.pk",
  "org.pk",
  "net.pk",
  "gov.pk",
  "edu.pk",
  "com.ng",
  "org.ng",
  "gov.ng",
  "edu.ng",
  "com.eg",
  "org.eg",
  "gov.eg",
  "edu.eg",
  "com.sa",
  "org.sa",
  "gov.sa",
  "edu.sa",
  "co.th",
  "or.th",
  "ac.th",
  "go.th",
  "in.th",
  "com.vn",
  "org.vn",
  "net.vn",
  "gov.vn",
  "edu.vn",
  "com.co",
  "org.co",
  "net.co",
  "gov.co",
  "edu.co",
  "com.pe",
  "org.pe",
  "gob.pe",
  "com.ve",
  "com.uy",
  "com.ec",
  "com.bo",
  "com.py",
  "com.gt",
  "co.ke",
  "or.ke",
  "ac.ke",
  "go.ke",
  "co.tz",
  "co.ug",
  "co.zw",
  "co.bw",
  "co.at",
  "or.at",
  "gv.at",
  "ac.at",
  "com.pl",
  "net.pl",
  "org.pl",
  "gov.pl",
  "edu.pl",
  "com.es",
  "org.es",
  "nom.es",
  "gob.es",
  "edu.es",
  "com.pt",
  "org.pt",
  "gov.pt",
  "edu.pt",
  "com.gr",
  "org.gr",
  "gov.gr",
  "edu.gr",
  "com.ro",
  "org.ro",
  "com.cy",
  "com.mt",
  "com.hr",
  "co.hu",
  "co.rs",
  // Hosting platforms where each customer gets a subdomain.
  "github.io",
  "gitlab.io",
  "bitbucket.io",
  "codeberg.page",
  "sourceforge.io",
  "netlify.app",
  "vercel.app",
  "now.sh",
  "pages.dev",
  "workers.dev",
  "trycloudflare.com",
  "herokuapp.com",
  "herokussl.com",
  "appspot.com",
  "web.app",
  "firebaseapp.com",
  "azurewebsites.net",
  "cloudapp.net",
  "azurestaticapps.net",
  "azureedge.net",
  "blob.core.windows.net",
  "cloudfront.net",
  "amazonaws.com",
  "s3.amazonaws.com",
  "elasticbeanstalk.com",
  "awsapprunner.com",
  "blogspot.com",
  "wordpress.com",
  "tumblr.com",
  "wixsite.com",
  "squarespace.com",
  "weebly.com",
  "glitch.me",
  "repl.co",
  "replit.app",
  "replit.dev",
  "onrender.com",
  "fly.dev",
  "railway.app",
  "up.railway.app",
  "surge.sh",
  "readthedocs.io",
  "gitbook.io",
  "notion.site",
  "substack.com",
  "ngrok.io",
  "ngrok-free.app",
  "ngrok.app",
  "deno.dev",
  "neocities.org",
  "myshopify.com",
  "webflow.io",
  "framer.app",
  "framer.website",
  "streamlit.app",
  "hf.space",
  "carrd.co",
  "netlify.com",
  "pythonanywhere.com",
  "000webhostapp.com",
  "altervista.org",
  "free.fr",
]);

/** Local names: this computer and the home or office network, never a website. */
const LOCAL_SUFFIX =
  /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/;

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/**
 * The host a typed entry names, lowercase and in ASCII, or null when it names none: a bare name
 * or an address with a scheme, a path or a port; `*.` in front means its subdomains, which every
 * entry covers anyway.
 */
function hostOfEntry(entry: string): string | null {
  let text = entry.trim().replace(/^\*\./, "");
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/** One entry cleaned for a list, or refused with its reason. */
export function cleanSite(entry: string, list: SiteList): CleanedSite {
  const raw = entry.trim();
  const host = hostOfEntry(raw);
  if (!host) return { ok: false, entry: raw, why: "not a website address" };
  if (IPV4.test(host) || host.includes(":"))
    return { ok: false, entry: raw, why: "an IP address: name the website instead" };
  const site = host.replace(/^www\./, "");
  if (!site.includes(".") || LOCAL_SUFFIX.test(site))
    return {
      ok: false,
      entry: raw,
      why: "a name on this computer or the local network, which research never reads",
    };
  if (!HOST.test(site)) return { ok: false, entry: raw, why: "not a website address" };
  if (list === "only" && PUBLIC_SUFFIXES.has(site))
    return {
      ok: false,
      entry: raw,
      why: "too broad: anyone can have a site under it; name the site itself",
    };
  return { ok: true, entry: raw, site };
}

/** Entries as typed: one per line, or separated by commas or spaces. */
export function splitEntries(text: string | readonly string[]): string[] {
  const parts = typeof text === "string" ? [text] : [...text];
  return parts
    .flatMap((p) => p.split(/[\s,;]+/))
    .map((p) => p.trim())
    .filter(Boolean);
}

/** A list cleaned: the sites, what was changed, what was refused (never dropped silently). */
export function cleanSiteList(text: string | readonly string[], list: SiteList): CleanedList {
  const out: CleanedList = { sites: [], changed: [], refused: [] };
  for (const entry of splitEntries(text)) {
    const c = cleanSite(entry, list);
    if (!c.ok) {
      out.refused.push({ entry: c.entry, why: c.why });
      continue;
    }
    if (c.site !== c.entry) out.changed.push({ entry: c.entry, site: c.site });
    if (!out.sites.includes(c.site)) out.sites.push(c.site);
  }
  return out;
}

/** Whether `site` (a cleaned entry) covers `host`: the site itself or one of its subdomains. */
export function siteCovers(site: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const s = site.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  return !!s && (h === s || h.endsWith(`.${s}`));
}

/** Whether any site of `sites` covers `host`. */
export function sitesCover(sites: readonly string[], host: string): boolean {
  return sites.some((s) => siteCovers(s, host));
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * The rule in force for a project, from its settings: `web_access`, plus the blocks still under
 * `browser.blockedDomains` (written before the setting, not yet moved). A legacy entry the clean-up
 * takes is read as its cleaned site; one it refuses (an IP address, say) is kept as written,
 * lowercase, so the reader still matches it: a block is never lost on the way.
 */
export function webAccessOf(settings: Record<string, unknown> | null | undefined): WebAccess {
  const raw = settings?.[WEB_ACCESS_SETTING];
  const v =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const only = cleanSiteList(strings(v.only), "only").sites;
  const mode: WebAccessMode = v.mode === "only" && only.length > 0 ? "only" : "any";
  const never = cleanSiteList(strings(v.never), "never").sites;
  for (const entry of legacyBlocks(settings)) if (!never.includes(entry)) never.push(entry);
  return { mode, only: mode === "only" ? only : [], never };
}

/**
 * `browser.blockedDomains` as the never list reads it: each entry cleaned where the clean-up
 * takes it, else kept as written (lowercase, without `*.`).
 */
export function legacyBlocks(settings: Record<string, unknown> | null | undefined): string[] {
  const b = settings?.[BROWSER_KEY];
  if (!b || typeof b !== "object" || Array.isArray(b)) return [];
  const o = b as Record<string, unknown>;
  const out: string[] = [];
  for (const entry of strings(o.blockedDomains ?? o.blocked_domains)) {
    const c = cleanSite(entry, "never");
    const site = c.ok ? c.site : entry.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (site && !out.includes(site)) out.push(site);
  }
  return out;
}

/** Up to `max` sites, then "and N more" (design §5 rule 5). */
export function siteNames(sites: readonly string[], max = 3): string {
  if (sites.length <= max) return sites.join(", ");
  return `${sites.slice(0, max).join(", ")} and ${sites.length - max} more`;
}

/** The rule in words, for the Settings row, the change card and the change log. */
export function webAccessWords(value: unknown): string {
  const v = webAccessOf({ [WEB_ACCESS_SETTING]: value as never });
  if (v.mode === "only") {
    const never = v.never.length ? `; never ${siteNames(v.never)}` : "";
    return `Only these websites: ${siteNames(v.only, 5)}${never}`;
  }
  return v.never.length
    ? `Any public website, never ${siteNames(v.never, 5)}`
    : "Any public website";
}

/** The project page's line: "Research reads: any public website". */
export function researchReadsLine(v: WebAccess): string {
  if (v.mode === "only") return `Research reads: only ${siteNames(v.only)}`;
  return v.never.length
    ? `Research reads: any public website, never ${siteNames(v.never)}`
    : "Research reads: any public website";
}

/**
 * The brief's line for a run that reads the web, naming the project's rule (null for the default:
 * any public website, nothing blocked). The report says what it could not read because of it.
 */
export function webAccessBriefLine(v: WebAccess): string | null {
  const never = v.never.length ? ` It never reads ${v.never.join(", ")}.` : "";
  if (v.mode === "only")
    return `This project's research reads only these websites and their subdomains: ${v.only.join(", ")}.${never} Use no other source; say in the report which pages you could not read because of this rule.`;
  if (v.never.length)
    return `This project's research reads any public website except these and their subdomains: ${v.never.join(", ")}. Say in the report which pages you could not read because of this rule.`;
  return null;
}

/** Whether `inner` (a site) lies inside or equals `outer`. */
const within = (inner: string, outer: string) => siteCovers(outer, inner);

/**
 * Whether the rule `to` lets research read nothing that `from` did not (a narrowing, which acts at
 * once; a widening asks a yes first). Exact over sites and subdomains: every never-site of `from`
 * stays unreadable under `to`, and in "only" mode `to` reads within `from`'s list.
 */
export function webAccessNarrows(toValue: unknown, fromValue: unknown): boolean {
  const to = webAccessOf({ [WEB_ACCESS_SETTING]: toValue as never });
  const from = webAccessOf({ [WEB_ACCESS_SETTING]: fromValue as never });
  const blockedBy = (host: string, w: WebAccess) => w.never.some((n) => within(host, n));
  if (from.mode === "only") {
    if (to.mode !== "only") return false;
    for (const s of to.only)
      if (!blockedBy(s, to) && !from.only.some((f) => within(s, f))) return false;
  }
  for (const n of from.never) {
    if (blockedBy(n, to)) continue;
    if (to.mode === "any") return false;
    // In "only" mode the blocked site may stay out of reach because no "only" entry reaches it.
    if (to.only.some((s) => within(n, s))) return false;
    for (const s of to.only) if (within(s, n) && !blockedBy(s, to)) return false;
  }
  return true;
}
