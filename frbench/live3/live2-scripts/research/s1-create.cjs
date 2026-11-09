// Step 1: New project "Static hosts" with the research brief, through the UI.
const { R, N, log, text, goto, save } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/");
    if (/Set up Forerunner/.test(await text(page))) await R.skipSetup(page);
    await goto(page, "/");
    await R.step(page, "s1-home");
    await page.getByRole("button", { name: "New project" }).first().click();
    await page.waitForTimeout(500);
    const d = page.getByTestId("new-project-dialog");
    await d.locator('input[name="name"]').fill("Static hosts");
    await d.locator('textarea[name="brief"]').fill("Compare the free tiers of three static site hosts, with sources");
    await R.step(page, "s1-new-project-dialog");
    await page.getByTestId("create-project").click();
    await page.waitForTimeout(3000);
    log("url", page.url());
    await R.step(page, "s1-created");
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
