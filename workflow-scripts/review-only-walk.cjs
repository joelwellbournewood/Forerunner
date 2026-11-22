// Bench walk for the fixup of w15-words (W15B-14): a task whose review waited for the project's
// budget is reviewed only in the next session; from its review line on, the session page, the
// project's line and the chat's facts never say that task runs. A second ready task runs after it
// in the same session, so the time between the review's verdict and the next start is seen too.
// Usage: node review-only-walk.cjs <repo> <bench> <label>
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const REPO = process.argv[2];
const NAME = process.argv[3] || "fixup-w15-words";
const LABEL = process.argv[4] || "after";
const R = require(path.join(REPO, "scripts/bench/recorder.cjs"));
const enc = encodeURIComponent;
const result = { label: LABEL, checks: [], polls: [] };
const out = (s) => console.log(`[review-only ${LABEL}] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const ENDED = ["completed", "stopped", "failed", "killed"];

async function exec(projectId, commands, words) {
  return R.api(NAME, "POST", "/commands/execute", {
    commands,
    wordsUsed: words,
    source: "ui",
    projectId,
    confirm: "tap",
  });
}

async function task(projectId, title, file) {
  return R.api(NAME, "POST", `/projects/${enc(projectId)}/tasks`, {
    title,
    outcome: `${file} exists`,
    acceptanceCriteria: [`${file} exists`],
    priority: "high",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 0,
    specialist: "coder",
    riskTier: 1,
  });
}

(async () => {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Club rules ${LABEL}`,
    goal: "Pages for the club",
  });
  const low = await exec(
    project.id,
    [{ name: "budget.set", params: { scope: "project", amountChf: 0.01, project: project.id } }],
    "Settings: Project budget to 0.01",
  );
  out(`project budget CHF 0.01: ${low.status} ${low.sentence ?? low.reason ?? ""}`);
  const a = await task(project.id, "Make the rules page in rules.html", "rules.html");
  const first = await R.startSession(NAME, project.id, "review-only walk, first session");
  const s1 = await R.waitForSession(NAME, first.session.id, 300_000);
  out(`first session ${s1.status}: ${s1.statusText ?? ""}`);
  const rowA = (await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`)).find(
    (t) => t.id === a.id,
  );
  result.firstRow = { label: rowA?.display?.label, reason: rowA?.reason };
  check(
    "the first session leaves the rules page's review waiting",
    /review/i.test(`${rowA?.display?.label} ${rowA?.reason}`),
    `${rowA?.display?.label}: ${rowA?.reason}`,
  );
  const bTask = await task(project.id, "Make the members page in members.html", "members.html");

  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2000);
    await R.step(page, `${LABEL} inbox review waits`);
    const raised = await exec(
      project.id,
      [{ name: "budget.set", params: { scope: "project", amountChf: 5, project: project.id } }],
      "Settings: Project budget to 5",
    );
    out(`project budget CHF 5: ${raised.status} ${raised.sentence ?? raised.reason ?? ""}`);
    // The waiting review's session (the wake starts it).
    const second = await R.until(
      async () => {
        const all = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`);
        const list = Array.isArray(all) ? all : (all.sessions ?? all.items ?? []);
        return list.find((s) => s.id !== first.session.id) ?? null;
      },
      60_000,
      100,
      "the second session to start",
    );
    out(`second session ${second.id}`);
    await page.goto(`${b.uiUrl}/sessions/${enc(second.id)}`);
    let shotDuring = false;
    let reviewSeenAt = -1;
    for (let i = 0; i < 3000; i++) {
      const [view, events, card] = await Promise.all([
        R.api(NAME, "GET", `/sessions/${enc(second.id)}`),
        R.api(NAME, "GET", `/sessions/${enc(second.id)}/events`),
        R.api(NAME, "GET", `/projects/${enc(project.id)}`),
      ]);
      const pageCurrent = await page
        .locator('[data-testid="current-task"]')
        .first()
        .textContent({ timeout: 500 })
        .catch(() => null);
      const types = events.map((e) => e.type);
      const reviewed = types.includes("critic.review_resumed") || events.some((e) => e.payload?.reviewOnly);
      const verdictA = events.some((e) => e.type === "critic.verdict" && e.payload?.taskId === a.id);
      if (reviewed && reviewSeenAt < 0) reviewSeenAt = i;
      result.polls.push({
        i,
        status: view.status,
        currentTask: view.currentTask?.title ?? null,
        working: card.working?.taskTitle ?? null,
        statusLine: card.statusLine?.text ?? null,
        page: pageCurrent,
        reviewLine: reviewed,
        verdictA,
        last: types.at(-1),
      });
      if (reviewed && !shotDuring && !ENDED.includes(view.status)) {
        shotDuring = true;
        await R.step(page, `${LABEL} session during the review`);
      }
      if (ENDED.includes(view.status)) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    await page.waitForTimeout(1500);
    const said = await R.step(page, `${LABEL} session ended`);
    const events = await R.api(NAME, "GET", `/sessions/${enc(second.id)}/events`);
    const person = events.filter((e) => e.audience === "person").map((e) => e.text);
    result.person = person;
    const reviewLine = `The critic reviews "${a.title}": its work was done in an earlier session.`;
    check("the log has the review line once", person.filter((l) => l === reviewLine).length === 1, reviewLine);
    check(
      "the critic's verdict follows it",
      person.indexOf(`The critic accepted "${a.title}".`) > person.indexOf(reviewLine),
    );
    check(
      "no start line for the reviewed task",
      !person.some((l) => /started "Make the rules page/.test(l)),
    );
    check(
      "the members page runs after it in the same session",
      person.some((l) => /The coder started "Make the members page/.test(l)),
    );
    check("no task.started for the reviewed task", !events.some((e) => e.type === "task.started" && e.payload?.taskId === a.id));
    const running = result.polls.filter((p) => !ENDED.includes(p.status));
    check(
      "while the session ran, GET /sessions/:id never named the reviewed task",
      !running.some((p) => p.currentTask === a.title),
      [...new Set(running.map((p) => p.currentTask))].join(" | "),
    );
    check(
      "the project's line never said it works on the reviewed task",
      !running.some((p) => p.working === a.title || (p.statusLine ?? "").includes("rules page")),
      [...new Set(running.map((p) => p.statusLine))].join(" | "),
    );
    check(
      "the session page's Current task never named the reviewed task",
      !running.some((p) => (p.page ?? "").includes("rules page")),
      [...new Set(running.map((p) => p.page))].join(" | "),
    );
    check(
      "polls after the verdict and before the end were seen",
      running.some((p) => p.verdictA),
      `${running.filter((p) => p.verdictA).length} polls`,
    );
    check(
      "the members page was seen as the current task while it ran",
      running.some((p) => p.currentTask === bTask.title),
    );
    result.endedText = said.slice(0, 2000);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2000);
    await R.step(page, `${LABEL} tasks after`);
  } finally {
    await browser.close();
  }
  const file = path.join(path.dirname(R.bench(NAME).home), "steps", `${LABEL}-review-only.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  out(`result: ${file}`);
  process.exit(result.checks.every((c) => c.ok) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
