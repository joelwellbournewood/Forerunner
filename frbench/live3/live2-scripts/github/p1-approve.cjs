const { R, N, log, text, goto } = require("./h.cjs");
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    const projects = await R.api(N, "GET", "/projects");
    const p = (projects.projects || projects).find((x) => x.name === "Kite club");
    await goto(page, "/projects/" + p.id);
    let t = await R.step(page, "p1-project-before-approve");
    log(t.slice(t.indexOf("Kite club\nStart") , t.indexOf("Kite club\nStart") + 300));
    await goto(page, "/inbox");
    await page.getByRole("button", { name: "Approve and start" }).first().click();
    await page.waitForTimeout(4000);
    t = await R.step(page, "p1-after-approve-inbox");
    log(t.slice(t.indexOf("Inbox"), t.indexOf("Inbox") + 800));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
