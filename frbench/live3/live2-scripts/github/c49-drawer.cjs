const { R, N, log, text, goto } = require("./h.cjs");
const P1 = "01a1be66-fc1d-730a-b94a-a92298cad6f6";
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    for (const title of ["Add footer to kite/index.html", "Add kite/footer.test.mjs using node:test"]) {
      await goto(page, "/projects/" + P1 + "/tasks");
      await page.getByText(title, { exact: true }).first().click();
      await page.waitForTimeout(2500);
      const t = await R.step(page, "c49-drawer-" + title.slice(0, 20));
      const i = t.lastIndexOf(title);
      log("=== drawer", title, "\n" + t.slice(i, i + 2500));
    }
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
