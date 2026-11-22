// Review walk, part 1: Home and both Overviews before; the dialog refused while a session runs;
// the join from Site's Overview; Site's Overview after (lines and pull requests), Merge of a moved
// pull request from Site; Kite club's joined page and tabs; Site's Sessions and Costs; Home after;
// Changes. Results in /tmp/frbench/<n>/walk1.json.
const fs = require("node:fs");
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_ab42b5f3-91e-3";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const N = "review-d1109-onerepo-join";
const B = () => JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));
const pair = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/pair.json`, "utf8"));
const out = { checks: [], texts: {} };
const check = (name, ok, detail) => {
  out.checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : String(detail).slice(0, 600) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` :: ${String(detail).slice(0, 300)}` : ""}`);
};
const text = async (loc) => ((await loc.textContent()) ?? "").replace(/\s+/g, " ").trim();

(async () => {
  const { browser, page } = await R.openApp(N, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${B().uiUrl}/`);
    await page.waitForTimeout(2500);
    out.texts.homeBefore = await R.step(page, "a01-home-before");
    // Site's Overview: the shared line.
    await page.goto(`${B().uiUrl}/projects/${pair.site}/summary`);
    const line = page.getByTestId("shared-repository-line");
    await line.waitFor({ timeout: 30_000 });
    check("Site: shared line", (await text(line)) === '"Kite club" and "Site" both work in bench/seeded.', await text(line));
    check("Site: explain line", (await text(page.getByTestId("shared-repository"))).includes("You choose which to keep; the other's tasks, plan and cards move into it."));
    out.texts.siteBefore = await R.step(page, "a02-site-overview-before");
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/summary`);
    await page.getByTestId("shared-repository-line").waitFor({ timeout: 30_000 });
    check("Kite: same shared line", (await text(page.getByTestId("shared-repository-line"))) === '"Kite club" and "Site" both work in bench/seeded.');
    out.texts.kiteBefore = await R.step(page, "a03-kite-overview-before");

    // Failure injection: a slow session on Kite club holds the join.
    const t = await R.api(N, "POST", `/projects/${pair.kite}/tasks`, {
      title: "Write the rules in rules.md",
      outcome: "rules.md lists the club rules",
      riskTier: 1,
      specialist: "coder",
    });
    const s = await R.startSession(N, pair.kite);
    const sid = s.session?.id;
    check("slow session on Kite club started", !!sid, s.result);
    await page.goto(`${B().uiUrl}/projects/${pair.site}/summary`);
    await page.getByTestId("make-one-project").click();
    await page.getByTestId("join-projects-dialog").waitFor({ timeout: 15_000 });
    await page.getByTestId(`join-project-${pair.kite}`).waitFor({ timeout: 15_000 });
    check("Make one project disabled before a choice", await page.getByTestId("join-confirm").isDisabled());
    out.texts.dialogBefore = await R.step(page, "a04-dialog-no-choice");
    await page.getByLabel('Keep "Site"').check();
    const refusal = page.getByTestId("join-refusal");
    await refusal.waitFor({ timeout: 10_000 }).catch(() => undefined);
    const rtext = (await refusal.count()) ? await text(refusal) : "(none)";
    check("refusal while a session works on Kite club", rtext === 'A session is working on "Kite club". Make one project when it ends.', rtext);
    check("Make one project disabled while refused", await page.getByTestId("join-confirm").isDisabled());
    out.texts.dialogRefused = await R.step(page, "a05-dialog-refused-running");
    await page.getByRole("button", { name: "Cancel" }).click();
    // Stop it and wait for it to end.
    await R.api(N, "POST", `/sessions/${sid}/stop`, {});
    await R.waitForSession(N, sid, 120_000);
    const kt = (await R.api(N, "GET", `/projects/${pair.kite}/tasks`)).map((x) => `${x.title}=${x.status}`);
    console.log("kite tasks after stop", kt.join("; "));
    out.kiteTasksBefore = kt;

    // The join from Site's Overview.
    await page.goto(`${B().uiUrl}/projects/${pair.site}/summary`);
    await page.getByTestId("make-one-project").click();
    await page.getByTestId(`join-project-${pair.kite}`).waitFor({ timeout: 15_000 });
    await page.getByLabel('Keep "Site"').check();
    await page.waitForTimeout(500);
    const plan = await text(page.getByTestId("join-plan"));
    check("moves line", plan.includes('The tasks, plan, cards and pull requests of "Kite club" move into "Site".'), plan);
    check("stays line", plan.includes('"Kite club" keeps its sessions, changes and spending to read; no budget changes.'), plan);
    check("no refusal now", (await page.getByTestId("join-refusal").count()) === 0);
    out.texts.dialogKeepSite = await R.step(page, "a06-dialog-keep-site");
    await page.getByTestId("join-confirm").click();
    await page.waitForURL(new RegExp(`/projects/${pair.site}/summary`), { timeout: 20_000 });
    const includes = page.getByTestId("includes-work-of");
    await includes.waitFor({ timeout: 20_000 });
    check("Site includes Kite club", (await text(includes)) === 'Includes the work of "Kite club".', await text(includes));
    check("Site: shared line gone", (await page.getByTestId("shared-repository").count()) === 0);
    await page.waitForTimeout(2500);
    const waiting = await page.getByTestId("pr-waiting").allTextContents();
    out.siteWaiting = waiting;
    check("Site lists Kite club's pull requests too", waiting.length === 4, waiting.join(" | "));
    out.texts.siteAfter = await R.step(page, "a07-site-overview-after-join");
    // Merge Kite club's task pull request from Site's Overview.
    const kitePr = page.locator('[data-testid="pr-waiting"]', { hasText: "Write the club notes" });
    await kitePr.getByTestId("pr-merge").click();
    await R.until(async () => {
      const prs = await R.api(N, "GET", `/projects/${pair.site}/pull-requests`);
      return prs.waiting.every((w) => !/club notes/.test(w.title)) ? prs : null;
    }, 60_000, 1000, "Kite club's task pull request to merge from Site");
    await page.waitForTimeout(1500);
    out.texts.siteMerged = await R.step(page, "a08-site-after-merge");
    const gh = B().githost.url;
    const pr2 = await fetch(`${gh}/repos/bench/seeded/pulls/2`).then((r) => r.json()).catch(() => null);
    out.pr2 = pr2 ? { state: pr2.state, merged: pr2.merged } : null;
    // Kite club's page.
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/summary`);
    const joined = page.getByTestId("project-joined");
    await joined.waitFor({ timeout: 20_000 });
    check("Kite: joined line", /^Joined into "Site" on 16 Nov\.\s*Open it$/.test(await text(joined)), await text(joined));
    check("Kite: no Start session", (await page.getByRole("button", { name: /Start session/ }).count()) === 0);
    out.texts.kiteJoined = await R.step(page, "a09-kite-joined-overview");
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/tasks`);
    await page.waitForTimeout(2500);
    out.texts.kiteTasks = await R.step(page, "a10-kite-joined-tasks");
    out.kiteNewTask = await page.getByRole("button", { name: /New task/ }).count();
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/chat`);
    await page.waitForTimeout(2000);
    out.texts.kiteChat = await R.step(page, "a11-kite-joined-chat");
    await page.goto(`${B().uiUrl}/projects/${pair.kite}/sessions`);
    await page.waitForTimeout(2000);
    out.texts.kiteSessions = await R.step(page, "a12-kite-joined-sessions");
    // Site's Sessions and Costs.
    await page.goto(`${B().uiUrl}/projects/${pair.site}/sessions`);
    const sj = page.getByTestId("sessions-joined");
    await sj.waitFor({ timeout: 20_000 });
    check("Site Sessions: joined line", /^"Kite club" had 2 sessions before it joined\. Open$/.test(await text(sj)), await text(sj));
    out.texts.siteSessions = await R.step(page, "a13-site-sessions");
    await page.goto(`${B().uiUrl}/projects/${pair.site}/costs`);
    const cj = page.getByTestId("cost-joined");
    await cj.waitFor({ timeout: 20_000 });
    check("Site Costs: joined spend", /^Spent in "Kite club" before it joined: (CHF \d+\.\d\d|less than CHF 0\.01)$/.test(await text(cj)), await text(cj));
    out.texts.siteCosts = await R.step(page, "a14-site-costs");
    await page.goto(`${B().uiUrl}/projects/${pair.site}/tasks`);
    await page.waitForTimeout(2500);
    out.texts.siteTasks = await R.step(page, "a15-site-tasks");
    await page.goto(`${B().uiUrl}/`);
    await page.waitForTimeout(2500);
    out.texts.homeAfter = await R.step(page, "a16-home-after");
    check("Home lists Site, not Kite club", out.texts.homeAfter.includes("Site") && !out.texts.homeAfter.includes("Kite club"));
    await page.goto(`${B().uiUrl}/changes`);
    await page.getByText('Made one project: "Kite club" joined "Site".').first().waitFor({ timeout: 20_000 });
    out.texts.changes = await R.step(page, "a17-changes");
  } finally {
    await browser.close().catch(() => undefined);
    fs.writeFileSync(`/tmp/frbench/${N}/walk1.json`, JSON.stringify(out, null, 2));
  }
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(`/tmp/frbench/${N}/walk1.json`, JSON.stringify({ ...out, error: String(e) }, null, 2));
  process.exit(1);
});
