// Resume journey (budget-resume, ADR 0112 amended): a paused task keeps its work and continues
// from it. A 3-task chain of coder tasks: "Write the intro in intro.md" (no budget of its own),
// "Write the guide in guide.md" (a budget about three times its run's reserve: it hears the
// wrap-up and pauses with its note) and "Write the notes in notes.md" (a tiny budget: it pauses
// at its budget with no note). Each pause files one card naming the limit with "Continue (CHF N
// more)"; pressing it in the Inbox starts the next session at once, whose brief starts with
// "Where the last run stopped". Run on a bench started with
//   --provider bench --env "FORERUNNER_BENCH_LONG=Write the guide,Write the notes"
// (and --githost <port> for --repo):
//   node scripts/bench/journeys/resume.cjs <bench> <label> [--repo bench/seeded]
//     [--guide-chf 0.08] [--notes-chf 0.004] [--cancel]
// --cancel instead pauses one task that another waits on and cancels it in the Tasks tab: the
// dialog names the task that will be stuck, the work is set aside, and Undo brings it back.
// Steps are <bench>/steps/NN-<label>-*.png and .txt; the result is <bench>/steps/<label>-resume.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const R = require("../recorder.cjs");

const NAME = process.argv[2] || "resume";
const LABEL = process.argv[3] || "walk";
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const num = (flag, fallback) => (argOf(flag) ? Number(argOf(flag)) : fallback);
const REPO = argOf("--repo") ?? null;
const GUIDE_CHF = num("--guide-chf", 0.08);
const NOTES_CHF = num("--notes-chf", 0.008);
const CANCEL = process.argv.includes("--cancel");
// The bench's rate (compose's default): CHF 0.80 per USD.
const usdMicro = (chf) => Math.round((chf / 0.8) * 1_000_000);
const WHERE = "## Where the last run stopped";

const result = { label: LABEL, repo: REPO, checks: [], cards: [], briefs: {}, git: {} };
const out = (s) => console.log(`[resume ${LABEL}] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const enc = encodeURIComponent;
const textOf = (m) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? [])
        .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
        .join("\n");

function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (e) {
    return `(git ${args.join(" ")} failed: ${String(e.stderr || e.message).split("\n")[0]})`;
  }
}

/** The folder a task worked in: the project's workspace, or its own worktree of the repository. */
function folderOf(projectId, taskId) {
  if (!REPO) return R.workspaceOf(NAME, projectId);
  const root = path.join(R.bench(NAME).home, "worktrees");
  const hit = fs.existsSync(root) ? fs.readdirSync(root).find((d) => d.includes(taskId)) : null;
  return hit ? path.join(root, hit) : null;
}

function gitState(projectId, task) {
  const dir = folderOf(projectId, task.id);
  if (!dir || !fs.existsSync(path.join(dir, ".git"))) return { dir, missing: true };
  return {
    dir,
    branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    log: git(dir, ["log", "--oneline", "-6"]).split("\n"),
    status: git(dir, ["status", "--porcelain"]),
    lastBody: git(dir, ["log", "-1", "--format=%B"]),
  };
}

function hostBranches() {
  const b = R.bench(NAME);
  if (!REPO || !b.githost) return null;
  const bare = path.join(path.dirname(b.home), "githost", ...REPO.split("/"));
  const dir = fs.existsSync(bare) ? bare : `${bare}.git`;
  return git(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n");
}

const sessionsOf = async (projectId) => R.api(NAME, "GET", `/sessions?projectId=${enc(projectId)}`);
const tasksOf = async (projectId) => R.api(NAME, "GET", `/projects/${enc(projectId)}/tasks`);
async function waitIdle(projectId, ms = 300_000) {
  await R.until(
    async () => {
      const list = await sessionsOf(projectId);
      const all = Array.isArray(list) ? list : (list.sessions ?? []);
      return (
        all.length > 0 && all.every((s) => !["running", "planned", "paused"].includes(s.status))
      );
    },
    ms,
    1000,
    "the project's sessions to end",
  );
}

async function cardOf(taskId) {
  const inbox = await R.api(NAME, "GET", "/inbox");
  return inbox.requests.find((r) => r.taskId === taskId && r.status === "open") ?? null;
}

/** Press a card's button in the Inbox as the person does; returns the card as it was. */
async function pressInInbox(page, task, pick, shot) {
  const b = R.bench(NAME);
  const card = await cardOf(task.id);
  if (!card) return null;
  result.cards.push({
    task: task.title,
    title: card.title,
    body: card.body,
    choices: (card.choices ?? []).map((c) => ({
      label: c.label,
      explain: c.explain,
      tone: c.tone,
    })),
    links: card.links ?? [],
  });
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} ${shot} card`);
  const choice = (card.choices ?? []).find(pick);
  if (!choice) return { card, pressed: null };
  const item = page.getByTestId("request").filter({ hasText: card.title }).first();
  await item.getByTestId("option").filter({ hasText: choice.label }).first().click();
  const yes = page.getByTestId("choice-confirm-yes");
  if (await yes.count()) await yes.first().click();
  await page.waitForTimeout(1500);
  await R.step(page, `${LABEL} ${shot} pressed`);
  return { card, pressed: choice.label };
}

async function chain(page) {
  const b = R.bench(NAME);
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Resume walk (${LABEL} ${new Date().toISOString().slice(11, 19)})`,
    goal: "An intro, a guide and notes, each within its budget",
    ...(REPO ? { repos: [REPO] } : {}),
  });
  const create = (title, file, chf, dependsOn) =>
    R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title,
      outcome: `${file} is written`,
      acceptanceCriteria: [`${file} exists`],
      priority: "medium",
      status: "ready",
      dependsOn,
      budgetUsdMicro: chf ? usdMicro(chf) : 0,
      specialist: "coder",
      riskTier: 1,
    });
  const intro = await create("Write the intro in intro.md", "intro.md", 0, []);
  const guide = await create("Write the guide in guide.md", "guide.md", GUIDE_CHF, [intro.id]);
  const notes = await create("Write the notes in notes.md", "notes.md", NOTES_CHF, [guide.id]);
  out(`project ${project.id}; guide CHF ${GUIDE_CHF}, notes CHF ${NOTES_CHF}`);
  await R.startSession(NAME, project.id, "resume walk");
  await waitIdle(project.id);
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} tasks after the first session`);
  let rows = await tasksOf(project.id);
  const g1 = rows.find((t) => t.id === guide.id);
  result.guideAfterFirst = { status: g1?.status, display: g1?.display };
  result.git.guidePaused = gitState(project.id, guide);
  result.git.hostWhilePaused = hostBranches();
  check(
    "the guide paused after its wrap-up and reads so",
    /Paused at its budget/.test(g1?.display?.label ?? ""),
    JSON.stringify(g1?.display),
  );
  const paused = result.git.guidePaused;
  check(
    "the guide's work is a work-in-progress commit with its to-do list",
    !paused.missing &&
      // In a project's folder the session's own end commit may sit on top of it.
      (paused.log ?? []).slice(0, 3).some((l) => /Work in progress: Write the guide/.test(l)) &&
      !paused.status,
    JSON.stringify({ log: paused.log?.slice(0, 2), status: paused.status }),
  );
  if (REPO)
    check(
      "nothing of the paused task is pushed (the setting is off)",
      !(result.git.hostWhilePaused ?? []).some((r) => /guide/.test(r)),
      JSON.stringify(result.git.hostWhilePaused),
    );
  // The drawer of the paused task.
  const row = page.getByTestId("task-row").filter({ hasText: guide.title }).first();
  if (await row.count()) {
    await row.click();
    await page.waitForTimeout(1500);
    await R.step(page, `${LABEL} guide drawer paused`);
    await page.keyboard.press("Escape").catch(() => undefined);
  }

  const before = (await sessionsOf(project.id)).length ?? 0;
  const g = await pressInInbox(page, guide, (c) => c.tone === "primary", "guide");
  check(
    "the guide's card offers Continue (CHF N more) and Cancel task",
    /^Continue \(CHF \d+\.\d\d more\)$/.test(g?.pressed ?? "") &&
      (g?.card.choices ?? []).some((c) => c.label === "Cancel task"),
    JSON.stringify(g?.card.choices?.map((c) => c.label)),
  );
  check(
    "the guide's card names its budget, what is done and what is left",
    /paused at its budget of CHF/.test(g?.card.title ?? "") &&
      /Done: .+; left: /.test(g?.card.body ?? ""),
    `${g?.card.title} | ${g?.card.body}`,
  );
  // Continue starts the next session at once.
  const started = await R.until(
    async () => {
      const list = await sessionsOf(project.id);
      return (list.length ?? 0) > before ? list : null;
    },
    15_000,
    250,
    "a session to start after Continue",
  ).catch(() => null);
  check("Continue started a session at once", !!started, String(started?.length ?? 0));
  await waitIdle(project.id);
  rows = await tasksOf(project.id);
  const g2 = rows.find((t) => t.id === guide.id);
  const n2 = rows.find((t) => t.id === notes.id);
  const sessions = await sessionsOf(project.id);
  const second = sessions.find(
    (s) =>
      R.modelCalls(NAME, "specialist").some(
        (c) => c.sessionId === s.id && (c.label ?? "").includes(guide.title),
      ) && s.id !== sessions.at(-1)?.id,
  );
  const mine = new Set((await sessionsOf(project.id)).map((x) => x.id));
  const guideBriefs = R.modelCalls(NAME, "specialist")
    .filter((c) => mine.has(c.sessionId) && (c.label ?? "").includes(guide.title))
    .map((c) => ({
      session: c.sessionId,
      user: textOf((c.messages ?? []).find((m) => m.role === "user") ?? {}),
    }));
  const resumed = [...new Set(guideBriefs.map((x) => x.session))].map(
    (s) => guideBriefs.find((x) => x.session === s)?.user ?? "",
  );
  result.briefs.guide = resumed.map((u) => u.slice(u.indexOf("## "), u.indexOf("## ") + 1500));
  check(
    "the guide's next brief starts from where the last run stopped (its note and to-do list)",
    resumed.length >= 2 && resumed[1].includes(WHERE) && /Left to do/i.test(resumed[1]),
    resumed[1]?.slice(resumed[1].indexOf(WHERE), resumed[1].indexOf(WHERE) + 400) ??
      "(no second run)",
  );
  const critic = R.modelCalls(NAME, "critic").filter(
    (c) => mine.has(c.sessionId) && (c.label ?? "").includes(guide.id),
  );
  const reviewed = [...new Set(critic.map((c) => c.sessionId))];
  check(
    "the guide finished and was reviewed once",
    g2?.status === "done" && reviewed.length === 1,
    JSON.stringify({ status: g2?.status, reviews: reviewed.length, second: second?.id }),
  );
  result.git.guideDone = gitState(project.id, guide);
  // The notes then ran on a tiny budget: no note, its files are listed.
  check(
    "the notes paused at their tiny budget",
    /Paused at its budget/.test(n2?.display?.label ?? ""),
    JSON.stringify(n2?.display),
  );
  result.git.notesPaused = gitState(project.id, notes);
  const n = await pressInInbox(page, notes, (c) => c.tone === "primary", "notes");
  check(
    "the notes' card offers Continue (CHF N more)",
    /^Continue \(CHF \d+\.\d\d more\)$/.test(n?.pressed ?? ""),
    JSON.stringify(n?.card.choices?.map((c) => c.label)),
  );
  await R.until(
    async () =>
      (await sessionsOf(project.id)).some((s) => ["running", "planned"].includes(s.status)),
    15_000,
    250,
    "a session after the notes' Continue",
  ).catch(() => undefined);
  await waitIdle(project.id);
  const ours = new Set((await sessionsOf(project.id)).map((x) => x.id));
  const notesBriefs = R.modelCalls(NAME, "specialist")
    .filter((c) => ours.has(c.sessionId) && (c.label ?? "").includes(notes.title))
    .map((c) => ({
      session: c.sessionId,
      user: textOf((c.messages ?? []).find((m) => m.role === "user") ?? {}),
    }));
  const nResumed = [...new Set(notesBriefs.map((x) => x.session))].map(
    (s) => notesBriefs.find((x) => x.session === s)?.user ?? "",
  );
  result.briefs.notes = nResumed.map((u) => u.slice(u.indexOf("## "), u.indexOf("## ") + 1500));
  // The brief that starts from the pause (a run below even its first step made no call).
  const w = nResumed.find((u) => u.includes(WHERE)) ?? "";
  check(
    "the notes' next brief says the run left no note and lists the files it changed",
    w.includes(WHERE) && /no note/i.test(w) && /notes\.md/.test(w.slice(w.indexOf(WHERE))),
    w.slice(w.indexOf(WHERE), w.indexOf(WHERE) + 400) || "(no second run)",
  );
  rows = await tasksOf(project.id);
  result.final = rows.map((t) => ({ title: t.title, status: t.status, label: t.display?.label }));
  check(
    "every task of the chain is done",
    rows.every((t) => t.status === "done"),
    JSON.stringify(result.final),
  );
  if (REPO) result.git.hostAtEnd = hostBranches();
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} tasks at the end`);
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} overview at the end`);
}

async function cancelWalk(page) {
  const b = R.bench(NAME);
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Cancel walk (${LABEL} ${new Date().toISOString().slice(11, 19)})`,
    goal: "A guide and its summary",
    ...(REPO ? { repos: [REPO] } : {}),
  });
  const create = (title, file, chf, dependsOn) =>
    R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title,
      outcome: `${file} is written`,
      acceptanceCriteria: [`${file} exists`],
      priority: "medium",
      status: "ready",
      dependsOn,
      budgetUsdMicro: chf ? usdMicro(chf) : 0,
      specialist: "coder",
      riskTier: 1,
    });
  const guide = await create("Write the guide in guide.md", "guide.md", GUIDE_CHF, []);
  const summary = await create("Sum up the guide in summary.md", "summary.md", 0, [guide.id]);
  await R.startSession(NAME, project.id, "cancel walk");
  await waitIdle(project.id);
  result.git.cancelPaused = gitState(project.id, guide);
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
  await page.waitForTimeout(2000);
  const row = page.getByTestId("task-row").filter({ hasText: guide.title }).first();
  await row.getByTestId("action-cancel").first().click();
  await page.waitForTimeout(800);
  await R.step(page, `${LABEL} cancel dialog`);
  const explain = await page
    .getByTestId("action-explain")
    .first()
    .textContent()
    .catch(() => "");
  result.cancelDialog = explain;
  check(
    "the Cancel dialog names the task that will be stuck and what happens to the work",
    explain.includes(summary.title) && /set aside|Undo/i.test(explain),
    explain,
  );
  await page.getByTestId("confirm-action").first().click();
  await page.waitForTimeout(1500);
  const moved = await page
    .getByTestId("task-moved-sentence")
    .first()
    .textContent()
    .catch(() => "");
  result.cancelSentence = moved;
  await R.step(page, `${LABEL} cancelled`);
  check(
    "the line after Cancel names the stuck task and the work set aside",
    moved.includes(summary.title) && /set aside/i.test(moved),
    moved,
  );
  const dir = folderOf(project.id, guide.id);
  const gone = dir ? !fs.existsSync(path.join(dir, "guide.md")) : false;
  result.git.cancelled = gitState(project.id, guide);
  check("the paused work is set aside", gone, JSON.stringify(result.git.cancelled));
  const undo = page.getByTestId("task-moved-undo").first();
  if (await undo.count()) {
    await undo.click();
    await page.waitForTimeout(2000);
  }
  const undone = await R.step(page, `${LABEL} undone`);
  const back = dir ? fs.existsSync(path.join(dir, "guide.md")) : false;
  result.git.undone = gitState(project.id, guide);
  check("Undo brings the work back", back, undone.slice(0, 300));
}

async function main() {
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    if (CANCEL) await cancelWalk(page);
    else await chain(page);
  } finally {
    await browser.close();
  }
  const file = path.join(R.bench(NAME).steps, `${LABEL}-resume.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  const failed = result.checks.filter((c) => !c.ok);
  out(`${result.checks.length - failed.length}/${result.checks.length} checks passed; ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
