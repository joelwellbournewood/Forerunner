import { requireScope, resolveHumanId } from "../auth/principal.ts";
import { ApiError } from "../errors.ts";
import { type App, principal, type RouteContext } from "../http.ts";
import { costView, currentChfRate } from "../views.ts";

function isoOrThrow(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) throw new ApiError(400, "validation", `${name} must be ISO-8601`);
  return new Date(t).toISOString();
}

/** Cost totals by project and human for the phone (spec I, R). Devices see their own human only. */
export function registerCostRoutes(app: App, ctx: RouteContext): void {
  app.get("/costs", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const humanId = resolveHumanId(p, c.req.query("humanId"));
    const projectId = c.req.query("projectId") || undefined;
    const agentId = c.req.query("agentId") || undefined;
    const now = ctx.clock.now();
    const from =
      isoOrThrow(c.req.query("from"), "from") ??
      new Date(now - 30 * 24 * 3600 * 1000).toISOString();
    // `to` is exclusive in the ledger query; the default window includes entries made this millisecond.
    const to = isoOrThrow(c.req.query("to"), "to") ?? new Date(now + 1).toISOString();
    const rate = await currentChfRate(ctx.store, ctx.chfPerUsd);
    const view = await costView(
      ctx.store,
      {
        ...(humanId ? { humanId } : {}),
        ...(projectId ? { projectId } : {}),
        ...(agentId ? { agentId } : {}),
        from,
        to,
      },
      rate,
      { from, to },
    );
    return c.json(view);
  });
}
