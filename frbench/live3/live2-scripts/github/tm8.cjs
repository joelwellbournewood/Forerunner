const { R, N, log, text, goto, save } = require("./h.cjs");
(async () => {
  const projects = await R.api(N, "GET", "/projects");
  const p = (projects.projects || projects).find((x) => x.name === "Kite timer");
  const { browser, page } = await R.openApp(N);
  const out = {};
  try {
    for (const how of ["x", "escape"]) {
      await goto(page, "/projects/" + p.id + "/summary");
      await page.getByRole("button", { name: "Create a repository" }).first().click();
      await page.waitForTimeout(800);
      const d = page.getByTestId("create-repo-dialog");
      log("dialog:", (await d.innerText()).slice(0, 800));
      await R.step(page, "tm8-" + how + "-dialog");
      await d.getByTestId("create-repo-preview").click();
      await page.waitForTimeout(2000);
      log("after preview:", (await d.innerText()).slice(0, 1200));
      const before = await R.api(N, "GET", "/inbox");
      out[how + "-open-after-preview"] = (before.requests || []).filter((q) => q.status !== "answered").map((q) => q.kind + " | " + (q.title || "").slice(0, 120));
      log("open cards after preview:", out[how + "-open-after-preview"]);
      await R.step(page, "tm8-" + how + "-preview");
      if (how === "x") await d.getByRole("button", { name: /×|Close/ }).first().click();
      else await page.keyboard.press("Escape");
      await page.waitForTimeout(2000);
      const after = await R.api(N, "GET", "/inbox");
      out[how + "-open-after-close"] = (after.requests || []).filter((q) => q.status !== "answered").map((q) => q.kind + " | " + (q.title || "").slice(0, 120));
      log("open cards after close (" + how + "):", out[how + "-open-after-close"]);
      await goto(page, "/inbox");
      const t = await R.step(page, "tm8-" + how + "-inbox-after-close");
      const i = t.indexOf("Needs you");
      log(t.slice(i, i + 400));
    }
    save("tm8.json", out);
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
