// d1109-run-visible V-6 bench walk: a task fails its tries, Try again in the Inbox, the Done
// line offers Start (none while a session of the project runs), Start opens the dialog.
// Usage: node rv-walk-v6.cjs <repo> <bench> <label>
const path = require("node:path");
const fs = require("node:fs");
const [repo, NAME, LABEL] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const enc = encodeURIComponent;
const out = { label: LABEL, checks: [] };
const check = (name, ok, detail = "") => {
  out.checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 800) });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${ok ? "" : ` :: ${String(detail).slice(0, 300)}`}`);
};

(async () => {
  const b = R.bench(NAME);
  // The card of a task that failed its tries (FORERUNNER_BENCH_FAIL), filed by an earlier session.
  const inbox = await R.api(NAME, "GET", "/inbox");
  const card = inbox.requests.find(
    (r) => r.status === "open" && (r.choices ?? []).some((c) => c.label === "Try again"),
  );
  const project = { id: card?.projectId };
  check("the failed task has one card with Try again", !!card, JSON.stringify(inbox.requests.map((r) => r.title)));
  const { browser, page } = await R.openApp(NAME, { path: "/inbox" });
  await R.skipSetup(page);
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForTimeout(2000);
  await R.step(page, `${LABEL} inbox failed-task card`);
  const item = page.getByTestId("request").filter({ hasText: card.title }).first();
  await item.getByTestId("option").filter({ hasText: "Try again" }).first().click();
  const yes = page.getByTestId("choice-confirm-yes");
  if (await yes.count()) await yes.first().click();
  await page.waitForTimeout(1500);
  const done = page.getByTestId("done-line").first();
  const doneText = await done.innerText().catch(() => "");
  await R.step(page, `${LABEL} inbox done line with Start`);
  check("the Done line says it runs at the next Start", /it runs at your next Start/.test(doneText), doneText);
  const start = done.getByTestId("done-line-start");
  check("the Done line offers Start", (await start.count()) === 1, doneText);
  if (await start.count()) {
    await start.click();
    await page.waitForTimeout(1200);
    const dialog = page.getByTestId("start-session-dialog");
    check("Start opens the project's Start dialog", (await dialog.count()) === 1, "");
    await R.step(page, `${LABEL} start dialog from the done line`);
    // The dialog's own Start starts the session; the Done line's Start then goes.
    const go = dialog.getByRole("button", { name: /^Start/ }).last();
    await go.click();
    await page.waitForTimeout(2500);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(1000);
    const now = await R.api(NAME, "GET", "/running");
    const runs = now.some((r) => r.projectId === project.id);
    await R.step(page, `${LABEL} inbox while the session runs`);
    const shown = await page.getByTestId("done-line-start").count();
    check("no Start beside the Done line while a session of that project runs", !runs || shown === 0, JSON.stringify({ runs, shown }));
  }
  fs.writeFileSync(path.join(b.steps, `${LABEL}-v6.json`), JSON.stringify(out, null, 1));
  await browser.close();
  const failed = out.checks.filter((c) => !c.ok).length;
  console.log(`${LABEL}: ${out.checks.length - failed}/${out.checks.length} checks pass`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
