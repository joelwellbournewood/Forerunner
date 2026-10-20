import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { isLoopbackHost } from "./config.ts";

/**
 * Health and readiness on the loopback interface, a Hono app served by `@hono/node-server`
 * (spec: "a health route on 127.0.0.1 (Hono)"). `GET /health` answers 200 with the runner's
 * status JSON (never a credential) or 500 when the status function fails, `GET /ready`
 * answers 200 once the runner is ready and 503 before; any other path is 404 and any method
 * but GET or HEAD is 405. Every answer is JSON with `cache-control: no-store`.
 *
 * The host is validated by the configuration (`isLoopbackHost`, config.ts) before anything is
 * composed; the check in `startHealthServer` is the last line for callers that bypass
 * `readRunnerConfig`. `createHealthApp` is the app without a socket, for in-process tests.
 *
 * The readiness file (`runner-ready.json` in the runtime directory by default) carries the
 * runner id, pid, health URL and the ready time; a supervisor or a test waits for it. It is
 * removed on stop.
 */
export interface HealthServerOptions {
  host: string;
  port: number;
  status: () => Promise<object> | object;
  ready: () => boolean;
}

export interface HealthServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

export type HealthApp = Hono;

/** The three routes as a Hono app; `startHealthServer` binds it to the loopback interface. */
export function createHealthApp(opts: Pick<HealthServerOptions, "status" | "ready">): HealthApp {
  const app = new Hono();
  app.use("*", async (c, next) => {
    // Hono routes HEAD to the GET handler and drops the body; `c.req.method` still says HEAD.
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      return c.json({ error: "method_not_allowed" }, 405, { "cache-control": "no-store" });
    }
    await next();
    c.header("cache-control", "no-store");
  });
  app.get("/health", async (c) => {
    try {
      const status = await opts.status();
      return c.json({ ok: true, ...status }, 200);
    } catch (e) {
      return c.json({ ok: false, error: errorMessage(e) }, 500);
    }
  });
  app.get("/ready", (c) => {
    const ready = opts.ready();
    return c.json({ ready }, ready ? 200 : 503);
  });
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((e, c) =>
    c.json({ ok: false, error: errorMessage(e) }, 500, { "cache-control": "no-store" }),
  );
  return app;
}

export async function startHealthServer(opts: HealthServerOptions): Promise<HealthServer> {
  if (!isLoopbackHost(opts.host)) {
    throw new ForerunnerError(
      "validation",
      `the health route binds the loopback interface only, not ${opts.host}`,
    );
  }
  const logger = log("cloud-runner:health");
  const app = createHealthApp(opts);
  // "[::1]" is accepted by the configuration; the socket wants the bare address, the URL the brackets.
  const listenHost = opts.host.trim().replace(/^\[|\]$/g, "");
  const urlHost = listenHost.includes(":") ? `[${listenHost}]` : listenHost;
  const server = await new Promise<ServerType>((resolve, reject) => {
    const srv = serve(
      {
        fetch: app.fetch,
        hostname: listenHost,
        port: opts.port,
        serverOptions: { keepAliveTimeout: 1_000 },
      },
      () => {
        srv.off("error", reject);
        resolve(srv);
      },
    );
    srv.once("error", reject);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? (address as AddressInfo).port : opts.port;
  const url = `http://${urlHost}:${port}`;
  logger.info("health route listening", { url });
  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        if ("closeAllConnections" in server) server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface ReadyFile {
  runnerId: string;
  pid: number;
  healthUrl: string;
  readyAt: string;
  version: string;
}

export function writeReadyFile(path: string, body: ReadyFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
}

export function removeReadyFile(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}
