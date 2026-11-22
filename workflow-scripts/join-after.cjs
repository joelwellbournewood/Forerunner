// After (this branch): the Overview's line, the dialog, Make one project, the joined page, the
// kept project's Includes, Sessions and Costs lines, Changes with Undo, then Undo after a restart.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-1";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "fix-d1109-onerepo-join";
const B = () => JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));
const pair = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/pair.json`, "utf8"));
const out = { checks: [] };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${String(detail).slice(0, 240)}` : ""}`);
};
const text = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();

(async () => {
  let { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    // 1. Site's Overview: the line with Make one project.
    await page.goto(`${B().uiUrl}/projects/${pair.site}/summary`);
    const line = page.getByTestId("shared-repository-line");
    await line.waitFor({ timeout: 30_000 });
    check(
      "Site's Overview says both work in the folder",
      (await text(line)) === '"Site" and "Kite club" both work in the same folder.',
      await text(line),
    );
    check("the explain line", (await text(page.getByTestId("shared-repository"))).includes("You choose which to keep; the other's tasks, plan and cards move into it."));
    await R.step(page, "after-01-site-overview-line");
    // 2. The dialog.
    await page.getByTestId("make-one-project").click();
    const dialog = page.getByTestId("join-projects-dialog");
    await dialog.waitFor({ timeout: 15_000 });
    await page.getByTestId(`join-project-${pair.kite}`).waitFor({ timeout: 15_000 });
    check("Make one project is off until a project is chosen", await page.getByTestId("join-confirm").isDisabled());
    await R.step(page, "after-02-dialog");
    await page.getByLabel('Keep "Site"').check();
    await page.waitForTimeout(500);
    const plan = await text(page.getByTestId("join-plan"));
    check("the moves line names both", plan.includes('The tasks, plan, cards and pull requests of "Kite club" move into "Site".'), plan);
    await R.step(page, "after-03-dialog-keep-site");
    await page.getByTestId("join-confirm").click();
    await page.waitForURL(new RegExp(`/projects/${pair.site}`), { timeout: 20_000 });
    const includes = page.getByTestId("includes-work-of");
    await includes.waitFor({ timeout: 20_000 });
    check("Site includes the work of Kite club", (await text(includes)).includes('Includes the work of "Kite club".'), await text(includes));
    check("the shared line is gone", (await page.getByTestId("shared-repository").count()) === 0);
    await R.step(page, "after-04-site-includes");
    // 3. The kept project's tasks, Sessions and Costs.
    const tasks = await R.api(N, "GET", `/projects/${pair.site}/tasks`);
    check("Kite club's tasks are Site's now", tasks.length === 2, tasks.map((t) => `${t.title}:${t.status}`).join("; "));
    await page.goto(`${B().uiUrl}/projects/${pair.site}/sessions`);
    const sj = page.getByTestId("sessions-joined");
    await sj.waitFor({ timeout: 20_000 });
    check("Sessions says Kite club's sessions before it joined", /^"Kite club" had \d+ sessions? before it joined\. Open$/.test(await text(sj)), await text(sj));
    await R.step(page, "after-05-site-sessions-joined");
    await page.goto(`${B().uiUrl}/projects/${pair.site}/costs`);
    const cj = page.getByTestId("cost-joined");
    await cj.waitFor({ timeout: 20_000 });
    check("Costs says what Kite club spent before it joined", /^Spent in "Kite club" before it joined: (CHF \d+\.\d\d|less than CHF 0\.01)/.test(await text(cj)), await text(cj));
    await R.step(page, "after-06-site-costs-joined");
    // 4. The joined project's page.
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/summary`);
    const joined = page.getByTestId("project-joined");
    await joined.waitFor({ timeout: 20_000 });
    check("Kite club's page says it joined Site", /^Joined into "Site" on \d+ \w+\.\s*Open it$/.test(await text(joined)), await text(joined));
    check("no Start on the joined page", (await page.getByRole("button", { name: /^Start/ }).count()) === 0);
    await R.step(page, "after-07-kite-joined-page");
    // 5. Changes, then a restart, then Undo.
    await page.goto(`${B().uiUrl}/changes`);
    const row = page.getByText('Made one project: "Kite club" joined "Site".').first();
    await row.waitFor({ timeout: 20_000 });
    await R.step(page, "after-08-changes-row");
    await browser.close();
    execFileSync("node", [`${REPO}/scripts/bench/restart-daemon.mjs`, "--name", N], { stdio: "inherit" });
    ({ browser, page } = await R.openApp(N));
    await page.goto(`${B().uiUrl}/changes`);
    await page.getByText('Made one project: "Kite club" joined "Site".').first().waitFor({ timeout: 30_000 });
    const changes = await R.api(N, "GET", "/changes");
    const list = Array.isArray(changes) ? changes : changes.changes ?? changes.rows ?? [];
    const joinRow = list.find((r) => r.sentence === 'Made one project: "Kite club" joined "Site".');
    check("after a restart the row still has Undo", joinRow && joinRow.undoable === true, JSON.stringify(joinRow ?? {}).slice(0, 300));
    const undone = await R.api(N, "POST", `/changes/${joinRow.id}/undo`, {});
    check("Undo after the restart", undone.status === "done" && undone.sentence === '"Kite club" is its own project again.', JSON.stringify(undone).slice(0, 300));
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/summary`);
    await page.getByTestId("shared-repository-line").waitFor({ timeout: 20_000 });
    const kiteTasks = await R.api(N, "GET", `/projects/${pair.kite}/tasks`);
    check("Kite club has its tasks back", kiteTasks.length === 2);
    check("Kite club's Overview shows the line again", (await text(page.getByTestId("shared-repository-line"))).includes('"Site" and "Kite club" both work in'));
    await R.step(page, "after-09-undone-after-restart");
  } finally {
    await browser.close().catch(() => undefined);
    fs.writeFileSync(`/tmp/frbench/${N}/after-walk.json`, JSON.stringify(out, null, 2));
  }
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`/tmp/frbench/${N}/after-walk.json`, JSON.stringify({ ...out, error: String(e) }, null, 2));
  process.exit(1);
});
