// Fixup walk (budget-resume, blocking 1): a task paused at the project's budget of CHF 0.01
// below the 80% line. Watch 3 minutes without touching anything (before the fix: a session every
// tick); then raise the project's budget as Settings does and see it go on once and finish.
"use strict";
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_3eff7ab7-708-6/scripts/bench/recorder.cjs");
const NAME = "fixup-budget-resume";
const enc = encodeURIComponent;
const CHF = Number(process.argv[2] || "0.01");
const WATCH_MS = Number(process.argv[3] || "180000");
const out = { chf: CHF, watch: [], checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};

(async () => {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Project budget walk ${new Date().toISOString().slice(11, 19)}`,
    goal: "A guide within a small project budget",
  });
  const set = await R.api(NAME, "POST", "/commands/execute", {
    commands: [{ name: "budget.set", params: { scope: "project", project: project.id, amountChf: CHF } }],
    source: "ui",
    confirm: "tap",
  });
  console.log("project budget set:", set.status, JSON.stringify(set.sentence ?? ""));
  const task = await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Write the guide for the project budget",
    outcome: "pbudget.md is written",
    acceptanceCriteria: ["pbudget.md exists"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    specialist: "coder",
    riskTier: 1,
  });
  const started = await R.api(NAME, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    reason: "project budget walk",
  });
  const sid = started.session?.id;
  const s = await R.waitForSession(NAME, sid);
  console.log("first session", s.status, s.statusText, "|", s.summary);
  out.firstSummary = s.summary;
  check("the result says how it goes on, not continue", /it goes on by itself once that limit is raised or resets\./.test(s.summary ?? "") && !/continue or cancel/.test(s.summary ?? ""), s.summary);
  const t = (await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`)).find((x) => x.id === task.id);
  console.log("task", t.status, JSON.stringify(t.display), "actual", JSON.stringify(t.actual));
  out.pausedDisplay = t.display;
  check("the task paused at the project's budget", t.display?.label === "Paused at the project's budget", t.display?.label);
  check(
    "its row says what wakes it",
    t.display?.detail === "It goes on by itself once that limit is raised or resets; cancel it in the Inbox.",
    t.display?.detail,
  );
  const inbox = await R.api(NAME, "GET", "/inbox");
  const card = inbox.requests.find((r) => r.taskId === task.id && r.status === "open");
  out.card = { title: card?.title, body: card?.body, choices: card?.choices?.map((c) => c.label), links: card?.links };
  console.log("CARD:", card?.title, "|", card?.body, "|", JSON.stringify(card?.choices?.map((c) => c.label)), JSON.stringify(card?.links));
  check("one card, Cancel task only", JSON.stringify(card?.choices?.map((c) => c.label)) === '["Cancel task"]');
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/`);
    await page.waitForTimeout(1500);
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await R.step(page, "fx project budget card");
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks?task=${enc(task.id)}`);
    await page.waitForTimeout(2500);
    await R.step(page, "fx project budget paused row");
    // Watch: sessions of the project, the task's status, its cards.
    const t0 = Date.now();
    while (Date.now() - t0 < WATCH_MS) {
      await new Promise((r) => setTimeout(r, 15_000));
      const l = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`);
      const all = Array.isArray(l) ? l : (l.sessions ?? []);
      const tt = (await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`)).find((x) => x.id === task.id);
      const ib = await R.api(NAME, "GET", "/inbox");
      const cards = ib.requests.filter((r) => r.taskId === task.id);
      const row = {
        s: Math.round((Date.now() - t0) / 1000),
        sessions: all.length,
        task: tt.status,
        label: tt.display?.label,
        cards: cards.map((c) => c.status),
      };
      out.watch.push(row);
      console.log(JSON.stringify(row));
    }
    const last = out.watch.at(-1);
    check("nothing changed: no new session while watched", last?.sessions === 1, `sessions=${last?.sessions}`);
    check("the task stays paused with its one card", last?.task === "needs_human" && JSON.stringify(last?.cards) === '["open"]', JSON.stringify(last));
    const notes = await R.api(NAME, "GET", "/notifications/recent?limit=200");
    const mine = (notes.notifications ?? []).filter((n) => n.projectId === project.id);
    out.notificationsWhileWatched = mine.map((n) => `${n.kind}: ${n.title}`);
    check("no notification repeated while watched", new Set(out.notificationsWhileWatched).size === mine.length && mine.filter((n) => n.kind === "budget_stop").length === 1, `${mine.length}: ${out.notificationsWhileWatched.join(" | ")}`);

    // The person raises the project's budget as Settings does.
    const raised = await R.api(NAME, "POST", "/commands/execute", {
      commands: [{ name: "budget.set", params: { scope: "project", project: project.id, amountChf: 5 } }],
      source: "ui",
      confirm: "tap",
    });
    console.log("raised:", raised.status, JSON.stringify(raised.sentence ?? ""));
    const done = await R.until(async () => {
      const tt = (await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`)).find((x) => x.id === task.id);
      return tt.status === "done" ? tt : undefined;
    }, 180_000).catch(() => undefined);
    const l = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`);
    const all = Array.isArray(l) ? l : (l.sessions ?? []);
    const ib = await R.api(NAME, "GET", "/inbox");
    const cards = ib.requests.filter((r) => r.taskId === task.id);
    out.after = { task: done?.status, sessions: all.map((x) => [x.status, x.trigger]), cards: cards.map((c) => [c.status, c.outcome]) };
    console.log("after raise:", JSON.stringify(out.after));
    check("after the raise it went on and finished", done?.status === "done");
    check("exactly one more session", all.length === 2, `sessions=${all.length}`);
    check(
      "its card closed with 'goes on'",
      cards.length === 1 && cards[0].status === "withdrawn" && /goes on: its limit has room again/.test(cards[0].outcome ?? ""),
      JSON.stringify(cards.map((c) => [c.status, c.outcome])),
    );
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    await R.step(page, "fx project budget after raise tasks");
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await R.step(page, "fx project budget after raise inbox");
  } finally {
    await browser.close();
  }
  fs.writeFileSync(`${b.steps ?? "/tmp/frbench/fixup-budget-resume/steps"}/fx-wake.json`, JSON.stringify(out, null, 1));
  const failed = out.checks.filter((c) => !c.ok).length;
  console.log(`${out.checks.length - failed}/${out.checks.length} checks passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
