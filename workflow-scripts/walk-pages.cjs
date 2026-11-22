// Two pages shown (Show older still offered), a session ends: the 40 rows stay, the one that
// ended joins the top, and Show older goes on from the oldest shown to the very first session.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-8/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "fixup-d1109-sessions";
const OUT = "/tmp/frbench/fixup-d1109-sessions-evidence";
const seed = JSON.parse(fs.readFileSync(`${OUT}/seed.json`, "utf8"));
const pid = seed.projectId;
const result = { checks: {}, requests: [] };
const check = (name, ok, detail) => {
  result.checks[name] = { ok: !!ok, ...(detail !== undefined ? { detail } : {}) };
  console.log(ok ? "PASS" : "FAIL", name, detail !== undefined ? JSON.stringify(detail) : "");
};
const hrefs = (page) =>
  page.$$eval('[data-testid="session-row"]', (els) => els.map((e) => e.getAttribute("href")));
const heading = (page) => page.locator('[data-testid="sessions-heading"]').textContent();

(async () => {
  const { browser, page } = await R.openApp(N, { path: `/projects/${pid}/sessions` });
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes(`/projects/${pid}/sessions`)) {
      const q = new URL(u).searchParams;
      result.requests.push({ at: new Date().toISOString(), before: !!q.get("before"), limit: q.get("limit") });
    }
  });
  const count0 = (await R.api(N, "GET", `/projects/${pid}/sessions`)).count;
  result.countBefore = count0;
  await R.until(async () => (await hrefs(page)).length === 20, 20_000, 500, "20 rows");
  await page.click('[data-testid="sessions-older"]');
  await R.until(async () => (await hrefs(page)).length === 40, 20_000, 500, "40 rows");
  const before = await hrefs(page);
  check("40 of the sessions shown with Show older still offered", before.length === 40 && (await page.$('[data-testid="sessions-older"]')) !== null, { count0, heading: await heading(page) });
  await R.step(page, `sessions tab, 40 of ${count0} rows`);

  await R.api(N, "POST", `/projects/${pid}/tasks`, {
    title: "Long essay three in essay3.md",
    outcome: "essay3.md exists",
    riskTier: 1,
    specialist: "writer",
  });
  const sid = (await R.startSession(N, pid)).session?.id;
  await page.waitForSelector('[data-testid="session-row-working"]', { timeout: 20_000 });
  await page.waitForTimeout(8_000);
  const during = await hrefs(page);
  check("while it works the 40 ended rows stay as they were", JSON.stringify(during) === JSON.stringify(before), { rows: during.length });
  await R.step(page, "working row on top of the 40 rows");
  await R.api(N, "POST", `/sessions/${sid}/stop`, { reason: "stopped by the fix-up's walk" });
  await R.waitForSession(N, sid);
  await R.until(async () => (await page.$('[data-testid="session-row-working"]')) === null, 30_000, 500, "the working row to go");
  await R.until(async () => (await hrefs(page)).length === 41, 30_000, 500, "41 rows");
  const after = await hrefs(page);
  check("the one that ended on top, then the 40 shown before in order", after[0] === `/sessions/${sid}` && JSON.stringify(after.slice(1)) === JSON.stringify(before));
  check("the heading counts it", (await heading(page)) === `${count0 + 1} sessions`, await heading(page));
  check("Show older still offered", (await page.$('[data-testid="sessions-older"]')) !== null);
  await R.step(page, "sessions tab after the session ended, 41 rows and Show older");
  await page.click('[data-testid="sessions-older"]');
  await R.until(async () => (await hrefs(page)).length === count0 + 1, 30_000, 500, "every row");
  const all = await hrefs(page);
  check("Show older goes on from the oldest shown: every session once", all.length === count0 + 1 && new Set(all).size === all.length, { rows: all.length });
  check("the last row is the project's first session", all.at(-1) === `/sessions/${seed.sessions[0]}`, all.at(-1));
  check("no Show older on the last page", (await page.$('[data-testid="sessions-older"]')) === null);
  await R.step(page, `sessions tab, all ${count0 + 1} rows`);
  const apiAll = [];
  let next;
  do {
    const v = await R.api(N, "GET", `/projects/${pid}/sessions?limit=50${next ? `&before=${next}` : ""}`);
    apiAll.push(...v.rows.map((r) => `/sessions/${r.id}`));
    next = v.next;
  } while (next);
  check("the rows on screen are the daemon's list, in its order", JSON.stringify(all) === JSON.stringify(apiAll), { api: apiAll.length });
  result.problems = R.problems(N);
  fs.writeFileSync(`${OUT}/walk3-pages.json`, JSON.stringify(result, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${OUT}/walk3-pages.json`, JSON.stringify({ ...result, error: String(e) }, null, 1));
  process.exit(1);
});
