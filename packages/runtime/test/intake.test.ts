import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GitOps, MemoryGitHost } from "@forerunner/capabilities";
import { appDirs, join, run, SimulatedClock } from "@forerunner/platform";
import type { JsonObject } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { INTAKE_RUN_SPECIALIST } from "../src/models/ladder.ts";
import {
  INTAKE_AUDIT_TOOL,
  INTAKE_BUILTIN_PROMPT_VERSION,
  IntakeService,
  intakeKey,
  parseIntakeReply,
} from "../src/session/intake.ts";
import { ScriptedProvider, type ScriptReply } from "./helpers.ts";

/**
 * PM intake (spec A.2): the brief becomes the doc set, the milestones, the tasks and a
 * first-session plan through one model call on the planning rung; the proposal is one
 * blocking approval request and nothing is written until the human approves it.
 */

const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

/** A proposal in the shape the model is asked for; two phases, a dependency, seven docs. */
function proposal(over: Partial<Record<"plan" | "docs" | "firstSession", unknown>> = {}) {
  const base = {
    plan: {
      reason: "planned from the brief",
      milestones: [
        {
          name: "Foundations",
          successCriteria: ["CI is green on main"],
          targetDate: "2026-04-01",
          tasks: [
            {
              key: "scaffold",
              title: "Scaffold the repository",
              outcome: "A runnable skeleton with tests",
              acceptanceCriteria: ["pnpm test passes"],
              priority: 8,
              specialist: "coder",
            },
            {
              key: "ci",
              title: "Set up continuous integration",
              outcome: "Every push runs the tests",
              acceptanceCriteria: ["the workflow is green"],
              dependsOn: ["scaffold"],
              priority: 6,
            },
          ],
        },
        {
          name: "First feature",
          successCriteria: ["A user can sign in"],
          targetDate: null,
          tasks: [
            {
              key: "signin",
              title: "Sign-in flow",
              outcome: "Sign in with email and password",
              acceptanceCriteria: ["the e2e test signs in"],
              dependsOn: ["scaffold"],
              priority: 5,
              riskTier: 2,
            },
          ],
        },
      ],
      tasks: [],
    },
    docs: {
      "README.md": "# Gamma\n\nShip the thing.\n\n## Run\n\npnpm dev\n",
      "docs/overview.md": "# Overview\n\n## Goal\n\nShip the thing to the first ten users.\n",
      "docs/architecture.md": "# Architecture\n\nOne service, one database.\n",
      "docs/status.md": "# Status\n\n## Next\n\n- scaffold\n",
      "docs/runbook.md": "# Runbook\n\n## Start and stop\n\npnpm start\n",
      "docs/data.md": "# Data\n\nOne SQLite file.\n",
      "docs/decisions/0001-stack.md":
        "# 0001 — Stack\n\nDate: 2026-03-05\nStatus: accepted\n\n## Context\n\nSmall team.\n",
    },
    firstSession: {
      summary: "Scaffold first, then wire CI; sign-in waits for the skeleton.",
      items: [
        { key: "scaffold", estimateUsdMicro: 400_000, rationale: "everything depends on it" },
        { key: "ci", estimateUsdMicro: 250_000 },
      ],
    },
  };
  return { ...base, ...over } as typeof base;
}

describe("PM intake (A.2): the brief becomes docs, milestones, tasks and a first-session plan, shown for approval", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home = "";
  let bare = "";
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");
  /** One reply per model call, pushed right before the call that consumes it. */
  const replies: ScriptReply[] = [];
  const provider = new ScriptedProvider(replies, clock);
  const host = new MemoryGitHost("alice");
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  /** The creation-time scaffold (spec G.5) wrote the placeholder; the intake drafted nothing. */
  const expectNotDrafted = (projectId: string) => {
    const readme = join(rt.intake.workspaceDir(projectId), "README.md");
    expect(existsSync(readme)).toBe(true);
    const text = readFileSync(readme, "utf8");
    expect(text).toContain("maintained-by: forerunner");
    expect(text).not.toContain("Ship the thing.");
  };
  const createProject = async (body: Json): Promise<string> => {
    const res = await req("/projects", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    return String((await json(res)).id);
  };
  const answer = async (requestId: string, value: string) => {
    const row = await rt.store.humanRequest.mustGet(requestId);
    const res = await req(`/requests/${requestId}/answer`, {
      method: "POST",
      body: JSON.stringify({ version: row.version, answer: value }),
    });
    expect(res.status).toBe(200);
  };
  const card = async (requestId: string): Promise<JsonObject> =>
    ((await rt.store.humanRequest.mustGet(requestId)).change_card ?? {}) as JsonObject;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-intake-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    // A bare repository as the clone URL of the host's "o/sample" (the repository path).
    bare = join(home, "sample.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({
      cwd: join(home, "seed"),
      identity: { name: "Seed", email: "seed@example.test" },
    });
    await seed.clone(bare);
    writeFileSync(join(home, "seed", "README.md"), "# sample (kept)\n");
    await seed.commitAll("seed");
    await seed.push("main");
    await host.createRepo({ owner: "o", name: "sample", private: true, cloneUrl: bare });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      gitHost: host,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  describe("a project without a repository", () => {
    let projectId = "";
    let requestId = "";

    it("files one blocking approval with the whole proposal and writes nothing before the answer", async () => {
      projectId = await createProject({
        name: "Gamma",
        goal: "Ship the thing",
        brief: "Build a small web app for ten users. Sign-in first, then a dashboard.",
      });
      replies.push({ text: `\`\`\`json\n${JSON.stringify(proposal())}\n\`\`\`` });
      const callsBefore = provider.calls.length;
      const res = await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" });
      expect(res.status).toBe(202);
      const view = await json(res);
      expect(view).toMatchObject({
        pending: true,
        projectId,
        reused: false,
        summary: { milestones: 2, tasks: 3, docs: 7, firstSessionTasks: 2 },
      });
      requestId = String(view.requestId);
      expect(provider.calls.length).toBe(callsBefore + 1);
      // The one model call: the planning rung at high effort, the brief as data in the prompt.
      const call = provider.calls.at(-1);
      expect(call?.model).toBe("fake-sonnet");
      expect(call?.effort).toBe("high");
      expect(JSON.stringify(call?.messages)).toContain("Sign-in first, then a dashboard.");
      expect(call?.tools ?? []).toHaveLength(0);

      const row = await rt.store.humanRequest.mustGet(requestId);
      expect(row).toMatchObject({
        kind: "approval",
        blocking: true,
        status: "open",
        human_id: rt.human.id,
        project_id: projectId,
        author_agent: rt.agent.id,
        options: ["approve", "reject"],
      });
      const c = row.change_card as JsonObject;
      expect(c.key).toBe(intakeKey(projectId));
      expect(c.applied_at).toBeNull();
      const prop = c.proposal as { plan: { milestones: unknown[] }; docs: JsonObject };
      expect(prop.plan.milestones).toHaveLength(2);
      expect(Object.keys(prop.docs)).toContain("docs/decisions/0001-stack.md");
      expect(row.why).toContain("2 milestone(s)");
      expect(row.steps.some((s) => s.startsWith("Milestone: Foundations"))).toBe(true);

      // Nothing is written until the human approves: no rows, no docs, no plan on the project.
      expect(await rt.store.milestone.forProject(projectId)).toHaveLength(0);
      expect(await rt.store.task.list({ project_id: projectId } as never)).toHaveLength(0);
      const queued = await rt.store.queue.pending(projectId);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.text).toContain("Project brief:");
      expectNotDrafted(projectId);
      const project = await rt.store.project.mustGet(projectId);
      expect(project.summary_cache).not.toHaveProperty("first_session");
      // The call is billed to the project through an intake session and audited.
      const spend = await rt.store.costLedger.sum({ projectId });
      expect(spend.usd_micro).toBeGreaterThan(0);
      const session = await rt.store.session.mustGet(String(c.session_id));
      expect(session).toMatchObject({ project_id: projectId, status: "completed" });
      expect(session.summary).toContain("intake");
      // Spec D.19: the call has a Run row with its timing, which the Performance view reads
      // as the planning mode (performance-view.test.ts).
      const runRow = await rt.store.run.mustGet(String(c.run_id));
      expect(runRow).toMatchObject({
        session_id: session.id,
        task_id: null,
        specialist: INTAKE_RUN_SPECIALIST,
        model: "fake-sonnet",
        effort: "high",
        outcome: "completed",
        author_agent: rt.agent.id,
      });
      expect(runRow.ttft_ms).not.toBeNull();
      expect(runRow.duration_ms).not.toBeNull();
      expect(runRow.cost_usd_micro).toBe(spend.usd_micro);
      // Spec D.5: the row stores the registry PM prompt's version, as every run does.
      const pm = rt.registry.principals.get("project-manager");
      expect(pm?.promptVersion).toMatch(/^project-manager@/);
      expect(runRow.prompt_version).toBe(pm?.promptVersion);
      const audit = await rt.store.auditLog.list({ tool: INTAKE_AUDIT_TOOL });
      expect(audit.some((a) => a.input_summary.includes(requestId))).toBe(true);
      // The status route reports the open proposal.
      const status = await json(await req(`/projects/${projectId}/intake`));
      expect(status).toMatchObject({ projectId, state: "pending", requestId });
    });

    it("a second trigger while the proposal is open reuses it without another model call", async () => {
      const callsBefore = provider.calls.length;
      const res = await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" });
      expect(res.status).toBe(202);
      expect(await json(res)).toMatchObject({ pending: true, requestId, reused: true });
      expect(provider.calls.length).toBe(callsBefore);
    });

    it("the approving answer writes the rows, the docs and the first-session plan, once", async () => {
      await answer(requestId, "approve");
      const milestones = await rt.store.milestone.forProject(projectId);
      expect(milestones.map((m) => m.name)).toEqual(["Foundations", "First feature"]);
      const tasks = await rt.store.task.list({ project_id: projectId } as never);
      expect(tasks).toHaveLength(3);
      const byTitle = new Map(tasks.map((t) => [t.title, t]));
      const scaffold = byTitle.get("Scaffold the repository");
      const ci = byTitle.get("Set up continuous integration");
      expect(ci?.depends_on).toEqual([scaffold?.id]);
      expect(ci?.milestone_id).toBe(milestones[0]?.id);
      expect(byTitle.get("Sign-in flow")).toMatchObject({ risk_tier: 2, status: "ready" });
      expect(scaffold).toMatchObject({
        risk_tier: 1,
        specialist: "coder",
        author_human: rt.human.id,
        author_agent: rt.agent.id,
        reason: "planned from the brief",
        est_cost_usd_micro: 400_000,
      });
      // The docs: the drafted ones as drafted, the two the model left out from the templates.
      const dir = rt.intake.workspaceDir(projectId);
      expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("Ship the thing.");
      expect(readFileSync(join(dir, "docs", "decisions", "0001-stack.md"), "utf8")).toContain(
        "0001 — Stack",
      );
      expect(readFileSync(join(dir, "docs", "testing.md"), "utf8")).toContain(
        "maintained-by: forerunner",
      );
      expect(existsSync(join(dir, "docs", "decisions", "README.md"))).toBe(true);
      // The first-session plan: on the summary cache with task ids, and queued for the planner.
      const project = await rt.store.project.mustGet(projectId);
      const first = (project.summary_cache as { first_session?: JsonObject }).first_session;
      expect(first).toMatchObject({
        request_id: requestId,
        estimate_usd_micro: 650_000,
        summary: "Scaffold first, then wire CI; sign-in waits for the skeleton.",
      });
      expect(first?.items).toEqual([
        expect.objectContaining({ task_id: scaffold?.id, estimate_usd_micro: 400_000 }),
        expect.objectContaining({ task_id: ci?.id, estimate_usd_micro: 250_000 }),
      ]);
      expect((project.summary_cache as { next_steps?: string[] }).next_steps).toEqual([
        "Scaffold the repository",
        "Set up continuous integration",
      ]);
      const queued = await rt.store.queue.pending(projectId);
      const planNote = queued.find((q) => q.text.startsWith("First-session plan"));
      expect(planNote).toMatchObject({ kind: "task", priority: 9, author_agent: rt.agent.id });
      expect(planNote?.text).toContain("1. Scaffold the repository");
      // Applied once: the card says so, and a second sync writes nothing more.
      const c = await card(requestId);
      expect(c.outcome).toBe("approved");
      expect(typeof c.applied_at).toBe("string");
      expect((c.docs as JsonObject).target).toBe("workspace");
      // The two docs the model left out were already scaffolded at creation (spec G.5), so
      // the intake scaffolds nothing and leaves those placeholders as they are.
      expect((c.docs as JsonObject).scaffolded).toEqual([]);
      expect(readFileSync(join(dir, "docs", "testing.md"), "utf8")).toContain(
        "maintained-by: forerunner",
      );
      const again = await rt.syncApprovals();
      expect(again.intake).toEqual({ applied: 0, rejected: 0, skipped: 0 });
      expect(await rt.store.task.list({ project_id: projectId } as never)).toHaveLength(3);
      expect(await rt.store.milestone.forProject(projectId)).toHaveLength(2);
      const status = await json(await req(`/projects/${projectId}/intake`));
      expect(status).toMatchObject({ state: "approved", requestId });
      const summary = await json(await req(`/projects/${projectId}/summary`));
      expect(summary.nextSteps).toEqual([
        "Scaffold the repository",
        "Set up continuous integration",
      ]);
    });
  });

  it("a rejecting answer writes nothing and leaves a note for the next session", async () => {
    const projectId = await createProject({
      name: "Delta",
      goal: "Try an idea",
      brief: "A throwaway prototype.",
    });
    replies.push({ text: JSON.stringify(proposal()) });
    const res = await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" });
    const requestId = String((await json(res)).requestId);
    await answer(requestId, "reject");
    expect(await rt.store.task.list({ project_id: projectId } as never)).toHaveLength(0);
    expect(await rt.store.milestone.forProject(projectId)).toHaveLength(0);
    expectNotDrafted(projectId);
    const c = await card(requestId);
    expect(c.outcome).toBe("rejected");
    expect(typeof c.applied_at).toBe("string");
    const queued = await rt.store.queue.pending(projectId);
    const note = queued.find((q) => q.text.includes("rejected"));
    expect(note).toMatchObject({ kind: "note", author_agent: rt.agent.id });
    expect(note?.text).toContain(requestId);
    const status = await json(await req(`/projects/${projectId}/intake`));
    expect(status).toMatchObject({ state: "rejected", requestId });
  });

  it("malformed model output is refused with validation and no request is filed", async () => {
    const projectId = await createProject({
      name: "Epsilon",
      goal: "Something",
      brief: "A brief.",
    });
    const attempt = async (reply: string) => {
      replies.push({ text: reply });
      const res = await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" });
      expect(res.status).toBe(409);
      const body = await json(res);
      expect(body).toMatchObject({ code: "conflict", details: { cause: "validation" } });
      return String(body.message);
    };
    expect(await attempt("Sure! Here is a plan: first scaffold, then CI.")).toContain("JSON");
    // Valid JSON, wrong shape: a doc outside the standard set and a task without an outcome.
    const badDocs = proposal({ docs: { "src/secrets.txt": "x" } });
    expect(await attempt(JSON.stringify(badDocs))).toContain("docs");
    const missing = proposal();
    (missing.plan.milestones[0]?.tasks[0] as { outcome?: string }).outcome = undefined;
    expect(await attempt(JSON.stringify(missing))).toContain("outcome");
    // A first-session item that names no plan task, and a dependency on an unknown key.
    const badFirst = proposal({
      firstSession: { summary: "s", items: [{ key: "ghost", estimateUsdMicro: 1 }] },
    });
    expect(await attempt(JSON.stringify(badFirst))).toContain("ghost");
    const badDep = proposal();
    (badDep.plan.milestones[1]?.tasks[0] as { dependsOn?: string[] }).dependsOn = ["task_123"];
    expect(await attempt(JSON.stringify(badDep))).toContain("task_123");
    expect(
      (await rt.store.humanRequest.open({ humanId: rt.human.id })).filter(
        (r) => r.project_id === projectId,
      ),
    ).toHaveLength(0);
    expect(await rt.store.task.list({ project_id: projectId } as never)).toHaveLength(0);
    // The failed calls were still billed and their sessions closed as failed, never left running.
    const sessions = await rt.store.session.forProject(projectId);
    expect(sessions.length).toBeGreaterThanOrEqual(5);
    expect(sessions.every((s) => s.status === "failed")).toBe(true);
    expect(await rt.store.session.active(rt.agent.id)).toHaveLength(0);
  });

  it("parseIntakeReply takes bare JSON and a fenced block, and refuses the rest", () => {
    const p = proposal();
    expect(parseIntakeReply(JSON.stringify(p)).plan.milestones).toHaveLength(2);
    expect(parseIntakeReply(`Here you go:\n\`\`\`json\n${JSON.stringify(p)}\n\`\`\``).docs).toEqual(
      p.docs,
    );
    expect(() => parseIntakeReply("[1, 2]")).toThrow(/JSON object/);
    expect(() => parseIntakeReply(JSON.stringify({ ...p, extra: 1 }))).toThrow(/extra/);
    expect(() => parseIntakeReply(JSON.stringify({ ...p, plan: { milestones: [] } }))).toThrow(
      /no milestone/,
    );
  });

  it("another human's answer is refused and nothing is written", async () => {
    const projectId = await createProject({
      name: "Zeta",
      goal: "Shared",
      brief: "A shared project brief.",
    });
    replies.push({ text: JSON.stringify(proposal()) });
    const res = await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" });
    const requestId = String((await json(res)).requestId);
    const other = await rt.store.human.insert({
      name: "K",
      email: "k@example.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 1,
      locale: "en",
    });
    const row = await rt.store.humanRequest.mustGet(requestId);
    // Answered in the shared state by someone else (the daemon's own route refuses this).
    await rt.store.humanRequest.answer(requestId, row.version, "approve", other.id);
    const synced = await rt.syncApprovals();
    expect(synced.intake).toEqual({ applied: 0, rejected: 0, skipped: 1 });
    expect(await rt.store.task.list({ project_id: projectId } as never)).toHaveLength(0);
    expect(await rt.store.milestone.forProject(projectId)).toHaveLength(0);
    expectNotDrafted(projectId);
    const c = await card(requestId);
    expect(c.outcome).toBe("wrong_human");
    const status = await json(await req(`/projects/${projectId}/intake`));
    expect(status).toMatchObject({ state: "skipped", requestId });
  });

  it("with a repository the approved doc set goes up as a pull request and existing files are kept", async () => {
    const projectId = await createProject({
      name: "Sample",
      goal: "Keep the sample alive",
      brief: "An existing repository with a README that must stay.",
      repos: ["o/sample"],
    });
    replies.push({ text: JSON.stringify(proposal()) });
    const res = await json(
      await req(`/projects/${projectId}/intake`, { method: "POST", body: "{}" }),
    );
    expect(res.docsTarget).toBe("repository");
    const requestId = String(res.requestId);
    await answer(requestId, "approve");
    const prs = await host.listPullRequests({ owner: "o", name: "sample" });
    // The creation-time scaffold (spec G.5) opened the first pull request; the intake's is its own.
    expect(prs).toHaveLength(2);
    expect(prs.some((pr) => pr.head.ref === "fr/docs-scaffold")).toBe(true);
    const intakePr = prs.find((pr) => /^fr\/intake-/.test(pr.head.ref));
    expect(intakePr?.title).toContain("doc set");
    const c = await card(requestId);
    expect(c.docs).toMatchObject({
      target: "repository",
      prUrl: intakePr?.htmlUrl,
      branch: intakePr?.head.ref,
      kept: ["README.md"],
    });
    const branch = String((c.docs as JsonObject).branch);
    const tree = await run(["git", "ls-tree", "-r", "--name-only", branch], { cwd: bare });
    expect(tree.stdout).toContain("docs/overview.md");
    expect(tree.stdout).toContain("docs/testing.md");
    const readme = await run(["git", "show", `${branch}:README.md`], { cwd: bare });
    expect(readme.stdout).toContain("# sample (kept)");
    expect(existsSync(rt.intake.workspaceDir(projectId))).toBe(false);
    expect(await rt.store.task.list({ project_id: projectId } as never)).toHaveLength(3);
  });

  it("POST /projects with intake: true runs the intake in the background; without it nothing runs", async () => {
    replies.push({ text: JSON.stringify(proposal()) });
    const callsBefore = provider.calls.length;
    const auto = await createProject({
      name: "Eta",
      goal: "Automatic",
      brief: "Plan me.",
      intake: true,
    });
    const job = rt.intake.inFlight(auto);
    expect(job).not.toBeNull();
    const result = await job;
    expect(result).toMatchObject({ pending: true, projectId: auto });
    expect(provider.calls.length).toBe(callsBefore + 1);
    expect(rt.intake.inFlight(auto)).toBeNull();
    const status = await json(await req(`/projects/${auto}/intake`));
    expect(status).toMatchObject({ state: "pending" });

    const manual = await createProject({ name: "Theta", goal: "Manual", brief: "Not yet." });
    expect(rt.intake.inFlight(manual)).toBeNull();
    expect(provider.calls.length).toBe(callsBefore + 1);
    expect(await json(await req(`/projects/${manual}/intake`))).toMatchObject({ state: "none" });
  });

  it("a failed automatic intake is recorded on the project, not lost", async () => {
    replies.push({ text: "no json here" });
    const id = await createProject({ name: "Iota", goal: "Fails", brief: "x", intake: true });
    // The job rejects with the refusal; the daemon never awaits it, the status route reports it.
    await expect(rt.intake.inFlight(id)).rejects.toMatchObject({ code: "validation" });
    const status = await json(await req(`/projects/${id}/intake`));
    expect(status).toMatchObject({ state: "failed" });
    expect(String(status.error)).toContain("JSON");
  });

  it("on the built-in prompt the intake Run row names the built-in prompt version", async () => {
    replies.push({ text: "no json here" });
    const service = new IntakeService({
      store: rt.store,
      clock,
      tokens: rt.tokens,
      driver: rt.driver,
      provider,
      pricing: { estimate: () => 1, cost: () => 1 },
      billingSourceId: rt.billingSourceId,
      modelConfig: rt.modelConfig,
      human: rt.human,
      agent: rt.agent,
      gitHost: host,
      projectsRoot: rt.data.assets.projectsRoot,
      worktreeRoot: join(home, "wt-builtin"),
    });
    const projectId = await createProject({ name: "Lambda", goal: "g", brief: "b" });
    await expect(service.propose(projectId)).rejects.toMatchObject({ code: "validation" });
    const runs = (await rt.store.run.list({ specialist: INTAKE_RUN_SPECIALIST } as never)).filter(
      (r) => r.prompt_version === INTAKE_BUILTIN_PROMPT_VERSION,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.prompt_version).not.toBe("");
  });

  it("the intake Run row stores the effort the call ran at: the slider's shift, held at the cap", async () => {
    // Spec D.16 and D.19: the Performance view's planning samples carry the effort in force.
    const service = (maxEffort?: "high") =>
      new IntakeService({
        store: rt.store,
        clock,
        tokens: rt.tokens,
        driver: rt.driver,
        provider,
        pricing: { estimate: () => 1, cost: () => 1 },
        billingSourceId: rt.billingSourceId,
        modelConfig: rt.modelConfig,
        maxEffort,
        human: rt.human,
        agent: rt.agent,
        gitHost: host,
        projectsRoot: rt.data.assets.projectsRoot,
        worktreeRoot: join(home, "wt-effort"),
      });
    const projectId = await createProject({ name: "Mu", goal: "g", brief: "b" });
    const project = await rt.store.project.mustGet(projectId);
    await rt.store.project.update(projectId, project.version, {
      settings: { ...project.settings, speed_quality_offset: 1 },
    });
    const runIdsOf = async () =>
      new Set(
        (await rt.store.run.list({ specialist: INTAKE_RUN_SPECIALIST } as never)).map((r) => r.id),
      );
    const newRow = async (before: Set<string>) => {
      const rows = (await rt.store.run.list({ specialist: INTAKE_RUN_SPECIALIST } as never)).filter(
        (r) => !before.has(r.id),
      );
      expect(rows).toHaveLength(1);
      return rows[0];
    };
    let before = await runIdsOf();
    replies.push({ text: "no json here" });
    await expect(service().propose(projectId)).rejects.toMatchObject({ code: "validation" });
    // Planning's high, one step up.
    expect(provider.calls.at(-1)?.effort).toBe("xhigh");
    expect((await newRow(before))?.effort).toBe("xhigh");
    before = await runIdsOf();
    replies.push({ text: "no json here" });
    await expect(service("high").propose(projectId)).rejects.toMatchObject({ code: "validation" });
    expect(provider.calls.at(-1)?.effort).toBe("high");
    expect((await newRow(before))?.effort).toBe("high");
  });

  it("without a model provider the intake is unavailable", async () => {
    const service = new IntakeService({
      store: rt.store,
      clock,
      tokens: rt.tokens,
      driver: rt.driver,
      provider: null,
      pricing: null,
      billingSourceId: rt.billingSourceId,
      modelConfig: rt.modelConfig,
      human: rt.human,
      agent: rt.agent,
      gitHost: host,
      projectsRoot: rt.data.assets.projectsRoot,
      worktreeRoot: join(home, "wt"),
    });
    const projectId = await createProject({ name: "Kappa", goal: "g", brief: "b" });
    await expect(service.propose(projectId)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("keeps the principal's planning rung under the project's ceiling (spec D.3)", async () => {
    const before = await rt.store.agent.mustGet(rt.agent.id);
    await rt.store.agent.update(rt.agent.id, before.version, {
      model_config: { modes: { planning: { tier: "fable" } } },
    });
    try {
      const propose = async (name: string, settings: JsonObject) => {
        const id = await createProject({ name, goal: "g", brief: "b" });
        const project = await rt.store.project.mustGet(id);
        await rt.store.project.update(id, project.version, { settings });
        replies.push({ text: `\`\`\`json\n${JSON.stringify(proposal())}\n\`\`\`` });
        const res = await req(`/projects/${id}/intake`, { method: "POST", body: "{}" });
        expect(res.status).toBe(202);
        return provider.calls.at(-1)?.model;
      };
      // The default ceiling is Opus: the top rung only by an explicit project setting.
      expect(await propose("Mu", {})).toBe("fake-opus");
      expect(await propose("Nu", { critic_ceiling: "fable" })).toBe("fake-fable");
    } finally {
      const row = await rt.store.agent.mustGet(rt.agent.id);
      await rt.store.agent.update(rt.agent.id, row.version, { model_config: {} });
    }
  });

  it("the principal's planning effort is the base the project's slider shifts (D.4 with D.16)", async () => {
    const before = await rt.store.agent.mustGet(rt.agent.id);
    await rt.store.agent.update(rt.agent.id, before.version, {
      model_config: { modes: { planning: { effort: "low" } } },
    });
    try {
      const propose = async (name: string, settings: JsonObject) => {
        const id = await createProject({ name, goal: "g", brief: "b" });
        const project = await rt.store.project.mustGet(id);
        await rt.store.project.update(id, project.version, { settings });
        replies.push({ text: `\`\`\`json\n${JSON.stringify(proposal())}\n\`\`\`` });
        const res = await req(`/projects/${id}/intake`, { method: "POST", body: "{}" });
        expect(res.status).toBe(202);
        return provider.calls.at(-1)?.effort;
      };
      expect(await propose("Xi", {})).toBe("low");
      expect(await propose("Omicron", { speed_quality_offset: 1 })).toBe("medium");
      expect(await propose("Pi", { speed_quality_offset: -1 })).toBe("low");
    } finally {
      const row = await rt.store.agent.mustGet(rt.agent.id);
      await rt.store.agent.update(rt.agent.id, row.version, { model_config: {} });
    }
  });

  it("runs at the principal's planning rung and prices the call as that model (spec D.4)", async () => {
    const before = await rt.store.agent.mustGet(rt.agent.id);
    await rt.store.agent.update(rt.agent.id, before.version, {
      model_config: { modes: { planning: { tier: "opus", max_tokens: 12_000 } } },
    });
    const priced: string[] = [];
    const service = new IntakeService({
      store: rt.store,
      clock,
      tokens: rt.tokens,
      driver: rt.driver,
      provider,
      // The table's planning rung (sonnet) would price this call at 1 per token.
      pricing: { estimate: (i, o) => i + o, cost: (u) => u.input_tokens + u.output_tokens },
      pricingFor: (model) => {
        priced.push(model);
        return { estimate: (i, o) => 7 * (i + o), cost: () => 123_456 };
      },
      billingSourceId: rt.billingSourceId,
      modelConfig: rt.modelConfig,
      human: rt.human,
      agent: rt.agent,
      gitHost: host,
      projectsRoot: rt.data.assets.projectsRoot,
      worktreeRoot: join(home, "wt"),
    });
    try {
      const projectId = await createProject({ name: "Lambda", goal: "g", brief: "b" });
      replies.push({ text: `\`\`\`json\n${JSON.stringify(proposal())}\n\`\`\`` });
      await service.propose(projectId);
      const call = provider.calls.at(-1);
      expect(call?.model).toBe("fake-opus");
      expect(call?.max_tokens).toBe(12_000);
      expect(priced).toEqual(["fake-opus"]);
      expect((await rt.store.costLedger.sum({ projectId })).usd_micro).toBe(123_456);
    } finally {
      const row = await rt.store.agent.mustGet(rt.agent.id);
      await rt.store.agent.update(rt.agent.id, row.version, { model_config: {} });
    }
  });
});
