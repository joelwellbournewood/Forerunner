import { describe, expect, it } from "vitest";
import { ApiError, createClient, describeError, routePath } from "../src/api/client.ts";
import { DEFAULT_DAEMON_URL, resolveDaemonConfig } from "../src/api/config.ts";
import { createFakeDaemon } from "./fake-daemon.ts";
import { fetchFromApp, testConfig } from "./helpers.tsx";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("daemon config resolution", () => {
  it("prefers the shell injection, then the Vite env, then the default with no token", () => {
    const shell = resolveDaemonConfig(
      {
        daemonUrl: "http://127.0.0.1:4100/",
        daemonToken: "abc",
        installId: "i1",
        platform: "linux",
      },
      { VITE_DAEMON_URL: "http://127.0.0.1:4200", VITE_DAEMON_TOKEN: "env" },
    );
    expect(shell).toMatchObject({
      baseUrl: "http://127.0.0.1:4100",
      token: "abc",
      source: "shell",
      installId: "i1",
      platform: "linux",
    });
    const env = resolveDaemonConfig(undefined, {
      VITE_DAEMON_URL: "http://127.0.0.1:4200",
      VITE_DAEMON_TOKEN: "env",
    });
    expect(env).toMatchObject({ baseUrl: "http://127.0.0.1:4200", token: "env", source: "env" });
    const fallback = resolveDaemonConfig({ installId: "i2" }, {});
    expect(fallback).toMatchObject({
      baseUrl: DEFAULT_DAEMON_URL,
      token: null,
      source: "default",
      installId: "i2",
    });
  });

  it("treats blank values as absent", () => {
    const cfg = resolveDaemonConfig({ daemonUrl: "  " }, { VITE_DAEMON_URL: "" });
    expect(cfg.source).toBe("default");
  });
});

describe("routePath", () => {
  it("fills params with URL encoding and drops the query hints", () => {
    expect(routePath("health")).toBe("/health");
    expect(routePath("tasks", { id: "p 1" })).toBe("/projects/p%201/tasks");
    expect(routePath("sessionEvents", { id: "s" })).toBe("/sessions/s/events");
    expect(routePath("resume")).toBe("/kill/resume");
    expect(() => routePath("project", {})).toThrow(/missing param id/);
  });
});

describe("daemon client", () => {
  it("sends the bearer token and validates a correct response", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const daemon = createFakeDaemon({ token: "tok" });
    const inner = fetchFromApp(daemon.app);
    const client = createClient(testConfig("tok"), (url, init) => {
      seen.push({ url, init });
      return inner(url, init);
    });
    const projects = await client.projects();
    expect(projects.map((p) => p.id)).toEqual(["proj_atlas", "proj_beacon"]);
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    expect(seen[0]?.url).toBe("http://127.0.0.1:9/projects");
  });

  it("rejects a malformed response with ui.invalid_response and names the field", async () => {
    const client = createClient(testConfig(), async () =>
      jsonResponse([{ id: "p", name: "x", spend: { usdMicro: "nope" } }]),
    );
    const error = await client.projects().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ui.invalid_response");
    expect((error as ApiError).message).toMatch(/does not match the contract/);
    expect((error as ApiError).message).toMatch(/0\.goal|0\.spend/);
  });

  it("rejects a non-JSON body", async () => {
    const client = createClient(
      testConfig(),
      async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    await expect(client.health()).rejects.toMatchObject({ code: "ui.invalid_response" });
  });

  it("surfaces the daemon's ErrorBody code and message", async () => {
    const client = createClient(testConfig(), async () =>
      jsonResponse({ code: "kill.active", message: "kill switch is active" }, 409),
    );
    const error = await client.startSession({ agentId: "a" }).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "kill.active",
      status: 409,
      message: "kill switch is active",
    });
  });

  it("maps a plain HTTP failure and a network failure to ui codes", async () => {
    const http = createClient(testConfig(), async () => new Response("nope", { status: 500 }));
    await expect(http.health()).rejects.toMatchObject({ code: "ui.http_error", status: 500 });
    const network = createClient(testConfig(), async () => {
      throw new TypeError("fetch failed");
    });
    const error = await network.health().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ui.network" });
    expect(describeError(error)).toBe("Daemon not reachable.");
  });

  it("answers 401 from the fake when the token is wrong", async () => {
    const daemon = createFakeDaemon({ token: "right" });
    const client = createClient(testConfig("wrong"), fetchFromApp(daemon.app));
    const error = await client.me().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: "auth.unauthorized" });
    expect(describeError(error)).toBe("Daemon rejected the token.");
  });

  it("builds query strings, skips empty values and adds the token only for EventSource URLs", () => {
    const client = createClient(testConfig("tok"), async () => jsonResponse({}));
    expect(client.url("/costs", { projectId: "p", from: undefined, to: "" })).toBe(
      "http://127.0.0.1:9/costs?projectId=p",
    );
    expect(client.url("/events", undefined, true)).toBe("http://127.0.0.1:9/events?token=tok");
    expect(client.url("/events")).toBe("http://127.0.0.1:9/events");
  });

  it("round-trips the phase-1 mutations against the fake daemon", async () => {
    const daemon = createFakeDaemon({ token: "tok", eventDelayMs: 5 });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const project = await client.createProject({ name: "Gamma", goal: "Ship it" });
    expect(project.name).toBe("Gamma");
    const task = await client.createTask(project.id, {
      title: "First task",
      outcome: "Done means done",
    });
    expect(task.status).toBe("ready");
    const moved = await client.transitionTask(task.id, {
      version: task.version,
      to: "claimed",
      reason: "test",
    });
    expect(moved.status).toBe("claimed");
    await expect(
      client.transitionTask(task.id, { version: task.version, to: "ready", reason: "stale" }),
    ).rejects.toMatchObject({ code: "conflict" });
    const session = await client.startSession({ agentId: "agent_alice", projectId: project.id });
    expect(session.status).toBe("running");
    const stopped = await client.stopSession(session.id, "test");
    expect(stopped.status).toBe("stopped");
    const kill = await client.kill({ scope: "all" });
    expect(kill.killActive).toBe(true);
    const resumed = await client.resume();
    expect(resumed.killActive).toBe(false);
    const inbox = await client.inbox("human_alice");
    expect(inbox.blockingCount).toBe(1);
    const answered = await client.answerRequest("req_1", { version: 1, answer: "Approve" });
    expect(answered.status).toBe("answered");
    const read = await client.markRead("msg_1");
    expect(read.readAt).not.toBeNull();
    const reply = await client.chat({ humanId: "human_alice", agentId: "agent_alice", text: "hi" });
    expect(reply.reply).toContain("hi");
    daemon.close();
  });
});
