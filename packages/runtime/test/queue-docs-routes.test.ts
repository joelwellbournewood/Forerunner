import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { openStore, QUEUE_KINDS, QUEUE_STATUSES, type StateStore } from "@forerunner/state";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { QUEUE_ITEM_KINDS, QUEUE_ITEM_STATUSES } from "../src/daemon/api-types.ts";
import { createDocsRoutes } from "../src/daemon/docs-routes.ts";
import { createQueueRoutes } from "../src/daemon/queue-routes.ts";

/**
 * The project page's Next session panel and Docs tab (U-004, U-005 in
 * docs/status/UPDATE-LOG.md): the routes 1.0.2 lacked. The UI's client runs against the real
 * daemon in apps/ui/test/real-daemon.test.ts; this file covers what that one does not: another
 * human's rows, stale dismissals, bad queries, paths outside the doc set and drift.
 */

interface World {
  store: StateStore;
  me: string;
  other: string;
  agent: string;
  project: string;
  root: string;
  events: EventEmitter;
}

/**
 * The routes throw typed errors that the daemon's `onError` maps to statuses; mounted alone,
 * a parent answers each with its code (and reason) so the test reads what was thrown.
 */
function mount(sub: Hono): Hono {
  const app = new Hono();
  app.onError((err, c) =>
    err instanceof ForerunnerError
      ? c.json({ code: err.code, reason: err.details?.reason ?? null }, 400)
      : c.json({ code: "internal", message: String(err) }, 500),
  );
  app.route("/", sub);
  return app;
}

const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

async function world(): Promise<World> {
  const clock = new SimulatedClock("2026-10-30T07:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = async (name: string) =>
    (
      await store.human.insert({
        name,
        email: `${name.toLowerCase()}@example.test`,
        timezone: "Europe/Zurich",
        notify_prefs: {},
        default_autonomy: 2,
        monthly_cap_usd_micro: 150_000_000,
        locale: "en",
      })
    ).id;
  const me = await human("J");
  const other = await human("K");
  const agent = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: me,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
    await store.project.insert({
      name: "Sample",
      goal: "Ship a sample service",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [agent] },
      small_project_mode: false,
      active: true,
    })
  ).id;
  const root = join(mkdtempSync(join(tmpdir(), "fr-docs-")), "workspace");
  mkdirSync(join(root, "docs", "decisions"), { recursive: true });
  return { store, me, other, agent, project, root, events: new EventEmitter() };
}

describe("next-session queue routes (U-004)", () => {
  let w: World;
  let app: Hono;
  beforeEach(async () => {
    w = await world();
    app = mount(
      createQueueRoutes({
        store: w.store,
        who: () => ({ humanId: w.me, agentId: w.agent }),
        events: w.events,
      }),
    );
  });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("mirrors the store's kinds and statuses", () => {
    expect([...QUEUE_ITEM_KINDS]).toEqual([...QUEUE_KINDS]);
    expect([...QUEUE_ITEM_STATUSES]).toEqual([...QUEUE_STATUSES]);
  });

  it("adds an item for the next session, lists only this human's, and announces the change", async () => {
    let announced = 0;
    w.events.on("project", () => announced++);
    const added = await post(`/projects/${w.project}/queue`, { kind: "idea", text: "  Try SSE  " });
    expect(added.status).toBe(201);
    const item = (await added.json()) as Record<string, unknown>;
    expect(item).toMatchObject({ kind: "idea", text: "Try SSE", priority: 5, status: "queued" });
    expect(announced).toBe(1);
    // A co-worker's note on the same project is theirs: never listed here.
    await w.store.queue.enqueue({
      project_id: w.project,
      human_id: w.other,
      kind: "note",
      text: "K's note",
      priority: 9,
      status: "queued",
    });
    const listed = (await (await app.request(`/projects/${w.project}/queue`)).json()) as Array<{
      text: string;
    }>;
    expect(listed.map((q) => q.text)).toEqual(["Try SSE"]);
    // The runner briefs the same row (spec J.2).
    expect((await w.store.queue.pending(w.project, { humanId: w.me })).map((q) => q.id)).toEqual([
      item.id,
    ]);
  });

  it("refuses an empty text, an unknown kind and an unknown status filter", async () => {
    expect(
      await codeOf(await post(`/projects/${w.project}/queue`, { kind: "note", text: "  " })),
    ).toBe("validation");
    expect(
      await codeOf(await post(`/projects/${w.project}/queue`, { kind: "wish", text: "x" })),
    ).toBe("validation");
    const bad = await app.request(`/projects/${w.project}/queue?status=done`);
    expect(await bad.json()).toEqual({ code: "validation", reason: "bad_query" });
    expect(await w.store.queue.count()).toBe(0);
  });

  it("dismisses once, refuses a second dismissal and another human's item", async () => {
    const mine = (await (
      await post(`/projects/${w.project}/queue`, { kind: "note", text: "mine" })
    ).json()) as { id: string };
    const first = await post(`/queue/${mine.id}/dismiss`, {});
    expect(first.status).toBe(200);
    expect(((await first.json()) as { status: string }).status).toBe("dismissed");
    expect(await codeOf(await post(`/queue/${mine.id}/dismiss`, {}))).toBe("validation");
    const theirs = await w.store.queue.enqueue({
      project_id: w.project,
      human_id: w.other,
      kind: "note",
      text: "theirs",
      priority: 5,
      status: "queued",
    });
    expect((await post(`/queue/${theirs.id}/dismiss`, {})).status).toBe(403);
    expect((await w.store.queue.get(theirs.id))?.status).toBe("queued");
  });
});

describe("docs routes (U-005)", () => {
  let w: World;
  let app: Hono;
  beforeEach(async () => {
    w = await world();
    app = mount(
      createDocsRoutes({
        store: w.store,
        docsDirsFor: () => [w.root],
        who: () => ({ humanId: w.me, agentId: w.agent }),
      }),
    );
  });

  it("lists the standard set with what exists, where it was read and its drift", async () => {
    writeFileSync(join(w.root, "README.md"), "# Sample\n");
    writeFileSync(join(w.root, "docs", "status.md"), "# Status\n");
    const task = await w.store.task.insert({ project_id: w.project, title: "Change the API" });
    const review = await w.store.review.insert({
      task_id: task.id,
      critic_model: "fake-opus",
      verdict: "revise",
    });
    await w.store.finding.insert({
      review_id: review.id,
      task_id: task.id,
      severity: "medium",
      description: "Doc drift: docs/status.md does not mention the new endpoint",
      status: "open",
    });
    const docs = (await (await app.request(`/projects/${w.project}/docs`)).json()) as Array<{
      path: string;
      exists: boolean;
      drift: boolean;
      note: string;
    }>;
    expect(docs.map((d) => d.path)).toEqual([
      "README.md",
      "docs/overview.md",
      "docs/architecture.md",
      "docs/status.md",
      "docs/decisions/README.md",
      "docs/runbook.md",
      "docs/data.md",
      "docs/testing.md",
    ]);
    expect(docs[0]).toMatchObject({ exists: true, drift: false, note: "from the project folder" });
    expect(docs[1]).toMatchObject({ exists: false, drift: false, note: "not written yet" });
    expect(docs[3]).toMatchObject({ exists: true, drift: true });
    expect(docs[3]?.note).toContain("new endpoint");
  });

  it("reads one doc of the set and lists the decisions folder's records", async () => {
    writeFileSync(join(w.root, "docs", "decisions", "README.md"), "# Decisions\n");
    writeFileSync(join(w.root, "docs", "decisions", "0001-use-sqlite.md"), "# 1\n");
    const res = await app.request(
      `/projects/${w.project}/docs/${encodeURIComponent("docs/decisions/README.md")}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; content: string };
    expect(body.path).toBe("docs/decisions/README.md");
    expect(body.content).toContain("# Decisions");
    expect(body.content).toContain("- 0001-use-sqlite.md");
  });

  it("answers not_found for a doc not written yet and for any path outside the set", async () => {
    writeFileSync(join(w.root, "secret.txt"), "no");
    const get = async (rel: string) =>
      codeOf(await app.request(`/projects/${w.project}/docs/${encodeURIComponent(rel)}`));
    expect(await get("docs/overview.md")).toBe("not_found");
    expect(await get("secret.txt")).toBe("not_found");
    expect(await get("../workspace/secret.txt")).toBe("not_found");
    expect(await get("docs/../secret.txt")).toBe("not_found");
  });
});
