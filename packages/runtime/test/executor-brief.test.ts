import { openStore, type StateStore, type TaskRow } from "@forerunner/state";
import { afterEach, describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import {
  LoopTaskExecutor,
  retryConstraints,
  type SpecialistSpec,
} from "../src/session/executor.ts";
import { flatPricing, harness, issue, registry, ScriptedProvider } from "./helpers.ts";

/**
 * What a specialist is told, and how a failed run is named (core-experience design §4.4,
 * §4.6). The walks' model-call log showed every brief after the first one without the project's
 * goal or the person's brief ("greeting" and "date" appeared in no later brief), a chain step
 * told it "builds on the step before" without naming it, a retry after an error promised "the
 * critic's findings below" with none below, the person's notes on a task in no brief, and a run
 * that errored reported as the model's first remark ("I'll look at what is already in the
 * folder first.") while "model call failed" stayed in the daemon log.
 */
const coder: SpecialistSpec = {
  name: "coder",
  prompt: "You are the coder.",
  promptVersion: "coder@1",
  defaultTier: "sonnet",
  defaultEffort: "medium",
  allowedTools: ["echo", "read_file"],
  allowedDomains: [],
  maxBudgetUsdMicro: 2_000_000,
  maxTurns: 10,
  timeoutMs: 60_000,
};

interface World {
  h: ReturnType<typeof harness>;
  store: StateStore;
  human: string;
  agent: string;
  project: string;
  session: string;
}

async function world(): Promise<World> {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  const human = (
    await store.human.insert({
      name: "Robin",
      email: "r@x.test",
      timezone: "UTC",
      notify_prefs: {},
      default_autonomy: 2,
      monthly_cap_usd_micro: 100_000_000,
      locale: "en",
    })
  ).id;
  const agent = (
    await store.agent.insert({
      name: "Alice",
      owner_human_id: human,
      model_config: {},
      memory_location: "l",
      status: "active",
      kind: "principal",
    })
  ).id;
  const project = (
    await store.project.insert({
      name: "Greeting page",
      goal: "A one-page website that greets the visitor",
      repos: [],
      stage: "build",
      status: "active",
      budget_usd_micro: 50_000_000,
      autonomy_level: 2,
      summary_cache: {
        brief: "A one-page website that shows today's date and a greeting; plain HTML",
      },
      data_assets: [],
      settings: {},
      small_project_mode: false,
      active: true,
    })
  ).id;
  const session = (
    await store.session.insert({
      agent_id: agent,
      project_id: project,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 5_000_000,
      step_cap: 100,
      spent_usd_micro: 0,
      steps: 0,
      status: "running",
      summary: "",
      handoff: {},
      runner: "pc",
    })
  ).id;
  return { h, store, human, agent, project, session };
}

async function run(
  w: World,
  task: TaskRow,
  provider: ScriptedProvider,
  extra: { sessionNote?: string } = {},
) {
  const exec = new LoopTaskExecutor({
    store: w.store,
    clock: w.h.clock,
    tokens: w.h.tokens,
    driver: new LoopAgentDriver({ hooks: w.h.hooks, kill: w.h.kill, clock: w.h.clock }),
    provider,
    pricing: flatPricing,
    tools: registry(),
    billingSourceId: "bs",
    specialists: (n) => (n === "coder" ? coder : undefined),
  });
  const session = await w.store.session.mustGet(w.session);
  return exec.execute({
    task,
    session,
    token: issue(w.h, {
      agentId: w.agent,
      ownerHumanId: w.human,
      projectId: w.project,
      allowedTools: ["echo", "read_file"],
      budgetUsdMicro: 5_000_000,
      sessionId: w.session,
    }),
    budget: new SessionBudget({
      sessionId: w.session,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: w.h.clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 100_000 },
    signal: new AbortController().signal,
    ...extra,
  });
}

const add = (w: World, title: string, over: Record<string, unknown> = {}) =>
  w.store.task.insert({
    project_id: w.project,
    title,
    outcome: `${title} is done`,
    acceptance_criteria: ["it works"],
    risk_tier: 1,
    status: "in_progress",
    priority: 5,
    reason: "seed",
    ...over,
  });

describe("what a specialist is told (design §4.6)", () => {
  let w: World;
  afterEach(async () => {
    await w.store.close();
  });

  it("every brief carries the project's goal, the person's brief, the docs and what the task waited on", async () => {
    w = await world();
    const dep = await add(w, "Create the page skeleton in index.html", { status: "done" });
    // The step before ran in an earlier session: its run, its report and the files it changed.
    const earlier = await w.store.session.insert({
      agent_id: w.agent,
      project_id: w.project,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1,
      step_cap: 1,
      spent_usd_micro: 0,
      steps: 0,
      status: "completed",
      summary: "",
      handoff: {},
      runner: "pc",
    });
    await w.store.run.insert({
      task_id: dep.id,
      session_id: earlier.id,
      specialist: "coder",
      model: "fake-sonnet",
      provider: "fake",
      effort: "low",
      prompt_version: "v1",
      billing_source_id: null,
      outcome: "completed",
      artifacts: [{ report: "Wrote index.html with a heading, the date and the greeting." }],
    });
    await w.store.event.append(earlier.id, "task.files", {
      taskId: dep.id,
      files: ["index.html"],
    } as never);
    const task = await add(w, "Add the page behaviour in script.js", { depends_on: [dep.id] });
    const provider = new ScriptedProvider([{ text: "Done." }], w.h.clock);
    await run(w, task, provider, { sessionNote: "Keep everything in plain HTML." });
    const brief = provider.calls[0]?.messages[0]?.content as string;
    expect(brief).toContain("## Project");
    expect(brief).toContain("Greeting page: A one-page website that greets the visitor");
    expect(brief).toContain("today's date and a greeting");
    expect(brief).toContain("docs/overview.md");
    expect(brief).toContain("## Done before this task");
    expect(brief).toContain(
      '- "Create the page skeleton in index.html": Wrote index.html with a heading, the date and the greeting. Files: index.html',
    );
    expect(brief).toContain("## Note for this session (from the person)");
    expect(brief).toContain("Keep everything in plain HTML.");
    // A first attempt has no retry line and no promise of findings.
    expect(brief).not.toContain("findings below");
  });

  it("a brief never asks for a commit: it says Forerunner records the changes after the run (live check of 2026-11-01)", async () => {
    // Live, the planner wrote "committed in the project working tree" into a coder's outcome;
    // the coder has no commit step of its own ("I did not run git commit") and the critic
    // flagged it. The executor commits each run's changes (the workspace's baseline, or the
    // pull request), so the brief says so.
    w = await world();
    const task = await add(w, "Build the quote page");
    const provider = new ScriptedProvider([{ text: "Done." }], w.h.clock);
    await run(w, task, provider);
    const brief = provider.calls[0]?.messages[0]?.content as string;
    const constraints = brief.slice(
      brief.indexOf("## Constraints"),
      brief.indexOf("## Acceptance"),
    );
    expect(constraints).toContain(
      "- Forerunner commits your changes in the project's folder after the run: do not commit yourself. A criterion that asks for a commit is Forerunner's step: do not report it as not met.",
    );
    expect(constraints).toContain(
      "- Git's read commands (git status, git diff, git log) work in the folder, to see what you changed.",
    );
    // A project's folder of its own has no Local only folder: the brief names none.
    expect(constraints).not.toContain("Local only");
  });

  it("a task on a repository's branch is told Forerunner commits, pushes and opens the pull request (GitHub walk, 2026-11-02)", async () => {
    // On GitHub the coder found git "not working", wrote "Git doesn't work in this sandbox, so
    // I can't commit, push or open a PR" into its report, marked its criterion "Open a PR" not
    // met, and that text became the commit message and the PR body.
    w = await world();
    await w.store.project.patch(w.project, { repos: ["robin/greeting"] });
    const task = await add(w, "Build the quote page", {
      branch: "fr/01a1-build-the-quote-page",
      acceptance_criteria: ["index.html shows a quote", "Open a pull request with the change"],
    });
    const provider = new ScriptedProvider([{ text: "Done." }], w.h.clock);
    await run(w, task, provider);
    const brief = provider.calls[0]?.messages[0]?.content as string;
    const constraints = brief.slice(
      brief.indexOf("## Constraints"),
      brief.indexOf("## Acceptance"),
    );
    expect(constraints).toContain(
      "- Forerunner commits your changes on the branch fr/01a1-build-the-quote-page, pushes it and opens the pull request after the run: do not commit, push or open a pull request yourself. A criterion that asks for a commit, a push or a pull request is Forerunner's step: do not report it as not met.",
    );
    expect(constraints).toContain("Git's read commands (git status, git diff, git log) work");
    expect(constraints).not.toContain("in the project's folder after the run");
    // merged-copy (ADR 0113): the person's Local only folder, what it is and what not to do.
    expect(constraints).toContain(
      "- A folder named \"Local only\" in the project's folder, when there is one, holds the person's own files on this computer and is never uploaded: read or change them when the task needs it, and put their content into your work only when the task asks for it.",
    );
  });

  it("the brief tells the truth about how the work is checked, and a task without criteria is held to its outcome (ADR 0104)", async () => {
    // Live (2026-11-01): the brief said "Acceptance criteria (the critic checks each)" while a
    // tier 0 task had no critic, and a task added in chat carried "The outcome described in the
    // goal is achieved and verified.", which the critic marked met though nothing was verified.
    w = await world();
    const task = await add(w, "Write the FAQ", {
      outcome: "docs/faq.md answers the five questions members ask most",
      acceptance_criteria: [],
      risk_tier: 0,
    });
    const provider = new ScriptedProvider([{ text: "Done." }], w.h.clock);
    await run(w, task, provider);
    const brief = provider.calls[0]?.messages[0]?.content as string;
    const constraints = brief.slice(
      brief.indexOf("## Constraints"),
      brief.indexOf("## Acceptance"),
    );
    // ADR 0110: the brief names what is tried (a command line tool, a server, a page) and that
    // the project's scripts judge the work as they were before the task (L-5).
    expect(constraints).toContain(
      "- How your work is checked: after your run Forerunner runs the project's own build, lint and tests (its package.json scripts as they were before your task, or pytest, cargo test or go test), runs a command line tool you made with the sample input its brief or README names, starts a server you made and calls its routes, opens a page you made or changed in a browser, and the critic reads your work and the project's files against each acceptance criterion. Nothing is done on your word alone. Write the exact command a person runs in backticks in the README, so it can be tried.",
    );
    expect(constraints).toContain("add a test that runs it");
    expect(brief).toContain(
      "1. The work itself shows this outcome (a file, a page or an output, not only the report): docs/faq.md answers the five questions members ask most",
    );
    expect(brief).not.toContain("The outcome described in the goal is achieved and verified.");
  });

  it("a retry carries the previous attempt's error, and no 'findings below' line when none follow", async () => {
    w = await world();
    const task = await add(w, "Style the page in styles.css", { attempt: 1 });
    await w.store.run.insert({
      task_id: task.id,
      session_id: w.session,
      specialist: "coder",
      model: "fake-sonnet",
      provider: "fake",
      effort: "low",
      prompt_version: "v1",
      billing_source_id: null,
      outcome: "error",
      artifacts: [{ error: "Claude did not answer (model call failed)." }],
    });
    // The person's note on the task, given with Try again in the app.
    await w.store.changeLog.record({
      human_id: w.human,
      agent_id: w.agent,
      words_used: "Use the colours of the logo",
      commands: [
        {
          name: "task.transition",
          params: { task: task.id, to: "ready", reason: "Use the colours of the logo" },
        },
      ],
      project_id: w.project,
      source: "ui",
    } as never);
    const provider = new ScriptedProvider([{ text: "Styled it." }], w.h.clock);
    await run(w, task, provider);
    const brief = provider.calls[0]?.messages[0]?.content as string;
    expect(brief).toContain("## The previous attempt");
    expect(brief).toContain("It failed: Claude did not answer (model call failed).");
    expect(brief).toContain("## The person's note on this task");
    expect(brief).toContain("Use the colours of the logo");
    expect(brief).not.toContain("findings below");
    expect(retryConstraints(1, [])).toEqual([
      "Attempt 2: the previous attempt did not pass; what it said is under The previous attempt.",
    ]);
    expect(
      retryConstraints(1, [
        { severity: "major", description: "No test", required_action: "Add one" },
      ])[0],
    ).toContain("the critic's findings below");
  });

  it("L-4: a retry is not ordered to fix the critic's notes or a problem the task did not cause", async () => {
    // Live (2026-11-02, the clamp library): the retry brief read "[info] The existing round2
    // test fails … It is unrelated to this change … -> Resolve it and show the evidence" and
    // "[info] clamp does not handle lo > hi or NaN. The brief did not ask for either. -> Resolve
    // it…"; the retry rewrote src/round.js and stopped at its budget unreviewed.
    w = await world();
    const task = await add(w, "Add clamp to src/clamp.js", { attempt: 1 });
    const review = await w.store.review.insert({
      task_id: task.id,
      critic_model: "fake-sonnet",
      tier: 1,
      grade: 55,
      confidence: 0.8,
      verdict: "revise",
      evidence: [],
      summary: "The project's test failed.",
      author_agent: w.agent,
    });
    const finding = (
      severity: string,
      description: string,
      required_action: string,
      fingerprint: string,
    ) =>
      w.store.finding.insert({
        review_id: review.id,
        task_id: task.id,
        severity: severity as never,
        description,
        required_action,
        status: "open",
        fingerprint,
        author_agent: w.agent,
      });
    await finding(
      "high",
      "Check failed: test",
      'Make the check "test" pass; if it failed before this task, say so and why under "Questions for the person:"',
      "fp-test",
    );
    await finding(
      "info",
      "The existing round2 test fails: round2(1.005) returns 1 instead of 1.01. It is unrelated to this change.",
      "Resolve it and show the evidence",
      "fp-round2",
    );
    await finding(
      "info",
      "clamp does not handle lo > hi or NaN. The brief did not ask for either.",
      "Resolve it and show the evidence",
      "fp-nan",
    );
    await finding(
      "low",
      "Tried index.html: error on the page: x is not defined (not caused by this task)",
      "Make index.html work when it is opened as a person would use it",
      "fp-page",
    );
    const provider = new ScriptedProvider([{ text: "Fixed it." }], w.h.clock);
    await run(w, task, provider);
    const brief = provider.calls[0]?.messages[0]?.content as string;
    const orders = brief.slice(
      brief.indexOf("Critic findings to resolve"),
      brief.indexOf("Notes from the review"),
    );
    // The measured failure stays an order, with the way out when it failed before the task.
    expect(orders).toContain('- [high] Check failed: test -> Make the check "test" pass');
    expect(orders).not.toContain("round2");
    expect(orders).not.toContain("NaN");
    expect(orders).not.toContain("x is not defined");
    const notes = brief.slice(brief.indexOf("Notes from the review"));
    expect(notes).toContain(
      "Notes from the review, for your information only: they are not part of this task. Do not change code for them; if one stops your task, say so under 'Questions for the person:'.",
    );
    expect(notes).toContain(
      "- The existing round2 test fails: round2(1.005) returns 1 instead of 1.01. It is unrelated to this change.",
    );
    expect(notes).toContain(
      "- clamp does not handle lo > hi or NaN. The brief did not ask for either.",
    );
    expect(notes).toContain("x is not defined (not caused by this task)");
    // A note never carries an order.
    expect(notes).not.toContain("Resolve it and show the evidence");
    // Only notes left: no "findings below" promise.
    expect(
      retryConstraints(1, [
        { severity: "info", description: "A note", required_action: "Resolve it" },
      ])[0],
    ).toBe(
      "Attempt 2: the previous attempt did not pass; what it said is under The previous attempt.",
    );
  });
});

describe("a run that errors is named by its error (design §4.4)", () => {
  let w: World;
  afterEach(async () => {
    await w.store.close();
  });

  it("the model's first remark is not the reason; the error in words is, with its code", async () => {
    w = await world();
    const task = await add(w, "Create the page skeleton");
    const provider = new ScriptedProvider(
      [
        {
          text: "I'll look at what is already in the folder first.",
          tools: [{ name: "echo", input: { text: "ls" } }],
        },
        { error: "overloaded_error" },
      ],
      w.h.clock,
    );
    const r = await run(w, task, provider);
    expect(r.outcome).toBe("failed");
    expect(r.summary).toBe("Claude did not answer (model call failed).");
    expect(r.errorCode).toBe("provider_error");
    // The run row keeps the error for the next attempt's brief.
    const runs = await w.store.run.forTask(task.id);
    expect(runs[0]?.artifacts).toEqual(
      expect.arrayContaining([{ error: "Claude did not answer (model call failed)." }]),
    );
  });
});

describe("live steps (design §4.14)", () => {
  let w: World;
  afterEach(async () => {
    await w.store.close();
  });

  it("the executor reports every model call and tool result to the runner while the run goes", async () => {
    w = await world();
    const task = await add(w, "Read the readme");
    const provider = new ScriptedProvider(
      [{ tools: [{ name: "read_file", input: { path: "README.md" } }] }, { text: "Read it." }],
      w.h.clock,
    );
    const steps: unknown[] = [];
    const exec = new LoopTaskExecutor({
      store: w.store,
      clock: w.h.clock,
      tokens: w.h.tokens,
      driver: new LoopAgentDriver({ hooks: w.h.hooks, kill: w.h.kill, clock: w.h.clock }),
      provider,
      pricing: flatPricing,
      tools: registry(),
      billingSourceId: "bs",
      specialists: (n) => (n === "coder" ? coder : undefined),
    });
    await exec.execute({
      task,
      session: await w.store.session.mustGet(w.session),
      token: issue(w.h, {
        agentId: w.agent,
        ownerHumanId: w.human,
        projectId: w.project,
        allowedTools: ["echo", "read_file"],
        budgetUsdMicro: 5_000_000,
        sessionId: w.session,
      }),
      budget: new SessionBudget({
        sessionId: w.session,
        budgetUsdMicro: 5_000_000,
        stepCap: 100,
        deadlineMs: w.h.clock.now() + 3_600_000,
        reserveShare: 0.2,
      }),
      item: { taskId: task.id, title: task.title, specialist: "coder", estimateUsdMicro: 1 },
      signal: new AbortController().signal,
      onStep: (s) => steps.push(s),
    });
    expect(steps).toEqual([
      // ADR 0112: the run's budget line comes first, a line of the session's log.
      {
        kind: "note",
        text: expect.stringMatching(
          /^This run may spend CHF [\d.]+: at CHF [\d.]+ it is told to wrap up, keeping a reserve of CHF [\d.]+ to finish\.$/,
        ),
      },
      { kind: "model", costUsdMicro: expect.any(Number) },
      {
        kind: "tool",
        name: "read_file",
        input: { path: "README.md" },
        // This harness's token allows no path, so the read is refused: a step all the same.
        isError: true,
        denied: true,
      },
      { kind: "model", costUsdMicro: expect.any(Number) },
    ]);
  });
});
