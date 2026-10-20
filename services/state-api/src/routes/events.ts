import { requireScope } from "../auth/principal.ts";
import { ApiError } from "../errors.ts";
import { type App, principal, type RouteContext } from "../http.ts";
import { type ChangeEvent, filterForHuman } from "../realtime.ts";
import { sseLoop } from "../sse.ts";

/**
 * GET /events: the realtime channel (spec F.3, R). A device sees changes that concern its
 * human plus project-wide ones; the runtime (admin) sees everything. `Last-Event-ID` (or
 * ?lastEventId=) resumes from the in-process buffer; when the id is too old the stream sends
 * `resync` and the client reloads its state. A heartbeat every 15 s keeps proxies open.
 */
export function registerEventRoutes(app: App, ctx: RouteContext): void {
  app.get("/events", async (c) => {
    const p = principal(c);
    requireScope(p, "read");
    const filter = filterForHuman(p.kind === "device" ? p.humanId : null);
    const raw = c.req.header("last-event-id") ?? c.req.query("lastEventId");
    let lastSeq: number | undefined;
    if (raw !== undefined && raw !== "") {
      if (!/^\d+$/.test(raw))
        throw new ApiError(400, "validation", "Last-Event-ID must be an integer");
      lastSeq = Number(raw);
    }
    const queue: ChangeEvent[] = [];
    const drain = async (send: (event: string, data: unknown, id?: string) => Promise<void>) => {
      while (queue.length) {
        const e = queue.shift() as ChangeEvent;
        await send(e.type, e, String(e.seq));
      }
    };
    return sseLoop(c, {
      clock: ctx.clock,
      heartbeatMs: ctx.config.heartbeatMs,
      init: async (send) => {
        await send("ready", {
          seq: ctx.bus.currentSeq,
          at: ctx.clock.nowIso(),
          instance: ctx.bus.instanceId,
        });
        if (lastSeq !== undefined) {
          const missed = ctx.bus.since(lastSeq, filter);
          if (missed === undefined) await send("resync", { reason: "last-event-id too old" });
          else for (const e of missed) await send(e.type, e, String(e.seq));
        }
      },
      subscribe: (wake) =>
        ctx.bus.subscribe((e) => {
          queue.push(e);
          wake();
        }, filter),
      flush: drain,
    });
  });
}
