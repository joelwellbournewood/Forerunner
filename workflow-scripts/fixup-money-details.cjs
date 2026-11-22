// Session pages with Details on, for the fix-up walk's journeys (b, b2, d, f).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_e1575ce2-d2f-3/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "fixup-l4-money-pause";
const want = [
  ["after", "b"],
  ["after2", "b2"],
  ["after", "d"],
  ["after3", "f"],
];
(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  const out = {};
  try {
    await page.waitForTimeout(2000);
    await R.skipSetup(page).catch(() => undefined);
    const base = page.url().replace(/(\/\/[^/]+).*/, "$1");
    for (const [lab, j] of want) {
      const d = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/walk-${lab}.json`, "utf8")).journeys[j];
      const rows = (await R.api(N, "GET", `/projects/${d.projectId}/sessions`)).rows ?? [];
      // The work session: the newest row that ran tasks.
      const sid = (rows.find((r) => (r.tasks ?? r.taskCount ?? 1) && !/plan/i.test(r.kind ?? "")) ?? rows[0]).id;
      const all = [];
      for (const r of rows) {
        await page.goto(`${base}/sessions/${r.id}`);
        await page.waitForTimeout(2500);
        await page.getByLabel("Details").check().catch(() => undefined);
        await page.waitForTimeout(1500);
        const text = await R.step(page, `details-${j}-${r.id.slice(-4)}`, { fullPage: true });
        all.push({ id: r.id, text });
      }
      out[j] = { sid, sessions: all };
    }
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
  } finally {
    fs.writeFileSync(`/tmp/frbench/${N}/details.json`, JSON.stringify(out, null, 1));
    await browser.close();
  }
})();
