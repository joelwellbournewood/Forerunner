// Reviewer's walk of d1109-run-visible: the run indicator while a session runs, at both widths.
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
  await R.skipSetup(page);
  const me = await R.api(NAME, "GET", "/me");
  const mk = (name, goal) => R.api(NAME, "POST", "/projects", { name, goal });
  const quote = await mk("Quote page", "A page that shows a quote");
  const garden = await mk("Garden site", "A site about the garden");
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
  await task(quote.id, "Create index.html", "index.html", "high");
  await task(quote.id, "Style the page in styles.css", "styles.css", "medium");
  await task(quote.id, "Write the README", "README.md", "low");
  await task(garden.id, "Write plants.md", "plants.md");
  out("projects", quote.id, garden.id);

  // Before: nothing runs.
  await page.goto(`${R.bench(NAME).uiUrl}/`);
  await page.waitForTimeout(1500);
  await R.step(page, "rv1-home-before-start");
  check("no bar while nothing runs", (await barText(page)) === null, await barText(page));
  check("title is Forerunner while nothing runs", (await page.title()) === "Forerunner", await page.title());

  // Press Start on the project's Overview, as a person.
  await page.goto(`${R.bench(NAME).uiUrl}/projects/${enc(quote.id)}`);
  await page.waitForTimeout(1500);
  await R.step(page, "rv1-overview-ready");
  const startBtn = page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first();
  await startBtn.click();
  await page.waitForTimeout(1500);
  await R.step(page, "rv1-start-dialog");
  const dialogStart = page.getByTestId("confirm-start-session");
  if (await dialogStart.count()) await dialogStart.click();
  else await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click();
  await R.until(async () => (await barText(page)) !== null, 30_000, 500, "the bar");
  const t0 = await barText(page);
  out("bar:", t0);
  await R.step(page, "rv1-overview-just-started");
  check("bar names the project", /Quote page ·/.test(t0 ?? ""), t0);
  check("title has the dot", /^● Quote page · Forerunner$/.test(await page.title()), await page.title());

  // Every page at 1280.
  const routes = [
    ["home", "/"],
    ["inbox", "/inbox"],
    ["settings", "/settings"],
    ["memory", "/memory"],
    ["changes", "/changes"],
    ["overview", `/projects/${enc(quote.id)}`],
    ["tasks", `/projects/${enc(quote.id)}/tasks`],
    ["files", `/projects/${enc(quote.id)}/files`],
    ["sessions-tab", `/projects/${enc(quote.id)}/sessions`],
  ];
  const sessions = await R.api(NAME, "GET", `/sessions?status=running`);
  const sid = sessions[0]?.id;
  if (sid) routes.push(["session-page", `/sessions/${enc(sid)}`]);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: width === 375 ? 800 : 900 });
    for (const [label, route] of routes) {
      await page.goto(`${R.bench(NAME).uiUrl}${route}`);
      await page.waitForTimeout(1200);
      const t = await barText(page);
      await R.step(page, `rv1-${label}-${width}`);
      check(`bar on ${label} at ${width}`, /Quote page ·/.test(t ?? ""), t);
      if (label === "home") {
        const block = page.getByTestId("run-indicator-block");
        check(`Home's Working now shows the block at ${width}`, (await block.count()) > 0, await block.count());
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  // Running API view.
  const running = await R.api(NAME, "GET", "/running");
  out("GET /running:", JSON.stringify(running));
  const health = await R.api(NAME, "GET", "/health");
  out("/health.running:", JSON.stringify(health.running), "activeSessions", health.activeSessions);

  // Talk.
  await page.goto(`${R.bench(NAME).uiUrl}/projects/${enc(quote.id)}`);
  await page.waitForTimeout(1000);
  const talk = page.getByRole("button", { name: /Talk/ }).first();
  await talk.click();
  await page.waitForTimeout(1200);
  const compact = page.getByTestId("run-indicator-compact");
  const ct = (await compact.count()) ? (await compact.innerText()).trim() : null;
  await R.step(page, "rv1-talk-open");
  check("Talk's first line shows what runs", /Quote page ·/.test(ct ?? ""), ct);
  // Open Stop inside Talk.
  if (await compact.count()) {
    await compact.getByTestId("run-stop").click();
    await page.waitForTimeout(600);
    await R.step(page, "rv1-talk-stop-menu-open");
    const menu = compact.getByTestId("run-stop-menu");
    const box = (await menu.count()) ? await menu.boundingBox() : null;
    out("talk stop menu box", JSON.stringify(box));
    check("Talk's Stop menu opens", (await menu.count()) > 0, await menu.count());
    await compact.getByTestId("run-stop").click();
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // Watch the words change: a review and between tasks.
  const seen = new Set();
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    const t = await barText(page);
    if (t) seen.add(t);
    if ([...seen].some((s) => /critic checks/.test(s)) && seen.size >= 3) break;
    await page.waitForTimeout(400);
  }
  out("bar texts seen:", JSON.stringify([...seen]));
  check("bar said the critic checks", [...seen].some((s) => /the critic checks "/.test(s)), [...seen]);
  await R.step(page, "rv1-overview-after-watch");

  // Start Garden site while Quote page runs.
  await page.goto(`${R.bench(NAME).uiUrl}/projects/${enc(garden.id)}`);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first().click();
  await page.waitForTimeout(1500);
  const explain = page.getByTestId("start-session-explain");
  const et = (await explain.count()) ? await explain.innerText() : null;
  await R.step(page, "rv1-garden-start-dialog-while-quote-runs");
  check('Start dialog names the other project', /Starts after the session on "Quote page"/.test(et ?? ""), et);
  const ds = page.getByTestId("confirm-start-session");
  if (await ds.count()) await ds.click();
  else await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForTimeout(2500);
  const tq = await barText(page);
  await R.step(page, "rv1-garden-overview-queued");
  check("bar adds · then Garden site", /· then Garden site/.test(tq ?? ""), tq);
  const gline = (await R.api(NAME, "GET", `/projects/${enc(garden.id)}`)).statusLine;
  check('Garden site line says it starts after Quote page', /Starts after the session on "Quote page"/.test(gline?.text ?? ""), gline);

  // Stop after this task from the bar.
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop").first().click();
  await page.waitForTimeout(500);
  await R.step(page, "rv1-stop-menu-open");
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop-after").first().click();
  await page.waitForTimeout(2000);
  const ts = await barText(page);
  await R.step(page, "rv1-after-stop-after-this-task");
  check("bar says stops after", /Quote page · stops after "/.test(ts ?? ""), ts);

  // Wait for Quote page to end and Garden to take over.
  await R.until(async () => /^Garden site ·/.test((await barText(page)) ?? ""), 180_000, 1000, "Garden to run");
  const tg = await barText(page);
  await R.step(page, "rv1-garden-runs");
  check("bar names Garden site once it runs", /^Garden site ·/.test(tg ?? ""), tg);
  check("title names Garden site", /^● Garden site · Forerunner$/.test(await page.title()), await page.title());

  // Stop now (asks once).
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop").first().click();
  await page.waitForTimeout(400);
  await page.getByTestId("run-indicator-bar").getByTestId("run-stop-now").first().click();
  await page.waitForTimeout(400);
  await R.step(page, "rv1-stop-now-question");
  const q = page.getByTestId("stop-now-confirm");
  check("Stop now asks once", (await q.count()) > 0, await q.count());
  await page.getByTestId("run-stop-now-confirm").click();
  await R.until(async () => (await barText(page)) === null, 30_000, 500, "the bar to go");
  await R.step(page, "rv1-after-stop-now");
  check("no bar after Stop now", (await barText(page)) === null, await barText(page));
  check("title is Forerunner after", (await page.title()) === "Forerunner", await page.title());

  // Start Quote page again and press Stop all.
  await page.goto(`${R.bench(NAME).uiUrl}/projects/${enc(quote.id)}`);
  await page.waitForTimeout(1500);
  const sb = page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first();
  if (await sb.count()) {
    await sb.click();
    await page.waitForTimeout(1200);
    const ds2 = page.getByTestId("confirm-start-session");
    if (await ds2.count()) await ds2.click();
    else await page.getByRole("dialog").getByRole("button", { name: "Start", exact: true }).click();
    await R.until(async () => (await barText(page)) !== null, 30_000, 500, "the bar again");
    await page.getByTestId("run-indicator-bar").getByTestId("run-stop").first().click();
    await page.waitForTimeout(400);
    await page.getByTestId("run-indicator-bar").getByTestId("kill-switch").first().click();
    await page.waitForTimeout(400);
    await R.step(page, "rv1-stop-all-question");
    await page.getByTestId("kill-confirm-stop").click();
    await page.waitForTimeout(2500);
    const body = await R.step(page, "rv1-after-stop-all");
    check("Sessions are stopped bar after Stop all", /Sessions are stopped/.test(body), body.slice(0, 300));
    check("no run bar after Stop all", (await barText(page)) === null, await barText(page));
  } else {
    check("Quote page offers Start again", false, "no Start button");
  }
  fs.writeFileSync(`${R.bench(NAME).steps}/rv1-result.json`, JSON.stringify({ checks }, null, 1));
  out(`${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
  await browser.close();
}
main().catch((e) => {
  console.error(e);
  fs.writeFileSync(`${R.bench(NAME).steps}/rv1-result.json`, JSON.stringify({ checks, error: String(e) }, null, 1));
  process.exit(1);
});
