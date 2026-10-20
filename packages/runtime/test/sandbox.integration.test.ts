import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { errorMessage, join, run } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContainerSandbox, type EgressRoute } from "../src/sandbox/container.ts";
import { detectSandboxEngine } from "../src/sandbox/detect.ts";
import type { EgressDecision } from "../src/sandbox/egress-proxy.ts";
import { defaultEgressRoute } from "../src/sandbox/factory.ts";

/**
 * Container adapter against a real engine. Skips visibly when no daemon is reachable, when the
 * test image cannot be pulled (network policy) or, for the allowlist case on the sidecar
 * route, when the engine cannot route `host-gateway` (the sidecar needs it to reach the host).
 */
const IMAGE = "node:22-bookworm-slim";

interface Ready {
  engine: "docker" | "podman" | null;
  reason: string;
  route: EgressRoute;
  /** Whether the allowlist test can run: gateway route, or sidecar route with host-gateway. */
  allowlist: boolean;
  allowlistReason: string;
}

async function prepare(): Promise<Ready> {
  const none = (reason: string): Ready => ({
    engine: null,
    reason,
    route: "gateway",
    allowlist: false,
    allowlistReason: reason,
  });
  const d = await detectSandboxEngine({ ttlMs: 0 });
  if (d.engine === "none") return none(`no container engine: ${d.reason}`);
  const engine = d.engine;
  const inspect = await run([engine, "image", "inspect", IMAGE], {
    allowFailure: true,
    timeoutMs: 30_000,
  });
  if (inspect.code !== 0) {
    const pull = await run([engine, "pull", IMAGE], { allowFailure: true, timeoutMs: 300_000 });
    if (pull.code !== 0) return none(`image pull failed: ${pull.stderr.trim().slice(-400)}`);
  }
  const route = defaultEgressRoute(d);
  if (route === "gateway") {
    return { engine, reason: d.reason, route, allowlist: true, allowlistReason: "" };
  }
  const gw = await run(
    [engine, "run", "--rm", "--add-host", "host.docker.internal:host-gateway", IMAGE, "true"],
    { allowFailure: true, timeoutMs: 120_000 },
  );
  return {
    engine,
    reason: d.reason,
    route,
    allowlist: gw.code === 0,
    allowlistReason: gw.code === 0 ? "" : "engine cannot route host-gateway in this box",
  };
}

let ready: Ready = {
  engine: null,
  reason: "not probed",
  route: "gateway",
  allowlist: false,
  allowlistReason: "not probed",
};
try {
  ready = await prepare();
} catch (e) {
  ready = {
    engine: null,
    reason: errorMessage(e),
    route: "gateway",
    allowlist: false,
    allowlistReason: errorMessage(e),
  };
}

/** Node script for inside the container: one request through the proxy, prints "<status> <body>". */
function proxiedRequest(url: string): string {
  return [
    "const u = new URL(process.env.HTTP_PROXY);",
    "const auth = 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64');",
    `require('http').request({ host: u.hostname, port: u.port, path: '${url}', headers: { 'proxy-authorization': auth }, timeout: 15000 }, (res) => { let b=''; res.on('data', c => b += c); res.on('end', () => { console.log(res.statusCode + ' ' + b.trim()); process.exit(0); }); }).on('timeout', () => { console.log('timeout'); process.exit(4); }).on('error', (e) => { console.log('error ' + (e.code ?? e.message)); process.exit(2); }).end();`,
  ].join("\n");
}

describe.skipIf(ready.engine === null)(
  `container sandbox (${ready.engine ?? `skipped: ${ready.reason}`})`,
  () => {
    const engine = ready.engine ?? "docker";
    let worktree: string;

    beforeAll(async () => {
      worktree = await mkdtemp(join(tmpdir(), "fr-int-"));
    });
    afterAll(async () => {
      await rm(worktree, { recursive: true, force: true, maxRetries: 3 });
    });

    it("runs node inside the container with the worktree mounted and removes the container on destroy", async () => {
      const sb = await ContainerSandbox.create({
        engine,
        image: IMAGE,
        worktree,
        limits: { cpus: 1, memoryMb: 512, pidsLimit: 128, timeoutMs: 60_000 },
        network: { mode: "none" },
        taskId: "int-basic",
        user: "0:0",
      });
      try {
        const r = await sb.run(["node", "-e", "console.log(1+1)"]);
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe("2");

        // Host -> container through the bind mount.
        await sb.writeFile("sub/hello.txt", "hi from host\n");
        const cat = await sb.run(["cat", "hello.txt"], { cwd: "sub" });
        expect(cat.stdout).toBe("hi from host\n");
        const pwd = await sb.run(["pwd"], { cwd: "sub" });
        expect(pwd.stdout.trim()).toBe("/work/sub");

        // Container -> host.
        const w = await sb.run([
          "node",
          "-e",
          "require('fs').writeFileSync('out.txt', 'from container')",
        ]);
        expect(w.code).toBe(0);
        expect(await sb.readFile("out.txt")).toBe("from container");

        // A symlink planted by the sandboxed command cannot redirect host-side reads.
        const ln = await sb.run(["ln", "-s", "/etc", "etc-link"]);
        expect(ln.code).toBe(0);
        await expect(sb.readFile("etc-link/hostname")).rejects.toMatchObject({
          code: "path_not_allowed",
        });

        // stdin and per-run env.
        const echo = await sb.run(["node", "-e", "process.stdin.pipe(process.stdout)"], {
          input: "piped",
        });
        expect(echo.stdout).toBe("piped");
        const env = await sb.run(
          ["node", "-p", "process.env.FORERUNNER_SANDBOX + ':' + process.env.X"],
          {
            env: { X: "y" },
          },
        );
        expect(env.stdout.trim()).toBe("container:y");

        // Capabilities dropped, no new privileges.
        const caps = await sb.run(["cat", "/proc/self/status"]);
        expect(caps.stdout).toMatch(/CapEff:\s+0{16}/);
        expect(caps.stdout).toMatch(/NoNewPrivs:\s+1/);

        // Only the worktree is mounted from the host.
        const mounts = await sb.run(["cat", "/proc/self/mounts"]);
        const binds = mounts.stdout.split("\n").filter((l) => l.includes(" /work "));
        expect(binds.length).toBeGreaterThan(0);
        expect(mounts.stdout).not.toContain(` ${tmpdir()} `);

        // Timeout is enforced inside the container too.
        const t0 = performance.now();
        const slow = await sb.run(["sleep", "30"], { timeoutMs: 1_500 });
        expect(slow.timedOut).toBe(true);
        expect(performance.now() - t0).toBeLessThan(15_000);

        const name = sb.name;
        const before = await run([
          engine,
          "ps",
          "-a",
          "--filter",
          `name=^${name}$`,
          "--format",
          "{{.Names}}",
        ]);
        expect(before.stdout.trim()).toBe(name);
        await sb.destroy();
        const after = await run([
          engine,
          "ps",
          "-a",
          "--filter",
          `name=^${name}$`,
          "--format",
          "{{.Names}}",
        ]);
        expect(after.stdout.trim()).toBe("");
      } finally {
        await sb.destroy();
      }
    });

    it("--network none blocks outbound traffic", async () => {
      const sb = await ContainerSandbox.create({
        engine,
        image: IMAGE,
        worktree,
        limits: { timeoutMs: 60_000 },
        network: { mode: "none" },
        taskId: "int-netnone",
        user: "0:0",
      });
      try {
        const r = await sb.run([
          "node",
          "-e",
          "fetch('http://example.com').then(r => { console.log('reached', r.status); process.exit(0); }).catch(e => { console.log('blocked', e.cause?.code ?? e.message); process.exit(3); })",
        ]);
        expect(r.code).toBe(3);
        expect(r.stdout).toContain("blocked");
      } finally {
        await sb.destroy();
      }
    });

    it.skipIf(!ready.allowlist)(
      `allowlist mode (${ready.route} route): the internal network blocks direct egress, the proxy passes allowed hosts and refuses the rest${ready.allowlist ? "" : ` [skipped: ${ready.allowlistReason}]`}`,
      async () => {
        // Bound to loopback only: reachable from the proxy on the host, never from the
        // container directly.
        const target = http.createServer((_req, res) => res.end("target says hi"));
        await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
        const targetPort = (target.address() as AddressInfo).port;
        const decisions: EgressDecision[] = [];
        const sb = await ContainerSandbox.create({
          engine,
          image: IMAGE,
          worktree,
          limits: { timeoutMs: 60_000 },
          network: { mode: "allowlist", domains: ["127.0.0.1"] },
          taskId: "int-allow",
          user: "0:0",
          egress: { route: ready.route, onDecision: (d) => decisions.push(d) },
        });
        try {
          expect(sb.networkName).toBeTruthy();
          expect(sb.proxyAddress).not.toBeNull();
          const netInspect = await run([engine, "network", "inspect", sb.networkName ?? ""]);
          expect(netInspect.stdout).toMatch(/"[Ii]nternal":\s*true/);

          // Through the proxy: allowed host passes, blocked host gets 403, both audited.
          const allowed = await sb.run([
            "node",
            "-e",
            proxiedRequest(`http://127.0.0.1:${targetPort}/`),
          ]);
          expect(allowed.stdout.trim()).toBe("200 target says hi");
          const blocked = await sb.run(["node", "-e", proxiedRequest("http://example.com/")]);
          expect(blocked.stdout.trim().startsWith("403")).toBe(true);
          expect(decisions.map((d) => [d.host, d.allowed])).toEqual([
            ["127.0.0.1", true],
            ["example.com", false],
          ]);

          // Direct egress, ignoring the proxy variables: no route out of the internal network.
          const direct = await sb.run([
            "node",
            "-e",
            "fetch('http://example.com', { signal: AbortSignal.timeout(8000) }).then(r => { console.log('reached', r.status); process.exit(0); }).catch(e => { console.log('blocked', e.cause?.code ?? e.name); process.exit(3); })",
          ]);
          expect(direct.code).toBe(3);
          expect(direct.stdout).toContain("blocked");

          // The host's loopback-bound service is not reachable at the proxy's address either.
          const { host, port } = sb.proxyAddress ?? { host: "", port: 0 };
          const hostDirect = await sb.run([
            "node",
            "-e",
            `const s = require('net').connect({ host: '${host}', port: ${targetPort}, timeout: 4000 }); s.on('connect', () => { console.log('connected'); process.exit(0); }); s.on('error', (e) => { console.log('refused ' + e.code); process.exit(3); }); s.on('timeout', () => { console.log('timeout'); process.exit(3); });`,
          ]);
          expect(hostDirect.code).toBe(3);

          // The proxy itself needs the per-sandbox token.
          const noToken = await sb.run([
            "node",
            "-e",
            `require('http').request({ host: '${host}', port: ${port}, path: 'http://127.0.0.1:${targetPort}/' }, (res) => { console.log(res.statusCode); process.exit(0); }).on('error', (e) => { console.log('error ' + e.code); process.exit(2); }).end();`,
          ]);
          expect(noToken.stdout.trim()).toBe("407");

          const networkName = sb.networkName ?? "";
          const sidecarName = sb.sidecarName;
          await sb.destroy();
          const gone = await run([engine, "network", "inspect", networkName], {
            allowFailure: true,
          });
          expect(gone.code).not.toBe(0);
          if (sidecarName) {
            const ps = await run([
              engine,
              "ps",
              "-a",
              "--filter",
              `name=^${sidecarName}$`,
              "--format",
              "{{.Names}}",
            ]);
            expect(ps.stdout.trim()).toBe("");
          }
        } finally {
          await sb.destroy();
          await new Promise<void>((r) => target.close(() => r()));
        }
      },
    );
  },
);

if (ready.engine === null) {
  describe("container sandbox", () => {
    it.skip(`skipped: ${ready.reason}`, () => {});
  });
}
