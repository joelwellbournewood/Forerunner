/**
 * The daemon's side of web research (ADR 0107): whether this install offers the web page reader
 * (`web_fetch`, the loop driver's `cc:WebFetch`, and on a subscription the same reader through
 * the Agent SDK's tool server, 'sites') and Anthropic's web search on an API key (the loop
 * driver's `cc:WebSearch`, 'web-search'), and the project's rule a call is checked against or
 * sent with: "Web pages research may read" (`project.settings.web_access`, `webAccessOf`, which
 * also reads the blocks still under `browser.blockedDomains`), read at every run so a change
 * applies to the next. `browser.allowedDomains` is the agent browser's list and changes nothing
 * here.
 */
import type { web } from "@forerunner/capabilities";
import type { JsonObject } from "@forerunner/state";
import type { ToolExecutionContext } from "../agent/tools.ts";
import { siteCovers, type WebAccess, webAccessOf } from "./web-access.ts";

/** `FORERUNNER_WEB_FETCH=off` (or `0`, `false`): no web page reader on this install. */
export const WEB_FETCH_ENV = "FORERUNNER_WEB_FETCH";

/** Whether this install offers `web_fetch`: on unless the environment turns it off. */
export function webFetchEnabled(env: NodeJS.ProcessEnv): boolean {
  return !isOff(env[WEB_FETCH_ENV]);
}

/** `FORERUNNER_WEB_SEARCH=off` (or `0`, `false`): no web search on the API key ('web-search'). */
export const WEB_SEARCH_ENV = "FORERUNNER_WEB_SEARCH";

/**
 * Whether this install offers Anthropic's web search on an API key: on unless the environment
 * turns it off (the owner's decision of 2026-11-02, "Q5 yes").
 */
export function webSearchEnabled(env: NodeJS.ProcessEnv): boolean {
  return !isOff(env[WEB_SEARCH_ENV]);
}

function isOff(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === "off" || v === "0" || v === "false" || v === "no";
}

/**
 * The project's lists as Anthropic's web search takes them ('web-search', 'sites'): never both
 * lists in one request (the server refuses that), each entry a bare domain. "Only these
 * websites" is sent as `allowedDomains`, otherwise the "never" list as `blockedDomains`. `key`
 * names the rule sent, so a refusal of it is kept until it changes; `dropped` holds each entry
 * the server cannot take, left out (one log line names them). `withheld`: the rule cannot be sent
 * as one list (a "never" entry inside an "only" entry), so the run is offered no search (one log
 * line says why) and reads pages by address under the full rule.
 */
export interface WebSearchLists {
  allowedDomains?: string[];
  blockedDomains?: string[];
  dropped: string[];
  key: string;
  withheld?: string;
}

/**
 * One entry of a project's list in the server's form, or null when the server cannot take it:
 * `*.example.com` is sent as `example.com`, which covers its subdomains there (unlike the
 * capability token's own patterns, where `*.` is needed for them); a bare host without a dot
 * (`localhost`), an IP address or anything with a wildcard left is not a domain to it.
 */
export function serverDomainOf(entry: string): string | null {
  const host = entry.trim().toLowerCase().replace(/^\*\./, "");
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) return null;
  return host;
}

/** A rule in the server's form (`webSearchListsResolver`): "only" as allowed, else "never" as blocked. */
export function webSearchListsOf(rule: WebAccess): WebSearchLists {
  const dropped: string[] = [];
  const serverForm = (entries: readonly string[]) => {
    const out: string[] = [];
    for (const entry of entries) {
      const d = serverDomainOf(entry);
      if (d === null) dropped.push(entry);
      else if (!out.includes(d)) out.push(d);
    }
    return out;
  };
  if (rule.mode === "only") {
    const allowed = serverForm(rule.only);
    // A blocked site inside an allowed one cannot be said in the same request (never both lists):
    // the run gets no search, and its pages are read by address under the whole rule.
    const inside = rule.never.filter((n) => rule.only.some((o) => siteCovers(o, n)));
    return {
      allowedDomains: allowed,
      dropped,
      key: JSON.stringify({ allowed }),
      ...(inside.length
        ? {
            withheld: `the project reads only ${rule.only.join(", ")} but never ${inside.join(", ")}, which web search cannot be told in one request`,
          }
        : {}),
    };
  }
  const blocked = serverForm(rule.never);
  return {
    ...(blocked.length ? { blockedDomains: blocked } : {}),
    dropped,
    key: JSON.stringify({ blocked }),
  };
}

/**
 * The lists a run's web search is sent with: the project's rule in the server's form
 * (`webSearchListsOf`): "Only these websites" as `allowed_domains`, otherwise the "never" list as
 * `blocked_domains`, never both.
 */
export function webSearchListsResolver(projects: {
  get(id: string): Promise<{ settings: JsonObject } | undefined>;
}): (projectId: string | undefined) => Promise<WebSearchLists> {
  return async (projectId) => {
    const project = projectId ? await projects.get(projectId) : undefined;
    return webSearchListsOf(webAccessOf(project?.settings));
  };
}

/**
 * The rule a run's `web_fetch` is checked against: its project's "Web pages research may read"
 * (`webAccessOf`, with the blocks still under `browser.blockedDomains`). A run without a project,
 * or a project without the setting: any public website.
 */
export function webReadRulesResolver(projects: {
  get(id: string): Promise<{ settings: JsonObject } | undefined>;
}): (ctx: ToolExecutionContext) => Promise<web.WebReadRules> {
  return async (ctx) => {
    const project = ctx.projectId ? await projects.get(ctx.projectId) : undefined;
    return webAccessOf(project?.settings);
  };
}
