import { type JoinDeps, joinRefusal } from "@forerunner/runtime/daemon/join-preview";
import { identityOf, RepositoryIndex } from "@forerunner/runtime/sources/repository-use";
import type { ProjectRow, StateStore } from "@forerunner/state";
import type { ExecuteResult } from "../src/executor.ts";
import type { ProjectJoinPort } from "../src/types.ts";
import { RATE, type World } from "./helpers.ts";

/**
 * Two projects on one repository with work and history, the join's port as the daemon wires it,
 * and every table's row count per project: shared by the SQLite cases (`project-join.test.ts`)
 * and the Postgres case (`project-join.integration.test.ts`, L4-github-121), so both adapters
 * run the same join and its Undo over the same rows.
 */

/** The join's port as the daemon wires it (`joinRefusal` over this store), with seeded waits. */
export function joinPort(w: World, waits: Map<string, string | null> = new Map()): ProjectJoinPort {
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

export const TABLES = [
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
export async function counts(
  store: StateStore,
  projectId: string,
): Promise<Record<string, number>> {
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

export interface Pair {
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
export async function seedPair(w: World): Promise<Pair> {
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

export async function join(w: World, keep: string, close: string[]): Promise<ExecuteResult> {
  return w.executor.execute({
    name: "project.join",
    params: { keep, close },
    ctx: w.ctx({ source: "ui" }),
    confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
  });
}
