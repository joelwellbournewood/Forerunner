// Watches project <name> on bench <bench>: while a task runs or is being reviewed, opens its drawer
// in a throwaway browser context and saves screenshots + text to steps/watch/. Also records the
// plan card text (Inbox) as soon as it appears, and the Start dialog figures when asked.
const L = require("./lib.cjs");
const { R, log, enc, fs, path } = L;
const NAME = process.argv[2], PROJECT = process.argv[3], MAXMIN = Number(process.argv[4] || 30);
(async () => {
  const b = R.bench(NAME);
  const dir = path.join(b.steps, "watch");
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  const shot = async (page, label) => {
    n++;
    const base = path.join(dir, `${String(n).padStart(3, "0")}-${label.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => undefined);
    const t = await page.evaluate(() => document.body.innerText).catch(() => "");
    fs.writeFileSync(`${base}.txt`, t);
    return t;
  };
  const { browser, page } = await R.openApp(NAME, { profile: false });
  const seen = {};
  let planShot = false;
  const end = Date.now() + MAXMIN * 60000;
  let pid = null;
  try {
    while (Date.now() < end) {
      const projects = await R.api(NAME, "GET", "/projects").catch(() => []);
      const p = projects.find((x) => x.name === PROJECT);
      if (p) pid = p.id;
      if (pid && !planShot) {
        const ik = await R.api(NAME, "GET", `/projects/${enc(pid)}/intake`).catch(() => null);
        if (ik?.state === "pending") {
          await page.goto(`${b.uiUrl}/inbox`); await page.waitForTimeout(2500);
          await shot(page, "plan-card-inbox");
          planShot = true; log("plan card shot");
        }
      }
      if (pid) {
        const rows = await L.tasks(NAME, pid).catch(() => []);
        for (const t of rows) {
          if (!["in_progress", "claimed", "in_review"].includes(t.status)) continue;
          const k = `${t.id}:${t.status}`;
          seen[k] = (seen[k] || 0) + 1;
          if (seen[k] > 4) continue; // up to 4 shots per task per state
          const url = `${b.uiUrl}/projects/${enc(pid)}/tasks?task=${enc(t.id)}`;
          if (!page.url().startsWith(url)) { await page.goto(url); await page.waitForTimeout(1500); }
          else await page.waitForTimeout(500);
          const txt = await shot(page, `drawer-${t.status}-${t.title}`);
          log("drawer shot", t.status, t.title, "lines:", (txt.match(/^(wrote|ran|read|listed)/gm) || []).length);
        }
        if (rows.length && rows.every((t) => ["done", "failed", "cancelled", "needs_human"].includes(t.status)) && planShot) {
          // keep going a bit for the next session if any
        }
      }
      await L.sleep(4000);
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
