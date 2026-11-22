// Fix-up walk B of d1109-run-visible (--provider bench-api --api-key limited,
// FORERUNNER_BENCH_API_LIMIT_MIN=2): the review's blocking 3. After Cancel on a session that
// waits to go on, the Overview's Last result, Read aloud's text and the Inbox's Update line say
// what is true now, also after a reload and after a daemon restart.
"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_bc132d49-0b3-6";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const NAME = process.argv[2] || "fixup-d1109-run-visible";
const LABEL = process.argv[3] || "after";
const enc = encodeURIComponent;
const out = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, seen) => {
  checks.push({ name, ok: !!ok, seen });
  out(ok ? "PASS" : "FAIL", name, ok ? "" : `-- saw: ${JSON.stringify(seen).slice(0, 500)}`);
};
const save = () =>
  fs.writeFileSync(`${R.bench(NAME).steps}/${LABEL}-walk-b.json`, JSON.stringify({ checks }, null, 1));

async function barText(page) {
  const bar = page.getByTestId("run-indicator-bar");
  if (!(await bar.count())) return null;
  return (await bar.getByTestId("run-text").first().innerText().catch(() => "")).trim();
}
const lastResult = (text) => (text.split("Last result")[1] ?? "").split("Next")[0];

async function main() {
  let { browser, page } = await R.openApp(NAME, { viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15_000);
  await R.skipSetup(page);
  const ui = () => R.bench(NAME).uiUrl;
  const sea = await R.api(NAME, "POST", "/projects", { name: "Sea notes", goal: "Notes about the sea" });
  for (const t of ["Write tides.md", "Write waves.md"])
    await R.api(NAME, "POST", `/projects/${enc(sea.id)}/tasks`, {
      title: t,
      outcome: `${t.split(" ").pop()} exists`,
      acceptanceCriteria: [`${t.split(" ").pop()} exists`],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: 0,
      specialist: "coder",
      riskTier: 1,
    });
  await page.goto(`${ui()}/projects/${enc(sea.id)}`);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first().click();
  await page.waitForTimeout(1500);
  await page.getByTestId("confirm-start-session").click();
  await page.waitForTimeout(1500);
  const close = page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).last();
  if (await close.count()) await close.click();
  await R.until(async () => /^Sea notes · waiting/.test((await barText(page)) ?? ""), 90_000, 1000, "Sea notes to wait");
  await page.goto(`${ui()}/projects/${enc(sea.id)}`);
  await page.waitForTimeout(2000);
  const ov0 = await R.step(page, `${LABEL}-b1-sea-overview-waiting`);
  check("while it waits the Last result says the session goes on", /then your session goes on/.test(lastResult(ov0)), lastResult(ov0));

  // Cancel on the bar.
  await page.getByTestId("run-indicator-bar").getByTestId("run-cancel").click();
  await page.waitForTimeout(3000);
  const ov = await R.step(page, `${LABEL}-b2-sea-overview-after-cancel`);
  check("after Cancel the Last result no longer promises it goes on (no reload)", !/then your session goes on/.test(lastResult(ov)), lastResult(ov));
  check("after Cancel the Last result says it runs at the next Start", /then it runs at your next Start/.test(lastResult(ov)), lastResult(ov));
  await page.reload();
  await page.waitForTimeout(2500);
  const ov2 = await R.step(page, `${LABEL}-b3-sea-overview-after-cancel-reload`);
  check("after a reload too", !/then your session goes on/.test(lastResult(ov2)), lastResult(ov2));
  const summary = await R.api(NAME, "GET", `/projects/${enc(sea.id)}/summary`);
  check("Read aloud's text no longer promises it", !/then your session goes on/.test(summary.spoken ?? ""), summary.spoken);
  await page.goto(`${ui()}/inbox`);
  await page.waitForTimeout(2000);
  const inbox = await R.step(page, `${LABEL}-b4-inbox-after-cancel`);
  const msgs = (await R.api(NAME, "GET", "/inbox")).messages.filter((m) => m.projectId === sea.id).map((m) => m.body);
  check("the Inbox's Update line no longer promises it", msgs.length > 0 && msgs.every((b) => !/then your session goes on/.test(b)), msgs);
  check("the Inbox page shows no promise", !/Sea notes: Waits until .*then your session goes on/.test(inbox), inbox.slice(0, 1500));
  save();
  await browser.close();

  // After a daemon restart.
  out(execFileSync("node", [`${REPO}/scripts/bench/restart-daemon.mjs`, "--name", NAME], { encoding: "utf8" }).trim());
  ({ browser, page } = await R.openApp(NAME, { viewport: { width: 1280, height: 900 } }));
  await page.goto(`${ui()}/projects/${enc(sea.id)}`);
  await page.waitForTimeout(2500);
  const ov3 = await R.step(page, `${LABEL}-b5-sea-overview-after-restart`);
  check("after a restart the Last result still says it runs at the next Start", /then it runs at your next Start/.test(lastResult(ov3)) && !/then your session goes on/.test(lastResult(ov3)), lastResult(ov3));
  const msgs2 = (await R.api(NAME, "GET", "/inbox")).messages.filter((m) => m.projectId === sea.id).map((m) => m.body);
  check("after a restart the Update line too", msgs2.every((b) => !/then your session goes on/.test(b)), msgs2);
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
