// l4-github-link walk: Take it over on a repository whose main names "Kite club" and that keeps an
// old fr/docs-scaffold branch of a closed pull request; Undo; New project on it again.
// node walk-takeover.cjs <repo> <bench name> <label>
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
const gh = JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/githost.json`, "utf8"));
const ghApi = async (path) => {
  const r = await fetch(`${gh.url}${path}`, {
    headers: { authorization: `token ${gh.token}`, accept: "application/vnd.github+json" },
  });
  return r.json();
};

async function newProject(page, { name, brief, repo }) {
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel(/^Goal/).fill("Fly kites together");
  if (brief) await page.getByLabel(/^Brief/).fill(brief);
  await page.getByLabel(/^Repository link/).fill(repo);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForTimeout(2500);
}

(async () => {
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  await R.skipSetup(page);
  try {
    // 1. New project on bench/seeded: the offer.
    await newProject(page, { name: "Kite flyers", repo: "bench/seeded" });
    const offer = await R.step(page, `${LABEL}-01-offer`);
    check("the first New project gets the offer", /Kite club/.test(offer), offer.slice(0, 300));
    await page.getByTestId("offer-take-over").click();
    await page.waitForURL(/\/projects\/[^/]+/, { timeout: 30_000 });
    await page.waitForTimeout(4000);
    const projectId = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
    out.projectId = projectId;
    await page.reload();
    await page.waitForTimeout(2500);
    const overview = await R.step(page, `${LABEL}-02-overview-after-take-over`);
    out.overview = overview.slice(0, 1500);
    const prs = await ghApi("/repos/bench/seeded/pulls?state=all");
    out.prs = prs.map((p) => ({ n: p.number, head: p.head.ref, state: p.state, body: p.body }));
    const open = prs.filter((p) => p.state === "open");
    check("Take it over opens one docs pull request", open.length === 1, JSON.stringify(out.prs.map((p) => [p.n, p.head, p.state])));
    // 2. Docs tab.
    await page.getByRole("link", { name: "Docs", exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(1500);
    out.docs = (await R.step(page, `${LABEL}-03-docs`)).slice(0, 1500);
    // 3. Changes: Undo the creation.
    await page.goto(`${R.bench ? "" : ""}${JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/bench.json`, "utf8")).uiUrl}/changes`);
    await page.waitForTimeout(2000);
    await R.step(page, `${LABEL}-04-changes`);
    const undo = page.getByTestId("change-undo").first();
    if (await undo.count()) {
      await undo.click();
      await page.waitForTimeout(1500);
      const confirm = page.getByRole("button", { name: /^Undo/ }).last();
      if (await confirm.count()) await confirm.click().catch(() => {});
      await page.waitForTimeout(2500);
    }
    out.changesAfterUndo = (await R.step(page, `${LABEL}-05-changes-after-undo`)).slice(0, 1200);
    // 4. New project on the same repository again, with a brief.
    await page.goto(JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/bench.json`, "utf8")).uiUrl);
    await page.waitForTimeout(1500);
    await newProject(page, {
      name: "Kite flyers again",
      repo: "bench/seeded",
      brief: "A page that lists the club's kites.",
    });
    const second = await R.step(page, `${LABEL}-06-second-new-project`);
    check(
      "New project again after Undo gets the same offer",
      /Kite club/.test(second) && !/\/projects\/[^/]+/.test(page.url()),
      second.slice(0, 300),
    );
    out.secondUrl = page.url();
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    console.error(e);
    await R.step(page, `${LABEL}-error`).catch(() => {});
  } finally {
    fs.writeFileSync(`/tmp/frbench/${NAME}/steps/${LABEL}-takeover.json`, JSON.stringify(out, null, 2));
    await browser.close();
  }
})();
