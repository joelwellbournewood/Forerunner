// usage: node chat.cjs <projectName> <label> <message>
const { R, N, log, text, goto } = require("./h.cjs");
const [PROJ, LABEL, MSG] = process.argv.slice(2);
(async () => {
  const projects = await R.api(N, "GET", "/projects");
  const p = (projects.projects || projects).find((x) => x.name === PROJ);
  const { browser, page } = await R.openApp(N);
  try {
    await goto(page, "/projects/" + p.id + "/chat");
    const before = await page.getByTestId("chat-agent").count();
    await page.getByTestId("chat-input").fill(MSG);
    await page.getByTestId("chat-send").click();
    await R.until(async () => (await page.getByTestId("chat-agent").count()) > before && !/…$/.test((await page.getByTestId("chat-agent").last().innerText()).trim()), 120000, 2000, "chat reply");
    await page.waitForTimeout(4000);
    const t = await R.step(page, LABEL);
    log("reply:", (await page.getByTestId("chat-agent").last().innerText()).slice(0, 1500));
  } finally { await browser.close(); }
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
