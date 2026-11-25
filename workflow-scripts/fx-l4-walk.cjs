"use strict";
// Reviewer walk for w8-l4-leftovers on bench A (--provider bench).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-9/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const NAME = "fixup-w8-l4-leftovers";
const enc = encodeURIComponent;
const usdMicro = (chf) => Math.round((chf / 0.8) * 1_000_000);
const out = {};
const log = (k, v) => {
  out[k] = v;
  console.log(`== ${k}: ${typeof v === "string" ? v : JSON.stringify(v).slice(0, 1500)}`);
};
const step = (page, s, o) => R.step(page, `fx ${s}`, o);
const openProject = async (page, projectId, tab) => {
  await page.goto(`${R.bench(NAME).uiUrl}/projects/${enc(projectId)}/${tab}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
};
async function startFromUi(page, projectId, what) {
  await openProject(page, projectId, "summary");
  const open = page.getByRole("button", { name: /^(Start session|Start|Continue)$/ }).first();
  await open.click();
  await page.waitForTimeout(1500);
  const dialogText = await step(page, `${what} start dialog`);
  const dialog = page.getByTestId("start-session-dialog");
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await page.waitForTimeout(2500);
  await step(page, `${what} after start`);
  return dialogText;
}
async function newestSession(projectId) {
  return R.until(
    async () => (await R.api(NAME, "GET", `/sessions?projectId=${enc(projectId)}`))[0] ?? null,
    30_000,
    500,
    "the new session",
  );
}
const task = (projectId, title, file, extra = {}) =>
  R.api(NAME, "POST", `/projects/${enc(projectId)}/tasks`, {
    title,
    outcome: `${file} is written`,
    acceptanceCriteria: [`${file} exists`],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    specialist: "coder",
    riskTier: 1,
    ...extra,
  });

(async () => {
  const which = process.argv[2] || "all";
  const { browser, page } = await R.openApp(NAME);
  try {
    const first = await page.evaluate(() => document.body.innerText);
    if (/Set up Forerunner/.test(first)) await R.skipSetup(page);

    if (which === "all" || which === "review") {
      // L4i-left-31 + L4i-left-64: a task whose work fits its budget and whose review does not.
      const p = await R.api(NAME, "POST", "/projects", { name: "Pond notes", goal: "Notes about the pond" });
      await task(p.id, "Write the pond notes", "notes/pond.md", { budgetUsdMicro: usdMicro(0.01) });
      await task(p.id, "Write the frog notes", "notes/frogs.md");
      await openProject(page, p.id, "tasks");
      log("pond tasks before", await step(page, "pond tasks before start"));
      log("pond dialog", await startFromUi(page, p.id, "pond"));
      const s = await newestSession(p.id);
      const ended = await R.waitForSession(NAME, s.id);
      await page.waitForTimeout(2000);
      log("pond session statusText", ended.statusText);
      log("pond session summary", ended.summary);
      await page.goto(`${R.bench(NAME).uiUrl}/sessions/${enc(s.id)}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      log("pond session page", await step(page, "pond session page"));
      await openProject(page, p.id, "sessions");
      log("pond sessions tab", await step(page, "pond sessions tab"));
      await openProject(page, p.id, "tasks");
      log("pond tasks after", await step(page, "pond tasks after"));
      const events = await R.api(NAME, "GET", `/sessions/${enc(s.id)}/events`);
      log("pond lines", events.map((e) => e.text));
      out.pond = { projectId: p.id, sessionId: s.id };
    }

    if (which === "all" || which === "outer") {
      // L4i-left-28: an outer limit (the project's budget) ends the session with room left.
      const p = await R.api(NAME, "POST", "/projects", {
        name: "Bird notes",
        goal: "Notes about birds",
        budgetUsdMicro: usdMicro(0.06),
      });
      await task(p.id, "Write the heron page", "heron.md");
      await task(p.id, "Write the owl page", "owl.md");
      log("bird dialog", await startFromUi(page, p.id, "bird"));
      const s = await newestSession(p.id);
      const ended = await R.waitForSession(NAME, s.id);
      await page.waitForTimeout(2000);
      log("bird session statusText", ended.statusText);
      log("bird session summary", ended.summary);
      await page.goto(`${R.bench(NAME).uiUrl}/sessions/${enc(s.id)}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      log("bird session page", await step(page, "bird session page"));
      await openProject(page, p.id, "sessions");
      log("bird sessions tab", await step(page, "bird sessions tab"));
      await openProject(page, p.id, "summary");
      log("bird overview", await step(page, "bird overview"));
      const events = await R.api(NAME, "GET", `/sessions/${enc(s.id)}/events`);
      log("bird lines", events.map((e) => e.text));
      const notes = await R.api(NAME, "GET", "/notifications/recent?limit=50");
      log("bird notifications", (notes.notifications ?? []).map((n) => `${n.title} | ${n.body}`));
      out.bird = { projectId: p.id, sessionId: s.id };
    }

    if (which === "all" || which === "assisted") {
      // L4i-left-27: Assisted mode's session plan card.
      const p = await R.api(NAME, "POST", "/projects", {
        name: "Fern notes",
        goal: "Notes about ferns",
        autonomyLevel: 1,
      });
      await task(p.id, "Write the fern notes", "ferns.md");
      log("fern dialog", await startFromUi(page, p.id, "fern"));
      await page.goto(`${R.bench(NAME).uiUrl}/inbox`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3000);
      log("fern inbox", await step(page, "fern inbox plan card"));
      const inbox = await R.api(NAME, "GET", "/inbox");
      const card = inbox.requests.find(
        (r) => r.projectId === p.id && r.status === "open" && /session plan/i.test(r.title ?? r.why ?? ""),
      );
      log("fern card", card ? { title: card.title, options: card.options, choices: card.choices } : null);
      const btn = page.getByRole("button", { name: "Approve", exact: true }).first();
      log("approve button visible", await btn.isVisible().catch(() => false));
      await btn.click();
      await page.waitForTimeout(4000);
      log("fern after approve", await step(page, "fern after approve"));
      const sessions = await R.api(NAME, "GET", `/sessions?projectId=${enc(p.id)}`);
      log("fern sessions", sessions.map((x) => ({ status: x.status, statusText: x.statusText })));
      out.fern = { projectId: p.id };
    }
  } catch (e) {
    console.error("WALK ERROR", e);
    out.error = String(e && e.stack ? e.stack : e);
  } finally {
    fs.writeFileSync(
      "/tmp/claude-0/-home-user/9d17d664-b8c3-5e0d-8f13-1f917f72dcc2/scratchpad/fx-l4-walk-result.json",
      JSON.stringify(out, null, 1),
    );
    await browser.close();
  }
})();
