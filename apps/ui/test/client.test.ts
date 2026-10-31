import { DAEMON_ROUTES } from "@forerunner/runtime/daemon/api-types";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  createClient,
  describeError,
  isRouteMissing,
  routePath,
} from "../src/api/client.ts";
import { DEFAULT_DAEMON_URL, resolveDaemonConfig } from "../src/api/config.ts";
import { createFakeDaemon } from "./fake-daemon.ts";
import { ME } from "./fixtures.ts";
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
    // The capability routes (email, desktop) wrap the same body under `error`; a 403 from
    // them is the route's own refusal, never the token.
    const nested = createClient(testConfig(), async () =>
      jsonResponse(
        {
          error: {
            code: "tool_not_allowed",
            message: "the signed-in human does not own this agent",
            details: { agentId: "agent_bob" },
            retryable: false,
          },
        },
        403,
      ),
    );
    const refused = await nested.emailSettings("agent_bob").catch((e: unknown) => e);
    expect(refused).toMatchObject({
      code: "tool_not_allowed",
      status: 403,
      message: "the signed-in human does not own this agent",
      details: { agentId: "agent_bob" },
    });
    expect(describeError(refused)).toBe("the signed-in human does not own this agent");
  });

  it("maps a plain HTTP failure and a network failure to ui codes", async () => {
    const http = createClient(testConfig(), async () => new Response("nope", { status: 500 }));
    await expect(http.health()).rejects.toMatchObject({ code: "ui.http_error", status: 500 });
    const network = createClient(testConfig(), async () => {
      throw new TypeError("fetch failed");
    });
    const error = await network.health().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ui.network" });
    expect(describeError(error)).toBe("Forerunner's background service does not answer.");
  });

  it("answers 401 from the fake when the token is wrong", async () => {
    const daemon = createFakeDaemon({ token: "right" });
    const client = createClient(testConfig("wrong"), fetchFromApp(daemon.app));
    const error = await client.me().catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 401, code: "auth.unauthorized" });
    expect(describeError(error)).toBe(
      "Forerunner's background service refused this window's key: close Forerunner and open it again.",
    );
  });

  it("builds query strings, skips empty values and adds the token only for EventSource URLs", () => {
    const client = createClient(testConfig("tok"), async () => jsonResponse({}));
    expect(client.url("/costs", { projectId: "p", from: undefined, to: "" })).toBe(
      "http://127.0.0.1:9/costs?projectId=p",
    );
    expect(client.url("/events", undefined, true)).toBe("http://127.0.0.1:9/events?token=tok");
    expect(client.url("/events")).toBe("http://127.0.0.1:9/events");
  });

  it("validates /health including the sandbox and extensions sections", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const health = await client.health();
    expect(health.sandbox).toEqual({
      kind: "process",
      available: false,
      engine: "none",
      reason: "fake daemon",
    });
    // Derived from the extension fixtures: five installed and enabled or disabled, one pending.
    expect(health.extensions).toEqual({ enabled: 4, pending: 1 });
    const legacy = createClient(testConfig(), async () => {
      const { sandbox: _s, extensions: _e, ...rest } = health;
      return jsonResponse(rest);
    });
    await expect(legacy.health()).rejects.toMatchObject({ code: "ui.invalid_response" });
  });

  it("reads a project's decisions and peer feed and rejects malformed bodies", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const decisions = await client.decisions("proj_atlas");
    expect(decisions.map((d) => d.id)).toEqual(["dec_1"]);
    expect(decisions[0]?.chosen).toBe("Static index built at deploy time");
    expect(await client.decisions("proj_beacon")).toEqual([]);
    const peers = await client.peers("proj_atlas");
    expect(peers.projectId).toBe("proj_atlas");
    expect(peers.peers.map((p) => p.agentName)).toEqual(["Bob's agent"]);
    expect(peers.peers[0]?.activeClaims[0]?.taskId).toBe("task_2");
    const empty = await client.peers("proj_beacon");
    expect(empty.peers).toEqual([]);
    await expect(client.decisions("proj_missing")).rejects.toMatchObject({ status: 404 });

    const badDecisions = createClient(testConfig(), async () =>
      jsonResponse([{ id: "d", projectId: "p", question: "q", chosen: 1 }]),
    );
    await expect(badDecisions.decisions("p")).rejects.toMatchObject({
      code: "ui.invalid_response",
    });
    const badPeers = createClient(testConfig(), async () =>
      jsonResponse({ generatedAt: "now", projectId: "p", peers: [{ agentId: "a" }] }),
    );
    await expect(badPeers.peers("p")).rejects.toMatchObject({ code: "ui.invalid_response" });
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
    const started = await client.startSession({ agentId: "agent_alice", projectId: project.id });
    expect(started.result).toBe("started");
    expect(started.session?.status).toBe("running");
    const stopped = await client.stopSession(started.session?.id ?? "", "test");
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

  it("tells a missing route apart from a typed not_found", async () => {
    // The example is `docs`, served since U-005; the fake is told to lack it, as a daemon
    // without the route would.
    expect("docs" in DAEMON_ROUTES).toBe(true);
    const daemon = createFakeDaemon({
      token: "tok",
      missingRoutes: ["/projects/proj_atlas/docs"],
    });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const missing = await client.docs("proj_atlas").catch((e: unknown) => e);
    expect(isRouteMissing(missing)).toBe(true);
    const typed = await client.project("proj_missing").catch((e: unknown) => e);
    expect(typed).toMatchObject({ status: 404, code: "not_found" });
    expect(isRouteMissing(typed)).toBe(false);
    const plain = new ApiError("ui.http_error", "404: Not Found", 404);
    expect(isRouteMissing(plain)).toBe(true);
    expect(isRouteMissing(new ApiError("ui.http_error", "500: boom", 500))).toBe(false);
    // The real daemon registers no notFound handler, so a route it lacks answers Hono's
    // plain-text 404 rather than the fake's typed "no route" body: the client must read that
    // as a missing route too.
    const honoDefault = createClient(
      testConfig(),
      async () =>
        new Response("404 Not Found", { status: 404, headers: { "content-type": "text/plain" } }),
    );
    const untyped = await honoDefault.docs("proj_atlas").catch((e: unknown) => e);
    expect(untyped).toMatchObject({
      code: "ui.http_error",
      status: 404,
      message: "404: 404 Not Found",
    });
    expect(isRouteMissing(untyped)).toBe(true);
    // An untyped 404 with an empty body (statusText only) reads the same way.
    const empty = createClient(
      testConfig(),
      async () => new Response(null, { status: 404, statusText: "Not Found" }),
    );
    expect(isRouteMissing(await empty.docs("proj_atlas").catch((e: unknown) => e))).toBe(true);
  });

  it("round-trips reviews, memory, commands and the change log against the fake daemon", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const reviews = await client.reviews("proj_atlas", { limit: 10 });
    expect(reviews.reviews.map((r) => r.id)).toEqual(["rev_0", "rev_2", "rev_1"]);
    expect(reviews.gradeTrend.map((p) => p.grade)).toEqual([82, 64, 75]);
    expect(reviews.openFindings).toBe(1);
    expect(reviews.verdicts).toEqual({ accept: 2, revise: 1 });
    expect((await client.taskReviews("task_2")).reviews.map((r) => r.id)).toEqual(["rev_2"]);
    const badReviews = createClient(testConfig(), async () =>
      jsonResponse({ projectId: "p", reviews: [{ id: "r" }], openFindings: 0 }),
    );
    await expect(badReviews.reviews("p")).rejects.toMatchObject({ code: "ui.invalid_response" });

    const scopes = await client.memoryScopes();
    expect(scopes.map((s) => [s.scope, s.active, s.pinned])).toEqual([
      ["agent_private", 2, 1],
      ["critic", 1, 0],
      ["shared", 1, 1],
    ]);
    const mine = await client.memory({
      scope: "agent_private",
      agentId: "agent_alice",
      q: "windows",
    });
    expect(mine.lessons.map((l) => l.id)).toEqual(["les_1"]);
    await expect(
      client.memory({ scope: "agent_private", agentId: "agent_bob" }),
    ).rejects.toMatchObject({
      status: 403,
      code: "autonomy_insufficient",
    });
    const edited = await client.updateLesson("les_2", { text: "Ask for criteria first, always." });
    expect(edited.version).toBe(2);
    expect((await client.pinLesson("les_2", true)).pinned).toBe(true);
    expect((await client.deleteLesson("les_2")).status).toBe("retired");
    expect(
      (await client.memory({ scope: "agent_private", agentId: "agent_alice" })).lessons,
    ).toHaveLength(1);
    expect((await client.consolidation())[0]?.requestId).toBe("req_cons_1");
    expect((await client.runConsolidation()).proposals).toBe(0);

    expect((await client.commandDefs()).map((d) => d.name)).toContain("budget.set");
    const parsed = await client.parseCommand({ text: "switch to Beacon" });
    expect(parsed).toEqual({
      commands: [{ name: "project.switch", params: { project: "Beacon" } }],
      question: null,
      matched: "pattern",
    });
    const low = await client.executeCommands({
      commands: [{ name: "project.switch", params: { project: "Beacon" } }],
      wordsUsed: "switch to Beacon",
    });
    expect(low.status).toBe("done");
    expect(low.sentence).toBe("Switched to Beacon. Undo.");
    const pending = await client.executeCommands({
      commands: [{ name: "autonomy.set", params: { level: 2, project: "proj_beacon" } }],
    });
    expect(pending.status).toBe("pending");
    expect(pending.decision).toBe("needs_yes");
    expect((await client.pendingCommands()).map((p) => p.id)).toEqual([pending.pendingId]);
    const confirmed = await client.confirmCommand(pending.pendingId ?? "", { answer: "yes" });
    expect(confirmed.status).toBe("done");
    expect(confirmed.undoToken).toBe(confirmed.changeLogId);
    const high = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 500 } }],
    });
    expect(high.decision).toBe("needs_device");
    const refused = await client.confirmCommand(high.pendingId ?? "", { answer: "yes" });
    expect(refused).toMatchObject({ status: "refused", code: "approval_required" });
    // The fake checks the device like the real executor: an id that is no paired row of the
    // human is refused and the card stays; the row `/me` names (this PC) performs.
    const unknown = await client.confirmCommand(high.pendingId ?? "", {
      answer: "device",
      deviceId: "install-uuid-of-shell",
    });
    expect(unknown).toMatchObject({
      status: "refused",
      code: "approval_required",
      reason: "unknown device; pair it first",
      pendingId: high.pendingId,
    });
    expect((await client.pendingCommands()).map((p) => p.id)).toEqual([high.pendingId]);
    expect((await client.me()).desktopDeviceId).toBe(ME.desktopDeviceId);
    const cancelled = await client.cancelCommand(high.pendingId ?? "");
    expect(cancelled.status).toBe("cancelled");
    const secondHigh = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 500 } }],
    });
    const onThisPc = await client.confirmCommand(secondHigh.pendingId ?? "", {
      answer: "device",
      deviceId: ME.desktopDeviceId ?? "",
    });
    expect(onThisPc.status).toBe("done");
    // The literal `desktop` an older settings screen sent is this PC, as on the daemon's route.
    const thirdHigh = await client.executeCommands({
      commands: [{ name: "budget.set", params: { scope: "month", amountChf: 600 } }],
    });
    const literal = await client.confirmCommand(thirdHigh.pendingId ?? "", {
      answer: "device",
      deviceId: "desktop",
    });
    expect(literal.status).toBe("done");
    const tapped = await client.executeCommands({
      commands: [{ name: "autonomy.set", params: { level: 1, project: "proj_beacon" } }],
      confirm: "tap",
    });
    expect(tapped.status).toBe("done");
    const plan = await client.executeCommands({
      commands: [
        { name: "project.switch", params: { project: "Atlas" } },
        { name: "note.add", params: { text: "look at the sitemap", project: "Atlas" } },
      ],
    });
    expect(plan.status).toBe("done");
    expect(plan.commands).toEqual(["project.switch", "note.add"]);
    const changes = await client.changes({ limit: 10 });
    expect(changes[0]?.commands).toHaveLength(2);
    expect(changes.filter((c) => c.undoable).length).toBeGreaterThan(0);
    const undone = await client.undoChange(confirmed.changeLogId ?? "");
    expect(undone.status).toBe("done");
    expect(undone.sentence).toMatch(/^Undone: /);
    const again = await client.undoChange(confirmed.changeLogId ?? "");
    expect(again.status).toBe("refused");
    expect((await client.changes({ undoable: true })).every((c) => c.undoable)).toBe(true);
    daemon.close();
  });

  it("round-trips the proposed routes and performance: queue, milestones, data, docs", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    const queued = await client.enqueue("proj_atlas", {
      kind: "idea",
      text: "Dark mode docs",
      priority: 3,
    });
    expect(queued.status).toBe("queued");
    expect((await client.queue("proj_atlas", { status: "queued" })).map((q) => q.id)).toContain(
      queued.id,
    );
    expect((await client.dismissQueueItem(queued.id)).status).toBe("dismissed");
    expect((await client.milestones("proj_atlas")).map((m) => m.id)).toEqual([
      "ms_index",
      "ms_search",
      "ms_launch",
    ]);
    const asset = await client.registerDataAsset("proj_atlas", {
      locator: "/data/x.csv",
      kind: "csv",
    });
    expect(asset.name).toBe("x.csv");
    await client.removeDataAsset(asset.id);
    expect((await client.dataAssets("proj_atlas")).map((a) => a.id)).toEqual(["da_1"]);
    const imported = await client.importProject("proj_atlas", {
      source: "zip",
      locator: "/tmp/site.zip",
    });
    expect(imported).toMatchObject({ source: "zip", projectId: "proj_atlas", entryCount: 1 });
    expect((await client.docs("proj_atlas")).length).toBe(8);
    expect((await client.doc("proj_atlas", "README.md")).content).toContain("# Atlas");
    expect((await client.performance({ projectId: "proj_atlas" })).projectId).toBe("proj_atlas");
    expect((await client.performance({ days: 30 })).days).toBe(30);
    await expect(client.performance({ days: 0 })).rejects.toMatchObject({
      status: 400,
      code: "validation",
    });
    // As the daemon: decimal digits only.
    for (const bad of ["0x10", "1e1", "7.0", "+7"]) {
      const res = await daemon.app.request(`/performance?days=${bad}`, {
        headers: { authorization: "Bearer tok" },
      });
      expect(res.status).toBe(400);
    }
    await expect(client.performance({ projectId: "proj_missing" })).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    const badPerf = createClient(testConfig(), async () =>
      jsonResponse({ generatedAt: "x", modes: "no" }),
    );
    await expect(badPerf.performance()).rejects.toMatchObject({ code: "ui.invalid_response" });
    daemon.close();
  });

  it("round-trips extensions, updates and the model watch", async () => {
    const daemon = createFakeDaemon({ token: "tok" });
    const client = createClient(testConfig("tok"), fetchFromApp(daemon.app));
    expect((await client.extensions({ kind: "connector" })).map((e) => e.id)).toEqual([
      "ext_github",
      "ext_slack",
    ]);
    expect((await client.extensionCatalog()).entries.length).toBe(4);
    // As the daemon: a catalog add waits; from the panel it is confirmed there (U-026), with
    // this PC's device answer and nothing less.
    const added = await client.addExtension({ catalogId: "data-analyst", confirmIn: "panel" });
    expect(added).toMatchObject({ status: "pending_approval", confirmIn: "panel" });
    await expect(client.approveExtension(added.id)).rejects.toMatchObject({ status: 403 });
    expect((await client.approveExtension(added.id, { answer: "device" })).status).toBe("enabled");
    const pending = await client.addExtension({ url: "https://mcp.example.test/x" });
    expect(pending.status).toBe("pending_approval");
    await expect(client.toggleExtension(pending.id, true)).rejects.toMatchObject({ status: 403 });
    expect((await client.approveExtension(pending.id)).enabled).toBe(true);
    expect((await client.toggleExtension(pending.id, false)).status).toBe("disabled");
    const widened = await client.updateExtensionPermissions(pending.id, {
      domains: ["other.example.test"],
    });
    expect(widened.status).toBe("pending_approval");
    await client.denyExtension(pending.id);
    await client.removeExtension(added.id);
    expect((await client.extensions()).length).toBe(6);

    // Opening reads local state; only the explicit check asks the feed.
    expect((await client.updates()).app.available).toBeNull();
    const feed = await client.checkUpdates();
    expect(feed.app.available?.version).toBe("0.2.0");
    expect((await client.updates()).app.available?.version).toBe("0.2.0");
    const applied = await client.applyUpdate("0.2.0");
    expect(applied).toMatchObject({ version: "0.2.0", restarting: true });
    expect((await client.health()).version).toBe("0.2.0");
    expect((await client.rollbackUpdate("test")).to).toBe("0.1.0-fake");

    expect((await client.modelWatchReports(5)).reports.map((r) => r.id)).toEqual(["mw_2", "mw_1"]);
    expect((await client.modelWatchLatest()).health?.decision).toBe("pending");
    const answered = await client.modelWatchAnswer("mw_2", {
      decision: "ignore",
      by: "human_alice",
    });
    expect(answered.decision).toBe("ignored");
    expect((await client.modelWatchRun()).decision).toBe("nothing_to_decide");
    daemon.close();
  });
});
