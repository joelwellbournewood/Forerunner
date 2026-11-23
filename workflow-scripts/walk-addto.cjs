// l4-github-link walk: Add to it on a project with done tasks (L4-github-106).
// node walk-addto.cjs <repo> <bench name> <label> <projectName> <repo link>
const REPO = process.argv[2];
const NAME = process.argv[3];
const LABEL = process.argv[4] || "walk";
const PROJECT = process.argv[5];
const LINK = process.argv[6];
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const out = { label: LABEL, checks: [], timeline: [] };
const check = (what, ok, seen) => {
  out.checks.push({ what, ok, seen });
  console.log(ok ? "PASS" : "FAIL", what, seen ?? "");
};
const ui = () => JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/bench.json`, "utf8")).uiUrl;

(async () => {
  const { browser, page } = await R.openApp(NAME);
  await R.skipSetup(page);
  try {
    const project = (await R.api(NAME, "GET", "/projects")).find((p) => p.name === PROJECT);
    if (!project) throw new Error(`no project ${PROJECT}`);
    const intake = await R.api(NAME, "GET", `/projects/${encodeURIComponent(project.id)}/intake`);
    if (intake.state === "pending") {
      await page.goto(`${ui()}/inbox`);
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Approve and start" }).first().click();
      await page.waitForTimeout(3000);
      await R.until(
        async () => {
          const s = await R.api(NAME, "GET", `/sessions?projectId=${encodeURIComponent(project.id)}`);
          const list = Array.isArray(s) ? s : [];
          return list.length && list.every((x) => !["running", "starting", "queued"].includes(x.status)) ? list : null;
        },
        300_000,
        3000,
        "the session to end",
      );
    }
    await page.goto(ui());
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.getByLabel("Name").fill("Kite gallery");
    await page.getByLabel(/^Brief/).fill("Add a gallery page with photos of each kite.");
    await page.getByLabel(/^Repository link/).fill(LINK);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL}-20-in-use-offer`);
    const t0 = Date.now();
    await page.getByTestId("offer-add").click();
    await page.waitForTimeout(300);
    out.timeline.push({ ms: Date.now() - t0, url: page.url() });
    const early = await R.step(page, `${LABEL}-21-after-add-press`);
    out.early = early.slice(0, 800);
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 60_000 });
    out.timeline.push({ ms: Date.now() - t0, landed: page.url() });
    const landed = await R.step(page, `${LABEL}-22-landed`);
    check("the page says Drafting the plan... after Add to it", /Drafting the plan/.test(landed) || /Drafting the plan/.test(early), landed.slice(0, 400));
    await page.waitForTimeout(6000);
    await R.step(page, `${LABEL}-23-plan-card`);
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    console.error(e);
    await R.step(page, `${LABEL}-error`).catch(() => {});
  } finally {
    fs.writeFileSync(`/tmp/frbench/${NAME}/steps/${LABEL}-addto.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
