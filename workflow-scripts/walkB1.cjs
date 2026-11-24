// Review walk B1: an Assisted project; its session's task check files a suggestion card to split
// the person's "Style the page". Usage: node walkB1.cjs <repo> <bench> <label>
const fs = require("node:fs");
const path = require("node:path");
const [repo, n, label] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { label };
(async () => {
  const project = await R.api(n, "POST", "/projects", {
    name: "Price page",
    goal: "A page that lists prices",
    autonomyLevel: 1,
  });
  const pid = project.id;
  const task = (body) => R.api(n, "POST", `/projects/${pid}/tasks`, body);
  const logo = await task({ title: "Send the logo", outcome: "The logo is in the folder", specialist: "person" });
  await task({
    title: "Create the page in index.html",
    outcome: "The page exists",
    acceptanceCriteria: ["index.html exists"],
    riskTier: 1,
    specialist: "coder",
  });
  const style = await task({
    title: "Style the page",
    outcome: "The page has its layout and colours",
    acceptanceCriteria: ["the layout is a grid", "the colours match the logo"],
    riskTier: 1,
    specialist: "coder",
    dependsOn: [logo.id],
  });
  await task({
    title: "Publish the page",
    outcome: "The page is online",
    acceptanceCriteria: ["the page opens"],
    riskTier: 1,
    specialist: "coder",
    dependsOn: [style.id],
  });
  const started = await R.startSession(n, pid);
  out.sessionId = started.session?.id ?? started.id;
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${R.bench(n).uiUrl}/inbox`);
    await sleep(3000);
    await R.step(page, `${label}-plan-card`);
    await page.getByRole("button", { name: "approve", exact: true }).first().click();
    await R.until(
      async () => (await R.api(n, "GET", "/inbox")).requests.find((r) => r.status === "open" && /suggests/i.test(r.title ?? r.question ?? "")) ?? null,
      180_000,
      2000,
      "the suggestion card",
    ).catch(() => null);
    await R.waitForSession(n, out.sessionId, 300_000);
    await sleep(2000);
    await page.goto(`${R.bench(n).uiUrl}/inbox`);
    await sleep(3000);
    out.inbox = await R.step(page, `${label}-suggestion-card`);
  } finally {
    await browser.close();
  }
  const inbox = await R.api(n, "GET", "/inbox");
  out.cards = inbox.requests.map((r) => ({ id: r.id, status: r.status, title: r.title, question: r.question, details: r.details, options: r.options, outcome: r.outcome }));
  out.projectId = pid;
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.cards, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
