// Stop now while the researcher runs (after its search): the run ends at once, the task goes
// back to Ready, and no further model call is made.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_3eff7ab7-708-3/scripts/bench/recorder.cjs");
const NAME = "review-web-search";
const LABEL = "stopnow";
const b = R.bench(NAME);
const enc = encodeURIComponent;
const out = {};
const step = (page, s) => R.step(page, `${LABEL} ${s}`);
(async () => {
  const { browser, page } = await R.openApp(NAME);
  try {
    const project = await R.api(NAME, "POST", "/projects", { name: "Hosts halt two", goal: "Pick a host" });
    for (let version = 0; version < 6; version++) {
      const ok = await R.api(NAME, "PUT", `/projects/${enc(project.id)}/settings`, {
        version,
        settings: { browser: { allowedDomains: ["127.0.0.1"] } },
      }).catch(() => null);
      if (ok) break;
    }
    await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title: "Compare the free tiers of three static site hosts",
      outcome: "research/hosts.md compares the free tiers, with sources",
      acceptanceCriteria: ["research/hosts.md names its sources"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      specialist: "researcher",
      riskTier: 1,
    });
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/summary`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^(Start session|Start|Continue)$/ }).first().click();
    await page.waitForTimeout(1200);
    await page.getByTestId("start-session-dialog").getByRole("button", { name: "Start", exact: true }).click();
    const session = await R.until(
      async () => (await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`))[0] ?? null,
      30_000,
      500,
      "the session",
    );
    await page.goto(`${b.uiUrl}/sessions/${enc(session.id)}`, { waitUntil: "domcontentloaded" });
    await R.until(
      async () => /searched the web for/.test(await page.evaluate(() => document.body.innerText)),
      60_000,
      300,
      "the search line",
    );
    const callsBefore = fs.readFileSync(b.modelCallLog, "utf8").split("\n").filter(Boolean).length;
    out.before = await step(page, "after search line");
    await page.getByTestId("stop-now").click();
    await page.waitForTimeout(800);
    out.confirm = await step(page, "stop now confirm");
    const confirm = page.getByTestId("stop-now-confirm").getByRole("button", { name: "Stop now" });
    if (await confirm.count()) await confirm.last().click();
    await R.until(
      async () => {
        const s = await R.api(NAME, "GET", `/sessions/${enc(session.id)}`);
        const st = s.status ?? s.session?.status;
        return ["running", "paused", "planned"].includes(st) ? null : st;
      },
      60_000,
      500,
      "the session to stop",
    );
    await page.waitForTimeout(6000);
    out.after = await step(page, "after stop now");
    const lines = fs.readFileSync(b.modelCallLog, "utf8").split("\n").filter(Boolean);
    out.callsBefore = callsBefore;
    out.callsAfter = lines.length;
    out.lastCalls = lines.slice(-3).map((l) => {
      const c = JSON.parse(l);
      return { role: c.role, stop: c.reply?.stopReason, error: c.reply?.error };
    });
    const tasks = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
    out.tasks = (Array.isArray(tasks) ? tasks : tasks.tasks).map((t) => ({ title: t.title, status: t.status }));
  } catch (e) {
    out.error = String(e?.stack || e);
    await step(page, "error").catch(() => undefined);
  } finally {
    fs.writeFileSync(path.join(b.steps, `${LABEL}.json`), JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
