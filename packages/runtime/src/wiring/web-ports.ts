/**
 * The daemon's side of web research (ADR 0107): whether this install offers the web page reader
 * (`web_fetch`, the loop driver's `cc:WebFetch`) and the project's site list and block list a
 * call is checked against. The lists are the project's `settings.browser` ones, the same the
 * browser capability reads (ADR 0047), read at every call so a change applies to the next page.
 */
import type { web } from "@forerunner/capabilities";
import type { JsonObject } from "@forerunner/state";
import type { ToolExecutionContext } from "../agent/tools.ts";
import { browserSettingsOf } from "./browser-ports.ts";

/** `FORERUNNER_WEB_FETCH=off` (or `0`, `false`): no web page reader on this install. */
export const WEB_FETCH_ENV = "FORERUNNER_WEB_FETCH";

/** Whether this install offers `web_fetch`: on unless the environment turns it off. */
export function webFetchEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env[WEB_FETCH_ENV]?.trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
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
