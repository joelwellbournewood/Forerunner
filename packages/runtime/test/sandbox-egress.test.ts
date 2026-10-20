import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EGRESS_PROXY_USER,
  type EgressDecision,
  EgressProxy,
  isPrivateAddress,
  splitHostPort,
} from "../src/sandbox/egress-proxy.ts";

interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(
  proxy: EgressProxy,
  opts: { path: string; method?: string; auth?: string | null; body?: string },
): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const headers: http.OutgoingHttpHeaders = {};
    const auth = opts.auth === undefined ? basic(proxy.token ?? "") : opts.auth;
    if (auth) headers["proxy-authorization"] = auth;
    const req = http.request(
      {
        host: proxy.host,
        port: proxy.port,
        method: opts.method ?? "GET",
        path: opts.path,
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
        });
        res.on("end", () =>
          resolveReply({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

function basic(token: string): string {
  return `Basic ${Buffer.from(`${EGRESS_PROXY_USER}:${token}`).toString("base64")}`;
}

describe("EgressProxy", () => {
  let target: http.Server;
  let targetPort: number;
  let proxy: EgressProxy;
  const decisions: EgressDecision[] = [];
  let targetHits = 0;

  beforeAll(async () => {
    target = http.createServer((req, res) => {
      targetHits++;
      res.setHeader("x-target", "yes");
      res.end(`hello from target ${req.method} ${req.url}`);
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
    targetPort = (target.address() as AddressInfo).port;
    proxy = await EgressProxy.start({
      allow: ["127.0.0.1", "*.allowed.example"],
      token: EgressProxy.newToken(),
      onDecision: (d) => decisions.push(d),
    });
  });

  afterAll(async () => {
    await proxy.close();
    await new Promise<void>((r) => target.close(() => r()));
  });

  it("forwards plain HTTP to an allowed host and counts bytes", async () => {
    const before = proxy.stats();
    const r = await request(proxy, { path: `http://127.0.0.1:${targetPort}/hello?x=1` });
    expect(r.status).toBe(200);
    expect(r.body).toBe("hello from target GET /hello?x=1");
    expect(r.headers["x-target"]).toBe("yes");
    const after = proxy.stats();
    expect(after.bytesOut).toBeGreaterThan(before.bytesOut);
    expect(after.allowed).toBe(before.allowed + 1);
    expect(decisions.at(-1)).toMatchObject({
      host: "127.0.0.1",
      port: targetPort,
      allowed: true,
      method: "GET",
    });
  });

  it("returns 403 for a host outside the allowlist without contacting it", async () => {
    const hits = targetHits;
    const r = await request(proxy, { path: `http://blocked.example:${targetPort}/secret` });
    expect(r.status).toBe(403);
    expect(r.body).toContain("host not allowed: blocked.example");
    expect(targetHits).toBe(hits);
    expect(decisions.at(-1)).toMatchObject({ host: "blocked.example", allowed: false });
    expect(decisions.at(-1)?.reason).toBeTruthy();
  });

  it("matches wildcard patterns case-insensitively on the host", async () => {
    // The host is allowed but does not resolve: the decision is "allowed" and the upstream fails.
    const r = await request(proxy, { path: "http://API.Allowed.Example:1/" });
    expect(decisions.at(-1)).toMatchObject({ host: "api.allowed.example", allowed: true });
    expect([502, 200]).toContain(r.status);
  });

  it("rejects requests without the token (407) and never records a decision for them", async () => {
    const n = decisions.length;
    const r = await request(proxy, { path: `http://127.0.0.1:${targetPort}/`, auth: null });
    expect(r.status).toBe(407);
    expect(r.headers["proxy-authenticate"]).toContain("Basic");
    const wrong = await request(proxy, {
      path: `http://127.0.0.1:${targetPort}/`,
      auth: basic("nope"),
    });
    expect(wrong.status).toBe(407);
    expect(decisions.length).toBe(n);
  });

  it("tunnels CONNECT to an allowed host", async () => {
    const reply = await new Promise<string>((resolveReply, reject) => {
      const req = http.request({
        host: proxy.host,
        port: proxy.port,
        method: "CONNECT",
        path: `127.0.0.1:${targetPort}`,
        headers: { "proxy-authorization": basic(proxy.token ?? "") },
      });
      req.on("connect", (res, socket) => {
        expect(res.statusCode).toBe(200);
        let data = "";
        socket.setEncoding("utf8");
        socket.on("data", (c: string) => {
          data += c;
        });
        socket.on("end", () => resolveReply(data));
        socket.on("error", reject);
        socket.write(
          `GET /tunnel HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`,
        );
      });
      req.on("response", (res) => reject(new Error(`unexpected response ${res.statusCode}`)));
      req.on("error", reject);
      req.end();
    });
    expect(reply).toContain("hello from target GET /tunnel");
    expect(decisions.at(-1)).toMatchObject({
      host: "127.0.0.1",
      port: targetPort,
      allowed: true,
      method: "CONNECT",
    });
    expect(proxy.stats().bytesIn).toBeGreaterThan(0);
  });

  it("refuses CONNECT to a blocked host with 403", async () => {
    const status = await new Promise<number>((resolveStatus, reject) => {
      const req = http.request({
        host: proxy.host,
        port: proxy.port,
        method: "CONNECT",
        path: "blocked.example:443",
        headers: { "proxy-authorization": basic(proxy.token ?? "") },
      });
      // Node emits "connect" for every reply to a CONNECT request; the status says whether
      // the tunnel opened.
      req.on("connect", (res, socket) => {
        socket.destroy();
        resolveStatus(res.statusCode ?? 0);
      });
      req.on("response", (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(decisions.at(-1)).toMatchObject({
      host: "blocked.example",
      port: 443,
      allowed: false,
      method: "CONNECT",
    });
  });

  it("drops connections from sources the filter rejects", async () => {
    const strict = await EgressProxy.start({ allow: ["127.0.0.1"], allowFrom: () => false });
    try {
      await expect(request(strict, { path: `http://127.0.0.1:${targetPort}/` })).rejects.toThrow();
    } finally {
      await strict.close();
    }
  });

  it("denies everything with an empty allowlist (the process sandbox's `none` mode)", async () => {
    const deny = await EgressProxy.start({ allow: [] });
    try {
      const r = await request(deny, { path: `http://127.0.0.1:${targetPort}/` });
      expect(r.status).toBe(403);
    } finally {
      await deny.close();
    }
  });

  it("builds proxy URLs and environment with credentials", () => {
    const u = proxy.url("host.docker.internal");
    expect(u).toBe(
      `http://forerunner:${encodeURIComponent(proxy.token ?? "")}@host.docker.internal:${proxy.port}`,
    );
    const env = proxy.envFor();
    expect(env.HTTP_PROXY).toBe(proxy.url());
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY);
    expect(env.NO_PROXY).toBe("");
  });
});

describe("EgressProxy upstream timeout", () => {
  it("answers 504 when an allowed upstream accepts but never responds", async () => {
    // Accepts, reads and never answers. The sockets are tracked so the fixture can close
    // them: the proxy drops its side on timeout, which the test checks below.
    const upstreamSockets: net.Socket[] = [];
    const silent = net.createServer((s) => {
      upstreamSockets.push(s);
      s.resume();
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    const silentPort = (silent.address() as AddressInfo).port;
    const proxy = await EgressProxy.start({ allow: ["127.0.0.1"], upstreamTimeoutMs: 300 });
    try {
      const t0 = performance.now();
      const r = await request(proxy, { path: `http://127.0.0.1:${silentPort}/hang` });
      expect(r.status).toBe(504);
      expect(r.body).toContain("timed out");
      expect(performance.now() - t0).toBeLessThan(5_000);
      // The proxy closed its upstream socket: the silent server sees the end of the stream.
      await new Promise<void>((resolveEnd) => {
        const s = upstreamSockets[0];
        if (!s || s.readableEnded || s.destroyed) return resolveEnd();
        s.once("end", () => resolveEnd());
        s.once("close", () => resolveEnd());
      });
    } finally {
      await proxy.close();
      for (const s of upstreamSockets) s.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  });

  it("gives up on a CONNECT whose upstream never completes the handshake", async () => {
    // 10.255.255.1 is unassigned in most networks: either the SYN is black-holed (the connect
    // timeout answers 504) or the kernel reports no route at once (502). Without the timeout
    // a black-holed host would keep the tunnel open until the idle timeout.
    const proxy = await EgressProxy.start({ allow: ["10.255.255.1"], upstreamTimeoutMs: 300 });
    try {
      const t0 = performance.now();
      const status = await new Promise<number>((resolveStatus, reject) => {
        const req = http.request({
          host: proxy.host,
          port: proxy.port,
          method: "CONNECT",
          path: "10.255.255.1:9",
        });
        req.on("connect", (res, socket) => {
          socket.destroy();
          resolveStatus(res.statusCode ?? 0);
        });
        req.on("response", (res) => {
          res.resume();
          resolveStatus(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      expect([502, 504]).toContain(status);
      expect(performance.now() - t0).toBeLessThan(5_000);
    } finally {
      await proxy.close();
    }
  });
});

describe("egress helpers", () => {
  it("splitHostPort handles host, host:port and IPv6 literals", () => {
    expect(splitHostPort("Example.com:8443")).toEqual({ host: "example.com", port: 8443 });
    expect(splitHostPort("example.com")).toEqual({ host: "example.com", port: 443 });
    expect(splitHostPort("[::1]:8080")).toEqual({ host: "::1", port: 8080 });
  });

  it("isPrivateAddress accepts loopback and private ranges only", () => {
    for (const ok of [
      "127.0.0.1",
      "::1",
      "::ffff:172.17.0.2",
      "10.1.2.3",
      "192.168.0.9",
      "172.31.0.1",
      "fd12::1",
      "fe80::1",
      "169.254.1.1",
      "100.64.0.1",
    ]) {
      expect(isPrivateAddress(ok), ok).toBe(true);
    }
    for (const bad of ["8.8.8.8", "172.32.0.1", "2001:db8::1", "93.184.216.34", "not-an-ip"]) {
      expect(isPrivateAddress(bad), bad).toBe(false);
    }
  });
});
