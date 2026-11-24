import { joinRefusedHeldStart } from "@forerunner/runtime/daemon/join-words";
import { keepStartPending } from "@forerunner/runtime/session/prepared-work";
import { describe, expect, it } from "vitest";
import { PROJECT_JOIN_DESCRIPTION } from "../src/commands/project-join.ts";
import type { ExecuteResult } from "../src/executor.ts";
import { toToolSpecs } from "../src/registry.ts";
import { type World, world } from "./helpers.ts";
import { counts, join, joinPort, seedPair } from "./join-world.ts";

/**
 * D1 (the owner's words of 2026-11-09: "There should not be 2 projects in one repo. ... Make it
 * such that multiple projects are not done on one repo, in an intelligent way."): two projects
 * that already share a repository on this computer become one with `project.join`. Every table's
 * rows of both projects are counted before and after, over a real SQLite store: the work moves in
 * one transaction, the history stays readable where it was, and each refusal moves nothing.
 */

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
      // L4-creds-28: one sentence of at most 100 characters (was about 130).
      'A session of "Site" waits to start by itself: make one project after it ran.',
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
      { name: "settings.set", params: { key: "status_issue", value: false } },
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
    expect(kept.settings.status_issue).toBeUndefined();
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

// l4-selftasks-check, run L4 (L4-selftasks-109; C4L-14, merge-w20): after Make one project, the
// notes a session kept for the closing project were never checked (nothing moved
// summary_cache.task_list_notes), and the kept project could show two open "the agent suggests
// ... changes to the tasks" cards.
describe("l4-selftasks-check, run L4: project.join and the agent's task-list notes and suggestions (L4-selftasks-109)", () => {
  const NOTE = {
    source: "report",
    taskId: "t-kite",
    taskTitle: "Signup form",
    specialist: "coder",
    lines: [{ text: "nothing checks the signup's email field", flagged: false }],
    at: "2026-03-05T08:00:00.000Z",
  };
  const SITE_NOTE = { ...NOTE, taskId: "t-site", taskTitle: "Launch page" };
  const proposalCard = (w: World, projectId: string, why: string) =>
    w.store.humanRequest.insert({
      human_id: w.human.id,
      project_id: projectId,
      kind: "decision",
      why,
      steps: ['Add "Check the email field".'],
      options: ["Make these changes", "Keep the tasks"],
      blocking: false,
      risk: "low",
      status: "open",
      change_card: { key: "task_proposal", project_id: projectId },
    } as never);
  const openProposals = async (w: World, projectId: string) =>
    (await w.store.humanRequest.list({ project_id: projectId, status: "open" } as never)).filter(
      (r) => (r.change_card as { key?: unknown } | null)?.key === "task_proposal",
    );
  const notesOf = async (w: World, projectId: string) =>
    ((await w.store.project.mustGet(projectId)).summary_cache as { task_list_notes?: unknown })
      .task_list_notes ?? [];

  it("the kept project holds the closing project's notes and one open suggestion; Undo puts both back as they were", async () => {
    const w = await world();
    w.ports.projectJoin = joinPort(w);
    const { site, kite } = await seedPair(w);
    await w.store.project.patch(kite.id, { summary_cache: { task_list_notes: [NOTE] } } as never);
    await w.store.project.patch(site.id, {
      summary_cache: { task_list_notes: [SITE_NOTE] },
    } as never);
    const siteCard = await proposalCard(w, site.id, "Site's suggestion.");
    const kiteCard = await proposalCard(w, kite.id, "Kite club's suggestion.");
    const r = await join(w, site.id, [kite.id]);
    expect(r.status).toBe("done");
    expect(await notesOf(w, site.id)).toEqual([SITE_NOTE, NOTE]);
    expect(await notesOf(w, kite.id)).toEqual([]);
    const open = await openProposals(w, site.id);
    expect(open.map((c) => c.id)).toEqual([kiteCard.id]);
    expect(await openProposals(w, kite.id)).toEqual([]);
    const done = r as Extract<ExecuteResult, { status: "done" }>;
    const undone = await w.executor.undo(done.changeLogId, w.ctx({ source: "ui" }));
    expect(undone.status).toBe("done");
    expect(await notesOf(w, site.id)).toEqual([SITE_NOTE]);
    expect(await notesOf(w, kite.id)).toEqual([NOTE]);
    expect((await openProposals(w, site.id)).map((c) => c.id)).toEqual([siteCard.id]);
    expect((await openProposals(w, kite.id)).map((c) => c.id)).toEqual([kiteCard.id]);
  });
});

describe("l4-github-merge, run L4", () => {
  it("L4-creds-28: the held hands-off start's refusal is one sentence of at most 100 characters", () => {
    const line = joinRefusedHeldStart("Kite club");
    expect(line).toBe(
      'A session of "Kite club" waits to start by itself: make one project after it ran.',
    );
    expect(line.length).toBeLessThanOrEqual(100);
    expect(line.match(/[.!?](\s|$)/g)).toHaveLength(1);
  });
});

describe("l4-github-carried, run L4", () => {
  it("L4e-left-8: the held hands-off start's refusal promises no 'soon' (quiet hours can hold it for hours)", () => {
    const line = joinRefusedHeldStart("Kite club");
    // Before: 'A session of "Kite club" starts by itself soon: make one project after it ran.'
    expect(line).not.toMatch(/\bsoon\b/);
    expect(line).toContain("waits to start by itself");
  });
});

describe("l4-chat-carried, run L4: a split asked for a closed project's task (C4-left-9)", () => {
  // task.split is not among the commands a closed project still answers (OPEN_ON_A_CLOSED_PROJECT):
  // chat's split of a task left on Kite club after the join is refused in the same sentence as
  // any other new work, and nothing is split.
  it('from chat and from the app: \'"Kite club" joined "Site", so its work runs there.\', nothing written', async () => {
    const w = await world();
    w.ports.projectJoin = joinPort(w);
    const { site, kite } = await seedPair(w);
    expect((await join(w, site.id, [kite.id])).status).toBe("done");
    const left = await w.store.task.insert({
      project_id: kite.id,
      title: "Style the page",
      outcome: "Styled",
      acceptance_criteria: ["a", "b"],
      risk_tier: 1,
      status: "ready",
      priority: 5,
      reason: "planned",
    } as never);
    const tap = { kind: "tap" as const, by: { kind: "human" as const, id: w.human.id } };
    for (const source of ["chat", "ui"] as const) {
      const r = await w.executor.execute({
        name: "task.split",
        params: {
          task: left.id,
          parts: [
            { title: "Style the layout", acceptance_criteria: ["a"] },
            { title: "Style the colours", acceptance_criteria: ["b"] },
          ],
          order: "in_turn",
        },
        ctx: w.ctx({ source, activeProjectId: kite.id }),
        confirmation: tap,
      });
      expect(r, source).toMatchObject({
        status: "refused",
        code: "validation",
        reason: '"Kite club" joined "Site", so its work runs there.',
      });
    }
    expect((await w.store.task.mustGet(left.id)).title).toBe("Style the page");
    expect((await w.store.task.forProject(kite.id)).length).toBe(1);
    await w.store.close();
  });
});
