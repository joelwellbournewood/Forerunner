import { type JoinDeps, joinRefusal } from "@forerunner/runtime/daemon/join-preview";
import { keepStartPending } from "@forerunner/runtime/session/prepared-work";
import { identityOf, RepositoryIndex } from "@forerunner/runtime/sources/repository-use";
import type { ProjectRow, StateStore } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { PROJECT_JOIN_DESCRIPTION } from "../src/commands/project-join.ts";
import type { ExecuteResult } from "../src/executor.ts";
import { toToolSpecs } from "../src/registry.ts";
import type { ProjectJoinPort } from "../src/types.ts";
import { RATE, type World, world } from "./helpers.ts";

/**
 * D1 (the owner's words of 2026-11-09: "There should not be 2 projects in one repo. ... Make it
 * such that multiple projects are not done on one repo, in an intelligent way."): two projects
 * that already share a repository on this computer become one with `project.join`. Every table's
 * rows of both projects are counted before and after, over a real SQLite store: the work moves in
 * one transaction, the history stays readable where it was, and each refusal moves nothing.
 */

/** The join's port as the daemon wires it (`joinRefusal` over this store), with seeded waits. */
function joinPort(w: World, waits: Map<string, string | null> = new Map()): ProjectJoinPort {
  const deps: JoinDeps = {
    store: w.store,
    humanId: w.human.id,
    agentId: w.agent.id,
    index: () => RepositoryIndex.read(w.store),
    identities: (repos) =>
      repos.flatMap((r) => {
        const x = identityOf(r);
        return x.kind === "identity" ? [x.identity] : [];
      }),
    keptWaitWhen: async (id) => (waits.has(id) ? (waits.get(id) ?? null) : undefined),
    chfPerUsd: () => RATE,
  };
  return {
    refusal: async (keepId, closeIds) =>
      joinRefusal(deps, {
        keep: await w.store.project.mustGet(keepId),
        close: await Promise.all(closeIds.map((id) => w.store.project.mustGet(id))),
      }),
  };
}

const TABLES = [
  "task",
  "milestone",
  "human_request",
  "queue_item",
  "merge_record",
  "decision",
  "source_candidate",
  "lesson",
  "session",
  "cost_ledger",
  "change_log",
  "message",
] as const;

/** How many rows of each table name the project (and data assets that list it). */
async function counts(store: StateStore, projectId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const rows = await store.db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM "${t}" WHERE "project_id" = ?`,
      [projectId],
    );
    out[t] = Number(rows[0]?.n ?? 0);
  }
  out.data_asset = (await store.dataAsset.forProject(projectId)).length;
  return out;
}

interface Pair {
  site: ProjectRow;
  kite: ProjectRow;
  alone: ProjectRow;
  ids: Record<
    | "cart"
    | "signup"
    | "cardAbout"
    | "openProjectCard"
    | "answeredProjectCard"
    | "note"
    | "asset"
    | "m1"
    | "m2",
    string
  >;
}

/** "Site" and "Kite club" on one repository, made through the store, with work and history. */
async function seedPair(w: World): Promise<Pair> {
  const { store } = w;
  const site = await store.project.insert({ name: "Site", goal: "A site", repos: ["o/site"] });
  const kite = await store.project.insert({
    name: "Kite club",
    goal: "Kites",
    repos: ["https://github.com/O/site.git"],
  });
  const alone = await store.project.insert({ name: "Alone", goal: "Alone", repos: [] });
  const by = { reason: "planned", author_human: w.human.id };
  await store.milestone.insert({ project_id: site.id, name: "Launch", order_index: 0, ...by });
  const m1 = await store.milestone.insert({
    project_id: kite.id,
    name: "Club page",
    order_index: 0,
    ...by,
  });
  const m2 = await store.milestone.insert({
    project_id: kite.id,
    name: "Signup",
    order_index: 1,
    ...by,
  });
  const cart = await store.task.insert({
    project_id: kite.id,
    milestone_id: m1.id,
    title: "Cart",
    status: "done",
    pr_url: "https://github.com/o/site/pull/7",
    branch: "fr/task-cart",
  });
  const signup = await store.task.insert({
    project_id: kite.id,
    milestone_id: m2.id,
    title: "Signup form",
    status: "ready",
    depends_on: [cart.id],
  });
  await store.task.insert({ project_id: kite.id, title: "Old idea", status: "cancelled" });
  await store.task.insert({ project_id: kite.id, title: "Broken", status: "failed" });
  await store.task.insert({ project_id: kite.id, title: "Draft", status: "draft" });
  await store.task.insert({ project_id: site.id, title: "Home page", status: "ready" });
  const cardAbout = await store.humanRequest.insert({
    project_id: kite.id,
    task_id: signup.id,
    kind: "decision",
    why: "Which fields?",
    status: "open",
  });
  await store.humanRequest.insert({
    project_id: kite.id,
    task_id: cart.id,
    kind: "approval",
    why: "Accept the cart?",
    status: "answered",
  });
  const openProjectCard = await store.humanRequest.insert({
    project_id: kite.id,
    kind: "info",
    why: "Which colours?",
    status: "open",
  });
  const answeredProjectCard = await store.humanRequest.insert({
    project_id: kite.id,
    kind: "info",
    why: "What are the opening hours?",
    status: "answered",
  });
  const note = await store.queue.insert({
    project_id: kite.id,
    human_id: w.human.id,
    kind: "note",
    text: "Use the club's blue.",
  });
  await store.queue.insert({
    project_id: kite.id,
    human_id: w.human.id,
    kind: "note",
    text: "Read already.",
    status: "consumed",
  });
  await store.mergeRecord.insert({
    task_id: cart.id,
    project_id: kite.id,
    agent_id: w.agent.id,
    pr_number: 7,
    pr_url: "https://github.com/o/site/pull/7",
    reviewed_head_sha: "abc",
    state: "merged",
  });
  await store.decision.insert({
    project_id: kite.id,
    question: "Which colour?",
    question_normalised: "which colour?",
    chosen: "Blue",
    decided_by: w.human.id,
  });
  const source = await store.source.insert({
    kind: "github_user",
    display_name: "o",
    locator: "o",
  });
  await store.sourceCandidate.insert({
    source_id: source.id,
    kind: "repo",
    name: "site",
    locator: "o/site",
    key: "github:o/site",
    proposed_name: "Kite club",
    status: "accepted",
    project_id: kite.id,
    last_seen_at: w.clock.nowIso(),
  });
  const asset = await store.dataAsset.insert({
    project_ids: [kite.id],
    locator: "/data/kites.csv",
    kind: "csv",
    registered_by: w.human.id,
  });
  await store.lesson.insert({
    scope: "shared",
    project_id: kite.id,
    text: "Kites need wind.",
  });
  const session = await store.session.insert({
    agent_id: w.agent.id,
    project_id: kite.id,
    status: "completed",
    started_at: w.clock.nowIso(),
    ended_at: w.clock.nowIso(),
  });
  await store.costLedger.record({
    human_id: w.human.id,
    project_id: kite.id,
    session_id: session.id,
    kind: "api",
    usd_micro: 4_000_000,
    chf_micro: 3_200_000,
    model: "claude-sonnet",
  });
  await store.changeLog.insert({ project_id: kite.id, sentence: "Set autonomy." });
  await store.message.insert({
    from_agent_id: w.agent.id,
    project_id: kite.id,
    type: "info",
    body: "Hello",
  });
  return {
    site,
    kite,
    alone,
    ids: {
      cart: cart.id,
      signup: signup.id,
      cardAbout: cardAbout.id,
      openProjectCard: openProjectCard.id,
      answeredProjectCard: answeredProjectCard.id,
      note: note.id,
      asset: asset.id,
      m1: m1.id,
      m2: m2.id,
    },
  };
}

async function join(w: World, keep: string, close: string[]): Promise<ExecuteResult> {
  return w.executor.execute({
    name: "project.join",
    params: { keep, close },
    ctx: w.ctx({ source: "ui" }),
    confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
  });
}

describe("d1109-onerepo-join, run C: project.join (OJ-02, OJ-04, OJ-06, OJ-08)", () => {
  it("moves Kite club's work into Site in one change: every task with its milestones after Site's, the cards about them and its open cards, its queued notes, merge records, decisions and accepted source proposals; its data assets add Site; its sessions, ledger, changes, chat and answered project cards stay; Undo puts every row back", async () => {
    const w = await world();
    w.ports.projectJoin = joinPort(w);
    const { site, kite, ids } = await seedPair(w);
    const before = { site: await counts(w.store, site.id), kite: await counts(w.store, kite.id) };
    // OJ-07: the sums every cap check reads (month, project, session) before the join.
    const sums = async () => ({
      month: (await w.store.costLedger.sum({ humanId: w.human.id })).usd_micro,
      site: (await w.store.costLedger.sum({ projectId: site.id })).usd_micro,
      kite: (await w.store.costLedger.sum({ projectId: kite.id })).usd_micro,
    });
    const sumsBefore = await sums();
    const r = await join(w, site.id, [kite.id]);
    expect(r.status).toBe("done");
    const done = r as Extract<ExecuteResult, { status: "done" }>;
    expect(done.sentence).toBe('Made one project: "Kite club" joined "Site".');
    const after = { site: await counts(w.store, site.id), kite: await counts(w.store, kite.id) };
    // Moved: 5 tasks, 2 milestones, the 2 cards about tasks and the open project card, 1 queued
    // note, 1 merge record, 1 decision, 1 accepted proposal; the asset now lists both.
    const moved = {
      task: 5,
      milestone: 2,
      human_request: 3,
      queue_item: 1,
      merge_record: 1,
      decision: 1,
      source_candidate: 1,
    };
    for (const [t, n] of Object.entries(moved)) {
      expect(after.site[t], t).toBe((before.site[t] ?? 0) + n);
      expect(after.kite[t], t).toBe((before.kite[t] ?? 0) - n);
    }
    expect(after.site.data_asset).toBe(1);
    expect(after.kite.data_asset).toBe(1);
    // Stayed, readable: sessions, ledger, changes, chat, lessons, the answered project card and
    // the consumed note.
    for (const t of ["session", "cost_ledger", "message", "lesson"]) {
      expect(after.kite[t], t).toBe(before.kite[t]);
      expect(after.site[t], t).toBe(before.site[t]);
    }
    expect((await w.store.humanRequest.mustGet(ids.answeredProjectCard)).project_id).toBe(kite.id);
    expect(await sums()).toEqual(sumsBefore);
    expect(sumsBefore).toEqual({ month: 4_000_000, site: 0, kite: 4_000_000 });
    // Ids, dependencies, branches and pull requests kept; milestones after Site's.
    const signup = await w.store.task.mustGet(ids.signup);
    expect(signup.depends_on).toEqual([ids.cart]);
    const cart = await w.store.task.mustGet(ids.cart);
    expect(cart.pr_url).toBe("https://github.com/o/site/pull/7");
    expect(cart.branch).toBe("fr/task-cart");
    expect((await w.store.milestone.mustGet(ids.m1)).order_index).toBe(1);
    expect((await w.store.milestone.mustGet(ids.m2)).order_index).toBe(2);
    // Kite club is closed into Site: archived with joined_into, no link, its link kept.
    const closed = await w.store.project.mustGet(kite.id);
    expect(closed.status).toBe("archived");
    expect(closed.repos).toEqual([]);
    expect(closed.name).toBe("Kite club");
    expect(closed.settings.joined_into).toMatchObject({ project: site.id, name: "Site" });
    expect(closed.settings.was_linked).toEqual(["https://github.com/O/site.git"]);
    expect((await w.store.project.mustGet(site.id)).settings.joined_from).toEqual([kite.id]);
    // One change row on Site, with its Undo.
    const row = await w.store.changeLog.mustGet(done.changeLogId);
    expect(row.project_id).toBe(site.id);
    expect(row.sentence).toBe('Made one project: "Kite club" joined "Site".');

    // A card made on Site since for a moved task goes back with it.
    const since = await w.store.humanRequest.insert({
      project_id: site.id,
      task_id: ids.signup,
      kind: "decision",
      why: "Email or phone?",
      status: "open",
    });
    const undone = await w.executor.undo(done.changeLogId, w.ctx({ source: "ui" }));
    expect(undone.status).toBe("done");
    expect((undone as Extract<ExecuteResult, { status: "done" }>).sentence).toBe(
      '"Kite club" is its own project again.',
    );
    const back = { site: await counts(w.store, site.id), kite: await counts(w.store, kite.id) };
    expect(back.site).toEqual({ ...before.site, change_log: back.site.change_log });
    expect(back.kite).toEqual({
      ...before.kite,
      human_request: (before.kite.human_request ?? 0) + 1,
    });
    expect((await w.store.humanRequest.mustGet(since.id)).project_id).toBe(kite.id);
    expect((await w.store.milestone.mustGet(ids.m1)).order_index).toBe(0);
    const reopened = await w.store.project.mustGet(kite.id);
    expect(reopened.status).toBe("active");
    expect(reopened.repos).toEqual(["https://github.com/O/site.git"]);
    expect(reopened.settings.joined_into).toBeUndefined();
    expect(reopened.settings.was_linked).toBeUndefined();
    expect((await w.store.project.mustGet(site.id)).settings.joined_from).toBeUndefined();
    expect((await w.store.dataAsset.mustGet(ids.asset)).project_ids).toEqual([kite.id]);
    await w.store.close();
  });

  it("each refusal answers its sentence and moves nothing: a session working on either, a session waiting to go on, a held hands-off start, Kite club's plan waiting, one of its merges under way, no shared link, a project that is not the person's own", async () => {
    const w = await world();
    const waits = new Map<string, string | null>();
    w.ports.projectJoin = joinPort(w, waits);
    const { site, kite, alone, ids } = await seedPair(w);
    const stranger = await w.store.project.insert({
      name: "Their site",
      repos: ["o/site"],
      author_human: w.other.id,
    });
    // The rows a join moves (sessions are seeded below as the holds themselves).
    const movable = async (id: string) => {
      const { session: _seeded, ...rest } = await counts(w.store, id);
      return rest;
    };
    const snapshot = async () => ({
      site: await movable(site.id),
      kite: await movable(kite.id),
      kiteRow: (await w.store.project.mustGet(kite.id)).status,
    });
    const before = await snapshot();
    const refused = async (keep: string, close: string[], reason: string) => {
      const r = await join(w, keep, close);
      expect(r).toMatchObject({ status: "refused", reason });
      expect(await snapshot()).toEqual(before);
    };
    await refused(site.id, [stranger.id], "Only your own projects can be made one.");
    await w.store.project.patch(stranger.id, { status: "archived", active: false });
    await refused(
      site.id,
      [alone.id],
      '"Site" and "Alone" do not work in the same repository or folder, so they stay apart.',
    );
    // A session working on Site (either project).
    const running = await w.store.session.insert({
      agent_id: w.agent.id,
      project_id: site.id,
      status: "running",
      started_at: w.clock.nowIso(),
    });
    await refused(
      site.id,
      [kite.id],
      'A session is working on "Site". Make one project when it ends.',
    );
    await w.store.session.patch(running.id, { status: "completed", ended_at: w.clock.nowIso() });
    // A session of Kite club waits to go on after its credential (d1109-starts-engine).
    waits.set(kite.id, "at 15:40");
    await refused(
      site.id,
      [kite.id],
      'A session of "Kite club" waits to go on at 15:40. Make one project after it ran, or cancel it first.',
    );
    waits.delete(kite.id);
    // A hands-off start held on Site.
    await keepStartPending(w.store, site.id, { since: w.clock.nowIso(), why: "deferred" });
    await refused(
      site.id,
      [kite.id],
      'A session of "Site" waits to start by itself. Make one project after it ran, or turn "When work is ready" back to Wait for my Start.',
    );
    const siteRow = await w.store.project.mustGet(site.id);
    await w.store.project.patch(site.id, { summary_cache: {} });
    expect(siteRow.summary_cache).toHaveProperty("start_pending");
    before.site = await movable(site.id);
    // Kite club's plan waits for an answer.
    const plan = await w.store.humanRequest.insert({
      project_id: kite.id,
      kind: "approval",
      why: "Plan",
      status: "open",
      change_card: { key: `intake:${kite.id}` },
    });
    before.kite = await movable(kite.id);
    await refused(
      site.id,
      [kite.id],
      'The plan of "Kite club" waits for your answer. Answer it first.',
    );
    await w.store.humanRequest.withdraw(plan.id, plan.version);
    // One of its merges is under way.
    const record = await w.store.mergeRecord.forTask(ids.cart);
    if (!record) throw new Error("no merge record");
    await w.store.mergeRecord.patch(record.id, { state: "merging" });
    await refused(
      site.id,
      [kite.id],
      'A pull request of "Kite club" is being merged. Try again in a minute.',
    );
    await w.store.mergeRecord.patch(record.id, { state: "merged" });
    // Nothing holds it now: the join goes through.
    expect((await join(w, site.id, [kite.id])).status).toBe("done");
    await w.store.close();
  });

  it("OJ-04: Undo is refused while a session runs on Site, while a moved task's merge is under way, and while a Site task that was not moved waits for a moved one; a moved task merged from Site since goes back still merged with its record", async () => {
    const w = await world();
    w.ports.projectJoin = joinPort(w);
    const { site, kite, ids } = await seedPair(w);
    const r = (await join(w, site.id, [kite.id])) as Extract<ExecuteResult, { status: "done" }>;
    expect(r.status).toBe("done");
    const undo = () => w.executor.undo(r.changeLogId, w.ctx({ source: "ui" }));
    const running = await w.store.session.insert({
      agent_id: w.agent.id,
      project_id: site.id,
      status: "running",
      started_at: w.clock.nowIso(),
    });
    expect(await undo()).toMatchObject({
      status: "refused",
      reason: 'a session is working on "Site". Undo when it ends',
    });
    await w.store.session.patch(running.id, { status: "completed", ended_at: w.clock.nowIso() });
    const record = await w.store.mergeRecord.forTask(ids.cart);
    if (!record) throw new Error("no merge record");
    await w.store.mergeRecord.patch(record.id, { state: "merging" });
    expect(await undo()).toMatchObject({
      status: "refused",
      reason: 'a pull request of the work from "Kite club" is being merged. Try again in a minute',
    });
    await w.store.mergeRecord.patch(record.id, { state: "merged", merge_sha: "m1" });
    const shop = await w.store.task.insert({
      project_id: site.id,
      title: "Shop page",
      status: "ready",
      depends_on: [ids.cart],
    });
    expect(await undo()).toMatchObject({
      status: "refused",
      reason: '"Shop page" waits for "Cart", which came from "Kite club": change that first',
    });
    expect((await w.store.task.mustGet(ids.cart)).project_id).toBe(site.id);
    await w.store.task.patch(shop.id, { depends_on: [] });
    // Site's creation cannot be undone while it includes Kite club's work (OJ-06).
    const created = await w.store.changeLog.insert({
      project_id: site.id,
      human_id: w.human.id,
      commands: [
        { name: "project.create", params: { name: "Site", goal: "", repos: [], switch: false } },
      ],
      before: { project_id: null },
      after: { project_id: site.id },
      sentence: "Created the project Site. Undo.",
    });
    expect(await w.executor.undo(created.id, w.ctx({ source: "ui" }))).toMatchObject({
      status: "refused",
      reason: 'this project includes the work of "Kite club"',
    });
    const done = await undo();
    expect(done.status).toBe("done");
    const cart = await w.store.task.mustGet(ids.cart);
    expect(cart.project_id).toBe(kite.id);
    expect(cart.status).toBe("done");
    const back = await w.store.mergeRecord.forTask(ids.cart);
    expect(back).toMatchObject({ project_id: kite.id, state: "merged", merge_sha: "m1" });
    await w.store.close();
  });

  it("OJ-08: from chat the join is read back with Yes and No and its definition is the model's exact text; the yes runs the same moves", async () => {
    const w = await world();
    w.ports.projectJoin = joinPort(w);
    const { site, kite } = await seedPair(w);
    const chat = w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" });
    const spec = toToolSpecs(w.registry, {
      execute: async () => ({ status: "refused", reason: "-" }) as never,
      ctxFor: () => chat,
    } as never).find((s) => s.name === "project_join");
    expect(spec?.description).toBe(PROJECT_JOIN_DESCRIPTION);
    expect(PROJECT_JOIN_DESCRIPTION).toBe(
      "Make one project of projects on this computer that work in the same repository or folder: keep is the project the person chose to keep, close the others. Their tasks, plan, cards and open pull requests move into the kept project; their sessions, changes and spending stay readable where they are, and no budget changes. Only when the person asks for it and names the project to keep; never choose it yourself.",
    );
    const r = await w.executor.execute({
      name: "project.join",
      params: { keep: "Site", close: ["Kite club"] },
      ctx: chat,
    });
    expect(r.status).toBe("pending");
    const pending = r as Extract<ExecuteResult, { status: "pending" }>;
    expect(pending.card.ask).toBe(
      'Make one project: move the tasks, plan and cards of "Kite club" into "Site"? Changes has its Undo.',
    );
    expect((await w.store.project.mustGet(kite.id)).status).toBe("active");
    const yes = await w.executor.confirm(pending.pendingId, {
      kind: "yes",
      by: { kind: "human", id: w.human.id },
    });
    expect(yes.status).toBe("done");
    expect((await w.store.project.mustGet(kite.id)).settings.joined_into).toMatchObject({
      project: site.id,
    });
    await w.store.close();
  });
});

describe("d1109-onerepo-join, run C: a closed project takes no new work (OJ-06)", () => {
  it('after the join a task, a note, a setting, autonomy and a switch for Kite club are refused with \'"Kite club" joined "Site", so its work runs there.\', from the app and from chat, and nothing is written; a removed project answers its own sentence; Site takes the same work', async () => {
    const w = await world();
    w.ports.projectJoin = joinPort(w);
    const { site, kite } = await seedPair(w);
    expect((await join(w, site.id, [kite.id])).status).toBe("done");
    const tap = { kind: "tap" as const, by: { kind: "human" as const, id: w.human.id } };
    const asked = [
      { name: "task.create", params: { title: "Probe task", project: kite.id } },
      { name: "note.add", params: { text: "Use the red kite." } },
      { name: "settings.set", params: { key: "status_pull_request", value: true } },
      { name: "autonomy.set", params: { level: 2 } },
      { name: "project.switch", params: { project: kite.id } },
    ];
    const kiteRows = async () => ({
      tasks: (await w.store.task.forProject(kite.id)).length,
      queued: (await w.store.queue.pending(kite.id)).length,
      changes: (await w.store.changeLog.list({ project_id: kite.id } as never)).length,
    });
    const before = await kiteRows();
    expect(before.tasks).toBe(0);
    for (const source of ["ui", "chat"] as const) {
      for (const call of asked) {
        const r = await w.executor.execute({
          ...call,
          ctx: w.ctx({ source, activeProjectId: kite.id }),
          confirmation: tap,
        });
        expect(r, `${source} ${call.name}`).toMatchObject({
          status: "refused",
          code: "validation",
          reason: '"Kite club" joined "Site", so its work runs there.',
        });
      }
    }
    expect(await kiteRows()).toEqual(before);
    const kept = await w.store.project.mustGet(kite.id);
    expect(kept.settings.status_pull_request).toBeUndefined();
    expect(kept.autonomy_level).toBe(kite.autonomy_level);
    // Site, which has the work now, takes it.
    const onSite = await w.executor.execute({
      name: "task.create",
      params: { title: "Probe task", project: site.id },
      ctx: w.ctx({ source: "ui", activeProjectId: site.id }),
      confirmation: tap,
    });
    expect(onSite.status).toBe("done");
    // The sibling: a project whose creation was undone takes no new work either.
    const gone = await w.store.project.insert({ name: "Gone", goal: "g", repos: [] });
    await w.store.project.patch(gone.id, { status: "archived" });
    const onGone = await w.executor.execute({
      name: "task.create",
      params: { title: "Probe task", project: gone.id },
      ctx: w.ctx({ source: "ui", activeProjectId: gone.id }),
      confirmation: tap,
    });
    expect(onGone).toMatchObject({
      status: "refused",
      code: "validation",
      reason: 'The project "Gone" was removed, so nothing of it runs.',
    });
    expect((await w.store.task.forProject(gone.id)).length).toBe(0);
    await w.store.close();
  });

  it("Undo of the join gives Kite club back as it was: a paused project left off comes back paused and off, and takes work again", async () => {
    const w = await world();
    w.ports.projectJoin = joinPort(w);
    const { site, kite } = await seedPair(w);
    await w.store.project.patch(kite.id, { status: "paused", active: false });
    const r = await join(w, site.id, [kite.id]);
    expect(r.status).toBe("done");
    const done = r as Extract<ExecuteResult, { status: "done" }>;
    expect((await w.executor.undo(done.changeLogId, w.ctx({ source: "ui" }))).status).toBe("done");
    const back = await w.store.project.mustGet(kite.id);
    expect({ status: back.status, active: back.active }).toEqual({
      status: "paused",
      active: false,
    });
    const again = await w.executor.execute({
      name: "task.create",
      params: { title: "Probe task", project: kite.id },
      ctx: w.ctx({ source: "ui", activeProjectId: kite.id }),
      confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
    });
    expect(again.status).toBe("done");
    await w.store.close();
  });
});
