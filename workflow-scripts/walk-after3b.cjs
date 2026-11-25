// w8-together AFTER walk, part 3: Ada's Add to it through the New project dialog (stand-in model).
"use strict";
const path = require("node:path");
const R = require(path.join(process.env.REPO, "scripts/bench/recorder.cjs"));
const A = "w8t-after";
(async () => {
  const { browser, page } = await R.openApp(A);
  try {
    await page.goto(`${R.bench(A).uiUrl}/`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => undefined);
    await R.skipSetup(page);
    await page.getByRole("button", { name: "New project", exact: true }).first().click();
    await page.locator('input[name="name"]').fill("Contact form");
    await page.locator('textarea[name="goal"], input[name="goal"]').first().fill("A contact form");
    await page
      .locator('textarea[name="brief"], input[name="brief"]')
      .first()
      .fill("Add a contact form page with a short thank-you note after sending.");
    await page.locator('input[name="repo"]').fill("https://github.com/team/shared");
    await page.getByTestId("create-project").click();
    await page.getByTestId("offer-add").waitFor({ timeout: 15000 });
    await R.step(page, "after-ada-add-to-offer", { settleMs: 500 });
    const t0 = Date.now();
    await page.getByTestId("offer-add").click();
    await page.waitForURL(/\/projects\//, { timeout: 4000 }).catch(() => undefined);
    const landed = Date.now() - t0;
    const text = await R.step(page, "after-ada-add-to-landed", { settleMs: 0 });
    console.log("landed after ms", landed, "drafting line:", /Drafting the plan/.test(text));
    console.log(text.slice(0, 900));
    await page.waitForTimeout(5000);
    const later = await R.step(page, "after-ada-add-to-plan-waits", { settleMs: 1000 });
    console.log("LATER:", later.slice(0, 700));
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
