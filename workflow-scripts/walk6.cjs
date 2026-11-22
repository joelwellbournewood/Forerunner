// Review walk part 6: the plan card's note (OS-5) under a task above the project's session work
// budget; set through the project's settings route as the Settings screen does.
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-5/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "review-d1109-oversize-start";
const out = {};

(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  const brief =
    "A small web page for a bakery: a home page with the opening hours, a page listing the breads with prices, and a contact form. Plain HTML, CSS and a little JavaScript.";
  const existing = process.argv[2];
  const p = existing ? { id: existing } : await R.api(N, "POST", "/projects", {
    name: "Bakery",
    goal: "A web page for a bakery",
    brief,
    intake: true,
  });
  out.project = p.id;
  const card = async () => {
    const inbox = await R.api(N, "GET", "/inbox");
    const reqs = inbox.requests ?? inbox;
    return reqs.find((r) => r.projectId === p.id && r.status === "open" && r.planTasks);
  };
  await R.until(async () => !!(await card()), 120_000, 1500, "the plan card");
  const first = await card();
  out.before = first.planTasks.map((t) => ({
    title: t.title,
    est: t.estimateUsdMicro,
    oversized: t.oversized ?? null,
  }));
  const figures = first.planTasks.map((t) => t.estimateUsdMicro ?? 0).filter((n) => n > 0);
  const max = Math.max(...figures);
  const min = Math.min(...figures);
  // A session cap whose work budget lies between the smallest and the largest figure.
  const work = Math.floor((max + min) / 2);
  const cap = Math.ceil(work / 0.8);
  out.cap = cap;
  const proj = await R.api(N, "GET", `/projects/${p.id}`);
  out.projectKeys = Object.keys(proj);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync("/tmp/frbench/review-d1109-oversize-start/home/data/state.sqlite", { readOnly: true });
  const version = db.prepare("select version from project where id = ?").get(p.id).version;
  db.close();
  const settings = {};
  const put = await R.apiRaw(N, "PUT", `/projects/${p.id}/settings`, {
    version,
    settings: { ...settings, session_cap_usd_micro: cap },
  });
  out.put = { status: put.status, body: JSON.stringify(put.body).slice(0, 400) };
  const second = await card();
  out.after = second.planTasks.map((t) => ({
    title: t.title,
    est: t.estimateUsdMicro,
    oversized: t.oversized ?? null,
  }));
  await page.goto(`${ui}/inbox`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  out.notes = await page.getByTestId("intake-task-oversized").allInnerTexts();
  await R.step(page, "plan card with a small session budget");
  fs.writeFileSync("/tmp/frbench/review-d1109-oversize-start/walk6.json", JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    "/tmp/frbench/review-d1109-oversize-start/walk6.json",
    JSON.stringify({ ...out, error: String(e.stack || e) }, null, 2),
  );
  process.exit(1);
});
