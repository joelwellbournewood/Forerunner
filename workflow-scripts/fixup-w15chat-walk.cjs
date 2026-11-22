// Fix-up walk for w15-chat on the stand-in bench "fixup-w15-chat": W15-36's review findings.
// 1. New project keeps "go back" (Talk "go back" after New project returns to the project you
//    were on). 2. After the creation's Undo (after a daemon restart) Changes names the removed
//    project in words, no link, no Undo on its other rows; its plan card leaves the Inbox.
// 3. New project with the same name works after the Undo.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_442cea1d-150-12/scripts/bench/recorder.cjs");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const NAME = "fixup-w15-chat";
const STEPS = "/tmp/frbench/fixup-w15-chat/steps";
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_442cea1d-150-12";
const out = { checks: {} };
const check = (k, v, detail) => {
  out.checks[k] = { ok: !!v, detail };
  console.log(`${v ? "PASS" : "FAIL"} ${k}${detail ? `: ${JSON.stringify(detail).slice(0, 300)}` : ""}`);
};

async function newProject(page, name, goal, brief) {
  await page.goto(`${R.bench(NAME).uiUrl}/`);
  await page.waitForTimeout(1200);
  await page.getByTestId("new-project").click();
  const d = page.getByTestId("new-project-dialog");
  await d.getByLabel("Name").fill(name);
  await d.getByLabel(/Goal/).fill(goal);
  if (brief) await d.getByLabel("Brief").fill(brief);
  await d.getByTestId("create-project").click();
  await d.waitFor({ state: "hidden", timeout: 20_000 });
}

async function talk(page, text) {
  if (!(await page.getByTestId("conversation-input").isVisible().catch(() => false)))
    await page.getByTestId("talk-open").click();
  const before = await page.getByTestId("conversation-agent").count();
  await page.getByTestId("conversation-input").fill(text);
  await page.getByTestId("conversation-send").click();
  await R.until(
    async () => (await page.getByTestId("conversation-agent").count()) > before,
    30_000,
    500,
    "the reply",
  );
  await page.waitForTimeout(800);
  return (await page.getByTestId("conversation-agent").last().innerText()).trim();
}

const activeName = async (page) => (await page.getByTestId("active-project").innerText()).trim();

(async () => {
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  const go = async (path) => {
    await page.goto(`${R.bench(NAME).uiUrl}${path}`);
    await page.waitForTimeout(1500);
  };
  try {
    await R.skipSetup(page).catch(() => {});
    await go("/");
    await R.step(page, "home-start");
    await newProject(page, "Old garden", "A garden page");
    await page.waitForTimeout(1500);
    await newProject(
      page,
      "Garden club",
      "A page for the club",
      "A one-page site for the garden club with the meeting times.",
    );
    await page.waitForTimeout(2000);
    check("active is Garden club after New project", /Garden club/.test(await activeName(page)));
    await R.step(page, "after-new-project-garden-club");

    // 1. go back (Talk), then go back again.
    const back = await talk(page, "go back");
    await page.waitForTimeout(1000);
    check("Talk 'go back' after New project returns to Old garden", /Switched back to Old garden/.test(back), back);
    // The header shows the project whose page is open; the active project is /me's.
    const meNow = await R.api(NAME, "GET", "/me");
    const oldNow = (await R.api(NAME, "GET", "/projects")).find((p) => p.name === "Old garden");
    check("the active project is Old garden after 'go back'", meNow.activeProjectId === oldNow?.id, meNow.activeProjectId);
    await R.step(page, "talk-go-back-after-new-project");
    const again = await talk(page, "go back");
    check("'go back' again returns to Garden club", /Switched back to Garden club/.test(again), again);
    await page.waitForTimeout(1000);

    // A change of Garden club's own (Talk is on Garden club now).
    const narrowed = await talk(
      page,
      'tool: settings_set {"key":"web_access","value":{"mode":"only","only":["developer.mozilla.org"]}}',
    );
    out.narrowed = narrowed;
    // The plan card from the brief arrives in the Inbox.
    const me = await R.api(NAME, "GET", "/me");
    const projects = await R.api(NAME, "GET", "/projects");
    const garden = projects.find((p) => p.name === "Garden club");
    const old = projects.find((p) => p.name === "Old garden");
    out.gardenId = garden?.id;
    await R.until(
      async () =>
        (await R.api(NAME, "GET", `/inbox?humanId=${encodeURIComponent(me.id)}`)).requests.some(
          (r) => r.projectId === garden.id && r.status === "open",
        ),
      120_000,
      1000,
      "the plan card",
    ).catch((e) => console.log("no plan card:", String(e)));
    await go("/inbox");
    await R.step(page, "inbox-plan-card-before-undo");

    // 2. Restart the daemon, then Undo the creation from Changes.
    execFileSync("node", [`${REPO}/scripts/bench/restart-daemon.mjs`, "--name", NAME], {
      stdio: "inherit",
    });
    await R.reconnect(page, NAME).catch(() => {});
    await go("/changes");
    await page.waitForTimeout(1500);
    const creationRow = page
      .getByTestId("change")
      .filter({ hasText: "Created the project Garden club and made it the active project." });
    await creationRow.getByTestId("change-undo").click();
    await page.waitForTimeout(2000);
    const changesText = await R.step(page, "changes-after-undo-create-after-restart");
    check("no UUID on Changes", !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(changesText));
    check("removed project's rows read 'Garden club (removed)'", /Garden club \(removed\)/.test(changesText));
    check(
      "the setting row says the project was removed",
      /Cannot be undone now: the project Garden club was removed\./.test(changesText),
    );
    const links = await page.locator(`a[href*="${garden.id}"]`).count();
    check("no link to the removed project", links === 0, { links });
    check("Old garden is active after the Undo", /Old garden/.test(await activeName(page)), await activeName(page));
    await go("/");
    const home = await R.step(page, "home-after-undo");
    check("Home no longer lists Garden club", !/Garden club/.test(home.replace(/Garden club \(removed\)/g, "")));
    await go("/inbox");
    const inbox = await R.step(page, "inbox-after-undo");
    const openForGarden = (
      await R.api(NAME, "GET", `/inbox?humanId=${encodeURIComponent(me.id)}`)
    ).requests.filter((r) => r.projectId === garden.id && r.status === "open");
    check("the removed project's open cards left the Inbox", openForGarden.length === 0, openForGarden.map((r) => r.title));
    out.inboxAfter = inbox.slice(0, 600);
    const back2 = await talk(page, "go back");
    check("'go back' never returns to the removed project", !/Garden club/.test(back2), back2);
    await page.waitForTimeout(800);

    // 3. The name again, after another restart.
    execFileSync("node", [`${REPO}/scripts/bench/restart-daemon.mjs`, "--name", NAME], {
      stdio: "inherit",
    });
    await R.reconnect(page, NAME).catch(() => {});
    await go("/");
    await newProject(page, "Garden club", "A page for the club, again");
    await page.waitForTimeout(2000);
    const homeAgain = await R.step(page, "home-new-project-same-name");
    check("New project 'Garden club' after the Undo works", /Garden club/.test(await activeName(page)), await activeName(page));
    check("no duplicate refusal", !/There is already a project called/.test(homeAgain));
    await go("/changes");
    const finalChanges = await R.step(page, "changes-final");
    check(
      "the switch back to Old garden cannot be undone back to the removed project",
      /Switched back to Old garden\.[\s\S]{0,80}Cannot be undone now: the project Garden club was removed\./.test(finalChanges),
    );

    // W15-37: the same-title refusal's example, typed in Talk.
    await go("/");
    await talk(page, "add a task: Write the guide");
    await page.waitForTimeout(800);
    await talk(page, "add a task: Write the guide");
    await page.waitForTimeout(800);
    const asked = await talk(page, "pause Write the guide");
    const example = /for example "([^"]+)"/.exec(asked)?.[1];
    check("the refusal gives an example in brackets", /\(the older one\)/.test(example ?? ""), asked);
    const picked = await talk(page, `pause ${example}`);
    out.picked = picked;
    await R.step(page, "talk-same-title-example");
    check("the example picks one task (a read-back or done, not the model)", !/stand-in model/.test(picked), picked);
    out.old = old?.id;
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    console.log(out.error);
    await R.step(page, "error").catch(() => {});
  } finally {
    fs.writeFileSync(`${STEPS}/fixup-walk.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
