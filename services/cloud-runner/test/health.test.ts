import { ForerunnerError } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthApp, type HealthServer, startHealthServer } from "../src/health.ts";

/**
 * The health route as a Hono app (spec: "a health route on 127.0.0.1 (Hono)"): the three
 * routes in process and over a real loopback socket, the loopback-only bind, the method rule,
 * a failing status function, and that no credential-shaped value reaches the answer.
 */
const TOKEN = ["api", "key", "value"].join("-"); // not-a-secret

let server: HealthServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("health app", () => {
  it("answers /health, /ready and 404 for the rest, JSON with no-store, without a socket", async () => {
    let ready = false;
    const app = createHealthApp({
      status: () => ({ runnerId: "runner-test", billing: { kind: "api_key" } }),
      ready: () => ready,
    });
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    expect(health.headers.get("content-type")).toMatch(/application\/json/);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(await health.json()).toEqual({
      ok: true,
      runnerId: "runner-test",
      billing: { kind: "api_key" },
    });

    const notReady = await app.request("/ready");
    expect(notReady.status).toBe(503);
    expect(await notReady.json()).toEqual({ ready: false });
    ready = true;
    const isReady = await app.request("/ready");
    expect(isReady.status).toBe(200);
    expect(await isReady.json()).toEqual({ ready: true });

    const missing = await app.request("/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(await missing.json()).toEqual({ error: "not_found" });

    const query = await app.request("/health?x=1");
    expect(query.status).toBe(200);
  });

  it("allows HEAD, refuses every other method with 405", async () => {
    const app = createHealthApp({ status: () => ({}), ready: () => true });
    const head = await app.request("/health", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await app.request("/health", { method });
      expect(res.status).toBe(405);
      expect(await res.json()).toEqual({ error: "method_not_allowed" });
    }
  });

  it("answers 500 with the message when the status function fails, never its data", async () => {
    const app = createHealthApp({
      status: async () => {
        throw new ForerunnerError("unavailable", "store closed", { details: { token: TOKEN } });
      },
      ready: () => true,
    });
    const res = await app.request("/health");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: "store closed" });
    expect(body).not.toContain(TOKEN);
  });
});

describe("health server", () => {
  it("binds a free loopback port and serves the app; close releases it", async () => {
    server = await startHealthServer({
      host: "127.0.0.1",
      port: 0,
      status: () => ({ runnerId: "runner-test" }),
      ready: () => true,
    });
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    const health = (await (await fetch(`${server.url}/health`)).json()) as Record<string, unknown>;
    expect(health).toEqual({ ok: true, runnerId: "runner-test" });
    expect((await fetch(`${server.url}/ready`)).status).toBe(200);
    expect((await fetch(`${server.url}/nope`)).status).toBe(404);
    expect((await fetch(`${server.url}/health`, { method: "POST" })).status).toBe(405);
    const url = server.url;
    await server.close();
    server = undefined;
    await expect(fetch(`${url}/health`)).rejects.toThrow();
  });

  it("accepts localhost and refuses a host off the loopback interface before binding", async () => {
    server = await startHealthServer({
      host: "localhost",
      port: 0,
      status: () => ({}),
      ready: () => false,
    });
    expect(server.url).toBe(`http://localhost:${server.port}`);
    expect((await fetch(`${server.url}/ready`)).status).toBe(503);
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "example.test"]) {
      await expect(
        startHealthServer({ host, port: 0, status: () => ({}), ready: () => true }),
      ).rejects.toMatchObject({ code: "validation" });
    }
  });
});
