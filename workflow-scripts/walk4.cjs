// Reviewer's walk 4 of d1109-run-visible: a waiting session that goes on by itself, one that is
// cancelled (the Overview's result afterwards), and the Inbox Done line's Start (V-6).
// Bench: --provider bench-api --api-key limited, LIMIT_MIN=2, FORERUNNER_BENCH_FAIL="Draw the logo"
"use strict";
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_bc132d49-0b3-5/scripts/bench/recorder.cjs");
const NAME = process.argv[2] || "review-d1109-run-visible";
const enc = encodeURIComponent;
const out = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, seen) => {
  checks.push({ name, ok: !!ok, seen });
  out(ok ? "PASS" : "FAIL", name, ok ? "" : `-- saw: ${JSON.stringify(seen).slice(0, 600)}`);
};
const save = () =>
  fs.writeFileSync(`${R.bench(NAME).steps}/rv4-result.json`, JSON.stringify({ checks }, null, 1));

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
  const mk = (name) => R.api(NAME, "POST", "/projects", { name, goal: name });
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
  const startOn = async (pid) => {
    await page.goto(`${ui}/projects/${enc(pid)}`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first().click();
    await page.waitForTimeout(1500);
    await page.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(1500);
    const close = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last();
    if (await close.count()) await close.click();
    await page.waitForTimeout(300);
  };
  const park = await mk("Park walk");
  await task(park.id, "Create index.html", "index.html", "high");
  await task(park.id, "Write paths.md", "paths.md");
  const sea = await mk("Sea notes");
  await task(sea.id, "Write tides.md", "tides.md");
  await task(sea.id, "Write fish.md", "fish.md");

  // Park walk: Start; it waits for the key's limit.
  await startOn(park.id);
  await R.until(async () => /^Park walk · waiting/.test((await barText(page)) ?? ""), 90_000, 1000, "Park walk to wait");
  out("bar:", await barText(page));
  // Sea notes: Start; it waits too, then Cancel on the bar.
  await startOn(sea.id);
  await R.until(
    async () => (await R.api(NAME, "GET", "/running")).some((r) => r.projectName === "Sea notes"),
    90_000,
    1000,
    "Sea notes to wait",
  );
  await page.waitForTimeout(1500);
  const both = await barText(page);
  await R.step(page, "rv4-two-waiting");
  out("bar with two waiting:", both);
  // Cancel Sea notes's wait from its project's line.
  await page.goto(`${ui}/projects/${enc(sea.id)}`);
  await page.waitForTimeout(1500);
  await page.getByTestId("project-status-action").first().click().catch(async () => {
    await page.getByTestId("run-indicator-bar").getByTestId("run-cancel").last().click();
  });
  await page.waitForTimeout(2500);
  const ov = await R.step(page, "rv4-sea-overview-after-cancel");
  const last = ov.split("Last result")[1]?.split("Next")[0] ?? "";
  out("Sea notes Overview, Last result:", last.replace(/\n/g, " | "));
  check("after Cancel the Overview's result no longer says the session goes on", !/then your session goes on/.test(last), last);
  const line = await page.getByTestId("project-status").first().innerText().catch(() => null);
  check("after Cancel the project line says the tasks wait for the Start", /^Ready: \d+ tasks? waits? for your Start/.test(line ?? ""), line);
  // Sessions tab of Sea notes.
  await page.goto(`${ui}/projects/${enc(sea.id)}/sessions`);
  await page.waitForTimeout(1500);
  const st = await R.step(page, "rv4-sea-sessions-after-cancel");
  check("after Cancel the Sessions list does not say it goes on", !/goes on/.test(st), st.slice(0, 800));
  // Park walk goes on by itself at the reset; the bar follows without a reload.
  await page.goto(`${ui}/`);
  await page.waitForTimeout(1500);
  await R.step(page, "rv4-home-park-waits");
  const seen = new Set();
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const t = await barText(page);
    if (t) seen.add(t.split("\n")[0]);
    if ([...seen].some((s) => /^Park walk · (the coder works on|picks the next task|the critic checks)/.test(s))) break;
    await page.waitForTimeout(1000);
  }
  out("bar texts seen:", JSON.stringify([...seen]));
  await R.step(page, "rv4-home-park-goes-on");
  check("Park walk went on by itself and the bar said so without a reload", [...seen].some((s) => /^Park walk · (the coder works on|picks the next task|the critic checks)/.test(s)), [...seen]);
  save();
  await R.until(async () => (await R.api(NAME, "GET", "/running")).length === 0, 240_000, 2000, "Park walk to end");

  // V-6: a failed task's card, Try again, the Done line's Start.
  const logo = await mk("Logo shop");
  await task(logo.id, "Draw the logo", "logo.svg");
  await startOn(logo.id);
  await R.until(
    async () => (await R.api(NAME, "GET", "/inbox")).requests.some((r) => r.status === "open" && r.projectId === logo.id),
    240_000,
    2000,
    "the failed-task card",
  );
  await R.until(async () => (await R.api(NAME, "GET", "/running")).length === 0, 120_000, 2000, "Logo shop to end");
  await page.goto(`${ui}/inbox`);
  await page.waitForTimeout(2000);
  await R.step(page, "rv4-inbox-failed-card");
  const tryAgain = page.getByRole("button", { name: /^Try again$/ }).first();
  await tryAgain.click();
  await page.waitForTimeout(2500);
  const inbox = await R.step(page, "rv4-inbox-done-line");
  const done = page.getByTestId("done-line-start");
  check("the Done line offers Start", (await done.count()) > 0, inbox.slice(0, 1200));
  if (await done.count()) {
    await done.first().click();
    await page.waitForTimeout(1500);
    const dlg = await page.getByTestId("start-session-dialog").innerText().catch(() => null);
    await R.step(page, "rv4-inbox-done-start-dialog");
    check("Start opens that project's Start dialog", /Start a session/.test(dlg ?? ""), dlg);
    await page.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(2500);
    const close = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last();
    if (await close.count()) await close.click();
    await page.waitForTimeout(1500);
    const running = (await R.api(NAME, "GET", "/running")).map((r) => r.text);
    const hidden = (await page.getByTestId("done-line-start").count()) === 0;
    await R.step(page, "rv4-inbox-while-logo-runs");
    check("Start is hidden while a session of that project runs", hidden || running.length === 0, { hidden, running });
  }
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
