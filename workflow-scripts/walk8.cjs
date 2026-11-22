// Review walk 8 (R-repooffer, the other order): Chat asks for a repository first (its card waits
// for Yes), then a session plans code work and the agent files its offer. Are both open? The
// person answers the offer; what becomes of Chat's card, and of its Yes?
const R = require("/home/user/Forerunner/.claude/worktrees/wf_8c348d94-071-3/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "review-leftovers7-merge";
const DIR = "/tmp/frbench/review-leftovers7-merge";
const NAME = "Bat count";
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { browser, page } = await R.openApp(N);
  const b = R.bench(N);
  const project = await R.api(N, "POST", "/projects", { name: NAME, goal: "Count the bats at dusk" });
  const P = project.id;
  await R.api(N, "POST", `/projects/${P}/tasks`, {
    title: "Write the counter in src/main.js",
    outcome: "src/main.js counts bats",
    specialist: "coder",
    riskTier: 1,
  });
  const cards = async () =>
    ((await R.api(N, "GET", "/inbox")).requests ?? [])
      .filter((r) => r.projectId === P)
      .map((r) => ({ id: r.id, title: r.title, status: r.status, outcome: r.outcome, options: r.options }));
  await page.goto(`${b.uiUrl}/projects/${P}/chat`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const box = page.getByRole("textbox").last();
  await box.fill(`tool: repo_create {"project": "${NAME}", "private": true}`);
  await box.press("Enter");
  await sleep(8000);
  const chat = await R.step(page, "w8-01-chat-asks-first");
  out.chat = chat.slice(chat.indexOf("tool: repo_create"), chat.indexOf("tool: repo_create") + 600);
  out.afterChat = await cards();
  await page.goto(`${b.uiUrl}/projects/${P}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.getByRole("button", { name: /^(Start|Continue|Start session)$/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /^Start/ }).last().click();
  await R.until(async () => (await cards()).some((c) => c.status === "open" && /^Create a repository for/.test(c.title)), 240_000, 3000, "the offer").catch((e) => (out.offerErr = String(e)));
  await sleep(3000);
  out.afterSession = await cards();
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await sleep(1000);
  await R.step(page, "w8-02-inbox-both-open");
  const offer = out.afterSession.find((c) => /^Create a repository for/.test(c.title) && c.status === "open");
  if (offer) {
    await page.locator(`[data-request-id="${offer.id}"]`).getByRole("button", { name: "Create the repository", exact: true }).click();
    await sleep(1500);
    const confirm = page.getByRole("dialog").getByRole("button", { name: /^Create/ });
    if (await confirm.count()) await confirm.last().click();
    await R.until(async () => ((await R.api(N, "GET", "/projects")).find((x) => x.id === P)?.repos ?? []).length > 0, 90_000, 2000, "linked").catch((e) => (out.linkErr = String(e)));
    await sleep(4000);
    out.afterOffer = await cards();
    const chatCard = out.afterOffer.find((c) => c.status === "open");
    if (chatCard) {
      await page.goto(`${b.uiUrl}/inbox`);
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await sleep(1000);
      await R.step(page, "w8-03-inbox-chat-card-left");
      await page.locator(`[data-request-id="${chatCard.id}"]`).getByRole("button", { name: "Yes", exact: true }).click();
      await sleep(6000);
      out.afterYes = await cards();
      out.warnings = ((await R.api(N, "GET", "/inbox")).messages ?? []).filter((m) => m.body.includes(NAME) && /not applied/.test(m.body)).map((m) => m.body);
      await R.step(page, "w8-04-inbox-after-yes");
    }
  }
  fs.writeFileSync(`${DIR}/walk8.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error("WALK FAILED", e);
  fs.writeFileSync(`${DIR}/walk8.json`, JSON.stringify({ ...out, error: String(e) }, null, 2));
  process.exit(1);
});
