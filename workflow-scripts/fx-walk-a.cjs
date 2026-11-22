// Fix-up walk A of d1109-run-visible (--provider bench): the review's blocking 1 and 4.
// A queued person start moves its project's line live; the Sessions list's working row says the
// bar's words; the queued project's line follows when it runs.
"use strict";
const fs = require("node:fs");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_bc132d49-0b3-6";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const NAME = process.argv[2] || "fixup-d1109-run-visible";
const LABEL = process.argv[3] || "after";
const enc = encodeURIComponent;
const out = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, seen) => {
  checks.push({ name, ok: !!ok, seen });
  out(ok ? "PASS" : "FAIL", name, ok ? "" : `-- saw: ${JSON.stringify(seen).slice(0, 400)}`);
};
const save = () =>
  fs.writeFileSync(`${R.bench(NAME).steps}/${LABEL}-walk-a.json`, JSON.stringify({ checks }, null, 1));

async function barText(page) {
  const bar = page.getByTestId("run-indicator-bar");
  if (!(await bar.count())) return null;
  return (await bar.getByTestId("run-text").first().innerText().catch(() => "")).trim();
}

async function main() {
  const { browser, page } = await R.openApp(NAME, { viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  await R.skipSetup(page);
  const ui = () => R.bench(NAME).uiUrl;
  const stamp = new Date().toISOString().slice(11, 16).replace(":", "");
  const mk = (name, goal) => R.api(NAME, "POST", "/projects", { name, goal });
  const kite = await mk(`Kite day ${stamp}`, "A page for the kite club");
  const bird = await mk(`Bird walk ${stamp}`, "Notes about birds");
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
  const titles = ["Create index.html", "Write about.md", "Write events.md", "Write members.md", "Write rules.md", "Write the README.md"];
  for (const [i, t] of titles.entries())
    await task(kite.id, t, t.split(" ").pop(), i === 0 ? "high" : "medium");
  await task(bird.id, "Write birds.md", "birds.md");
  const startOn = async (pid) => {
    await page.goto(`${ui()}/projects/${enc(pid)}`);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first().click();
    await page.waitForTimeout(1500);
    await page.getByTestId("confirm-start-session").click();
    await page.waitForTimeout(1500);
    const close = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last();
    if (await close.count()) await close.click();
    await page.waitForTimeout(300);
  };
  await startOn(kite.id);
  await R.until(async () => (await barText(page))?.startsWith(kite.name), 30_000, 500, "the bar");

  // Blocking 1: the Sessions list's working row says the bar's words (read together).
  await page.goto(`${ui()}/projects/${enc(kite.id)}/sessions`);
  await page.waitForTimeout(1500);
  let same = false;
  let seen = null;
  for (let i = 0; i < 10 && !same; i += 1) {
    const list = await R.api(NAME, "GET", `/projects/${enc(kite.id)}/sessions`);
    const row = list.working?.[0]?.gist ?? null;
    const run = (await R.api(NAME, "GET", "/running")).find((v) => v.projectId === kite.id)?.text;
    seen = { row, run };
    same = !!row && row === run;
    if (!same) await page.waitForTimeout(400);
  }
  await R.step(page, `${LABEL}-a1-kite-sessions-tab-while-running`);
  check("the Sessions list's working row says the bar's words", same, seen);

  // Blocking 4: Start on Bird walk while Kite day runs; its own line follows without a reload.
  await startOn(bird.id);
  const tq = await barText(page);
  check("the bar adds · then Bird walk", /· then Bird walk/.test(tq ?? ""), tq);
  let hl = null;
  for (let i = 0; i < 12; i += 1) {
    hl = await page.getByTestId("project-status").first().innerText().catch(() => null);
    if (/Starts after the session on "Kite day/.test(hl ?? "")) break;
    await page.waitForTimeout(500);
  }
  await R.step(page, `${LABEL}-a2-bird-overview-queued-no-reload`);
  check(
    "Bird walk's line says it starts after Kite day, without a reload (6 s)",
    /Starts after the session on "Kite day/.test(hl ?? ""),
    hl,
  );
  const startBtn = await page.getByRole("button", { name: /^(Start session|Continue)$/ }).count();
  await page.goto(`${ui()}/`);
  await page.waitForTimeout(1500);
  const home = await R.step(page, `${LABEL}-a3-home-while-one-queued`);
  check("Home names Bird walk's wait", /Starts after the session on "Kite day/.test(home), home.slice(0, 1200));
  out("Start buttons on Bird walk while queued:", startBtn);

  // Stop after this task: once Kite day ends Bird walk runs, and its line follows (no reload).
  await page.goto(`${ui()}/projects/${enc(bird.id)}`);
  await page.waitForTimeout(1500);
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop").first().click();
  await page.waitForTimeout(400);
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop-after").first().click();
  await R.until(async () => (await barText(page))?.startsWith(bird.name), 240_000, 1000, "Bird walk to run");
  let hl2 = null;
  for (let i = 0; i < 12; i += 1) {
    hl2 = await page.getByTestId("project-status").first().innerText().catch(() => null);
    if (!/Starts after the session/.test(hl2 ?? "")) break;
    await page.waitForTimeout(500);
  }
  await R.step(page, `${LABEL}-a4-bird-overview-runs-no-reload`);
  check("Bird walk's line no longer says it starts after, once it runs (no reload)", !/Starts after the session/.test(hl2 ?? ""), hl2);
  check("the title names Bird walk", (await page.title()).startsWith(`● ${bird.name.slice(0, 9)}`), await page.title());
  await R.until(async () => (await R.api(NAME, "GET", "/running")).length === 0, 240_000, 2000, "Bird walk to end");
  await page.waitForTimeout(1500);
  await R.step(page, `${LABEL}-a5-bird-overview-after`);
  check("no bar once nothing runs", (await barText(page)) === null, await barText(page));
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
