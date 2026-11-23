// Reviewer's walk for l4-github-link (independent of the fixer's script).
// node review-l4link-walk.cjs <repo> <bench name> <stage>
const REPO = process.argv[2];
const NAME = process.argv[3];
const STAGE = process.argv[4];
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const bench = () => JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/bench.json`, "utf8"));
const gh = JSON.parse(fs.readFileSync(`/tmp/frbench/${NAME}/githost.json`, "utf8"));
const ghApi = async (path) => {
  const r = await fetch(`${gh.url}${path}`, {
    headers: { authorization: `token ${gh.token}`, accept: "application/vnd.github+json" },
  });
  return r.json();
};
const out = { stage: STAGE, notes: {} };
const save = () =>
  fs.writeFileSync(`/tmp/frbench/${NAME}/steps/review-${STAGE}.json`, JSON.stringify(out, null, 2));

async function openNewProject(page, { name, brief, repo }) {
  await page.goto(bench().uiUrl);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "New project", exact: true }).first().click();
  await page.waitForTimeout(600);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel(/^Goal/).fill("Fly kites together");
  if (brief) await page.getByLabel(/^Brief/).fill(brief);
  await page.getByLabel(/^Repository link/).fill(repo);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForTimeout(3000);
}

async function projectTab(page, id, tab) {
  await page.goto(`${bench().uiUrl}/projects/${encodeURIComponent(id)}${tab ? `/${tab}` : ""}`);
  await page.waitForTimeout(2500);
}

(async () => {
  const { browser, page } = await R.openApp(NAME, { freshProfile: STAGE === "a" });
  if (STAGE === "a") await R.skipSetup(page);
  try {
    if (STAGE === "a") {
      await openNewProject(page, { name: "Kite flyers", repo: "bench/seeded" });
      out.notes.offer = await R.step(page, "rv-a1-offer");
      await page.getByTestId("offer-take-over").click();
      await page.waitForURL(/\/projects\/[^/]+/, { timeout: 30_000 });
      await page.waitForTimeout(5000);
      const id = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
      out.projectId = id;
      await page.reload();
      await page.waitForTimeout(3000);
      out.notes.overview = await R.step(page, "rv-a2-overview");
      const prs = await ghApi("/repos/bench/seeded/pulls?state=all");
      out.prs = prs.map((p) => ({ n: p.number, head: p.head.ref, state: p.state, body: p.body }));
      const branches = await ghApi("/repos/bench/seeded/branches");
      out.branches = branches.map((b) => [b.name, b.commit.sha.slice(0, 7)]);
    }
    if (STAGE === "docs") {
      const id = process.argv[5];
      await projectTab(page, id, "docs");
      out.notes.docs = await R.step(page, "rv-docs");
    }
    if (STAGE === "b") {
      await page.goto(`${bench().uiUrl}/changes`);
      await page.waitForTimeout(2500);
      out.notes.changes = await R.step(page, "rv-b1-changes");
      const undo = page.getByTestId("change-undo").first();
      out.notes.undoCount = await undo.count();
      if (out.notes.undoCount) {
        await undo.click();
        await page.waitForTimeout(1500);
        out.notes.undoDialog = await R.step(page, "rv-b2-undo-dialog");
        const confirm = page.getByRole("dialog").getByRole("button", { name: /^Undo/ });
        if (await confirm.count()) await confirm.first().click();
        await page.waitForTimeout(3000);
      }
      out.notes.changesAfter = await R.step(page, "rv-b3-changes-after-undo");
      await openNewProject(page, {
        name: "Kite flyers again",
        repo: "bench/seeded",
        brief: "A page that lists the club's kites.",
      });
      out.notes.offerAgain = await R.step(page, "rv-b4-offer-again");
      out.urlAfter = page.url();
    }
    if (STAGE === "c") {
      // The offer is open from stage b (a fresh dialog): Work together.
      await openNewProject(page, { name: "Kites together", repo: "bench/seeded" });
      out.notes.offer = await R.step(page, "rv-c1-offer");
      await page.getByTestId("offer-together").click();
      await page.waitForURL(/\/projects\/[^/]+/, { timeout: 30_000 });
      await page.waitForTimeout(4000);
      out.projectId = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
      out.notes.overview = await R.step(page, "rv-c2-together-overview");
      await projectTab(page, out.projectId, "docs");
      out.notes.docs = await R.step(page, "rv-c3-together-docs");
      await page.goto(`${bench().uiUrl}/settings`);
      await page.waitForTimeout(2500);
      const adv = page.getByRole("button", { name: /Advanced/ });
      if (await adv.count()) await adv.first().click().catch(() => {});
      await page.waitForTimeout(1500);
      out.notes.settings = await R.step(page, "rv-c4-settings");
    }
    if (STAGE === "chat") {
      const id = process.argv[5];
      await projectTab(page, id, "chat");
      const box = page.getByRole("textbox").last();
      await box.fill(process.argv[6] || "turn on the status pull request");
      await box.press("Enter");
      await page.waitForTimeout(6000);
      out.notes.chat = await R.step(page, "rv-chat-status-pr");
    }
    if (STAGE === "refused") {
      await openNewProject(page, { name: "Refused kites", repo: "bench/refused2" });
      out.notes.offer = await R.step(page, "rv-r1-offer");
      await page.getByTestId("offer-take-over").click();
      await page.waitForURL(/\/projects\/[^/]+/, { timeout: 30_000 });
      await page.waitForTimeout(5000);
      out.projectId = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
      await page.reload();
      await page.waitForTimeout(3000);
      out.notes.overview = await R.step(page, "rv-r2-overview");
      await projectTab(page, out.projectId, "docs");
      out.notes.docs = await R.step(page, "rv-r3-docs");
      const prs = await ghApi("/repos/bench/refused2/pulls?state=all");
      out.prs = prs.map((p) => ({ n: p.number, head: p.head.ref, state: p.state }));
    }
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    await R.step(page, `rv-${STAGE}-error`).catch(() => {});
  } finally {
    save();
    await browser.close();
  }
})();
