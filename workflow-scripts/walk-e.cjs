"use strict";
// Review walk E (S-9): what the Inbox's Try again explain says while a session of the project
// runs, and with "Start a session by itself" on, against what the answer then does.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_415a6fe9-606-5/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const NAME = "review-d1109-starts-engine";
const out = {};
const log = (k, v) => {
  out[k] = v;
  console.log(k, JSON.stringify(v));
};
const sessionsOf = async (pid) =>
  (await R.api(NAME, "GET", `/sessions?projectId=${encodeURIComponent(pid)}`)).filter(
    (s) => !/^intake/.test(s.summary || ""),
  );
const addTask = (pid, title) =>
  R.api(NAME, "POST", `/projects/${pid}/tasks`, {
    title,
    outcome: `${title} is written`,
    acceptanceCriteria: [],
    status: "ready",
  });
const cardOf = async (pid) => {
  const inbox = await R.api(NAME, "GET", "/inbox");
  return inbox.requests.find((r) => r.projectId === pid && r.status === "open");
};
const tryAgainExplain = (card) =>
  (card?.choices ?? []).find((c) => c.label === "Try again")?.explain ?? null;
(async () => {
  const { browser, page } = await R.openApp(NAME);
  const ui = R.bench(NAME).uiUrl;
  try {
    await R.skipSetup(page).catch(() => false);
    // Part 1: a failed card while a session of its project runs.
    const p = await R.api(NAME, "POST", "/projects", { name: "Walk explains", goal: "Notes", switch: true });
    await addTask(p.id, "Fail me now");
    const s1 = await R.startSession(NAME, p.id);
    await R.waitForSession(NAME, s1.session?.id ?? (await sessionsOf(p.id))[0].id, 300000);
    log("card idle explain", tryAgainExplain(await cardOf(p.id)));
    await addTask(p.id, "Write slow one in s1.md");
    await addTask(p.id, "Write slow two in s2.md");
    await addTask(p.id, "Write slow three in s3.md");
    const s2 = await R.startSession(NAME, p.id);
    await R.until(async () => (await sessionsOf(p.id)).some((s) => s.status === "running"), 30000, 300, "running");
    const card = await cardOf(p.id);
    log("card explain while the project's session runs", tryAgainExplain(card));
    await page.goto(`${ui}/inbox`);
    await page.waitForTimeout(2500);
    log("inbox while running", await R.step(page, "e-inbox-while-running"));
    const answered = await R.api(NAME, "POST", `/requests/${card.id}/answer`, {
      version: card.version,
      answer: "Try again",
    });
    log("answer outcome while running", answered.outcome ?? answered);
    await R.waitForSession(NAME, s2.session?.id ?? (await sessionsOf(p.id))[0].id, 300000);
    const ev = await R.api(NAME, "GET", `/sessions/${s2.session?.id ?? (await sessionsOf(p.id))[0].id}/events`);
    log("joined in s2", ev.filter((e) => e.type === "session.joined").map((e) => e.payload.title));

    // Part 2: "Start a session by itself" on, nothing running.
    const q = await R.api(NAME, "POST", "/projects", { name: "Walk explains hands off", goal: "Notes" });
    await addTask(q.id, "Fail me later");
    const s3 = await R.startSession(NAME, q.id);
    await R.waitForSession(NAME, s3.session?.id ?? (await sessionsOf(q.id))[0].id, 300000);
    const set = await R.api(NAME, "POST", "/commands/execute", {
      commands: [{ name: "settings.set", params: { key: "start_by_itself", value: true, project: q.id } }],
      source: "ui",
      confirm: "tap",
    });
    log("setting", set.status);
    const card2 = await cardOf(q.id);
    log("card explain with hands-off on", tryAgainExplain(card2));
    const before = (await sessionsOf(q.id)).length;
    const answered2 = await R.api(NAME, "POST", `/requests/${card2.id}/answer`, {
      version: card2.version,
      answer: "Try again",
    });
    log("answer outcome hands-off", answered2.outcome ?? answered2);
    await new Promise((r) => setTimeout(r, 4000));
    log("sessions before/after hands-off answer", [before, (await sessionsOf(q.id)).length]);
  } finally {
    fs.writeFileSync("/tmp/frbench/review-d1109-starts-engine/walk-e.json", JSON.stringify(out, null, 1));
    await browser.close();
  }
})().catch((e) => {
  console.error("WALK FAILED", e);
  process.exit(1);
});
