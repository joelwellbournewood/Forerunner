const L = require("./lib.cjs");
const { R, log, goto, save, enc } = L;
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");
const NAME = "run-live";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    const pid = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Clamp review").id;
    const ws = R.workspaceOf(NAME, pid);
    execSync(`cp -r /tmp/frbench/live2/run/scripts/fixtures/clamp/. ${ws}/`);
    out.before = execSync(`cd ${ws} && git status --short && ls -R src`, { encoding: "utf8" });
    await goto(page, NAME, "/inbox", 2500);
    const card = page.locator("[id^=card-]").filter({ hasText: "Review src/clamp.js for bugs" }).first();
    out.cardText = await card.innerText();
    const box = card.locator("textarea, input[type=text]").first();
    await box.fill("The code is in the folder now: src/clamp.js, package.json and README.md. Please review src/clamp.js.");
    await R.step(page, "r05 answering the reviewer card");
    const send = card.getByRole("button", { name: /^Send/ }).first();
    out.sendLabel = await send.innerText().catch(() => null);
    const t0 = Date.now();
    await send.click();
    await page.waitForTimeout(3000);
    out.afterSend = await card.innerText().catch(() => null);
    const s = await R.until(async () => { const a = await R.api(NAME, "GET", `/sessions?projectId=${enc(pid)}`); const arr = Array.isArray(a) ? a : a.sessions ?? []; return arr.find((x) => Date.parse(x.startedAt) >= t0 - 3000); }, 60000, 1000, "session after answer").catch(() => null);
    out.sessionStarted = !!s;
    if (s) {
      const d = await R.waitForSession(NAME, s.id, 1500000);
      out.session = { status: d.status, summary: d.summary };
      const ev = await R.api(NAME, "GET", `/sessions/${enc(s.id)}/events`);
      out.events = (ev.events ?? ev).map((e) => e.text).filter(Boolean);
    }
    const rows = await L.tasks(NAME, pid);
    out.rows = rows.map((t) => ({ title: t.title, status: t.status, display: t.display?.label, specialist: t.specialist }));
    out.files = execSync(`cd ${ws} && git status --short; find . -path ./.git -prune -o -type f -newer package.json -print | sort; git log --stat --oneline -4 | head -40`, { encoding: "utf8" });
    out.testingMd = fs.readFileSync(path.join(ws, "docs/testing.md"), "utf8");
    for (const t of rows) {
      await goto(page, NAME, `/projects/${enc(pid)}/tasks?task=${enc(t.id)}`, 2500);
      out[`drawer_${t.specialist}`] = await R.step(page, `r06 drawer ${t.specialist}`);
    }
  } finally { save(NAME, "noise2b.json", out); await browser.close(); }
  log("done");
})().catch((e) => { console.error(e); process.exit(1); });
