// w15-tail bench walk (W15B-01, W15B-02): node walk.cjs <bench> <label> <repo checkout>
//  01: a done task with an open pull request; the person commits in its task folder; the Tasks
//      row's Redo; a session. Is the commit still on the task's branch? What do the row and the
//      Inbox say?
//  02: a project made with the New project dialog, a ready task added, the creation's Undo in
//      Changes. What does its page offer? Does POST /sessions start a session on it?
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const NAME = process.argv[2];
const LABEL = process.argv[3];
const ROOT = process.argv[4];
const ONLY = process.argv[5] ?? "all";
const R = require(path.join(ROOT, "scripts/bench/recorder.cjs"));
const enc = encodeURIComponent;
const result = { label: LABEL, checks: [], facts: {} };
const out = (s) => console.log(`[w15-tail ${LABEL}] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Pat",
  GIT_AUTHOR_EMAIL: "pat@example.test",
  GIT_COMMITTER_NAME: "Pat",
  GIT_COMMITTER_EMAIL: "pat@example.test",
};
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

async function sessionsOf(projectId) {
  const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(projectId)}`);
  return Array.isArray(list) ? list : (list.sessions ?? []);
}
async function waitIdle(projectId, ms = 300_000) {
  await R.until(
    async () => {
      const all = await sessionsOf(projectId);
      return all.length > 0 && all.every((s) => !["running", "planned", "paused"].includes(s.status));
    },
    ms,
    1000,
    "the project's sessions to end",
  );
}
function folderOf(home, taskId) {
  const found = execFileSync("find", [home, "-maxdepth", "4", "-type", "d", "-name", taskId], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((l) => l && fs.existsSync(path.join(l, ".git")));
  return found[0] ?? null;
}

async function journeyRedo(page, b) {
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Redo keeps my commit (${LABEL})`,
    goal: "A page and its notes",
    repos: ["bench/seeded"],
  });
  const create = (title, file) =>
    R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title,
      outcome: `${file} is written`,
      acceptanceCriteria: [`${file} exists`],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      specialist: "coder",
      riskTier: 1,
    });
  const task = await create("Write the page in page.html", "page.html");
  out(`project ${project.id} task ${task.id}`);
  await R.startSession(NAME, project.id, "w15-tail walk: first run");
  await waitIdle(project.id);
  const tasks = async () => R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
  const row = async () => (await tasks()).find((t) => t.id === task.id);
  let r = await row();
  check("the task is done with an open pull request", r?.status === "done" && !!r?.prUrl, `${r?.status} ${r?.prUrl}`);
  const dir = folderOf(b.home, task.id);
  check("the task folder is on this computer", !!dir, String(dir));
  const branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  // The person commits a file in the task folder.
  fs.writeFileSync(path.join(dir, "my-notes.txt"), "Notes I wrote myself\n");
  git(dir, ["add", "my-notes.txt"]);
  git(dir, ["commit", "-qm", "My own notes"]);
  const mine = git(dir, ["rev-parse", "HEAD"]);
  result.facts.redo = { dir, branch, mine };
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} 01 tasks before redo`);
  // The Tasks row's Redo, as a person presses it.
  const rowEl = page.locator(`[data-testid="task-row"][data-task-id="${task.id}"]`);
  const redo = rowEl.getByRole("button", { name: /^Redo/ });
  if (await redo.count()) {
    await redo.first().click();
    await page.waitForTimeout(1000);
    const confirm = page.getByRole("button", { name: /^Redo/ }).last();
    if (await confirm.isVisible().catch(() => false)) await confirm.click().catch(() => undefined);
  } else {
    const t = await row();
    await R.api(NAME, "POST", `/tasks/${enc(task.id)}/action`, { version: t.version, action: "redo" });
  }
  await page.waitForTimeout(1500);
  await R.step(page, `${LABEL} 01 tasks after redo`);
  r = await row();
  check("Redo made the task ready", r?.status === "ready", r?.status);
  const before = (await R.modelCalls(NAME, "specialist")).length;
  const held = await R.startSession(NAME, project.id, "w15-tail walk: after the redo");
  const heldId = held?.id ?? held?.sessionId ?? held;
  await waitIdle(project.id);
  const after = (await R.modelCalls(NAME, "specialist")).length;
  r = await row();
  result.facts.redo.after = { status: r?.status, display: r?.display, specialistCalls: after - before };
  let kept = "";
  try {
    kept = git(dir, ["branch", "--contains", mine]);
  } catch (e) {
    kept = `error: ${String(e.message).split("\n")[0]}`;
  }
  result.facts.redo.branchesHolding = kept;
  check("the person's commit is still on the task's branch", kept.includes(branch), JSON.stringify(kept));
  check("my-notes.txt is still in the task folder", fs.existsSync(path.join(dir, "my-notes.txt")));
  check("no specialist call ran for the task", after === before, `${after - before} calls`);
  check("the task waits for the person", r?.status === "needs_human", `${r?.status} ${JSON.stringify(r?.display)}`);
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} 01 tasks after the session`);
  const inbox = await R.api(NAME, "GET", "/inbox");
  const cards = inbox.requests.filter((c) => c.taskId === task.id && c.status === "open");
  result.facts.redo.cards = cards.map((c) => ({ title: c.title, body: c.body, options: c.options }));
  check(
    "one card names the folder's commit and Try again",
    cards.length === 1 && /commit that is not on GitHub/.test(cards[0].body ?? "") && /Try again/.test(cards[0].body ?? ""),
    JSON.stringify(result.facts.redo.cards),
  );
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} 01 inbox after the session`);
  // The merge step's read (W15B-79): the session log's line for the held task.
  const all = await sessionsOf(project.id);
  const last = [...all].sort((a, b2) => String(b2.startedAt ?? b2.createdAt ?? "").localeCompare(String(a.startedAt ?? a.createdAt ?? "")))[0];
  const sid = typeof heldId === "string" ? heldId : last?.id;
  result.facts.redo.sessionId = sid;
  await page.goto(`${b.uiUrl}/sessions/${enc(sid)}`);
  await page.waitForTimeout(3000);
  const logText = await R.step(page, `${LABEL} 01 session log of the held task`);
  const lines = logText.split("\n").filter((l) => l.includes("Write the page in page.html"));
  result.facts.redo.sessionLogLines = lines;
  check(
    "the session log says the held task could not run, in the hold's words",
    lines.some((l) => /could not run: its task folder has a commit that is not on GitHub/.test(l)),
    JSON.stringify(lines),
  );
  check(
    "the session log does not say the held task asked questions",
    !lines.some((l) => /has questions for you/.test(l)),
    JSON.stringify(lines),
  );
  return { project, task };
}

async function journeyRemoved(page, b) {
  // The New project dialog's creation (one change, with its Undo in Changes).
  const created = await R.api(NAME, "POST", "/projects", {
    name: `Removed one (${LABEL})`,
    goal: "Something I did not mean to make",
    switch: true,
  });
  const projectId = created.id;
  await R.api(NAME, "POST", `/projects/${enc(projectId)}/tasks`, {
    title: "Write the readme in README.md",
    outcome: "README.md is written",
    acceptanceCriteria: ["README.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    specialist: "coder",
    riskTier: 1,
  });
  const changes = await R.api(NAME, "GET", "/changes");
  const list = Array.isArray(changes) ? changes : (changes.changes ?? changes.rows ?? []);
  const row = list.find((c) => c.projectId === projectId && /project/i.test(c.sentence ?? ""));
  result.facts.removed = { projectId, change: row ? { id: row.id, sentence: row.sentence } : null };
  check("the creation is in Changes", !!row, JSON.stringify(list.slice(0, 3).map((c) => c.sentence)));
  await page.goto(`${b.uiUrl}/changes`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} 02 changes before undo`);
  const undone = await R.api(NAME, "POST", `/changes/${enc(row.id)}/undo`);
  result.facts.removed.undo = undone;
  check("the creation's Undo went through", undone.status === "done", JSON.stringify(undone).slice(0, 300));
  const p = await R.api(NAME, "GET", `/projects/${enc(projectId)}`);
  result.facts.removed.status = p.status;
  check("GET /projects/:id says archived", p.status === "archived", p.status);
  await page.goto(`${b.uiUrl}/projects/${enc(projectId)}/summary`);
  await page.waitForTimeout(2500);
  const text = await R.step(page, `${LABEL} 02 removed project page`);
  check("the page says the project was removed", /This project was removed\./.test(text));
  check("the page offers no Start session", !(await page.locator('[data-testid="start-session"]').count()));
  check("the page offers no Create a repository", !(await page.locator('[data-testid="create-repo"]').count()));
  const sessionsBefore = (await sessionsOf(projectId)).length;
  const agent = (await R.api(NAME, "GET", "/agents"))[0];
  const started = await R.apiRaw(NAME, "POST", "/sessions", {
    agentId: agent.id,
    projectId,
    trigger: "manual",
    reason: "w15-tail walk: a start on a removed project",
  });
  result.facts.removed.start = started;
  await sleep(3000);
  const sessionsAfter = (await sessionsOf(projectId)).length;
  check("POST /sessions is refused in one sentence", started.status >= 400 && /was removed/.test(JSON.stringify(started.body)), JSON.stringify(started).slice(0, 300));
  check("no session row for the removed project", sessionsAfter === sessionsBefore, `${sessionsBefore} -> ${sessionsAfter}`);
  if (sessionsAfter > sessionsBefore) await waitIdle(projectId).catch(() => undefined);
}

(async () => {
  const b = R.bench(NAME);
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    if (ONLY === "all" || ONLY === "redo") await journeyRedo(page, b);
    if (ONLY === "all" || ONLY === "removed") await journeyRemoved(page, b);
  } catch (e) {
    check("walk finished", false, String(e.stack ?? e).slice(0, 800));
  } finally {
    fs.writeFileSync(
      path.join(path.dirname(b.home), "steps", `${LABEL}-w15-tail.json`),
      JSON.stringify(result, null, 2),
    );
    await browser.close();
  }
})();
