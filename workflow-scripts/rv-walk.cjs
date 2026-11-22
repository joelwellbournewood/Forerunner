// d1109-run-visible bench walk (BEFORE and AFTER): what a person sees while a session runs and
// after it ends, on every page and at two widths. Usage: node rv-walk.cjs <repo> <bench> <label>
const path = require("node:path");
const fs = require("node:fs");
const [repo, NAME, LABEL] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const enc = encodeURIComponent;
const out = { label: LABEL, checks: [], texts: {} };
const check = (name, ok, detail = "") => {
  out.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 800) });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : ` :: ${String(detail).slice(0, 300)}`}`);
};
const runIndicatorText = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid^="run-indicator"]');
    return el ? el.innerText : null;
  });

(async () => {
  const b = R.bench(NAME);
  const { browser, page } = await R.openApp(NAME);
  await R.skipSetup(page);
  const stamp = new Date().toISOString().slice(11, 19);
  const { projectId, tasks } = await R.createPlannedProject(NAME, {
    project: `Quote page ${stamp}`,
    goal: "A page that shows a quote of the day",
    brief: "A small web page that shows a quote of the day, with a stylesheet and a script.",
  });
  out.projectId = projectId;
  out.tasks = tasks.length;
  // Approve may have started a session; start one if none runs.
  const sessions = await R.api(NAME, "GET", `/sessions?projectId=${enc(projectId)}`).catch(() => []);
  const live = (Array.isArray(sessions) ? sessions : (sessions.sessions ?? [])).find(
    (s) => s.status === "running" || s.status === "starting",
  );
  let sessionId = live?.id;
  if (!sessionId) sessionId = (await R.startSession(NAME, projectId, "run-visible walk")).id;
  out.sessionId = sessionId;
  // Wait for its first task to be running.
  await R.until(
    async () => {
      const t = await R.api(NAME, "GET", `/projects/${enc(projectId)}/tasks`);
      return t.some((x) => x.status === "in_progress") ? t : null;
    },
    90_000,
    1000,
    "a running task",
  );
  const shot = async (label, route) => {
    if (route !== undefined) {
      await page.goto(`${b.uiUrl}${route}`);
      await page.waitForTimeout(1800);
    }
    const text = await R.step(page, `${LABEL} ${label}`);
    out.texts[label] = { indicator: await runIndicatorText(page), title: await page.title() };
    return text;
  };
  const pages = [
    ["home while running", "/"],
    ["inbox while running", "/inbox"],
    ["settings while running", "/settings"],
    ["overview while running", `/projects/${enc(projectId)}`],
    ["tasks while running", `/projects/${enc(projectId)}/tasks`],
    ["session page while running", `/sessions/${enc(sessionId)}`],
  ];
  for (const [label, route] of pages) await shot(label, route);
  // Talk, opened from the header.
  await page.goto(`${b.uiUrl}/projects/${enc(projectId)}`);
  await page.waitForTimeout(1500);
  const talk = page.getByTestId("talk-open");
  if (await talk.count()) {
    await talk.first().click();
    await page.waitForTimeout(1500);
    await shot("talk while running");
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  // The Stop menu (AFTER only: the bar's Stop).
  const stop = page.getByTestId("run-stop");
  if (await stop.count()) {
    await stop.first().click();
    await page.waitForTimeout(800);
    await shot("stop menu open");
    await page.keyboard.press("Escape").catch(() => undefined);
  }
  for (const [label] of pages) {
    const t = out.texts[label];
    check(`${label}: a run indicator names the project`, t.indicator && /Quote page/.test(t.indicator), JSON.stringify(t));
  }
  check(
    "the page title says the project is working",
    /Quote page/.test(out.texts["home while running"].title ?? ""),
    out.texts["home while running"].title,
  );
  // Phone width: Home and the session page.
  await page.setViewportSize({ width: 390, height: 844 });
  await shot("home while running narrow", "/");
  await shot("session page while running narrow", `/sessions/${enc(sessionId)}`);
  check(
    "narrow: the run indicator is shown",
    out.texts["home while running narrow"].indicator,
    JSON.stringify(out.texts["home while running narrow"]),
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  // What /running and /health say (AFTER only has /running).
  const running = await R.apiRaw(NAME, "GET", "/running");
  const health = await R.apiRaw(NAME, "GET", "/health");
  out.running = running;
  out.healthRunning = health.body?.running ?? null;
  check("GET /running answers with the running session", running.status === 200 && JSON.stringify(running.body).includes(sessionId), running.status);
  // After the session ends.
  await R.waitForSession(NAME, sessionId, 600_000);
  await page.waitForTimeout(2500);
  await shot("home after the session", "/");
  await shot("overview after the session", `/projects/${enc(projectId)}`);
  await shot("session page after the session", `/sessions/${enc(sessionId)}`);
  check(
    "no run indicator once nothing runs",
    !out.texts["home after the session"].indicator,
    JSON.stringify(out.texts["home after the session"]),
  );
  fs.writeFileSync(path.join(b.steps, `${LABEL}-run-visible.json`), JSON.stringify(out, null, 1));
  await browser.close();
  const failed = out.checks.filter((c) => !c.ok).length;
  console.log(`${LABEL}: ${out.checks.length - failed}/${out.checks.length} checks pass`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
