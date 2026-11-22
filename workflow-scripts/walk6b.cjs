// Review walk 6b (R-repooffer): a project without a repository runs code work; the agent's offer
// is in the Inbox. Chat asks for a repository (repo_create): no second card, the answer points to
// the offer. Then the project page's Create a repository (Preview, Yes): the offer is withdrawn.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_8c348d94-071-3/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "review-leftovers7-merge";
const DIR = "/tmp/frbench/review-leftovers7-merge";
const NAME = process.argv[2] || "Moth count";
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const { browser, page } = await R.openApp(N);
  const b = R.bench(N);
  const project = await R.api(N, "POST", "/projects", { name: NAME, goal: "Count the moths at night" });
  const P = project.id;
  out.projectId = P;
  await R.api(N, "POST", `/projects/${P}/tasks`, {
    title: "Write the counter in src/main.js",
    outcome: "src/main.js counts moths",
    specialist: "coder",
    riskTier: 1,
  });
  await page.goto(`${b.uiUrl}/projects/${P}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.getByRole("button", { name: /^(Start|Continue|Start session)$/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /^Start/ }).last().click();
  let offer = null;
  await R.until(
    async () => {
      const inbox = await R.api(N, "GET", "/inbox");
      offer = (inbox.requests ?? []).find((r) => r.status === "open" && r.projectId === P);
      return !!offer;
    },
    300_000,
    3000,
    "the repository offer",
  ).catch((e) => (out.offerErr = String(e)));
  out.offer = offer && { title: offer.title, options: offer.options };
  await sleep(3000);
  const openCards = async () =>
    ((await R.api(N, "GET", "/inbox")).requests ?? []).filter((r) => r.status === "open" && r.projectId === P).map((r) => r.title);
  out.openBeforeChat = await openCards();
  await page.goto(`${b.uiUrl}/projects/${P}/chat`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const box = page.getByRole("textbox").last();
  await box.fill(`tool: repo_create {"project": "${NAME}", "private": true}`);
  await box.press("Enter");
  await sleep(8000);
  out.chatText = await R.step(page, "w6b-01-chat-repo-create");
  out.openAfterChat = await openCards();
  await page.goto(`${b.uiUrl}/projects/${P}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.getByRole("button", { name: "Create a repository" }).first().click();
  await page.getByTestId("create-repo-preview").click();
  await sleep(2500);
  out.openWhileDialog = await openCards();
  await R.step(page, "w6b-02-create-repo-preview");
  await page.getByTestId("create-repo-dialog").getByRole("button", { name: "Yes", exact: true }).click();
  await sleep(6000);
  out.dialogDone = await R.step(page, "w6b-03-create-repo-done");
  const pj = await R.api(N, "GET", `/projects/${P}`);
  out.repos = pj.repos ?? pj.project?.repos;
  const inbox = await R.api(N, "GET", "/inbox");
  out.cardsAfter = (inbox.requests ?? []).filter((r) => r.projectId === P).map((r) => [r.title, r.status, r.outcome]);
  out.messagesAfter = (inbox.messages ?? []).filter((m) => /repositor/i.test(m.body)).map((m) => m.body);
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.getByText(/^Answered/).first().click().catch(() => undefined);
  await sleep(1000);
  out.inboxAfter = await R.step(page, "w6b-04-inbox-offer-withdrawn");
  fs.writeFileSync(`${DIR}/walk6b.json`, JSON.stringify(out, null, 2));
  const i = out.chatText.indexOf("tool: repo_create");
  console.log(JSON.stringify({ ...out, chatText: out.chatText.slice(i, i + 700), dialogDone: undefined, inboxAfter: undefined }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error("WALK FAILED", e);
  fs.writeFileSync(`${DIR}/walk6b.json`, JSON.stringify({ ...out, error: String(e) }, null, 2));
  process.exit(1);
});
