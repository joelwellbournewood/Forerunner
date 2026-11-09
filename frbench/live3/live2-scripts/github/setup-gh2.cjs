const { R, N, log, text, goto } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/setup");
    for (let i = 0; i < 4 && !/GitHub token/.test(await text(page)); i++) {
      const nm = page.getByLabel("Your name");
      if (await nm.count() && !(await nm.inputValue())) await nm.fill("Sam Tester");
      const c = page.getByRole("button", { name: /^(Continue)$/ });
      if (await c.count()) { await c.first().click(); await page.waitForTimeout(800); } else break;
    }
    const input = page.getByPlaceholder("github_pat_…");
    await input.fill(process.env.FORERUNNER_TEST_GITHUB_TOKEN || "");
    const respP = page.waitForResponse((r) => r.url().includes("/setup/github"), { timeout: 120000 });
    await page.getByRole("button", { name: "Check and save" }).click();
    const resp = await respP;
    const body = await resp.json().catch(() => ({}));
    log("status", resp.status(), JSON.stringify({ ok: body.ok, summary: body.summary, problems: body.problems, login: body.login, repos: body.repos, code: body.code, message: body.message }).slice(0, 1500));
    await page.waitForTimeout(1500);
    const v = await input.inputValue().catch(() => "");
    log("field still holds a value:", v.length > 0);
    if (v) await input.fill("");
    const t = await text(page);
    log(t.slice(t.indexOf("Your agent works"), t.indexOf("Your agent works") + 1500));
    if (!v) await R.step(page, "setup-github-checked");
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
