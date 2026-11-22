// TM-8 walk (leftovers7-tailmerge): Create a repository, Preview, then × closes it: no card left.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-1/scripts/bench/recorder.cjs");
const n = "fix-leftovers7-tailmerge";

(async () => {
  const out = {};
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => undefined);
    const project = await R.api(n, "POST", "/projects", {
      name: "Recipe box",
      goal: "Keep the family recipes in one place",
    });
    out.project = project.id;
    const humanId = (await R.api(n, "GET", "/me")).humanId ?? (await R.api(n, "GET", "/me")).human?.id;
    const openCards = async () => {
      const inbox = await R.api(n, "GET", `/inbox${humanId ? `?humanId=${humanId}` : ""}`);
      return (inbox.requests ?? []).filter((r) => r.projectId === project.id && r.status === "open");
    };
    const b = R.bench(n);
    await page.goto(`${b.uiUrl.replace(/\/$/, "")}/projects/${project.id}/summary`);
    await page.getByTestId("create-repo").click();
    await page.getByTestId("create-repo-dialog").waitFor();
    await R.step(page, "tm8-dialog-open");
    await page.getByTestId("create-repo-preview").click();
    await page.getByTestId("command-pending").waitFor();
    out.cardsAfterPreview = (await openCards()).map((r) => r.title);
    await R.step(page, "tm8-preview-shown");
    // The person walks away: the dialog's ×.
    await page.getByTestId("create-repo-dialog").getByRole("button", { name: "Close" }).click();
    await R.until(async () => (await openCards()).length === 0, 15_000, 500, "no open card").catch(
      () => undefined,
    );
    out.cardsAfterClose = (await openCards()).map((r) => r.title);
    await R.step(page, "tm8-closed");
    await page.goto(`${b.uiUrl.replace(/\/$/, "")}/inbox`);
    await page.waitForTimeout(1500);
    out.inboxText = (await R.step(page, "tm8-inbox-after-close")).slice(0, 600);
    // Preview then Yes still creates it.
    await page.goto(`${b.uiUrl.replace(/\/$/, "")}/projects/${project.id}/summary`);
    await page.getByTestId("create-repo").click();
    await page.getByTestId("create-repo-preview").click();
    await page.getByTestId("command-yes").click();
    await page.getByTestId("command-sentence").waitFor({ timeout: 30_000 });
    await R.step(page, "tm8-yes-created");
    out.reposAfterYes = (await R.api(n, "GET", `/projects/${project.id}`)).repos;
    out.cardsAfterYes = (await openCards()).map((r) => r.title);
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
    await R.step(page, "tm8-error").catch(() => undefined);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 2));
})();
