/**
 * Settings → Sandbox (Docker) behind the daemon (U-079, ADR 0101): `GET /sandbox` (the state
 * with its plain steps), `POST /sandbox/check` (Check again), `POST /sandbox/pull` (Download
 * the sandbox, a background `docker pull`) and `GET /sandbox/pull/events` (the download's
 * progress, replayable, as SSE with the bearer header or as JSON), the voice install's pattern
 * (ADR 0090).
 */
import { ForerunnerError } from "@forerunner/platform";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { SandboxPullEntryView } from "../sandbox/readiness-types.ts";
import type { ComposedSandbox } from "./sandbox-wiring.ts";

function errorBody(e: unknown): { code: string; message: string } {
  if (e instanceof ForerunnerError)
    return { code: e.code === "claim_conflict" ? "conflict" : e.code, message: e.message };
  return { code: "internal", message: e instanceof Error ? e.message : String(e) };
}

export function createSandboxRoutes(deps: {
  sandbox: Pick<ComposedSandbox, "readiness" | "view">;
}): Hono {
  const app = new Hono();
  const { sandbox } = deps;
  const readiness = sandbox.readiness;

  app.onError((e, c) => {
    const body = errorBody(e);
    if (body.code === "conflict") return c.json(body, 409);
    if (body.code === "validation") return c.json(body, 400);
    return c.json(body, 500);
  });

  app.get("/sandbox", async (c) => c.json(await sandbox.view()));

  app.post("/sandbox/check", async (c) => {
    await readiness.check({ force: true });
    return c.json(await sandbox.view());
  });

  app.post("/sandbox/pull", async (c) => {
    await readiness.startPull();
    return c.json(await sandbox.view(), 202);
  });

  app.get("/sandbox/pull/events", async (c) => {
    const raw = c.req.query("afterSeq");
    const afterSeq = raw === undefined || raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(afterSeq) || afterSeq < 0)
      return c.json(
        { code: "validation", message: "afterSeq must be a non-negative integer" },
        400,
      );
    if (!(c.req.header("accept") ?? "").includes("text/event-stream"))
      return c.json(readiness.eventsAfter(afterSeq));
    return streamSSE(c, async (stream) => {
      let last = afterSeq;
      const pending: SandboxPullEntryView[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = readiness.subscribe((e) => {
        if (e) pending.push(e);
        wake?.();
      });
      stream.onAbort(() => wake?.());
      try {
        for (;;) {
          for (const e of [...readiness.eventsAfter(last), ...pending.splice(0)]) {
            if (e.seq <= last) continue;
            last = e.seq;
            await stream.writeSSE({
              event: "sandbox.pull",
              data: JSON.stringify(e),
              id: String(e.seq),
            });
          }
          if (!readiness.pulling || stream.aborted) break;
          let cancel = () => {};
          await new Promise<void>((r) => {
            wake = r;
            cancel = readiness.timer(15_000, r);
          });
          cancel();
          wake = null;
          if (!stream.aborted && pending.length === 0 && readiness.pulling)
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
