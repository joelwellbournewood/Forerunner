// usage: node takeout.cjs <projectId> <task title> <label> [confirm]
const { R, N, log, text, goto, save } = require("./h.cjs");
const [P, TITLE, LABEL, CONFIRM] = process.argv.slice(2);
(async () => {
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/projects/" + P + "/tasks");
    const btns = page.getByRole("button", { name: "Take this work out" });
    log("take-out buttons on the tab:", await btns.count());
    await page.getByText(TITLE, { exact: true }).first().click();
    await page.waitForTimeout(2000);
    let t = await R.step(page, LABEL + "-drawer");
    const i = t.lastIndexOf(TITLE);
    log(t.slice(i, i + 700));
    const b = page.getByRole("button", { name: "Take this work out" });
    log("buttons now:", await b.count());
    if (!(await b.count())) return;
    await b.last().click();
    await page.waitForTimeout(800);
    t = await R.step(page, LABEL + "-dialog");
    const dlg = page.getByTestId("take-out-dialog");
    log("dialog:", (await dlg.innerText()).slice(0, 800));
    if (CONFIRM !== "confirm") return;
    const respP = page.waitForResponse((r) => r.request().method() === "POST" && /take-?out|answer|actions/.test(r.url()), { timeout: 120000 });
    await page.getByTestId("confirm-take-out").click();
    const resp = await respP;
    const body = await resp.json().catch(() => null);
    log("answer", resp.url().replace(/^.*48900/, ""), resp.status(), JSON.stringify(body).slice(0, 1200));
    save(LABEL + "-answer.json", body);
    await page.waitForTimeout(2500);
    t = await R.step(page, LABEL + "-after");
    const j = t.indexOf(TITLE);
    log(t.slice(j, j + 600));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
