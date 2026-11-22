// Chat cancel of a running task: add "Add a contact page in contact.html", start a session, and while it
// runs (faq.html written) type the phrase in the project's chat, then Yes.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_2c4365d2-5b3-5/scripts/bench/recorder.cjs");
const fs = require("fs");
const path = require("path");
const N = "review-continuity";
const UI = "http://127.0.0.1:1671";
const OUT = "/tmp/frbench/review-continuity/steps";
const projectId = process.argv[2];
const phrase = process.argv[3];
(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  const res = {};
  try {
    await R.skipSetup(page);
    const ws = R.workspaceOf(N, projectId);
    const added = await R.api(N, "POST", `/projects/${projectId}/tasks`, {
      title: "Add a contact page in contact.html",
      outcome: "contact.html says how to reach the club.",
      acceptanceCriteria: ["contact.html exists"],
      priority: "high",
      specialist: "coder",
      riskTier: 1,
    });
    const id = added.task?.id ?? added.id;
    await R.startSession(N, projectId);
    await R.until(async () => {
      const t = (await R.api(N, "GET", `/projects/${projectId}/tasks`)).find((x) => x.id === id);
      if (["in_review", "done"].includes(t.status)) throw new Error(`too late: ${t.status}`);
      return ["claimed", "in_progress"].includes(t.status) && fs.existsSync(path.join(ws, "contact.html")) ? t : null;
    }, 200_000, 300, "contact running with contact.html written");
    await page.goto(`${UI}/projects/${projectId}/chat`);
    await page.waitForTimeout(1000);
    const input = page.getByPlaceholder("Message your agent…");
    await input.fill(phrase);
    await input.press("Enter");
    await page.waitForTimeout(2500);
    res.afterSkip = (await R.step(page, "b6-chat-cancel")).split("Make this a task").slice(-1)[0].slice(0, 600);
    const yes = page.getByRole("button", { name: "Yes", exact: true });
    if (await yes.count()) {
      await yes.last().click();
      await page.waitForTimeout(2500);
      res.afterYes = (await R.step(page, "b6-chat-yes")).split("Make this a task").slice(-1)[0].slice(0, 800);
    }
    const t = (await R.api(N, "GET", `/projects/${projectId}/tasks`)).find((x) => x.id === id);
    res.statusAfter = t.status;
    const gone = await R.until(async () => (!fs.existsSync(path.join(ws, "contact.html")) ? true : null), 20_000, 300, "contact.html removed").catch(() => false);
    res.faqGone = gone === true;
    const sessions = await R.api(N, "GET", `/sessions?projectId=${projectId}`);
    for (const s of sessions) if (s.status === "running") await R.waitForSession(N, s.id, 200_000);
    const critic = R.modelCalls(N, "critic").filter((c) => JSON.stringify(c.messages).includes("Add a FAQ page"));
    res.criticCalls = critic.length;
    res.faqAfterSession = fs.existsSync(path.join(ws, "contact.html"));
    await page.goto(`${UI}/projects/${projectId}/tasks`);
    await page.waitForTimeout(1500);
    await R.step(page, "b6-tasks-after");
  } finally {
    fs.writeFileSync(`${OUT}/b6-result.json`, JSON.stringify(res, null, 1));
    console.log(JSON.stringify(res, null, 1));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
