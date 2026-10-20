import { randomBytes } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { type Clock, log, systemClock } from "@forerunner/platform";
import { domainAllowed } from "../enforcement/hooks.ts";

/**
 * Egress proxy for allowlisted sandboxes. Plain HTTP requests are forwarded and HTTPS goes
 * through CONNECT tunnels; both are allowed only when the target host matches the allowlist
 * (same patterns as a capability token's allowedDomains: exact host or `*.example.com`).
 * Everything else gets 403. Every decision is reported to `onDecision` (host, port, allowed)
 * and bytes are counted per direction.
 *
 * Containers reach it over the host gateway, so it can listen on a non-loopback interface;
 * two guards make that safe: a per-sandbox token in Proxy-Authorization and a source filter
 * that accepts loopback and private-range clients only.
 */
export interface EgressDecision {
  host: string;
  port: number;
  allowed: boolean;
  /** HTTP method, or "CONNECT" for tunnels. */
  method: string;
  /** Client address as seen by the proxy. */
  remote: string;
  reason?: string;
  at: string;
}

export interface EgressStats {
  bytesIn: number;
  bytesOut: number;
  allowed: number;
  denied: number;
}

export interface EgressProxyOptions {
  /** Allowed host patterns. Empty = deny everything (used by the process sandbox for "none"). */
  allow: readonly string[];
  /** Interface to listen on. Default 127.0.0.1; containers need 0.0.0.0 or the bridge IP. */
  bindHost?: string;
  /** Port; default 0 (ephemeral). */
  port?: number;
  /** When set, clients must send `Proxy-Authorization: Basic base64("forerunner:<token>")`. */
  token?: string;
  onDecision?: (d: EgressDecision) => void;
  /** Source filter; default accepts loopback and RFC 1918 / link-local / ULA addresses. */
  allowFrom?: (remoteAddress: string) => boolean;
  /** Idle socket timeout in ms; default 120 000. */
  idleTimeoutMs?: number;
  /**
   * Time an allowed upstream may take to connect (CONNECT tunnels) or to answer (forwarded
   * HTTP) before the client gets 504; default 30 000. Keeps a black-holed host from pinning a
   * tunnel open until the idle timeout.
   */
  upstreamTimeoutMs?: number;
  clock?: Clock;
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

export const EGRESS_PROXY_USER = "forerunner";

export class EgressProxy {
  readonly host: string;
  readonly port: number;
  readonly token: string | undefined;
  private readonly server: http.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly counters: EgressStats = { bytesIn: 0, bytesOut: 0, allowed: 0, denied: 0 };
  private readonly logger = log("sandbox:egress");
  private readonly upstreamTimeoutMs: number;
  private closed = false;

  private constructor(
    private readonly opts: EgressProxyOptions,
    server: http.Server,
    host: string,
    port: number,
  ) {
    this.server = server;
    this.host = host;
    this.port = port;
    this.token = opts.token;
    this.upstreamTimeoutMs = opts.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  }

  /** Random token for `EgressProxyOptions.token`. */
  static newToken(): string {
    return randomBytes(18).toString("base64url");
  }

  static async start(opts: EgressProxyOptions): Promise<EgressProxy> {
    const bindHost = opts.bindHost ?? "127.0.0.1";
    const server = http.createServer();
    let proxy: EgressProxy | null = null;
    const allowFrom = opts.allowFrom ?? isPrivateAddress;
    server.on("connection", (socket) => {
      const remote = socket.remoteAddress ?? "";
      if (!allowFrom(remote)) {
        socket.destroy();
        return;
      }
      socket.setTimeout(opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, () => socket.destroy());
      proxy?.sockets.add(socket);
      socket.on("close", () => proxy?.sockets.delete(socket));
    });
    server.on("request", (req, res) => proxy?.onRequest(req, res));
    server.on("connect", (req, socket, head) => proxy?.onConnect(req, socket as net.Socket, head));
    server.on("clientError", (_err, socket) => {
      try {
        (socket as net.Socket).end("HTTP/1.1 400 Bad Request\r\n\r\n");
      } catch {
        // socket already gone
      }
    });
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, bindHost, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
    proxy = new EgressProxy(opts, server, bindHost, port);
    return proxy;
  }

  /**
   * Proxy URL as a client should use it, with credentials when a token is set. `port` differs
   * from the listening port when a relay sidecar fronts the proxy.
   */
  url(
    advertisedHost = this.host === "0.0.0.0" || this.host === "::" ? "127.0.0.1" : this.host,
    port = this.port,
  ): string {
    const auth = this.token
      ? `${encodeURIComponent(EGRESS_PROXY_USER)}:${encodeURIComponent(this.token)}@`
      : "";
    return `http://${auth}${advertisedHost}:${port}`;
  }

  /** Environment variables that route well-behaved clients (git, curl, npm, pip) through it. */
  envFor(advertisedHost?: string, port?: number): Record<string, string> {
    const u = this.url(advertisedHost, port);
    return {
      HTTP_PROXY: u,
      HTTPS_PROXY: u,
      http_proxy: u,
      https_proxy: u,
      ALL_PROXY: u,
      NO_PROXY: "",
      no_proxy: "",
    };
  }

  stats(): EgressStats {
    return { ...this.counters };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolveClose) => this.server.close(() => resolveClose()));
  }

  private authorized(header: string | undefined): boolean {
    if (!this.token) return true;
    if (!header) return false;
    const m = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/i);
    if (!m?.[1]) return false;
    let decoded: string;
    try {
      decoded = Buffer.from(m[1], "base64").toString("utf8");
    } catch {
      return false;
    }
    const sep = decoded.indexOf(":");
    if (sep < 0) return false;
    return (
      decoded.slice(0, sep) === EGRESS_PROXY_USER &&
      timingSafeEqualStr(decoded.slice(sep + 1), this.token)
    );
  }

  private decide(host: string, port: number, method: string, remote: string): boolean {
    const allowed = host.length > 0 && domainAllowed(host, this.opts.allow);
    if (allowed) this.counters.allowed++;
    else this.counters.denied++;
    const d: EgressDecision = {
      host,
      port,
      allowed,
      method,
      remote,
      at: (this.opts.clock ?? systemClock).nowIso(),
    };
    if (!allowed) d.reason = "host not in the task allowlist";
    this.logger.info(allowed ? "egress allowed" : "egress denied", {
      host,
      port,
      method,
      remote,
    });
    try {
      this.opts.onDecision?.(d);
    } catch {
      // an audit sink must never break the proxy
    }
    return allowed;
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const remote = req.socket.remoteAddress ?? "";
    if (!this.authorized(req.headers["proxy-authorization"])) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="forerunner"' });
      res.end();
      return;
    }
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("forerunner egress: proxy requests need an absolute URL\n");
      return;
    }
    if (target.protocol !== "http:") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("forerunner egress: only http:// forwarding and CONNECT tunnels are supported\n");
      return;
    }
    const host = target.hostname.toLowerCase();
    const port = Number(target.port || 80);
    if (!this.decide(host, port, req.method ?? "GET", remote)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end(`forerunner egress: host not allowed: ${host}\n`);
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = http.request(
      {
        host,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        timeout: this.upstreamTimeoutMs,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.on("data", (c: Buffer) => {
          this.counters.bytesOut += c.length;
        });
        upRes.pipe(res);
      },
    );
    upstream.on("timeout", () => {
      if (!res.headersSent) res.writeHead(504, { "content-type": "text/plain" });
      res.end("forerunner egress: upstream timed out\n");
      upstream.destroy();
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("forerunner egress: upstream unreachable\n");
    });
    req.on("data", (c: Buffer) => {
      this.counters.bytesIn += c.length;
    });
    req.pipe(upstream);
  }

  private onConnect(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const remote = socket.remoteAddress ?? "";
    if (!this.authorized(req.headers["proxy-authorization"])) {
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="forerunner"\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    const { host, port } = splitHostPort(req.url ?? "");
    if (!this.decide(host, port, "CONNECT", remote)) {
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nforerunner egress: host not allowed: ${host}\r\n`,
      );
      return;
    }
    const upstream = net.connect(port, host, () => {
      // Connected: the per-connection idle timeout on the client socket takes over.
      upstream.setTimeout(0);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        this.counters.bytesIn += head.length;
        upstream.write(head);
      }
      upstream.on("data", (c: Buffer) => {
        this.counters.bytesOut += c.length;
      });
      socket.on("data", (c: Buffer) => {
        this.counters.bytesIn += c.length;
      });
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.setTimeout(this.upstreamTimeoutMs, () => {
      if (!socket.destroyed) {
        socket.end("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n");
      }
      upstream.destroy();
    });
    upstream.on("error", () => {
      if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
  }
}

export function splitHostPort(target: string): { host: string; port: number } {
  // [::1]:443, example.com:443, example.com
  const v6 = target.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6?.[1]) return { host: v6[1].toLowerCase(), port: Number(v6[2] ?? 443) };
  const idx = target.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(target.slice(idx + 1))) {
    return { host: target.slice(0, idx).toLowerCase(), port: Number(target.slice(idx + 1)) };
  }
  return { host: target.toLowerCase(), port: 443 };
}

/** Loopback, RFC 1918, link-local, CGNAT and IPv6 ULA / link-local addresses. */
export function isPrivateAddress(address: string): boolean {
  let a = address.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice(7);
  if (a === "::1" || a === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(a) || a.startsWith("fe80:")) return true;
  const m = a.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const o1 = Number(m[1]);
  const o2 = Number(m[2]);
  if (o1 === 127 || o1 === 10) return true;
  if (o1 === 192 && o2 === 168) return true;
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
  if (o1 === 169 && o2 === 254) return true;
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
  return false;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}
