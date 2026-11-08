/**
 * The daemon's side of web research (ADR 0107): whether this install offers the web page reader
 * (`web_fetch`, the loop driver's `cc:WebFetch`) and Anthropic's web search on an API key (the
 * loop driver's `cc:WebSearch`, 'web-search'), and the project's site list and block list a call
 * is checked against or sent with. The lists are the project's `settings.browser` ones, the same
 * the browser capability reads (ADR 0047), read at every run so a change applies to the next.
 */
import type { web } from "@forerunner/capabilities";
import type { JsonObject } from "@forerunner/state";
import type { ToolExecutionContext } from "../agent/tools.ts";
import { browserSettingsOf } from "./browser-ports.ts";

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
 * The project's lists as Anthropic's web search takes them ('web-search'): never both lists in
 * one request (the server refuses that), each entry a bare domain. `key` names the lists sent,
 * so a refusal of them is kept until they change; `dropped` holds each entry the server cannot
 * take, left out (one log line names them).
 */
export interface WebSearchLists {
  allowedDomains?: string[];
  blockedDomains?: string[];
  dropped: string[];
  key: string;
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

/**
 * The lists a run's web search is sent with: today the project's block list as
 * `blocked_domains` (the site list names hosts the page reader may reach on a private address,
 * which is no restriction of where research reads, so it is not sent; 'sites' adds the "Only
 * these websites" list here as `allowed_domains`, never with the block list).
 */
export function webSearchListsResolver(projects: {
  get(id: string): Promise<{ settings: JsonObject } | undefined>;
}): (projectId: string | undefined) => Promise<WebSearchLists> {
  return async (projectId) => {
    const project = projectId ? await projects.get(projectId) : undefined;
    const s = browserSettingsOf(project?.settings);
    const blocked: string[] = [];
    const dropped: string[] = [];
    for (const entry of s.blockedDomains) {
      const d = serverDomainOf(entry);
      if (d === null) dropped.push(entry);
      else if (!blocked.includes(d)) blocked.push(d);
    }
    return {
      ...(blocked.length ? { blockedDomains: blocked } : {}),
      dropped,
      key: JSON.stringify({ blocked }),
    };
  };
}

/**
 * The sites a run's `web_fetch` is checked against: its project's site list (hosts the person
 * named, allowed even on a private address) and block list (refused whatever else says). A run
 * without a project, or a project without the setting, has empty lists: public pages only.
 */
export function webReadSitesResolver(projects: {
  get(id: string): Promise<{ settings: JsonObject } | undefined>;
}): (ctx: ToolExecutionContext) => Promise<web.WebReadSites> {
  return async (ctx) => {
    const project = ctx.projectId ? await projects.get(ctx.projectId) : undefined;
    const s = browserSettingsOf(project?.settings);
    return { allowed: s.allowedDomains, blocked: s.blockedDomains };
  };
}
