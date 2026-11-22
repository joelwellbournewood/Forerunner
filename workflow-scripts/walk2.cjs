// Reviewer's walk 2 of d1109-run-visible: a queued person start, Stop after this task, Stop now, Stop all.
"use strict";
const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_bc132d49-0b3-5/scripts/bench/recorder.cjs");
const NAME = process.argv[2] || "review-d1109-run-visible";
const enc = encodeURIComponent;
const out = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, seen) => {
  checks.push({ name, ok: !!ok, seen });
  out(ok ? "PASS" : "FAIL", name, ok ? "" : `-- saw: ${JSON.stringify(seen).slice(0, 400)}`);
};

async function barText(page) {
  const bar = page.getByTestId("run-indicator-bar");
  if (!(await bar.count())) return null;
  return (await bar.innerText()).trim();
}

async function main() {
  const { browser, page } = await R.openApp(NAME, { viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  await R.skipSetup(page);
  const mk = (name, goal) => R.api(NAME, "POST", "/projects", { name, goal });
  const kite = await mk("Kite day", "A page for the kite club");
  const bird = await mk("Bird walk", "Notes about birds");
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
  const titles = [
    "Create index.html",
    "Write about.md",
    "Write events.md",
    "Write members.md",
    "Write rules.md",
    "Write the README.md",
  ];
  for (const [i, t] of titles.entries())
    await task(kite.id, t, t.split(" ").pop(), i === 0 ? "high" : "medium");
  await task(bird.id, "Write birds.md", "birds.md");
  const startOn = async (pid) => {
    await page.goto(`${R.bench(NAME).uiUrl}/projects/${enc(pid)}`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first().click();
    await page.waitForTimeout(1500);
    const ex = page.getByTestId("start-session-explain");
    const et = (await ex.count()) ? await ex.innerText() : null;
    await page.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(1500);
    const close = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last();
    if (await close.count()) await close.click();
    await page.waitForTimeout(300);
    return et;
  };
  await startOn(kite.id);
  await R.until(async () => /^Kite day ·/.test((await barText(page)) ?? ""), 30_000, 500, "the bar");
  const et = await startOn(bird.id);
  check('Start dialog names the other project', /Starts after the session on "Kite day"/.test(et ?? ""), et);
  const tq = await barText(page);
  check("bar adds · then Bird walk", /· then Bird walk/.test(tq ?? ""), tq);
  // The project's own header line, as the person reads it, within 6 s and without a reload.
  let hl = null;
  for (let i = 0; i < 12; i++) {
    hl = await page.getByTestId("project-status").first().innerText().catch(() => null);
    if (/Starts after the session on "Kite day"/.test(hl ?? "")) break;
    await page.waitForTimeout(500);
  }
  await R.step(page, "rv2-bird-overview-queued");
  check('Bird walk header line says it starts after Kite day (no reload)', /Starts after the session on "Kite day"/.test(hl ?? ""), hl);
  await page.reload();
  await page.waitForTimeout(2000);
  const hl2 = await page.getByTestId("project-status").first().innerText().catch(() => null);
  check('Bird walk header line after a reload', /Starts after the session on "Kite day"/.test(hl2 ?? ""), hl2);
  await page.goto(`${R.bench(NAME).uiUrl}/`);
  await page.waitForTimeout(1500);
  await R.step(page, "rv2-home-while-one-queued");

  // Stop after this task from the bar.
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop").first().click();
  await page.waitForTimeout(500);
  await R.step(page, "rv2-stop-menu-open");
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop-after").first().click();
  await page.waitForTimeout(2000);
  const ts = await barText(page);
  await R.step(page, "rv2-after-stop-after-this-task");
  check("bar says stops after", /Kite day · stops after "/.test(ts ?? ""), ts);

  await R.until(async () => /^Bird walk ·/.test((await barText(page)) ?? ""), 180_000, 1000, "Bird walk to run");
  const tg = await barText(page);
  await R.step(page, "rv2-bird-runs");
  check("bar names Bird walk once it runs", /^Bird walk ·/.test(tg ?? ""), tg);
  check("title names Bird walk", /^● Bird walk · Forerunner$/.test(await page.title()), await page.title());

  // Stop now (asks once).
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop").first().click();
  await page.waitForTimeout(400);
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop-now").first().click();
  await page.waitForTimeout(400);
  await R.step(page, "rv2-stop-now-question");
  const q = page.getByTestId("stop-now-confirm");
  check("Stop now asks once", (await q.count()) > 0, await q.count());
  await page.getByTestId("run-stop-now-confirm").click();
  await R.until(async () => (await barText(page)) === null, 30_000, 500, "the bar to go");
  await R.step(page, "rv2-after-stop-now");
  check("no bar after Stop now", (await barText(page)) === null, await barText(page));
  check("title is Forerunner after", (await page.title()) === "Forerunner", await page.title());

  // Start Kite day again and press Stop all.
  await startOn(kite.id);
  await R.until(async () => (await barText(page)) !== null, 30_000, 500, "the bar again");
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop").first().click();
  await page.waitForTimeout(400);
  await page.getByTestId("run-indicator-bar").getByTestId("kill-switch").first().click();
  await page.waitForTimeout(400);
  await R.step(page, "rv2-stop-all-question");
  await page.getByTestId("kill-confirm-stop").click();
  await page.waitForTimeout(2500);
  const body = await R.step(page, "rv2-after-stop-all");
  check("Sessions are stopped bar after Stop all", /Sessions are stopped/.test(body), body.slice(0, 300));
  check("no run bar after Stop all", (await barText(page)) === null, await barText(page));
  const allow = page.getByRole("button", { name: /Allow sessions again/ }).first();
  if (await allow.count()) await allow.click();
  await page.waitForTimeout(1500);
  await R.step(page, "rv2-after-allow");
  fs.writeFileSync(`${R.bench(NAME).steps}/rv2-result.json`, JSON.stringify({ checks }, null, 1));
  out(`${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
  await browser.close();
}
main().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${R.bench(NAME).steps}/rv2-result.json`, JSON.stringify({ checks, error: String(e) }, null, 1));
  process.exit(1);
});
