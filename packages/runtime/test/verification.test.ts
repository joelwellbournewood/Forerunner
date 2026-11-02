import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { NO_ACTION_GIVEN, SUBMIT_REVIEW_TOOL, type VerificationRecord } from "@forerunner/critic";
import { join } from "@forerunner/platform";
import { toolReply } from "@forerunner/testenv";
import { afterAll, describe, expect, it } from "vitest";
import type { TryPagesRequest } from "../src/loop/try-it.ts";
import { HOW_WORK_IS_CHECKED, outcomeCriterion, reviewTierOf } from "../src/loop/verification.ts";
import type { ModelRequest } from "../src/provider/types.ts";
import { FakeSandbox } from "../src/sandbox/fake.ts";
import { closingReply, doneExecutor, loopWorld, submitReply } from "./loop-helpers.ts";

/**
 * Proportional verification (the owner's decision of 2026-11-01, ADR 0104): nothing is Done
 * without the right check. These cases are the live findings of 2026-11-01 as the runner meets
 * them: a planner's tier 0 closed a code task on the specialist's own word (live2 #5), a report
 * that made nothing and asked for a file was accepted and Done (live2 part 3, B1), the critic
 * judged from the diff alone and never saw a command's output (live2 D2, live B+D), and an
 * accept was turned into a revise by "none (…)" doc drift (live B3).
 */
const folders: string[] = [];
afterAll(() => {
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

/** A task's folder with these files (a path with a space, as on Windows). */
function taskFolder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "fr verify "));
  folders.push(root);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, ...path.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const reviewCalls = (w: { provider: { calls: { request: ModelRequest }[] } }) =>
  w.provider.calls.filter((c) => c.request.tools?.some((t) => t.name === SUBMIT_REVIEW_TOOL));

const isReview = (req: ModelRequest) =>
  (req.tools ?? []).some((t) => t.name === SUBMIT_REVIEW_TOOL);
const toolResultText = (req: ModelRequest): string => {
  const last = req.messages.at(-1)?.content;
  return Array.isArray(last)
    ? last
        .filter((b) => (b as { type?: string }).type === "tool_result")
        .map((b) => JSON.stringify(b))
        .join("\n")
    : "";
};
const firstTurn = (req: ModelRequest) => isReview(req) && toolResultText(req) === "";

/** The verification record the review row keeps for the person (the task drawer reads it). */
async function verificationOfTask(
  w: Awaited<ReturnType<typeof loopWorld>>,
  taskId: string,
): Promise<VerificationRecord | undefined> {
  const review = await w.store.review.latestForTask(taskId);
  const entry = (review?.evidence ?? []).find(
    (e) => typeof e === "object" && e !== null && !Array.isArray(e) && "verification" in e,
  ) as unknown as { verification: VerificationRecord } | undefined;
  return entry?.verification;
}

describe("verification: nothing is Done without the right check", () => {
  it("a task the planner put at tier 0 is still reviewed by the critic before it is Done", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 90 }), closingReply()] });
    const task = await w.addTask("Build the three pages", { risk_tier: 0 });
    const result = await w.start(w.runner(doneExecutor(w)));
    // The critic made a call on it, with the submit tool, and its accept closed the task.
    expect(reviewCalls(w).length).toBeGreaterThan(0);
    expect(JSON.stringify(reviewCalls(w)[0]?.request.messages)).toContain("Build the three pages");
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0]).toMatchObject({ taskId: task.id, decision: "accepted" });
    // Reviewed as a light review: the lowest review a task gets.
    expect(result.reviews[0]?.tier).toBe(1);
    expect(await w.store.review.latestForTask(task.id)).toMatchObject({ verdict: "accept" });
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    await w.close();
  });

  it("a report that made nothing and asks for a file is never Done, even when the critic accepts: the task waits with a card that asks for it", async () => {
    // Live (2026-11-01, "Members chart"): the specialist made no chart, ended with "Questions
    // for the person:" asking for data/members.csv, the critic accepted (82) and the task was
    // Done with "Nothing needs you" in the Inbox.
    const report = [
      "**Summary** No chart was made: data/members.csv is not in the project's folder, and no number may be invented.",
      "",
      "Questions for the person:",
      "- Please add data/members.csv to the project's folder: the chart needs it.",
    ].join("\n");
    const w = await loopWorld({
      replies: [
        submitReply({
          grade: 82,
          verdict: "accept",
          summary: "A blocked report is the right outcome.",
          criteria: [
            {
              text: "Every bar uses the exact number from data/members.csv",
              met: true,
              evidence: "there are no bars",
            },
          ],
        }),
        closingReply(),
      ],
    });
    const task = await w.addTask("Members chart", {
      acceptance_criteria: ["Every bar uses the exact number from data/members.csv"],
    });
    const result = await w.start(w.runner(doneExecutor(w, { finalReport: report })));
    const after = await w.store.task.mustGet(task.id);
    expect(after.status).toBe("needs_human");
    expect(result.completed).not.toContain(task.id);
    expect(result.needsHuman).toContain(task.id);
    // The critic was told the report asks the person, and the code ruled out the accept.
    expect(JSON.stringify(reviewCalls(w)[0]?.request.messages)).toContain(
      "Questions the worker's report asks the person",
    );
    expect(await w.store.review.latestForTask(task.id)).toMatchObject({ verdict: "human" });
    // One open card for the person, asking the report's own question, and no sign-off beside it.
    const open = await w.store.humanRequest.list({ task_id: task.id, status: "open" } as never, {
      limit: 10,
    });
    expect(open).toHaveLength(1);
    expect(open[0]?.steps).toEqual([
      "Please add data/members.csv to the project's folder: the chart needs it.",
    ]);
    await w.close();
  });

  it("an accepted report whose only mention of the person is in passing is still Done", async () => {
    const w = await loopWorld({ replies: [submitReply({ grade: 92 }), closingReply()] });
    const task = await w.addTask("Add clamp");
    await w.start(
      w.runner(
        doneExecutor(w, {
          finalReport:
            "Done: clamp added with a test. Nothing here needs the human's decision; tests pass.",
        }),
      ),
    );
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    await w.close();
  });

  it("the critic reads the project's files itself: the read tools, the folder's file list, a file outside refused", async () => {
    // Live (2026-11-01, D2): "I could not check the claims about the pages because those files
    // were not in the request" in 4 of 5 reviews; it had the diff only.
    const root = taskFolder({
      "index.html": '<a href="about.html">About</a>',
      "about.html": "<h1>About the garden club</h1>",
      "data/members.csv": "year,members\n2024,31\n",
    });
    writeFileSync(join(root, "..", "outside-secret.txt"), "never readable");
    folders.push(join(root, "..", "outside-secret.txt"));
    const w = await loopWorld({
      replies: [
        toolReply("read_file", { path: "about.html" }, "Reading the page the change links.", {
          when: firstTurn,
        }),
        toolReply("read_file", { path: "../outside-secret.txt" }, "And one outside.", {
          when: (req) => isReview(req) && toolResultText(req).includes("About the garden club"),
        }),
        submitReply(
          { grade: 91, summary: "about.html exists and says what the link promises." },
          { when: (req) => isReview(req) && toolResultText(req).includes("outside") },
        ),
        closingReply(),
      ],
    });
    const task = await w.addTask("Link the about page", { risk_tier: 1 });
    const result = await w.start(
      w.runner(doneExecutor(w, { worktree: root, changedFiles: ["index.html"] })),
    );
    const calls = reviewCalls(w);
    const first = calls[0]?.request;
    expect(first?.tools?.map((t) => t.name).sort()).toEqual(
      ["list_dir", "read_file", SUBMIT_REVIEW_TOOL].sort(),
    );
    const sent = JSON.stringify(first?.messages);
    expect(sent).toContain("Project files you can read (read_file, list_dir)");
    expect(sent).toContain("about.html");
    expect(sent).toContain("data/members.csv");
    // The file it asked for came back; the one outside the task's folder was refused.
    expect(toolResultText(calls[1]?.request as ModelRequest)).toContain("About the garden club");
    const outside = toolResultText(calls[2]?.request as ModelRequest);
    expect(outside).not.toContain("never readable");
    expect(outside).toMatch(/is_error"?:true|outside|not allowed|denied/i);
    expect(result.reviews[0]).toMatchObject({ taskId: task.id, decision: "accepted" });
    await w.close();
  });

  it("the project's own build and tests run for a code task in the task's sandbox, at every level; their output is the critic's evidence and a failure blocks the accept", async () => {
    const root = taskFolder({
      "package.json": JSON.stringify({
        name: "garden",
        scripts: { build: "node build.js", test: "node --test", lint: "" },
      }),
      "src/clamp.js": "export const clamp = (x) => x;",
    });
    // One sandbox per review (the sent-back work is reviewed again in the same session).
    const leases: FakeSandbox[] = [];
    const opened: { tier: number }[] = [];
    const w = await loopWorld({
      replies: [
        // The model accepts; the failed test keeps the accept from standing.
        submitReply({ grade: 90 }),
        closingReply(),
      ],
      critic: {
        sandbox: {
          open: async (req) => {
            opened.push({ tier: req.task.risk_tier });
            const sandbox = new FakeSandbox({ worktree: root })
              .script(/build/, { code: 0, stdout: "built" })
              .script(/test/, {
                code: 1,
                stdout: "not ok 1 - clamp keeps 5 inside 0..3\n# fail 1",
              });
            leases.push(sandbox);
            return { sandbox, engine: "fake", warnings: [] };
          },
        },
        hasCommand: async () => true,
      },
    });
    const task = await w.addTask("Add clamp", { risk_tier: 0 });
    const result = await w.start(
      w.runner(doneExecutor(w, { worktree: root, changedFiles: ["src/clamp.js"] })),
      { budgetCapUsdMicro: 3_000_000 },
    );
    // npm run build, then test (lint is empty: not a check), in the task's sandbox.
    expect(leases[0]?.calls.map((c) => c.argv.join(" "))).toEqual([
      "npm run --silent build",
      "npm run --silent test",
    ]);
    expect(opened[0]).toEqual({ tier: 0 });
    expect(leases.every((l) => l.destroyed)).toBe(true);
    const sent = JSON.stringify(reviewCalls(w)[0]?.request.messages);
    expect(sent).toContain("Check results (run by the runtime: verified)");
    expect(sent).toContain("not ok 1 - clamp keeps 5 inside 0..3");
    expect(result.reviews[0]).toMatchObject({ taskId: task.id, verdict: "revise" });
    const found = (await w.store.finding.list({ task_id: task.id } as never)).map(
      (f) => f.description,
    );
    expect(found).toContain("Check failed: test");
    // What the person can open from the task: the checks with their output.
    const v = await verificationOfTask(w, task.id);
    expect(v?.checks.map((c) => [c.name, c.passed])).toEqual([
      ["build", true],
      ["test", false],
    ]);
    expect(v?.checks[1]?.output).toContain("npm run --silent test -> exit 1");
    await w.close();
  });

  it("without npm where the checks run, the project's checks are not run and the review says why; nothing fails for it", async () => {
    const root = taskFolder({
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
      "src/a.js": "export const a = 1;",
    });
    const sandbox = new FakeSandbox({ worktree: root });
    const w = await loopWorld({
      replies: [submitReply({ grade: 90 }), closingReply()],
      critic: {
        sandbox: { open: async () => ({ sandbox, engine: "fake", warnings: [] }) },
        hasCommand: async () => false,
      },
    });
    const task = await w.addTask("Add a");
    await w.start(w.runner(doneExecutor(w, { worktree: root, changedFiles: ["src/a.js"] })));
    expect(sandbox.calls).toEqual([]);
    expect(JSON.stringify(reviewCalls(w)[0]?.request.messages)).toContain(
      "the project's test was not run: npm is not installed where the checks run",
    );
    expect((await w.store.task.mustGet(task.id)).status).toBe("done");
    expect((await verificationOfTask(w, task.id))?.notChecked).toEqual([
      "the project's test was not run: npm is not installed where the checks run",
    ]);
    await w.close();
  });

  it("a page the task made is tried as a person would use it: the try is the critic's evidence and is kept with the review", async () => {
    const root = taskFolder({
      "index.html": "<title>Garden club</title><h1>Garden club</h1>",
      "styles.css": "h1 { color: green; }",
    });
    const asked: TryPagesRequest[] = [];
    const w = await loopWorld({
      replies: [submitReply({ grade: 90 }), closingReply()],
      critic: {
        tryIt: {
          tryPages: async (req) => {
            asked.push(req);
            return {
              tried: [
                {
                  what: "opened index.html in a browser, 1280 and 390 pixels wide",
                  target: "index.html",
                  ok: true,
                  blocking: false,
                  output: "opened index.html\ntitle: Garden club\ntext seen: Garden club",
                  screenshots: [
                    {
                      label: "1280 pixels wide (a computer)",
                      file: `${req.reviewKey}/index-1280.png`,
                    },
                  ],
                },
              ],
            };
          },
        },
      },
    });
    const page = await w.addTask("Build the welcome page");
    await w.start(
      w.runner(doneExecutor(w, { worktree: root, changedFiles: ["index.html", "styles.css"] })),
    );
    expect(asked.map((a) => [a.taskId, a.pages, a.root])).toEqual([
      [page.id, ["index.html"], root],
    ]);
    const sent = JSON.stringify(reviewCalls(w)[0]?.request.messages);
    expect(sent).toContain("Tried as a person would use it (by the runtime: verified)");
    expect(sent).toContain("text seen: Garden club");
    expect((await w.store.task.mustGet(page.id)).status).toBe("done");
    const v = await verificationOfTask(w, page.id);
    expect(v?.tried[0]).toMatchObject({ target: "index.html", ok: true });
    expect(v?.tried[0]?.screenshots?.[0]?.file).toMatch(/\/index-1280\.png$/);
    await w.close();
  });

  it("a page that throws when it is opened is sent back whatever the model said; without a browser the review says the page was not tried", async () => {
    const root = taskFolder({
      "index.html": "<script>document.getElementById('q').textContent='x'</script>",
    });
    const w = await loopWorld({
      replies: [submitReply({ grade: 90 }, { times: Number.POSITIVE_INFINITY }), closingReply()],
      critic: {
        tryIt: {
          tryPages: async () => ({
            tried: [
              {
                what: "opened index.html in a browser, 1280 and 390 pixels wide",
                target: "index.html",
                ok: false,
                blocking: true,
                output: "opened index.html\nproblem: error on the page: quote is null",
              },
            ],
          }),
        },
      },
    });
    const broken = await w.addTask("Show a quote");
    const result = await w.start(
      w.runner(doneExecutor(w, { worktree: root, changedFiles: ["index.html"] })),
    );
    expect(result.reviews[0]).toMatchObject({ taskId: broken.id, verdict: "revise" });
    const found = (await w.store.finding.list({ task_id: broken.id } as never)).map((f) => [
      f.severity,
      f.description,
    ]);
    expect(found).toContainEqual(["high", "Tried index.html: error on the page: quote is null"]);
    expect((await w.store.task.mustGet(broken.id)).status).not.toBe("done");
    await w.close();

    const w2 = await loopWorld({
      replies: [submitReply({ grade: 90 }), closingReply()],
      critic: {
        tryIt: {
          tryPages: async () => ({
            unavailable: "no Chromium, Edge or Chrome was found on this computer",
          }),
        },
      },
    });
    const plain = await w2.addTask("Build the page");
    await w2.start(w2.runner(doneExecutor(w2, { worktree: root, changedFiles: ["index.html"] })));
    expect(JSON.stringify(reviewCalls(w2)[0]?.request.messages)).toContain(
      "index.html was not tried: no Chromium, Edge or Chrome was found on this computer",
    );
    expect((await verificationOfTask(w2, plain.id))?.tried).toEqual([]);
    expect((await w2.store.task.mustGet(plain.id)).status).toBe("done");
    await w2.close();
  });

  it("a deploy gets the full review and is done only once the person signs it off, whatever its tier; rework still goes through the retry ladder", async () => {
    // Live (2026-11-02, D): an ops-deploy task edited down to a light review was accepted (86)
    // with a criterion "not verified" and was Done.
    const w = await loopWorld({
      replies: [
        submitReply(
          { grade: 95 },
          { when: (req) => firstTurn(req) && !/Fix the deploy/.test(JSON.stringify(req.messages)) },
        ),
        submitReply(
          {
            grade: 40,
            verdict: "revise",
            findings: [{ severity: "major", what: "The rollback was not tested" }],
          },
          { when: (req) => firstTurn(req) && /Fix the deploy/.test(JSON.stringify(req.messages)) },
        ),
        closingReply(),
      ],
      critic: { specialistFloor: (name) => (name === "ops-deploy" ? 2 : undefined) },
    });
    const task = await w.addTask("Deploy the site", { risk_tier: 1, specialist: "ops-deploy" });
    const executor = doneExecutor(w);
    const asDeploy = w.runner({
      execute: (ctx) =>
        executor.execute({ ...ctx, item: { ...ctx.item, specialist: "ops-deploy" } }),
    });
    const result = await w.start(asDeploy);
    // The full review (the registry's floor), and the accept became the person's sign-off.
    expect(result.reviews[0]).toMatchObject({ taskId: task.id, tier: 2, decision: "human" });
    expect((await w.store.task.mustGet(task.id)).status).toBe("needs_human");
    const [signoff] = await w.store.humanRequest.list(
      { task_id: task.id, status: "open" } as never,
      { limit: 5 },
    );
    expect(signoff?.why).toContain("needs your sign-off");
    // A deploy the critic sends back is reworked as any task is, not handed to the person.
    const fix = await w.addTask("Fix the deploy", { risk_tier: 1, specialist: "ops-deploy" });
    const second = await w.start(asDeploy, { budgetCapUsdMicro: 1_500_000 });
    expect(second.reviews.find((r) => r.taskId === fix.id)).toMatchObject({
      verdict: "revise",
      decision: "revise",
    });
    expect(reviewTierOf(0)).toBe(1);
    expect(reviewTierOf(1, 2)).toBe(2);
    expect(HOW_WORK_IS_CHECKED).toContain("the critic reads your work and the project's files");
    expect(outcomeCriterion("index.html shows the club's name")).toBe(
      "The work itself shows this outcome (a file, a page or an output, not only the report): index.html shows the club's name",
    );
    await w.close();
  });

  it('"none (…)" is no doc drift, and a finding the model gave no action for does not repeat itself', async () => {
    const w = await loopWorld({
      replies: [
        submitReply({
          grade: 88,
          doc_drift: "none (docs/testing.md still says how to run the tests)",
          findings: [{ severity: "note", what: "The header colour could be darker" }],
        }),
        closingReply(),
      ],
    });
    const task = await w.addTask("Style the header");
    const result = await w.start(w.runner(doneExecutor(w)));
    expect(result.reviews[0]).toMatchObject({ taskId: task.id, verdict: "accept" });
    const [finding] = await w.store.finding.list({ task_id: task.id } as never);
    expect(finding?.required_action).toBe(NO_ACTION_GIVEN);
    expect(finding?.required_action).not.toContain(finding?.description ?? "-");
    await w.close();
  });
});
