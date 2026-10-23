import { ForerunnerError, SimulatedClock } from "@forerunner/platform";
import { Scheduler, type StartRequest } from "@forerunner/runtime";
import {
  type JsonObject,
  openStore,
  type StateStore,
  TASK_STATUSES,
  type TaskRow,
} from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { GitHubHost } from "../src/githost/github.ts";
import { MemoryGitHost } from "../src/githost/memory.ts";
import {
  capBody,
  githubHostForSecretRef,
  HumanRequestMirrorPort,
  isMirrorRequest,
  MIRROR_APPROVE_OPTION,
  MIRROR_AUDIT_TOOL,
  MIRROR_BODY_MAX_CHARS,
  MIRROR_BODY_TRUNCATED_MARKER,
  MIRROR_DENY_OPTION,
  MIRROR_EVENT_TYPE,
  MIRROR_FIELDS,
  MIRROR_FIELDS_VERSION,
  MIRROR_SETTINGS_KEY,
  MIRROR_STATUS_LABELS,
  type MirrorApprovalRequest,
  type MirrorCliCommand,
  type MirrorSettings,
  mirrorAgentId,
  mirrorSettingsOf,
  mirrorStartHandler,
  ownerFromLocator,
  ProjectsMirror,
  registerMirrorCli,
  scheduleMirror,
  taskToItem,
} from "../src/githost/projects-mirror.ts";
import type { GitHost, ProjectItemInput, UpsertItemResult } from "../src/githost/types.ts";
import { FakeProjectsGraphql } from "./helpers/fake-projects-graphql.ts";

interface World {
  clock: SimulatedClock;
  store: StateStore;
  humanId: string;
  agentId: string;
  projectId: string;
  host: MemoryGitHost;
  mirror: ProjectsMirror;
  settings: () => Promise<MirrorSettings | null>;
  addTask: (title: string, extra?: Record<string, unknown>) => Promise<string>;
}

async function world(
  opts: {
    mirrorSettings?: Record<string, unknown> | null;
    host?: GitHost;
    human?: { ask(req: MirrorApprovalRequest): Promise<"approve" | "deny"> };
    batchSize?: number;
    repos?: string[];
    /** false: the only agent is a specialist, so the mirror finds no principal for a run session. */
    principal?: boolean;
  } = {},
): Promise<World> {
  const clock = new SimulatedClock("2026-04-01T08:00:00Z");
  const store = await openStore({ url: "sqlite::memory:", clock });
  const humanId = (
    await store.human.insert({
      name: "J",
      email: "j@example.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 0,
      locale: "en",
    })
  ).id;
  const agentId = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: humanId,
      model_config: {},
      memory_location: "l",
      status: "active",
      kind: opts.principal === false ? "specialist" : "principal",
    })
  ).id;
  const settings =
    opts.mirrorSettings === null
      ? {}
      : { [MIRROR_SETTINGS_KEY]: opts.mirrorSettings ?? { enabled: true, owner: "acme" } };
  const projectId = (
    await store.project.insert({
      name: "Sample",
      goal: "g",
      repos: opts.repos ?? ["acme/sample"],
      settings,
    })
  ).id;
  const host = new MemoryGitHost("alice");
  const mirror = new ProjectsMirror({
    store,
    clock,
    hostFor: () => opts.host ?? host,
    human: opts.human,
    humanId,
    batchSize: opts.batchSize,
  });
  return {
    clock,
    store,
    humanId,
    agentId,
    projectId,
    host,
    mirror,
    settings: async () => mirrorSettingsOf(await store.project.mustGet(projectId)),
    addTask: async (title, extra = {}) =>
      (await store.task.insert({ project_id: projectId, title, status: "ready", ...extra })).id,
  };
}

/** Wait (real time) until the code under test has armed a timer on the simulated clock. */
async function untilTimer(clock: SimulatedClock): Promise<void> {
  while (clock.pendingTimers() === 0) await new Promise((r) => setTimeout(r, 2));
}

async function items(host: MemoryGitHost, w: World) {
  const s = await w.settings();
  return host.listProjectItems(s?.project_id ?? "");
}

/** A task row for the pure mapping tests (no store). */
function taskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "t",
    created_at: "",
    updated_at: "",
    author_agent: null,
    author_human: null,
    version: 1,
    project_id: "p",
    milestone_id: null,
    title: "T",
    outcome: "",
    acceptance_criteria: [],
    status: "ready",
    risk_tier: 2,
    priority: 0,
    claimed_by: null,
    claim_expires: null,
    depends_on: [],
    budget_usd_micro: 0,
    est_cost_usd_micro: 0,
    actual_cost_usd_micro: 1_234_567,
    owner_agent_id: null,
    specialist: null,
    attempt: 0,
    pr_url: null,
    branch: null,
    reason: "",
    ...overrides,
  };
}

describe("ProjectsMirror", () => {
  it("creates the board and fields, mirrors title, status, specialist, cost in CHF, PR and review, and records event and audit rows", async () => {
    const w = await world();
    const t1 = await w.addTask("Write docs", {
      status: "in_review",
      specialist: "writer",
      pr_url: "https://github.example/acme/sample/pull/7",
      outcome: "Docs exist",
      acceptance_criteria: ["README updated"],
    });
    const t2 = await w.addTask("Draft idea", { status: "draft" });
    await w.store.costLedger.record({
      human_id: w.humanId,
      agent_id: w.agentId,
      project_id: w.projectId,
      task_id: t1,
      kind: "api",
      usd_micro: 1_000_000,
      chf_micro: 850_000,
      rate_chf_per_usd: 0.85,
      model: "m",
    });
    await w.store.costLedger.record({
      human_id: w.humanId,
      project_id: w.projectId,
      task_id: t1,
      kind: "api",
      usd_micro: 500_000,
      chf_micro: 425_000,
      rate_chf_per_usd: 0.85,
      model: "m",
    });
    const review = await w.store.review.insert({
      task_id: t1,
      critic_model: "critic",
      verdict: "accept",
      grade: 92,
      tier: 1,
    });

    const r = await w.mirror.sync(w.projectId);
    expect(r).toMatchObject({
      scanned: 2,
      changed: 2,
      created: 2,
      updated: 0,
      archived: 0,
      skipped: 0,
      errors: 0,
      stopped: null,
    });
    expect(r.githubProjectId).toMatch(/^PVT_/);
    expect(r.eventId).toBeTruthy();

    const s = await w.settings();
    expect(s?.project_id).toBe(r.githubProjectId);
    expect(s?.cursor).toEqual({ [t1]: 1, [t2]: 1 });
    expect(s?.fields_version).toBe(MIRROR_FIELDS_VERSION);

    const list = await items(w.host, w);
    const i1 = list.find((i) => i.forerunnerTaskId === t1);
    expect(i1).toMatchObject({
      title: "Write docs",
      archived: false,
      fields: {
        Status: "In Review",
        specialist: "writer",
        cost: "CHF 1.28",
        pr: "https://github.example/acme/sample/pull/7",
        review: `accept 92/100 forerunner://reviews/${review.id}`,
        forerunner_task_id: t1,
      },
    });
    expect(i1?.body).toContain("Docs exist");
    expect(i1?.body).toContain("- README updated");
    expect(i1?.body).toContain("one way");
    const i2 = list.find((i) => i.forerunnerTaskId === t2);
    expect(i2?.fields).toMatchObject({ Status: "Draft", cost: "USD 0.00" });
    expect(i2?.fields.specialist ?? null).toBeNull();
    expect(i2?.fields.pr ?? null).toBeNull();

    // The board got every status as an option, in the task workflow's order.
    const fields = await w.host.ensureFields(r.githubProjectId, []);
    const status = fields.find((f) => f.name === "Status");
    for (const st of TASK_STATUSES)
      expect(status?.options.map((o) => o.name)).toContain(MIRROR_STATUS_LABELS[st]);
    expect(fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(MIRROR_FIELDS.map((f) => f.name)),
    );

    // Event with counts on a session of its own, closed again.
    const session = await w.store.session.mustGet(r.sessionId ?? "");
    expect(session.status).toBe("completed");
    expect(session.summary).toContain("2 created");
    const [ev] = await w.store.event.list(session.id);
    expect(ev?.type).toBe(MIRROR_EVENT_TYPE);
    expect(ev?.payload).toMatchObject({
      created: 2,
      updated: 0,
      skipped: 0,
      project_id: w.projectId,
    });

    // Audit rows for every outward action.
    const audit = await w.store.auditLog.list({ sessionId: session.id });
    expect(audit.map((a) => a.tool)).toEqual([
      "github.projects.ensure_project",
      "github.projects.ensure_fields",
      "github.projects.upsert_item",
      "github.projects.upsert_item",
    ]);
    expect(audit.every((a) => a.allowed && a.agent_id === w.agentId)).toBe(true);
  });

  it("skips unchanged tasks on repeated runs (cursor) and re-mirrors only what changed", async () => {
    const w = await world();
    const t1 = await w.addTask("A");
    const t2 = await w.addTask("B");
    await w.mirror.sync(w.projectId);
    const calls = w.host.projectCalls.length;

    const r2 = await w.mirror.sync(w.projectId);
    expect(r2).toMatchObject({ scanned: 2, changed: 0, created: 0, updated: 0, skipped: 2 });
    expect(w.host.projectCalls.length).toBe(calls); // not one call to the host
    expect(r2.eventId).toBeTruthy(); // but still an event

    const row = await w.store.task.mustGet(t2);
    await w.store.task.update(t2, row.version, { title: "B renamed", specialist: "coder" });
    const r3 = await w.mirror.sync(w.projectId);
    expect(r3).toMatchObject({ changed: 1, updated: 1, created: 0, skipped: 1 });
    const ops = w.host.projectCalls.slice(calls).map((c) => c.op);
    expect(ops).toEqual(["upsertItem", "setItemFields"]);
    expect(w.host.projectCalls.slice(calls)[0]?.detail).toBe(t2);
    const s = await w.settings();
    expect(s?.cursor).toEqual({ [t1]: 1, [t2]: 2 });
    const list = await items(w.host, w);
    expect(list.find((i) => i.forerunnerTaskId === t2)).toMatchObject({
      title: "B renamed",
      fields: { specialist: "coder" },
    });
    expect(list).toHaveLength(2);
  });

  it("archives items of done, cancelled and deleted tasks; a reopened task comes back", async () => {
    const w = await world();
    const done = await w.addTask("Done one", { status: "in_review" });
    const cancelled = await w.addTask("Cancelled one", { status: "draft" });
    const gone = await w.addTask("Gone one");
    await w.mirror.sync(w.projectId);

    let row = await w.store.task.mustGet(done);
    await w.store.task.transition(done, row.version, "done", "accepted");
    row = await w.store.task.mustGet(cancelled);
    await w.store.task.transition(cancelled, row.version, "cancelled", "dropped");
    await w.store.task.delete(gone);

    const r = await w.mirror.sync(w.projectId);
    expect(r).toMatchObject({ scanned: 2, changed: 2, updated: 2, archived: 3, deleted: 1 });
    const list = await items(w.host, w);
    expect(list.find((i) => i.forerunnerTaskId === done)).toMatchObject({
      archived: true,
      fields: { Status: "Done" },
    });
    expect(list.find((i) => i.forerunnerTaskId === cancelled)).toMatchObject({
      archived: true,
      fields: { Status: "Cancelled" },
    });
    expect(list.find((i) => i.forerunnerTaskId === gone)?.archived).toBe(true);
    const s = await w.settings();
    expect(Object.keys(s?.cursor ?? {}).sort()).toEqual([cancelled, done].sort());

    // Reopened (a human sets it back to ready): the item is unarchived with the new status.
    await w.store.task.patch(done, { status: "ready" });
    const r2 = await w.mirror.sync(w.projectId);
    expect(r2).toMatchObject({ changed: 1, updated: 1, archived: 0 });
    expect((await items(w.host, w)).find((i) => i.forerunnerTaskId === done)).toMatchObject({
      archived: false,
      fields: { Status: "Ready" },
    });
    // No second run archives anything again: nothing changed.
    const r3 = await w.mirror.sync(w.projectId);
    expect(r3).toMatchObject({ changed: 0, archived: 0, deleted: 0 });
  });

  it("a full run archives the items of tasks deleted since the last run and drops their ids from the cursor", async () => {
    const w = await world();
    const keep = await w.addTask("Keep");
    const gone = await w.addTask("Gone");
    await w.mirror.sync(w.projectId);
    await w.store.task.delete(gone);

    const r = await w.mirror.sync(w.projectId, { full: true });
    expect(r).toMatchObject({ scanned: 1, changed: 1, updated: 1, deleted: 1, archived: 1 });
    const list = await items(w.host, w);
    expect(list.find((i) => i.forerunnerTaskId === gone)?.archived).toBe(true);
    expect(list.find((i) => i.forerunnerTaskId === keep)?.archived).toBe(false);
    expect((await w.settings())?.cursor).toEqual({ [keep]: 1 });
    expect(w.host.projectCalls.filter((c) => c.op === "archiveItem")).toHaveLength(1);

    // Nothing is left for the next incremental run: no ghost item, no second archive.
    const r2 = await w.mirror.sync(w.projectId);
    expect(r2).toMatchObject({ changed: 0, deleted: 0, archived: 0 });
  });

  it("a full run stopped by a rate limit keeps the ids of deleted tasks until their items are archived", async () => {
    const inner = new MemoryGitHost("alice");
    let limited = false;
    const host: GitHost = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      async upsertItem(projectId: string, item: ProjectItemInput): Promise<UpsertItemResult> {
        if (limited)
          throw new ForerunnerError("provider_rate_limit", "rate limited", {
            retryable: true,
            details: { retryAfterMs: 1_000 },
          });
        return inner.upsertItem(projectId, item);
      },
    });
    const w = await world({ host });
    const keep = await w.addTask("Keep");
    const gone = await w.addTask("Gone");
    await w.mirror.sync(w.projectId);
    await w.store.task.delete(gone);

    limited = true;
    const stopped = await w.mirror.sync(w.projectId, { full: true });
    expect(stopped.stopped).toEqual({ reason: "rate_limit", retryAfterMs: 1_000 });
    expect(stopped).toMatchObject({ updated: 0, deleted: 0, archived: 0 });
    expect((await w.settings())?.cursor).toEqual({ [gone]: 1 }); // remembered, not yet archived

    limited = false;
    const r = await w.mirror.sync(w.projectId);
    expect(r).toMatchObject({ changed: 1, updated: 1, deleted: 1, archived: 1, stopped: null });
    const s = await w.settings();
    expect(s?.cursor).toEqual({ [keep]: 1 });
    const list = await inner.listProjectItems(s?.project_id ?? "");
    expect(list.find((i) => i.forerunnerTaskId === gone)?.archived).toBe(true);
    expect(list).toHaveLength(2);
  });

  it("without a principal agent the run has no session: the counts go to the audit log instead of an event", async () => {
    const w = await world({ principal: false });
    await w.addTask("x");
    const r = await w.mirror.sync(w.projectId);
    expect(r).toMatchObject({ created: 1, sessionId: null, eventId: null });
    expect(await w.store.session.forProject(w.projectId)).toHaveLength(0);
    const rows = await w.store.auditLog.list({ tool: MIRROR_AUDIT_TOOL });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ allowed: true, session_id: null });
    expect(rows[0]?.input_summary).toContain(w.projectId);
    expect(rows[0]?.result_summary).toContain("1 created");
    expect(rows[0]?.result_summary).toContain("0 unchanged");

    // With a session the counts are an event, not an audit row.
    const full = await world();
    await full.addTask("y");
    const r2 = await full.mirror.sync(full.projectId);
    expect(r2.eventId).toBeTruthy();
    expect(await full.store.auditLog.list({ tool: MIRROR_AUDIT_TOOL })).toHaveLength(0);
  });

  it("is one way: an edit on the GitHub side never alters the store, and a full run re-asserts the store", async () => {
    const w = await world();
    const t1 = await w.addTask("Truth", { status: "ready", specialist: "coder" });
    await w.mirror.sync(w.projectId);
    const before = await w.store.task.mustGet(t1);
    const s = await w.settings();
    const item = (await items(w.host, w))[0];
    w.host.tamperItem(s?.project_id ?? "", item?.id ?? "", {
      title: "Edited on GitHub",
      fields: { Status: "Done", specialist: "someone" },
      archived: true,
    });

    const r = await w.mirror.sync(w.projectId);
    expect(r).toMatchObject({ changed: 0, skipped: 1 });
    const after = await w.store.task.mustGet(t1);
    expect(after).toEqual(before); // same version, same title, same status
    expect((await items(w.host, w))[0]?.title).toBe("Edited on GitHub"); // untouched: not our change

    const full = await w.mirror.sync(w.projectId, { full: true });
    expect(full).toMatchObject({ changed: 1, updated: 1 });
    expect((await items(w.host, w))[0]).toMatchObject({
      title: "Truth",
      archived: false,
      fields: { Status: "Ready", specialist: "coder" },
    });
    expect(await w.store.task.mustGet(t1)).toEqual(before);
    expect(await w.store.task.count()).toBe(1);
  });

  it("stops cleanly on a rate limit the host could not wait out, keeps the batch cursor and continues next run", async () => {
    const inner = new MemoryGitHost("alice");
    let upserts = 0;
    const limited: GitHost = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      async upsertItem(projectId: string, item: ProjectItemInput): Promise<UpsertItemResult> {
        upserts++;
        if (upserts === 3)
          throw new ForerunnerError("provider_rate_limit", "rate limited", {
            retryable: true,
            details: { retryAfterMs: 90_000 },
          });
        return inner.upsertItem(projectId, item);
      },
    });
    const w = await world({ host: limited, batchSize: 2 });
    const ids: string[] = [];
    for (const n of ["a", "b", "c", "d", "e"]) ids.push(await w.addTask(n));

    const r = await w.mirror.sync(w.projectId);
    expect(r.stopped).toEqual({ reason: "rate_limit", retryAfterMs: 90_000 });
    expect(r).toMatchObject({ created: 2, errors: 0 });
    const s = await w.settings();
    expect(Object.keys(s?.cursor ?? {}).sort()).toEqual([ids[0], ids[1]].sort());
    const session = await w.store.session.mustGet(r.sessionId ?? "");
    expect(session.status).toBe("completed");
    expect(session.summary).toContain("stopped: rate limit");
    const [ev] = await w.store.event.list(session.id);
    expect(ev?.payload).toMatchObject({ stopped: { reason: "rate_limit" }, created: 2 });

    const r2 = await w.mirror.sync(w.projectId);
    expect(r2).toMatchObject({ changed: 3, created: 3, skipped: 2, stopped: null });
    const list = await inner.listProjectItems(s?.project_id ?? "");
    expect(list).toHaveLength(5); // no duplicates
    expect(upserts).toBe(6);
  });

  it("refuses to run unless the mirror is enabled, and derives the owner from the repository", async () => {
    const off = await world({ mirrorSettings: null });
    await expect(off.mirror.sync(off.projectId)).rejects.toMatchObject({
      code: "tool_not_allowed",
    });
    expect(off.host.projectCalls).toHaveLength(0);
    const disabled = await world({ mirrorSettings: { enabled: false, owner: "acme" } });
    await expect(disabled.mirror.sync(disabled.projectId)).rejects.toMatchObject({
      code: "tool_not_allowed",
    });

    const derived = await world({
      mirrorSettings: { enabled: true, title: "Sample board" },
      repos: ["https://github.example/octo-org/sample.git"],
    });
    await derived.addTask("x");
    await derived.mirror.sync(derived.projectId);
    expect(derived.host.projectCalls[0]).toEqual({
      op: "ensureProject",
      detail: "octo-org:Sample board",
    });
    expect(ownerFromLocator("git@github.example:octo/repo.git")).toBe("octo");
    expect(ownerFromLocator("octo/repo")).toBe("octo");
    expect(ownerFromLocator("/local/folder")).toBeNull();
    expect(ownerFromLocator("")).toBeNull();

    const noOwner = await world({ mirrorSettings: { enabled: true }, repos: [] });
    await expect(noOwner.mirror.sync(noOwner.projectId)).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("asks the human port once before creating the board; a denial creates nothing", async () => {
    const asked: MirrorApprovalRequest[] = [];
    let answer: "approve" | "deny" = "deny";
    const human = {
      async ask(req: MirrorApprovalRequest) {
        asked.push(req);
        return answer;
      },
    };
    const w = await world({ human });
    await w.addTask("x");
    await expect(w.mirror.sync(w.projectId)).rejects.toMatchObject({ code: "approval_required" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      owner: "acme",
      title: "Sample",
      humanId: w.humanId,
      options: [MIRROR_APPROVE_OPTION, MIRROR_DENY_OPTION],
    });
    expect(w.host.projectCalls).toHaveLength(0);
    expect((await w.settings())?.approved).toBe(false);
    const denied = await w.store.auditLog.list({ tool: "github.projects.ensure_project" });
    expect(denied[0]).toMatchObject({ allowed: false });

    answer = "approve";
    const r = await w.mirror.sync(w.projectId);
    expect(r.created).toBe(1);
    expect((await w.settings())?.approved).toBe(true);
    await w.addTask("y");
    await w.mirror.sync(w.projectId);
    expect(asked).toHaveLength(2); // deny + approve; never asked again once approved
  });

  it("HumanRequestMirrorPort files a request and reads the answer back through the store", async () => {
    const w = await world();
    const port = new HumanRequestMirrorPort(w.store, w.clock, { pollMs: 1_000, timeoutMs: 10_000 });
    const req: MirrorApprovalRequest = {
      projectId: w.projectId,
      projectName: "Sample",
      humanId: w.humanId,
      owner: "acme",
      title: "Sample",
      why: "visibility",
      options: [MIRROR_APPROVE_OPTION, MIRROR_DENY_OPTION],
    };
    const pending = port.ask(req);
    await untilTimer(w.clock);
    await w.clock.advance(1_500);
    const [open] = await w.store.humanRequest.open({ projectId: w.projectId });
    expect(open).toMatchObject({ kind: "approval", human_id: w.humanId, options: req.options });
    await w.store.humanRequest.answer(
      open?.id ?? "",
      open?.version ?? 0,
      MIRROR_APPROVE_OPTION,
      w.humanId,
    );
    await w.clock.advance(1_500);
    expect(await pending).toBe("approve");

    const timeout = port.ask(req);
    await untilTimer(w.clock);
    await w.clock.advance(11_000);
    expect(await timeout).toBe("deny");
    expect(await w.store.humanRequest.open({ projectId: w.projectId })).toHaveLength(0);
  });

  it("scheduleMirror runs through the session scheduler and the start handler routes other requests on", async () => {
    const w = await world();
    await w.addTask("x");
    const synced: string[] = [];
    const others: StartRequest[] = [];
    const scheduler = new Scheduler(
      {
        clock: w.clock,
        start: mirrorStartHandler(
          {
            sync: async (projectId, opts) => {
              synced.push(`${projectId}:${opts?.trigger}`);
              return w.mirror.sync(projectId, opts);
            },
          },
          async (req) => {
            others.push(req);
          },
        ),
      },
      1_000,
    );
    const handle = scheduleMirror(scheduler, { projectId: w.projectId, everyMinutes: 5 });
    expect(handle.agentId).toBe(mirrorAgentId(w.projectId));
    expect(
      isMirrorRequest({
        agentId: handle.agentId,
        projectId: w.projectId,
        trigger: "schedule",
        reason: "",
      }),
    ).toBe(true);
    expect(
      isMirrorRequest({
        agentId: w.agentId,
        projectId: w.projectId,
        trigger: "schedule",
        reason: "",
      }),
    ).toBe(false);

    await scheduler.tick();
    await w.clock.advance(10);
    expect(synced).toEqual([`${w.projectId}:schedule`]);
    await scheduler.tick(w.clock.now() + 60_000);
    expect(synced).toHaveLength(1); // not due yet
    await scheduler.tick(w.clock.now() + 5 * 60_000 + 1);
    await w.clock.advance(10);
    expect(synced).toHaveLength(2);
    expect((await items(w.host, w)).length).toBe(1);

    await scheduler.request({ agentId: w.agentId, trigger: "manual", reason: "human" });
    await w.clock.advance(10);
    expect(others).toHaveLength(1);
    handle.remove();
    expect(scheduler.list()).toHaveLength(0);
  });

  it("registerMirrorCli adds fr mirror sync / enable / disable", async () => {
    const w = await world({ mirrorSettings: null });
    await w.addTask("x");
    const actions = new Map<string, (opts: Record<string, unknown>) => void | Promise<void>>();
    const options = new Map<string, string[]>();
    const fakeCommand = (path: string): MirrorCliCommand => ({
      command: (name) => fakeCommand(`${path} ${name}`.trim()),
      description: () => fakeCommand(path),
      option: (flags) => {
        options.set(path, [...(options.get(path) ?? []), flags]);
        return fakeCommand(path);
      },
      action: (fn) => {
        actions.set(path, fn);
        return fakeCommand(path);
      },
    });
    const out: string[] = [];
    registerMirrorCli(fakeCommand(""), {
      open: async () => ({ store: w.store, mirror: w.mirror }),
      out: (l) => out.push(l),
    });
    expect([...actions.keys()]).toEqual(["mirror sync", "mirror enable", "mirror disable"]);
    expect(options.get("mirror sync")).toEqual(["--project <name-or-id>", "--all", "--full"]);

    await expect(actions.get("mirror sync")?.({ project: "Sample" })).rejects.toMatchObject({
      code: "tool_not_allowed",
    });
    await actions.get("mirror enable")?.({ project: "Sample", owner: "acme", title: "Board" });
    expect(await w.settings()).toMatchObject({ enabled: true, owner: "acme", title: "Board" });
    await actions.get("mirror sync")?.({ project: "Sample" });
    expect(out.at(-1)).toMatch(
      /^Sample: 1 created, 0 updated, 0 archived, 0 unchanged -> memory:\/\//,
    );
    await actions.get("mirror sync")?.({ all: true });
    expect(out.at(-1)).toContain("1 unchanged");
    await actions.get("mirror disable")?.({ project: "Sample" });
    expect(await w.settings()).toBeNull();
    await expect(actions.get("mirror sync")?.({ project: "nope" })).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("builds the GitHub host from a vault reference; the value goes only into the header", async () => {
    const token = ["ghp_", "A".repeat(36)].join(""); // not-a-secret
    const vault = new MemoryVault({ github_token: token });
    const seen: { url: string; auth: string | null }[] = [];
    const names: string[] = [];
    const host = await githubHostForSecretRef({
      vault,
      audit: (n) => names.push(n),
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(url),
          auth: String((init?.headers as Record<string, string>)?.Authorization ?? null),
        });
        return new Response(JSON.stringify({ login: "alice" }), { status: 200 });
      }) as typeof fetch,
    });
    expect(host).toBeInstanceOf(GitHubHost);
    expect(names).toEqual(["github_token"]);
    await host.whoAmI();
    expect(seen[0]?.auth).toBe(`Bearer ${token}`);
    await expect(githubHostForSecretRef({ vault, ref: "secret:missing" })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(githubHostForSecretRef({ vault, ref: "github_token" })).rejects.toMatchObject({
      code: "validation",
    });
  });

  it("taskToItem maps every status to a label and falls back to USD when the ledger has no CHF", () => {
    for (const status of TASK_STATUSES) {
      const item = taskToItem(taskRow({ status }), {
        costChfMicro: null,
        costUsdMicro: 1_234_567,
        review: null,
        reviewLink: null,
        milestone: null,
      });
      expect(item.fields?.Status).toBe(MIRROR_STATUS_LABELS[status]);
      expect(item.fields?.cost).toBe("USD 1.23");
      expect(item.fields?.review).toBeNull();
      expect(item.fields?.milestone).toBeNull();
      expect(item.forerunnerTaskId).toBe("t");
    }
    expect(new Set(Object.values(MIRROR_STATUS_LABELS)).size).toBe(TASK_STATUSES.length);
  });

  it("caps a draft body at the host's limit and says where it was cut", () => {
    const extras = {
      costChfMicro: null,
      costUsdMicro: 0,
      review: null,
      reviewLink: null,
      milestone: "M1",
    };
    const short = taskToItem(taskRow({ acceptance_criteria: ["one"] }), extras);
    expect(short.body?.length).toBeLessThan(MIRROR_BODY_MAX_CHARS);
    expect(short.body).not.toContain(MIRROR_BODY_TRUNCATED_MARKER);
    expect(short.body).toContain("**Milestone:** M1");
    expect(short.fields?.milestone).toBe("M1");

    const criteria = Array.from({ length: 2_000 }, (_, i) => `criterion ${i} ${"x".repeat(60)}`);
    const long = taskToItem(taskRow({ acceptance_criteria: criteria }), extras);
    expect(long.body?.length).toBe(MIRROR_BODY_MAX_CHARS);
    expect(long.body?.endsWith(MIRROR_BODY_TRUNCATED_MARKER)).toBe(true);
    expect(long.body?.startsWith("Mirrored from Forerunner task")).toBe(true);
    expect(capBody("tiny")).toBe("tiny");
    expect(capBody("y".repeat(MIRROR_BODY_MAX_CHARS))).toHaveLength(MIRROR_BODY_MAX_CHARS);
    expect(capBody("y".repeat(MIRROR_BODY_MAX_CHARS + 1))).toHaveLength(MIRROR_BODY_MAX_CHARS);
  });

  it("mirrors the milestone name from the store and re-ensures the fields of a board set up by an older field set", async () => {
    const w = await world();
    const ms = await w.store.milestone.insert({ project_id: w.projectId, name: "Launch" });
    const t1 = await w.addTask("With milestone", { milestone_id: ms.id });
    const t2 = await w.addTask("Without milestone");
    await w.mirror.sync(w.projectId);
    const list = await items(w.host, w);
    expect(list.find((i) => i.forerunnerTaskId === t1)).toMatchObject({
      fields: { milestone: "Launch" },
    });
    expect(list.find((i) => i.forerunnerTaskId === t1)?.body).toContain("**Milestone:** Launch");
    expect(list.find((i) => i.forerunnerTaskId === t2)?.fields.milestone ?? null).toBeNull();
    const fields = await w.host.ensureFields((await w.settings())?.project_id ?? "", []);
    expect(fields.find((f) => f.name === "milestone")?.kind).toBe("text");

    // A milestone edit does not bump the task's version: the cursor hides it until the task
    // changes or a full run re-asserts the board (documented; the board is informational).
    await w.store.milestone.change(
      ms.id,
      ms.version,
      { name: "Launch v2" },
      "renamed for the board",
      {
        agentId: w.agentId,
      },
    );
    const quiet = await w.mirror.sync(w.projectId);
    expect(quiet).toMatchObject({ changed: 0, skipped: 2 });
    const full = await w.mirror.sync(w.projectId, { full: true });
    expect(full).toMatchObject({ changed: 2, updated: 2 });
    expect((await items(w.host, w)).find((i) => i.forerunnerTaskId === t1)?.fields.milestone).toBe(
      "Launch v2",
    );

    // Settings written by an older build (fields_version behind): the next run ensures the
    // fields again on the same board, once, and records the current version.
    const p = await w.store.project.mustGet(w.projectId);
    const existing = p.settings[MIRROR_SETTINGS_KEY] as JsonObject;
    await w.store.project.update(p.id, p.version, {
      settings: {
        ...p.settings,
        [MIRROR_SETTINGS_KEY]: { ...existing, fields_version: MIRROR_FIELDS_VERSION - 1 },
      },
    });
    const before = w.host.projectCalls.length;
    await w.mirror.sync(w.projectId);
    expect(w.host.projectCalls.slice(before).map((c) => c.op)).toEqual(["ensureFields"]);
    expect((await w.settings())?.fields_version).toBe(MIRROR_FIELDS_VERSION);
    const again = w.host.projectCalls.length;
    await w.mirror.sync(w.projectId);
    expect(w.host.projectCalls.length).toBe(again);
  });

  it("computes the retry delay of a resetAt rate limit on the injected clock, not the wall clock", async () => {
    const inner = new MemoryGitHost("alice");
    let resetAt = "";
    const limited: GitHost = Object.assign(Object.create(Object.getPrototypeOf(inner)), inner, {
      async upsertItem(): Promise<UpsertItemResult> {
        throw new ForerunnerError("provider_rate_limit", "rate limited", {
          retryable: true,
          details: { resetAt },
        });
      },
    });
    const w = await world({ host: limited });
    // The simulated clock sits in April 2026; a wall-clock subtraction would give 0 here.
    resetAt = new Date(w.clock.now() + 90_000).toISOString();
    await w.addTask("a");
    const r = await w.mirror.sync(w.projectId);
    expect(r.stopped).toEqual({ reason: "rate_limit", retryAfterMs: 90_000 });
    expect(r).toMatchObject({ created: 0, updated: 0, errors: 0 });
    expect((await w.settings())?.cursor).toEqual({});
  });

  it("end to end over GraphQL: the mirror drives the GitHub adapter with the expected operations", async () => {
    const fake = new FakeProjectsGraphql({ owners: ["acme"] });
    await fake.start();
    try {
      const clock = new SimulatedClock("2026-04-01T08:00:00Z");
      const gh = new GitHubHost({ token: "tok", baseUrl: fake.url, clock });
      const w = await world({ host: gh });
      const t1 = await w.addTask("Ship it", { status: "in_progress", specialist: "coder" });
      const r = await w.mirror.sync(w.projectId);
      expect(r).toMatchObject({ created: 1, errors: 0 });
      const ops = fake.ops();
      expect(ops.slice(0, 2)).toEqual(["MirrorOwnerProjects", "MirrorCreateProject"]);
      expect(ops).toContain("MirrorCreateField");
      expect(ops).toContain("MirrorUpdateFieldOptions");
      expect(ops.slice(-3)).toEqual(["MirrorItems", "MirrorAddDraft", "MirrorSetFields"]);
      const project = fake.projects.get(r.githubProjectId);
      expect(project?.items).toHaveLength(1);
      const listed = await new GitHubHost({ token: "tok", baseUrl: fake.url }).listProjectItems(
        r.githubProjectId,
      );
      expect(listed[0]).toMatchObject({
        forerunnerTaskId: t1,
        title: "Ship it",
        fields: { Status: "In Progress", specialist: "coder", forerunner_task_id: t1 },
      });
      const n = fake.requests.length;
      const r2 = await w.mirror.sync(w.projectId);
      expect(r2).toMatchObject({ skipped: 1, changed: 0 });
      expect(fake.requests.length).toBe(n);
    } finally {
      await fake.stop();
    }
  });
});
