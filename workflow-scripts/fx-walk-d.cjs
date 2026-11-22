// review-polish-words walk D: a repository task whose run changes no file (L-18): the failed-task
// card, the Overview's Last result, the Updates line, the session result, the Tasks row.
"use strict";
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-11";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const NAME = "fixup-polish-words";
const [PID] = process.argv.slice(2);
const out = (s) => console.log(`[walk D] ${s}`);
const result = { texts: {} };

(async () => {
  const { browser, page } = await R.openApp(NAME);
  const base = R.bench(NAME).uiUrl.replace(/\?.*$/, "").replace(/\/$/, "");
  const created = await R.api(NAME, "POST", `/projects/${PID}/tasks`, {
    title: "Style the guides in docs/style.css",
    outcome: "docs/style.css styles the guides",
    specialist: "coder",
    riskTier: 1,
  });
  const taskId = created.task?.id ?? created.id;
  const started = await R.startSession(NAME, PID);
  const sid = started.session?.id ?? started.sessionId ?? started.id;
  out(`session ${sid} task ${taskId}`);
  const s = await R.waitForSession(NAME, sid, 400_000);
  result.session = { status: s.status, statusText: s.statusText, summary: s.summary };
  out(`session ${JSON.stringify(result.session)}`);
  const t = (await R.api(NAME, "GET", `/projects/${PID}/tasks`)).find((x) => x.id === taskId);
  result.task = { status: t.status, reason: t.reason, display: t.display };
  out(`task ${JSON.stringify(result.task)}`);
  const inbox = await R.api(NAME, "GET", "/inbox");
  const card = inbox.requests.find((r) => r.taskId === taskId && r.status === "open");
  result.card = card ? { title: card.title, body: card.body, why: card.why } : null;
  out(`card ${JSON.stringify(result.card)}`);
  result.updates = inbox.messages.filter((m) => m.projectId === PID).map((m) => m.body);
  out(`updates ${JSON.stringify(result.updates)}`);
  // fixup: a cost under a centime is money, not news: no Update says only that.
  result.costOnlyUpdate = result.updates.some((b) => /^[^:]+: (?:[Ll]ess than )?CHF \d+\.\d\d\.$/.test(b ?? ""));
  out(`${result.costOnlyUpdate ? "FAIL" : "PASS"} no Update that says only the cost :: ${JSON.stringify(result.updates)}`);
  await page.goto(`${base}/inbox`);
  await page.waitForTimeout(2000);
  result.texts.inbox = await R.step(page, "41-inbox-empty-change");
  await page.goto(`${base}/projects/${PID}`);
  await page.waitForTimeout(2500);
  result.texts.overview = await R.step(page, "42-overview-empty-change");
  await page.goto(`${base}/projects/${PID}/tasks?task=${taskId}`);
  await page.waitForTimeout(2500);
  result.texts.drawer = await R.step(page, "43-drawer-empty-change");
  await page.goto(`${base}/sessions/${sid}`);
  await page.waitForTimeout(2500);
  result.texts.session = await R.step(page, "44-session-empty-change");
  const all = Object.values(result.texts).join("\n");
  out(`markdown left on screens: ${/\*\*|`/.test(all)}`);
  out(`'no changes were made' left: ${/no changes were made/.test(all)}`);
  fs.writeFileSync(`/tmp/frbench/${NAME}/steps/walk-d.json`, JSON.stringify(result, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
