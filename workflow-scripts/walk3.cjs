// Reviewer's walk 3 of d1109-run-visible: a person's session waiting for its Claude credential.
// Bench: --provider bench-api --api-key limited --env FORERUNNER_BENCH_API_LIMIT_MIN=2
"use strict";
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_bc132d49-0b3-5/scripts/bench/recorder.cjs");
const NAME = process.argv[2] || "review-d1109-run-visible";
const enc = encodeURIComponent;
const out = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, seen) => {
  checks.push({ name, ok: !!ok, seen });
  out(ok ? "PASS" : "FAIL", name, ok ? "" : `-- saw: ${JSON.stringify(seen).slice(0, 500)}`);
};
const save = () =>
  fs.writeFileSync(`${R.bench(NAME).steps}/rv3-result.json`, JSON.stringify({ checks }, null, 1));

async function barText(page) {
  const bar = page.getByTestId("run-indicator-bar");
  if (!(await bar.count())) return null;
  return (await bar.innerText()).trim();
}

async function main() {
  const { browser, page } = await R.openApp(NAME, { viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  await R.skipSetup(page);
  const ui = R.bench(NAME).uiUrl;
  const kite = await R.api(NAME, "POST", "/projects", { name: "Kite club", goal: "A kite club page" });
  const task = (pid, title, file, priority = "medium") =>
    R.api(NAME, "POST", `/projects/${enc(pid)}/tasks`, {
      title,
      outcome: `${file} exists`,
      acceptanceCriteria: [`${file} exists`],
      priority,
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
      specialist: "coder",
      riskTier: 1,
    });
  await task(kite.id, "Create index.html", "index.html", "high");
  await task(kite.id, "Write about.md", "about.md");
  await task(kite.id, "Write the README.md", "README.md", "low");
  const startOn = async (pid) => {
    await page.goto(`${ui}/projects/${enc(pid)}`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first().click();
    await page.waitForTimeout(1500);
    await R.step(page, "rv3-start-dialog");
    await page.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(1500);
    const close = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last();
    if (await close.count()) await close.click();
    await page.waitForTimeout(300);
  };
  await startOn(kite.id);
  await R.until(async () => /waiting/.test((await barText(page)) ?? ""), 90_000, 1000, "the waiting bar");
  const wt = await barText(page);
  out("waiting bar:", wt);
  await R.step(page, "rv3-overview-while-it-waits");
  check("bar says waiting until HH:MM, then it goes on", /^Kite club · waiting until \d\d:\d\d, then it goes on/.test(wt ?? ""), wt);
  const bar = page.getByTestId("run-indicator-bar");
  check("waiting bar offers Cancel", (await bar.getByTestId("run-cancel").count()) === 1, await bar.innerText());
  check("waiting bar offers no Stop", (await bar.getByTestId("run-stop").count()) === 0, null);
  check("title stays Forerunner while it only waits", (await page.title()) === "Forerunner", await page.title());
  const line = await page.getByTestId("project-status").first().innerText().catch(() => null);
  check("project line says waiting until ... then it goes on", /^Waiting until \d\d:\d\d \(.+\), then it goes on/.test(line ?? ""), line);
  const running = await R.api(NAME, "GET", "/running");
  out("GET /running:", JSON.stringify(running));
  const health = await R.api(NAME, "GET", "/health");
  out("/health.running:", JSON.stringify(health.running));
  // Home.
  await page.goto(`${ui}/`);
  await page.waitForTimeout(1500);
  await R.step(page, "rv3-home-while-it-waits");
  // Talk.
  await page.getByRole("button", { name: /Talk/ }).first().click();
  await page.waitForTimeout(1000);
  await R.step(page, "rv3-talk-while-it-waits");
  await page.keyboard.press("Escape");
  // Narrow.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(800);
  await R.step(page, "rv3-home-while-it-waits-375");
  await page.setViewportSize({ width: 1280, height: 900 });
  // The session page.
  const sid = running.find((r) => r.state === "waiting")?.sessionId;
  await page.goto(`${ui}/sessions/${enc(sid)}`);
  await page.waitForTimeout(2000);
  const blk = page.getByTestId("session-wait");
  const bt = (await blk.count()) ? await blk.innerText() : null;
  await R.step(page, "rv3-session-page-while-it-waits");
  check('session page block: Waiting until ... then it goes on with "X" and 1 more.', /Waiting until \d\d:\d\d \(.+\), then it goes on with "Write about.md" and 1 more\./.test(bt ?? "") || /Waiting until .* then it goes on with/.test(bt ?? ""), bt);
  // Cancel on the session page.
  await page.getByTestId("session-wait-cancel").click();
  await page.waitForTimeout(2500);
  const bt2 = (await blk.count()) ? await blk.innerText() : null;
  const body2 = await R.step(page, "rv3-session-page-after-cancel");
  check("after Cancel: Stopped to wait ... with Continue", /Stopped to wait for .+ until \d\d:\d\d: ".+" (and \d+ more )?waits?\./.test(bt2 ?? "") && /Continue/.test(bt2 ?? ""), bt2);
  check("result line no longer promises it goes on", !/then your session goes on/.test(body2), body2.slice(0, 1500));
  check("no bar after Cancel", (await barText(page)) === null, await barText(page));
  // Continue: the Start dialog with the budget left.
  await page.getByTestId("session-wait-continue").click();
  await page.waitForTimeout(1500);
  const dlg = await page.getByTestId("start-session-dialog").innerText().catch(() => null);
  const budget = await page.getByTestId("start-session-dialog").locator("input").first().inputValue().catch(() => null);
  await R.step(page, "rv3-continue-start-dialog");
  out("continue dialog budget:", budget, "|", (dlg ?? "").replace(/\n/g, " | ").slice(0, 400));
  check("Continue opens Start with the budget left", budget !== null && Number(budget) > 0 && Number(budget) <= 5, budget);
  await page.getByTestId("confirm-start-session").click();
  await page.waitForTimeout(2500);
  const close = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last();
  const afterStart = await page.getByTestId("start-session-dialog").innerText().catch(() => null);
  out("after Start in the Continue dialog:", (afterStart ?? "").replace(/\n/g, " | ").slice(0, 400));
  await R.step(page, "rv3-continue-started");
  if (await close.count()) await close.click();
  // Now leave it: the session goes on by itself at the reset. Watch the bar without a reload.
  await page.goto(`${ui}/projects/${enc(kite.id)}`);
  await page.waitForTimeout(2000);
  const tw = await barText(page);
  out("bar after Continue:", tw);
  await R.step(page, "rv3-overview-after-continue");
  const seen = new Set();
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const t = await barText(page);
    if (t) seen.add(t.split("\n")[0]);
    if ([...seen].some((s) => /the coder works on|picks the next task|the critic checks/.test(s))) break;
    await page.waitForTimeout(1000);
  }
  out("bar texts seen while waiting for the reset:", JSON.stringify([...seen]));
  await R.step(page, "rv3-overview-once-it-goes-on");
  check("the waiting session went on by itself and the bar said so without a reload", [...seen].some((s) => /^Kite club · (the coder works on|picks the next task|the critic checks|plans the session)/.test(s)), [...seen]);
  check("title has the dot once it runs", /^● Kite club · Forerunner$/.test(await page.title()), await page.title());
  save();
  // Wait for it to end.
  await R.until(async () => (await R.api(NAME, "GET", "/running")).length === 0, 240_000, 2000, "the session to end");
  await page.waitForTimeout(2000);
  await R.step(page, "rv3-overview-after-the-end");
  check("no bar after the end", (await barText(page)) === null, await barText(page));
  save();
  out(`${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
  await browser.close();
}
main().catch((e) => {
  console.error(e);
  checks.push({ name: "walk error", ok: false, seen: String(e).slice(0, 500) });
  save();
  process.exit(1);
});
