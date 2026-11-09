const { R, N, log, text, goto, save } = require("./h.cjs");
const P1 = "01a1be66-fc1d-730a-b94a-a92298cad6f6";
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/projects/" + P1 + "/summary");
    const row = page.locator("li, div").filter({ hasText: /pull request #10/ }).filter({ has: page.getByRole("button", { name: "Open this version" }) }).last();
    const respP = page.waitForResponse((r) => r.url().includes("/pull-requests/10/preview"), { timeout: 120000 });
    await row.getByRole("button", { name: "Open this version" }).click();
    const resp = await respP;
    const body = await resp.json().catch(() => null);
    log("preview answer", resp.status(), JSON.stringify(body).slice(0, 800));
    save("preview10-answer.json", body);
    await page.waitForTimeout(2000);
    const t = await R.step(page, "chain1-open-this-version-10");
    const i = t.indexOf("pull request #10");
    log(t.slice(i - 100, i + 700));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
