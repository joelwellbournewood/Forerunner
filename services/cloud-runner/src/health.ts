import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, ForerunnerError, log } from "@forerunner/platform";
import { isLoopbackHost } from "./config.ts";

/**
 * Health and readiness on the loopback interface. `GET /health` answers 200 with the runner's
 * status JSON (never a credential), `GET /ready` answers 200 once the runner is ready and 503
 * before; everything else is 404. Built on `node:http` because `hono` is not a dependency of
 * this service (see cloud-runner.md, "Known issues"). The host is validated by the
 * configuration (`isLoopbackHost`, config.ts) before anything is composed; the check here is
 * the last line for callers that bypass `readRunnerConfig`.
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

export async function startHealthServer(opts: HealthServerOptions): Promise<HealthServer> {
  if (!isLoopbackHost(opts.host)) {
    throw new ForerunnerError(
      "validation",
      `the health route binds the loopback interface only, not ${opts.host}`,
    );
  }
  const logger = log("cloud-runner:health");
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const send = (code: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(code, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(text),
        "cache-control": "no-store",
      });
      res.end(text);
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(405, { error: "method_not_allowed" });
      return;
    }
    if (path === "/health") {
      Promise.resolve(opts.status()).then(
        (status) => send(200, { ok: true, ...status }),
        (e: unknown) => send(500, { ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    }
    if (path === "/ready") {
      const ready = opts.ready();
      send(ready ? 200 : 503, { ready });
      return;
    }
    send(404, { error: "not_found" });
  });
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${opts.host}:${port}`;
  logger.info("health route listening", { url });
  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
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
