const L = require("./lib.cjs");
const { R, goto, save, enc } = L;
const NAME = "run-live";
(async () => {
  const out = {};
  const { browser, page } = await R.openApp(NAME);
  try {
    const pid = (await R.api(NAME, "GET", "/projects")).find((x) => x.name === "Budget fit").id;
    for (const b of ["0.04", "0.02", "0"]) {
      await goto(page, NAME, `/projects/${enc(pid)}`, 1500);
      await page.getByRole("button", { name: "Start session" }).first().click();
      await page.waitForTimeout(2500);
      const field = page.getByLabel("Session budget (CHF)");
      await field.fill(b);
      await page.waitForTimeout(2500);
      out[`budget_${b}`] = await page.getByRole("dialog").innerText();
      out[`startDisabled_${b}`] = await page.getByTestId("confirm-start-session").isDisabled().catch(() => null);
      await R.step(page, `z06 start dialog session budget ${b}`);
      await page.keyboard.press("Escape");
    }
  } finally { save(NAME, "zero2.json", out); await browser.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
