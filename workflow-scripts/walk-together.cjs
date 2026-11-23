// l4-github-link walk: Work together on bench/empty (its main names "Shared club"), then Settings.
// node walk-together.cjs <repo> <bench name> <label>
const REPO = process.argv[2];
const NAME = process.argv[3];
const LABEL = process.argv[4] || "walk";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const out = { label: LABEL, checks: [] };
const check = (what, ok, seen) => {
  out.checks.push({ what, ok, seen });
  console.log(ok ? "PASS" : "FAIL", what, seen ?? "");
};
const ui = () => JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/bench.json`, "utf8")).uiUrl;

(async () => {
  const { browser, page } = await R.openApp(NAME);
  await R.skipSetup(page);
  try {
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.getByLabel("Name").fill("Shared kites");
    await page.getByLabel(/^Goal/).fill("Share kites");
    await page.getByLabel(/^Repository link/).fill("bench/empty");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL}-10-together-offer`);
    await page.getByTestId("offer-together").click();
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 30_000 });
    await page.waitForTimeout(2500);
    const projectId = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
    out.projectId = projectId;
    await R.step(page, `${LABEL}-11-together-overview`);
    const settings = await R.api(NAME, "GET", "/settings");
    const rows = (settings.rows ?? settings).filter?.((r) => String(r.key).includes("status_pull_request")) ?? [];
    out.statusRows = rows;
    check(
      "a together project has no Status pull request row in GET /settings",
      !rows.some((r) => r.scopeId === projectId),
      JSON.stringify(rows).slice(0, 600),
    );
    await page.goto(`${ui()}/settings`);
    await page.waitForTimeout(2000);
    await page.getByText("Advanced", { exact: true }).first().click();
    await page.waitForTimeout(800);
    const row = page.getByText("Status pull request", { exact: true }).last();
    if (await row.count()) await row.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const text = await R.step(page, `${LABEL}-12-settings-status-pr`);
    out.settingsText = text.slice(0, 3000);
    // Chat: turn on the status pull request.
    const said = await R.apiRaw(NAME, "POST", "/commands/execute", {
      commands: [
        { name: "settings.set", params: { key: "status_pull_request", value: true, project: projectId } },
      ],
      wordsUsed: "turn on the status pull request",
      source: "ui",
      projectId,
      confirm: "tap",
    });
    out.setAnswer = said;
    check("settings.set status_pull_request on a together project is refused", said.body?.status === "refused", JSON.stringify(said.body).slice(0, 500));
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    console.error(e);
    await R.step(page, `${LABEL}-error`).catch(() => {});
  } finally {
    fs.writeFileSync(`/tmp/frbench/${NAME}/steps/${LABEL}-together.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
