// Screens area walk: Changes (b), Continue where it stopped (c), POST /sessions (f), the drawer's
// file link (a), the planning session (e), GET /projects timing (#71).
// Usage: node screens-walk-b.cjs <repo> <bench> <tag>
"use strict";
const [repo, N, tag] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const out = { tag };

async function planned(name) {
  const p = await R.createPlannedProject(N, {
    project: name,
    goal: "A page that shows a random quote each time it is opened",
    brief:
      "A one-page website that shows a random quote each time it is opened; plain HTML, CSS and JavaScript; no build step",
    approve: false,
  });
  return p.projectId;
}

async function waitIdle(ms = 300_000) {
  return R.until(
    async () => {
      const ss = await R.api(N, "GET", "/sessions");
      return ss.some((s) => ["running", "planned", "paused"].includes(s.status)) ? null : ss;
    },
    ms,
    1500,
    "no session running",
  );
}

(async () => {
  const me = await R.api(N, "GET", "/me");
  const agentId = me.agent.id;
  const { browser, page } = await R.openApp(N);
  await R.skipSetup(page);
  const ui = R.bench(N).uiUrl;

  // (c) Two projects with ready tasks (plans approved in the Inbox as the UI does, then any
  // session Approve and start began is waited for).
  const a = await R.createPlannedProject(N, {
    project: `Alpha ${tag}`,
    goal: "Notes",
    brief: "A notes file in notes/todo.md listing three things to do",
  });
  await waitIdle();
  const b = await R.createPlannedProject(N, {
    project: `Beta ${tag}`,
    goal: "Notes",
    brief: "A notes file in notes/ideas.md listing three ideas",
  });
  await waitIdle();
  // Give each a fresh ready task.
  for (const p of [a, b])
    await R.api(N, "POST", `/projects/${p.projectId}/tasks`, {
      title: `Write notes/extra-${tag}.md`,
      outcome: "the file lists two more items",
    });
  // A session on Alpha only, then Stop all from the header while it runs.
  await R.api(N, "POST", "/sessions", { agentId, projectId: a.projectId, trigger: "manual" });
  await R.until(
    async () =>
      (await R.api(N, "GET", `/sessions?projectId=${a.projectId}`)).find(
        (s) => s.status === "running",
      ) || null,
    30_000,
    300,
    "Alpha's session",
  );
  await page.goto(`${ui}/`);
  await page.waitForTimeout(1500);
  await page.getByTestId("kill-switch").click();
  await page.getByTestId("kill-confirm-stop").click();
  await page.getByTestId("kill-banner").waitFor();
  await R.step(page, `${tag} c stopped bar`);
  const before = (await R.api(N, "GET", "/sessions")).map((s) => s.id);
  await page.getByTestId("kill-continue").click();
  await page.waitForTimeout(4000);
  const after = await R.api(N, "GET", "/sessions");
  const fresh = after.filter((s) => !before.includes(s.id));
  out.continueStarted = fresh.map((s) => ({
    project: s.projectId === a.projectId ? "Alpha" : s.projectId === b.projectId ? "Beta" : s.projectId,
    status: s.status,
  }));
  await R.step(page, `${tag} c after continue`);
  await waitIdle();

  // (b) Changes: a start by chat words, then a Settings click (the Settings page's body).
  const asked = await R.api(N, "POST", "/commands/execute", {
    commands: [{ name: "session.start", params: { project: b.projectId, budgetChf: 1.5 } }],
    wordsUsed: "start a session on Beta",
    source: "text",
    projectId: b.projectId,
  });
  out.chatStart = asked.status;
  if (asked.status === "pending" && asked.pendingId)
    await R.api(N, "POST", `/commands/${asked.pendingId}/confirm`, { answer: "tap" });
  await waitIdle();
  await R.api(N, "POST", "/commands/execute", {
    commands: [
      { name: "settings.set", params: { key: "quiet_hours", value: { start: "12:00", end: "18:00" } } },
    ],
    wordsUsed: "Settings: Quiet hours to from 12:00 to 18:00",
    source: "ui",
  });
  await page.goto(`${ui}/changes`);
  await page.waitForTimeout(2500);
  out.changes = await R.step(page, `${tag} b changes`);

  // (f) POST /sessions on a project with nothing to run (a new empty project).
  const empty = await R.api(N, "POST", "/projects", { name: `Empty ${tag}`, goal: "Nothing yet" });
  out.postSessionsNothing = await R.apiRaw(N, "POST", "/sessions", {
    agentId,
    projectId: empty.id,
    trigger: "manual",
    reason: "bench: nothing runnable",
  });
  await waitIdle();

  // (a) A done task's drawer: click its first changed file.
  const tasks = await R.api(N, "GET", `/projects/${a.projectId}/tasks`);
  const done = tasks.find((t) => t.status === "done");
  if (done) {
    await page.goto(`${ui}/projects/${a.projectId}/tasks?task=${done.id}`);
    await page.waitForTimeout(2000);
    await R.step(page, `${tag} a done drawer`);
    const link = page.getByTestId("drawer-files").first().getByRole("link").first();
    if (await link.count()) {
      await link.click();
      await page.waitForTimeout(2000);
      out.fileOpened = await page.getByTestId("file-view-path").textContent().catch(() => null);
      await R.step(page, `${tag} a file opened from the drawer`);
    } else out.fileOpened = "no link in the drawer";
  }

  // (e) The planning session's page.
  const intake = (await R.api(N, "GET", `/sessions?projectId=${a.projectId}`)).find((s) =>
    /^intake:/.test(s.summary),
  );
  if (intake) {
    await page.goto(`${ui}/sessions/${intake.id}`);
    await page.waitForTimeout(2000);
    out.planningSession = await R.step(page, `${tag} e planning session`);
  }

  // (#71) GET /projects with 20 projects.
  const have = (await R.api(N, "GET", "/projects")).length;
  for (let i = have; i < 20; i++)
    await R.api(N, "POST", "/projects", { name: `Load ${tag} ${i}`, goal: "Count" });
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await R.api(N, "GET", "/projects");
    times.push(Date.now() - t0);
  }
  out.getProjectsMs = times;
  fs.writeFileSync(`/tmp/frbench/${N}/walk-b-${tag}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ...out, changes: undefined, planningSession: undefined }, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
