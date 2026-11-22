// fixup-d1109-onerepo-join walk: Make one project on bench/seeded, then what the joined project's
// page offers (no New task, Chat kept to read, no note box or research setting), what its routes
// answer to new work, the same after a daemon restart, then Undo from Changes after the restart
// and Kite club taking work again. Part "a" before the restart, part "b" after.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-4";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "fixup-d1109-onerepo-join";
const pair = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/pair.json`, "utf8"));
const REFUSED = '"Kite club" joined "Site", so its work runs there.';
const checks = [];
const check = (name, ok, seen) => {
  checks.push({ name, ok: !!ok, seen });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` :: ${JSON.stringify(seen).slice(0, 400)}`}`);
};
const kiteUrl = (tab) => `/projects/${pair.kite}/${tab}`;
const siteUrl = (tab) => `/projects/${pair.site}/${tab}`;

async function probes(label) {
  const task = await R.apiRaw(N, "POST", `/projects/${pair.kite}/tasks`, {
    title: "Probe task on the joined project",
    outcome: "probe",
  });
  check(`${label}: New task on Kite club is refused in words`, task.status === 409 && task.body?.message === REFUSED, task);
  const note = await R.apiRaw(N, "POST", `/projects/${pair.kite}/queue`, { kind: "note", text: "Use the red kite." });
  check(`${label}: a note for Kite club is refused in words`, note.status === 409 && note.body?.message === REFUSED, note);
  const set = await R.apiRaw(N, "POST", "/commands/execute", {
    commands: [{ name: "settings.set", params: { key: "status_pull_request", value: true, project: pair.kite } }],
    wordsUsed: "Status pull request (Settings)",
    source: "ui",
    projectId: pair.kite,
    confirm: "tap",
  });
  check(`${label}: a setting of Kite club is refused in words`, set.body?.status === "refused" && set.body?.reason === REFUSED, set.body);
  const tasks = await R.api(N, "GET", `/projects/${pair.kite}/tasks`);
  check(`${label}: no task was written on Kite club`, tasks.length === 0, tasks.map((t) => t.title));
  const queue = await R.api(N, "GET", `/projects/${pair.kite}/queue`);
  // The first session's consumed plan note stays Kite club's (only queued notes move).
  check(
    `${label}: no note was written on Kite club`,
    !queue.some((q) => q.text === "Use the red kite.") && queue.every((q) => q.status !== "queued"),
    queue.map((q) => ({ kind: q.kind, status: q.status, text: q.text.slice(0, 40) })),
  );
}

async function joinedPage(page, label) {
  await globalThis.go(kiteUrl("summary"));
  await page.getByTestId("project-joined").waitFor();
  await page.getByTestId("summary-tab").waitFor();
  const overview = await R.step(page, `${label}-kite-joined-overview`);
  check(`${label}: Kite club's Overview has no note box`, (await page.getByTestId("queue").count()) === 0, overview);
  check(`${label}: Kite club's Overview has no Research reads Change`, (await page.getByTestId("research-reads").count()) === 0, overview);
  check(`${label}: Kite club's Overview has no Decisions (moved)`, (await page.getByTestId("decisions").count()) === 0, overview);
  await globalThis.go(kiteUrl("tasks"));
  await page.getByTestId("no-tasks").waitFor();
  const tasks = await R.step(page, `${label}-kite-joined-tasks`);
  check(`${label}: Kite club's Tasks tab has no New task`, (await page.getByTestId("new-task").count()) === 0, tasks);
  check(`${label}: Kite club's Tasks tab says where its tasks are`, tasks.includes('Its tasks are in "Site".') && !tasks.includes("Press New task"), tasks);
  await globalThis.go(kiteUrl("chat"));
  await page.getByTestId("chat-closed").waitFor();
  const chat = await R.step(page, `${label}-kite-joined-chat`);
  check(`${label}: Kite club's Chat is kept to read`, chat.includes('This chat is kept to read; ask about its work in the Chat of "Site".') && (await page.getByTestId("chat-input").count()) === 0 && !chat.includes("add a task"), chat);
  await page.getByTestId("chat-closed").getByRole("link", { name: "Open it" }).click();
  await page.getByTestId("chat-input").waitFor();
  check(`${label}: Open it lands on Site's Chat`, page.url().endsWith(siteUrl("chat")), page.url());
  await R.step(page, `${label}-site-chat`);
}

(async () => {
  const part = process.argv[2] ?? "a";
  const { browser, page } = await R.openApp(N, part === "a" ? { freshProfile: true } : {});
  const go = async (path) => {
    await page.goto(`${R.bench(N).uiUrl}${path}`);
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    if (await R.skipSetup(page)) await page.goto(`${R.bench(N).uiUrl}${path}`);
  };
  globalThis.go = go;
  try {
    if (part === "a") {
      await globalThis.go(kiteUrl("summary"));
      await page.getByTestId("shared-repository").waitFor();
      const kiteBefore = await R.step(page, "a01-kite-overview-before");
      check("a: Kite club's Overview names the pair", /"Kite club" and "Site" both work in bench\/seeded\./.test(kiteBefore), kiteBefore);
      await page.getByTestId("make-one-project").click();
      const dialog = page.getByTestId("join-projects-dialog");
      await dialog.waitFor();
      await dialog.getByLabel('Keep "Site"').check();
      await R.step(page, "a02-dialog-keep-site");
      await dialog.getByTestId("join-confirm").click();
      await page.getByTestId("includes-work-of").waitFor({ timeout: 30_000 });
      const site = await R.step(page, "a03-site-includes");
      check("a: Site includes Kite club's work", site.includes('Includes the work of "Kite club".'), site);
      await joinedPage(page, "a");
      await probes("a");
    } else {
      await joinedPage(page, "b");
      await probes("b");
      await globalThis.go("/changes");
      const row = page.locator("li", { hasText: 'Made one project: "Kite club" joined "Site".' }).first();
      await row.waitFor();
      await R.step(page, "b10-changes-after-restart");
      await row.getByRole("button", { name: "Undo" }).click();
      await page.getByText('"Kite club" is its own project again.').first().waitFor({ timeout: 30_000 });
      await R.step(page, "b11-changes-undone");
      await globalThis.go(kiteUrl("tasks"));
      await page.getByTestId("new-task").waitFor();
      const back = await R.step(page, "b12-kite-tasks-after-undo");
      check("b: after Undo Kite club's Tasks tab has New task and its tasks", (await page.getByTestId("task-row").count()) > 0, back);
      await globalThis.go(kiteUrl("chat"));
      await page.getByTestId("chat-input").waitFor();
      await R.step(page, "b13-kite-chat-after-undo");
      const proj = await R.api(N, "GET", `/projects/${pair.kite}`);
      check("b: Kite club is active again", proj.status === "active" && proj.joinedInto == null, { status: proj.status, joinedInto: proj.joinedInto });
      const again = await R.apiRaw(N, "POST", `/projects/${pair.kite}/tasks`, { title: "A task after the Undo", outcome: "probe" });
      check("b: Kite club takes a new task again", again.status === 201, again.status);
    }
  } finally {
    await browser.close();
    const file = `/tmp/frbench/${N}/walk-${part}.json`;
    fs.writeFileSync(file, JSON.stringify({ part, checks }, null, 2));
    console.log(`${checks.filter((c) => c.ok).length} of ${checks.length} pass (${file})`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
