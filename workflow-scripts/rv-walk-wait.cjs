// d1109-run-visible: a person's session that stops at the API key's limit and goes on by itself.
// While it waits: the bar "<project> · waiting until HH:MM, then it goes on" with Cancel, Home,
// the session page's block; after the reset: it works again.
// Usage: node rv-walk-wait.cjs <repo> <bench> <label>
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
const bar = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="run-indicator-bar"]');
    return el ? el.innerText : null;
  });

(async () => {
  const b = R.bench(NAME);
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Kite club ${new Date().toISOString().slice(11, 19)}`,
    goal: "Two notes",
  });
  for (const [title, file] of [
    ["Write the intro in intro.md", "intro.md"],
    ["Write the rules in rules.md", "rules.md"],
  ])
    await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title,
      outcome: `${file} is written`,
      acceptanceCriteria: [`${file} exists`],
    });
  const { browser, page } = await R.openApp(NAME);
  await R.skipSetup(page);
  await R.startSession(NAME, project.id, "wait walk");
  const sessionOf = async () => {
    const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`);
    return (Array.isArray(list) ? list : (list.sessions ?? []))[0] ?? null;
  };
  const first = await R.until(sessionOf, 60_000, 1000, "the session");
  const ended = await R.waitForSession(NAME, first.id, 180_000);
  out.ended = { status: ended.status, summary: ended.summary };
  const running = await R.api(NAME, "GET", "/running");
  out.running = running;
  const waiting = running.find((r) => r.projectId === project.id);
  check(
    "GET /running lists the person's session waiting to go on, with Cancel",
    waiting?.state === "waiting" && waiting.cancel === true && /waiting until \d\d:\d\d, then it goes on$/.test(waiting.text),
    JSON.stringify(running),
  );
  await page.goto(`${b.uiUrl}/`);
  await page.waitForTimeout(2000);
  const homeBar = await bar(page);
  await R.step(page, `${LABEL} home while it waits`);
  check("the bar says it waits, then goes on, with Cancel and no Stop", /waiting until \d\d:\d\d, then it goes on/.test(homeBar ?? "") && /Cancel/.test(homeBar ?? "") && !/Stop/.test(homeBar ?? ""), homeBar);
  const title = await page.title();
  check("the title stays Forerunner while it only waits", title === "Forerunner", title);
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}`);
  await page.waitForTimeout(1800);
  await R.step(page, `${LABEL} overview while it waits`);
  await page.goto(`${b.uiUrl}/sessions/${enc(first.id)}`);
  await page.waitForTimeout(1800);
  const block = await page.getByTestId("session-wait").innerText().catch(() => "");
  await R.step(page, `${LABEL} session page while it waits`);
  check("the session page says it goes on, with Cancel", /then it goes on/.test(block) && /Cancel/.test(block), block);
  const health = await R.api(NAME, "GET", "/health");
  check("/health.running says it waits", health.running?.waiting === true, JSON.stringify(health.running));
  // The reset: it goes on by itself.
  const next = await R.until(
    async () => {
      const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`);
      const all = Array.isArray(list) ? list : (list.sessions ?? []);
      return all.find((s) => s.id !== first.id) ?? null;
    },
    240_000,
    2000,
    "the session to go on",
  );
  await page.goto(`${b.uiUrl}/`);
  await page.waitForTimeout(1500);
  const after = await bar(page);
  await R.step(page, `${LABEL} home once it goes on`);
  check("once it goes on the bar says it works (or it already ended)", after === null || /works on|checks|picks|plans/.test(after), after);
  await R.waitForSession(NAME, next.id, 300_000);
  fs.writeFileSync(path.join(b.steps, `${LABEL}-wait.json`), JSON.stringify(out, null, 1));
  await browser.close();
  const failed = out.checks.filter((c) => !c.ok).length;
  console.log(`${LABEL}: ${out.checks.length - failed}/${out.checks.length} checks pass`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
