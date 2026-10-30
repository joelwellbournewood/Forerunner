import { isForerunnerError, SimulatedClock } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isSchemaCompatible, SyncGate } from "../src/update/compat.ts";
import { GitHubReleasesFeed, JsonFeed } from "../src/update/feed.ts";
import { StaticHealthProbe } from "../src/update/health.ts";
import { readPointer, writePointer } from "../src/update/pointer.ts";
import { StaticExtensionCatalog, StaticModelWatchReport } from "../src/update/ports.ts";
import {
  composeUpdatesView,
  createUpdateRoutes,
  isConnectorUpdate,
  UpdatesView,
} from "../src/update/screen.ts";
import { buildRelease, FakeReleaseServer, type Harness, makeHarness } from "./update-helpers.ts";

const server = new FakeReleaseServer();
let feed: GitHubReleasesFeed;

beforeAll(async () => {
  await server.start();
  buildRelease(server, {
    version: "1.1.0",
    notes: "## 1.1.0\n- faster sync",
    files: { "app/VERSION": "1.1.0" },
  });
  feed = new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: server.url });
});
afterAll(() => server.stop());

async function withExtensions(h: Harness): Promise<void> {
  await h.store.extension.insert({
    kind: "connector",
    name: "github",
    ext_version: "1.0.0",
    enabled: true,
  });
  await h.store.extension.insert({
    kind: "mcp_server",
    name: "filesystem",
    ext_version: "0.4.0",
    enabled: false,
    source_url: "https://example.invalid/fs",
  });
  await h.store.extension.insert({
    kind: "skill",
    name: "review",
    ext_version: "2.0.0",
    enabled: true,
  });
  await h.store.extension.insert({
    kind: "specialist",
    name: "coder",
    ext_version: "",
    enabled: true,
  });
}

const catalog = new StaticExtensionCatalog([
  { kind: "connector", name: "github", version: "1.2.0", notes: "fine-grained tokens" },
  { kind: "mcp_server", name: "filesystem", version: "0.4.0" },
  { kind: "skill", name: "review", version: "1.9.0" },
  {
    kind: "specialist",
    name: "coder",
    version: "2026.10.1",
    sourceUrl: "https://example.invalid/registry",
  },
]);

const modelWatch = new StaticModelWatchReport([
  {
    model: "claude-haiku-next",
    provider: "anthropic",
    kind: "new_model",
    summary: "cheaper at the same eval score",
    recommendedAction: "switch summaries to it",
    evidence: ["evals/summaries: 0.91 vs 0.90"],
    reportedAt: "2026-10-19T00:00:00.000Z",
  },
]);

describe("updates view: app, connectors and models on one screen", () => {
  it("composes the three sections and validates against the zod view", async () => {
    const h = await makeHarness({ feed });
    try {
      await withExtensions(h);
      const view = await composeUpdatesView({
        manager: h.manager,
        clock: h.clock,
        checkFeed: true,
        extensions: h.store.extension,
        catalog,
        modelWatch,
      });
      expect(UpdatesView.safeParse(view).success).toBe(true);
      expect(view.app).toMatchObject({
        currentVersion: "1.0.0",
        channel: "stable",
        state: "available",
      });
      expect(view.app.available).toMatchObject({
        version: "1.1.0",
        changelog: "## 1.1.0\n- faster sync",
        minSchema: 1,
      });
      expect(view.app.available?.sizeBytes).toBeGreaterThan(0);
      expect(view.app.available?.artifactName).toContain("linux-x64");
      // The download URL comes with it: the desktop runs its installer by hand (ADR 0092).
      expect(view.app.available?.artifactUrl).toMatch(/^https?:\/\/.+linux-x64/);
      // only rows whose catalog version is newer; a non-semver installed version counts as an update
      expect(
        view.connectors.map((c) => [c.kind, c.name, c.installedVersion, c.availableVersion]),
      ).toEqual([
        ["connector", "github", "1.0.0", "1.2.0"],
        ["specialist", "coder", "", "2026.10.1"],
      ]);
      expect(view.connectors[0]?.notes).toBe("fine-grained tokens");
      expect(view.connectors[1]?.sourceUrl).toBe("https://example.invalid/registry");
      expect(view.models).toHaveLength(1);
      expect(view.models[0]).toMatchObject({
        model: "claude-haiku-next",
        kind: "new_model",
        recommendedAction: "switch summaries to it",
      });
      expect(view.generatedAt).toBe(h.clock.nowIso());
    } finally {
      await h.close();
    }
  });

  it("isConnectorUpdate compares semver when both sides have one", () => {
    expect(isConnectorUpdate("1.0.0", "1.0.1")).toBe(true);
    expect(isConnectorUpdate("1.0.1", "1.0.0")).toBe(false);
    expect(isConnectorUpdate("1.0.0", "1.0.0")).toBe(false);
    expect(isConnectorUpdate("abc", "def")).toBe(true);
    expect(isConnectorUpdate("abc", "")).toBe(false);
  });

  it("reflects pending health checks, rollbacks, rejections and an unreachable feed", async () => {
    const h = await makeHarness({
      feed,
      probe: new StaticHealthProbe({ ok: false, detail: "no daemon" }),
    });
    try {
      await h.manager.apply({ by: { kind: "human", id: "human-j" } });
      let view = await composeUpdatesView({ manager: h.manager, clock: h.clock, checkFeed: true });
      expect(view.app.state).toBe("pending_health_check");
      expect(view.app.currentVersion).toBe("1.1.0");
      expect(view.app.previousVersion).toBe("1.0.0");
      await h.manager.healthCheck();
      view = await composeUpdatesView({ manager: h.manager, clock: h.clock, checkFeed: true });
      // 1.1.0 was rolled back and is refused now; nothing newer exists
      expect(view.app.state).toBe("rolled_back");
      expect(view.app.lastRollback).toMatchObject({ from: "1.1.0", to: "1.0.0", automatic: true });
      expect(view.app.rejected).toEqual([
        {
          version: "1.1.0",
          reason: "previously_rejected",
          message: expect.stringContaining("rolled back"),
        },
      ]);
      expect(view.app.available).toBeNull();
      // status only (no feed) keeps the pointer facts and shows the last check's result
      const quick = await composeUpdatesView({
        manager: h.manager,
        clock: h.clock,
        checkFeed: false,
      });
      expect(quick.app.checkedAt).toBe(view.app.checkedAt);
      expect(quick.app.rejected).toEqual(view.app.rejected);
      expect(quick.app.currentVersion).toBe("1.0.0");
      // unreachable feed -> unknown with the error, never a crash
      const down = await makeHarness({
        feed: new JsonFeed({ url: "http://127.0.0.1:9/releases.json" }),
      });
      try {
        const v = await composeUpdatesView({
          manager: down.manager,
          clock: down.clock,
          checkFeed: true,
        });
        expect(v.app.state).toBe("unknown");
        expect(v.app.lastError).toMatch(/unreachable/);
      } finally {
        await down.close();
      }
    } finally {
      await h.close();
    }
  });

  it("shows a rejected release when the only candidate fails verification", async () => {
    const s = new FakeReleaseServer();
    await s.start();
    try {
      buildRelease(s, { version: "5.0.0", key: null });
      const h = await makeHarness({
        feed: new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: s.url }),
      });
      try {
        const v = await composeUpdatesView({ manager: h.manager, clock: h.clock, checkFeed: true });
        expect(v.app.state).toBe("rejected");
        expect(v.app.rejected).toEqual([
          { version: "5.0.0", reason: "unsigned", message: expect.stringContaining("not signed") },
        ]);
      } finally {
        await h.close();
      }
    } finally {
      await s.stop();
    }
  });
});

describe("update routes", () => {
  it("POST /updates/check, POST /updates/apply and POST /updates/rollback drive the manager as the human", async () => {
    const h = await makeHarness({ feed });
    try {
      await withExtensions(h);
      const app = createUpdateRoutes({
        manager: h.manager,
        clock: h.clock,
        extensions: h.store.extension,
        catalog,
        modelWatch,
        humanId: "human-j",
      });
      const get = await app.request("/updates/check", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect(get.status).toBe(200);
      const view = UpdatesView.parse(await get.json());
      expect(view.app.state).toBe("available");
      expect(view.connectors).toHaveLength(2);

      const noPrev = await app.request("/updates/rollback", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      });
      expect(noPrev.status).toBe(404);

      const apply = await app.request("/updates/apply", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      });
      expect(apply.status).toBe(202);
      expect(await apply.json()).toEqual({
        version: "1.1.0",
        previous: "1.0.0",
        state: "pending_health_check",
        restarting: true,
      });
      expect(h.restarter.requests).toHaveLength(1);
      expect((await h.store.auditLog.list({ tool: "update.apply" }))[0]?.human_id).toBe("human-j");

      const status = await app.request("/updates/status");
      expect(((await status.json()) as { app: { state: string } }).app.state).toBe(
        "pending_health_check",
      );

      await h.manager.healthCheck();
      const badBody = await app.request("/updates/apply", {
        method: "POST",
        body: JSON.stringify({ version: 7 }),
        headers: { "content-type": "application/json" },
      });
      expect(badBody.status).toBe(409);
      const again = await app.request("/updates/apply", {
        method: "POST",
        body: JSON.stringify({ version: "1.1.0" }),
        headers: { "content-type": "application/json" },
      });
      expect(again.status).toBe(409); // already installed
      expect(((await again.json()) as { details: { reason: string } }).details.reason).toBe(
        "already_installed",
      );
      const rb = await app.request("/updates/rollback", {
        method: "POST",
        body: JSON.stringify({ reason: "from the UI" }),
        headers: { "content-type": "application/json" },
      });
      expect(rb.status).toBe(202);
      expect(await rb.json()).toEqual({
        from: "1.1.0",
        to: "1.0.0",
        state: "installed",
        restarting: true,
      });
      expect(readPointer(h.dirs)?.current).toBeNull(); // the packaged 1.0.0 runs again
      expect(h.manager.installedVersion()).toBe("1.0.0");
      const missing = await app.request("/updates/apply", {
        method: "POST",
        body: JSON.stringify({ version: "4.4.4" }),
        headers: { "content-type": "application/json" },
      });
      expect(missing.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it("a second apply while one is in progress answers 409", async () => {
    const h = await makeHarness({ feed });
    try {
      const app = createUpdateRoutes({ manager: h.manager, clock: h.clock, humanId: "human-j" });
      const post = () =>
        app.request("/updates/apply", {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        });
      const [a, b] = await Promise.all([post(), post()]);
      expect([a.status, b.status].sort()).toEqual([202, 409]);
      const refused = a.status === 409 ? a : b;
      expect(await refused.json()).toMatchObject({
        code: "version_conflict",
        details: { reason: "in_progress", operation: "apply" },
      });
      expect(h.restarter.requests).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

describe("check results are cached for the screen", () => {
  const feedHits = () => server.requests.filter((p) => p === "/repos/owner/repo/releases").length;

  it("repeated views within the cache window neither query the feed nor append audit rows; fresh checks and state changes do", async () => {
    const h = await makeHarness({ feed, checkCacheMs: 30_000 });
    try {
      const before = feedHits();
      const v1 = await composeUpdatesView({ manager: h.manager, clock: h.clock, checkFeed: true });
      expect(v1.app.state).toBe("available");
      const v2 = await composeUpdatesView({ manager: h.manager, clock: h.clock, checkFeed: true });
      expect(v2.app.checkedAt).toBe(v1.app.checkedAt);
      expect(feedHits() - before).toBe(1);
      expect(await h.store.auditLog.list({ tool: "update.check" })).toHaveLength(1);
      expect((await h.manager.check()).cached).toBe(true);
      // an explicit (CLI, scheduled) check bypasses the cache and is audited
      expect(
        (await h.manager.check({ kind: "human", id: "human-j" }, { fresh: true })).cached,
      ).toBe(false);
      expect(feedHits() - before).toBe(2);
      expect(await h.store.auditLog.list({ tool: "update.check" })).toHaveLength(2);
      // the window expires on the injected clock
      await h.clock.advance(30_000);
      await composeUpdatesView({ manager: h.manager, clock: h.clock, checkFeed: true });
      expect(feedHits() - before).toBe(3);
      // apply invalidates: the next view reflects the new state without waiting
      await h.manager.apply({ by: { kind: "human", id: "human-j" } });
      const after = await composeUpdatesView({
        manager: h.manager,
        clock: h.clock,
        checkFeed: true,
      });
      expect(after.app.state).toBe("pending_health_check");
      expect(after.app.available).toBeNull();
      expect(feedHits() - before).toBeGreaterThanOrEqual(5); // apply's own fresh check + the view
    } finally {
      await h.close();
    }
  });
});

describe("schema compatibility and the sync gate (spec M, last bullet)", () => {
  it("isSchemaCompatible: equal and at least the minimum, otherwise who must update", () => {
    expect(isSchemaCompatible(3, 3, 2)).toMatchObject({
      compatible: true,
      reason: "ok",
      action: "none",
    });
    expect(isSchemaCompatible(1, 3, 2)).toMatchObject({
      compatible: false,
      reason: "local_below_min",
      action: "update_local",
    });
    expect(isSchemaCompatible(3, 1, 2)).toMatchObject({
      compatible: false,
      reason: "peer_below_min",
      action: "update_peer",
    });
    expect(isSchemaCompatible(2, 3, 2)).toMatchObject({
      compatible: false,
      reason: "version_mismatch",
      action: "update_local",
    });
    expect(isSchemaCompatible(3, 2, 2)).toMatchObject({
      compatible: false,
      reason: "version_mismatch",
      action: "update_peer",
    });
    expect(() => isSchemaCompatible(-1, 1, 1)).toThrow(/non-negative integer/);
    expect(() => isSchemaCompatible(1, 1.5, 1)).toThrow(/non-negative integer/);
  });

  it("the gate pauses sync with an event, blocks sync calls in code and resumes when both match", () => {
    const clock = new SimulatedClock("2026-10-20T12:00:00Z");
    const gate = new SyncGate(clock);
    const seen: string[] = [];
    const off = gate.on((e) => seen.push(e.type));
    expect(gate.paused).toBe(false);
    expect(() => gate.assertCanSync()).not.toThrow();
    gate.evaluate(2, 3, 2);
    expect(gate.paused).toBe(true);
    expect(gate.pauseReason?.action).toBe("update_local");
    const e = (() => {
      try {
        gate.assertCanSync();
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(isForerunnerError(e, "unavailable")).toBe(true);
    gate.evaluate(2, 3, 2); // unchanged: no second event
    expect(seen).toEqual(["sync_paused"]);
    gate.evaluate(3, 3, 2);
    expect(gate.paused).toBe(false);
    expect(seen).toEqual(["sync_paused", "sync_resumed"]);
    expect(gate.events.map((ev) => ev.at)).toEqual([clock.nowIso(), clock.nowIso()]);
    off();
    gate.evaluate(1, 3, 2);
    expect(seen).toHaveLength(2);
    expect(gate.events).toHaveLength(3);
  });

  it("the pointer is plain data: no path separators, versions only", async () => {
    const h = await makeHarness({ feed });
    try {
      writePointer(h.dirs, {
        schema: 1,
        current: "1.0.0",
        previous: null,
        state: "installed",
        updatedAt: h.clock.nowIso(),
        lastRollback: null,
      });
      const raw = JSON.stringify(readPointer(h.dirs));
      expect(raw).not.toMatch(/[\\/]/);
    } finally {
      await h.close();
    }
  });
});

describe("update checks are manual only (the human's decision of 2026-10-25, ADR 0015)", () => {
  const feedHits = () => server.requests.filter((p) => p === "/repos/owner/repo/releases").length;
  const postCheck = (app: ReturnType<typeof createUpdateRoutes>) =>
    app.request("/updates/check", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

  it("composeUpdatesView reads local state only unless a check is asked for", async () => {
    const h = await makeHarness({ feed, checkCacheMs: 30_000 });
    try {
      const before = feedHits();
      const view = await composeUpdatesView({ manager: h.manager, clock: h.clock });
      expect(feedHits() - before).toBe(0);
      expect(view.app.checkedAt).toBeNull();
      expect(view.app.available).toBeNull();
      expect(await h.store.auditLog.list({ tool: "update.check" })).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("opening the Updates screen (GET /updates) never asks the feed; POST /updates/check does, as the human, every time", async () => {
    const h = await makeHarness({ feed, checkCacheMs: 30_000 });
    try {
      const app = createUpdateRoutes({ manager: h.manager, clock: h.clock, humanId: "human-j" });
      const before = feedHits();
      const opened = UpdatesView.parse(await (await app.request("/updates")).json());
      expect(feedHits() - before).toBe(0);
      expect(opened.app.checkedAt).toBeNull();
      expect(opened.app.state).toBe("unknown");

      const checked = await postCheck(app);
      expect(checked.status).toBe(200);
      const view = UpdatesView.parse(await checked.json());
      expect(view.app.state).toBe("available");
      expect(view.app.available?.version).toBe("1.1.0");
      expect(feedHits() - before).toBe(1);
      const audits = await h.store.auditLog.list({ tool: "update.check" });
      expect(audits).toHaveLength(1);
      expect(audits[0]?.human_id).toBe("human-j");

      // The screen now shows the last check's result from local state, without the network.
      const reopened = UpdatesView.parse(await (await app.request("/updates")).json());
      expect(reopened.app.available?.version).toBe("1.1.0");
      expect(reopened.app.checkedAt).toBe(view.app.checkedAt);
      expect(feedHits() - before).toBe(1);

      // The button always asks the feed, even inside the cache window.
      await postCheck(app);
      expect(feedHits() - before).toBe(2);
      expect(await h.store.auditLog.list({ tool: "update.check" })).toHaveLength(2);
      // Installing stays its own click: a check never stages anything.
      expect(h.restarter.requests).toHaveLength(0);
      expect(readPointer(h.dirs)?.current ?? null).toBeNull();
    } finally {
      await h.close();
    }
  });

  it("an unreachable feed on the button is reported in the view, not as a server error", async () => {
    const down = new JsonFeed({ url: "http://127.0.0.1:9/releases.json" });
    const h = await makeHarness({ feed: down });
    try {
      const app = createUpdateRoutes({ manager: h.manager, clock: h.clock, humanId: "human-j" });
      const res = await postCheck(app);
      expect(res.status).toBe(200);
      const view = UpdatesView.parse(await res.json());
      expect(view.app.lastError).toBeTruthy();
      expect(view.app.state).toBe("unknown");
    } finally {
      await h.close();
    }
  });
});

describe("review of the manual check (2026-10-25)", () => {
  it("a failed check keeps showing the last good check's result with the error (no flip-flop between POST and GET)", async () => {
    let failing = false;
    const flaky = {
      kind: feed.kind,
      list: (channel: Parameters<typeof feed.list>[0]) =>
        failing ? Promise.reject(new Error("feed down")) : feed.list(channel),
      latest: (channel: Parameters<typeof feed.latest>[0]) => feed.latest(channel),
    } as unknown as typeof feed;
    const h = await makeHarness({ feed: flaky });
    try {
      const app = createUpdateRoutes({ manager: h.manager, clock: h.clock, humanId: "human-j" });
      const check = async () =>
        UpdatesView.parse(
          await (
            await app.request("/updates/check", {
              method: "POST",
              body: "{}",
              headers: { "content-type": "application/json" },
            })
          ).json(),
        );
      const good = await check();
      expect(good.app.available?.version).toBe("1.1.0");
      failing = true;
      const bad = await check();
      expect(bad.app.lastError).toMatch(/feed down/);
      expect(bad.app.available?.version).toBe("1.1.0");
      expect(bad.app.checkedAt).toBe(good.app.checkedAt);
      const opened = UpdatesView.parse(await (await app.request("/updates")).json());
      expect(opened.app.available?.version).toBe(bad.app.available?.version);
    } finally {
      await h.close();
    }
  });

  it("a configuration error is shown in the view", async () => {
    const h = await makeHarness({ feed });
    try {
      const view = await composeUpdatesView({
        manager: h.manager,
        clock: h.clock,
        configError: "update.json is not valid JSON: x",
      });
      expect(view.app.lastError).toBe(
        "update.json ignored (updates are off): update.json is not valid JSON: x",
      );
    } finally {
      await h.close();
    }
  });
});
