// Neighbouring journey: the person answers a person task's card (answers are written to the
// decision record in the project folder) while another task runs, then cancels that running
// task. Do the answers stay in the decision record?
const R = require("/home/user/Forerunner/.claude/worktrees/wf_2c4365d2-5b3-5/scripts/bench/recorder.cjs");
const fs = require("fs");
const path = require("path");
const N = "review-continuity";
const UI = "http://127.0.0.1:1671";
const OUT = "/tmp/frbench/review-continuity/steps";
const log = (...a) => console.log("[g]", ...a);
(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  const res = {};
  try {
    await R.skipSetup(page);
    const { projectId, tasks } = await R.createPlannedProject(N, {
      project: "Bakery two",
      goal: "A website for the bakery",
      brief: "A one-page website for a small bakery in Bern with its menu and hours.",
    });
    const ws = R.workspaceOf(N, projectId);
    log(tasks.map((t) => `${t.title} [${t.status}] ${t.specialist}`));
    const person = tasks.find((t) => t.specialist === "person");
    const build = tasks.find((t) => t.specialist !== "person" && t.dependsOn.length === 0);
    // While "build" runs and has written a file, answer the person's card.
    await R.until(async () => {
      const t = (await R.api(N, "GET", `/projects/${projectId}/tasks`)).find((x) => x.id === build.id);
      if (["in_review", "done"].includes(t.status)) throw new Error(`too late: ${t.status}`);
      return ["claimed", "in_progress"].includes(t.status) && fs.existsSync(path.join(ws, "index.html")) ? t : null;
    }, 200_000, 300, "build running with index.html written");
    await page.goto(`${UI}/inbox`);
    await page.waitForTimeout(1000);
    const box = page.getByTestId("request").filter({ hasText: person.title });
    const fields = box.getByTestId("person-answer");
    const n = await fields.count();
    const answers = ["Only as a local file on my laptop for now.", "English and German, please."];
    for (let i = 0; i < n; i++) await fields.nth(i).fill(answers[i] ?? "Yes.");
    await box.getByTestId("send-answers").first().click();
    await page.waitForTimeout(1500);
    const docDir = path.join(ws, "docs", "decisions");
    const docs = () => fs.readdirSync(docDir).map((f) => fs.readFileSync(path.join(docDir, f), "utf8")).join("\n");
    res.answersInDocBeforeCancel = docs().includes("Only as a local file on my laptop");
    const t = (await R.api(N, "GET", `/projects/${projectId}/tasks`)).find((x) => x.id === build.id);
    res.buildStatusAtCancel = t.status;
    await page.goto(`${UI}/projects/${projectId}/tasks`);
    await page.waitForTimeout(800);
    const row = page.getByTestId("task-row").filter({ hasText: build.title });
    await row.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Cancel task", exact: true }).click();
    await page.waitForTimeout(1500);
    res.line = (await R.step(page, "g-cancelled")).split("New task")[1]?.slice(0, 400);
    await R.until(async () => (!fs.existsSync(path.join(ws, "index.html")) ? true : null), 30_000, 300, "index.html removed").catch(() => null);
    res.indexGone = !fs.existsSync(path.join(ws, "index.html"));
    res.answersInDocAfterCancel = docs().includes("Only as a local file on my laptop");
    const sessions = await R.api(N, "GET", `/sessions?projectId=${projectId}`);
    for (const s of sessions) if (s.status === "running") await R.waitForSession(N, s.id, 200_000);
    res.answersInDocAfterSession = docs().includes("Only as a local file on my laptop");
    await page.goto(`${UI}/projects/${projectId}/files`);
    await page.waitForTimeout(1500);
    await R.step(page, "g-files");
  } finally {
    fs.writeFileSync(`${OUT}/g-result.json`, JSON.stringify(res, null, 1));
    console.log(JSON.stringify(res, null, 1));
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
