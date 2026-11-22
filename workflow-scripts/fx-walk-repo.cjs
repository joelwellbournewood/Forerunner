// Fix-up walk (R-repooffer, the other orders), on the fixup-leftovers7-merge bench.
//  A "Bat count": Chat asks first (tool: repo_create), then a session plans code work. One card?
//     Its Yes in the Inbox: linked, nothing open, no warning?
//  B "Pond survey": the project page's Create a repository is previewed and the dialog closed,
//     then a session plans code work. One card? Its Yes: linked, nothing open, no warning?
//  C "Moth count": the offer first, then a Preview on the project page closed: two cards (the
//     project page goes on, ADR 0097). The offer's Create: both close, the previewed one says
//     "Closed: it no longer needs you.", no warning.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_8c348d94-071-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "fixup-leftovers7-merge";
const DIR = `/tmp/frbench/${N}`;
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const which = process.argv[2] || "A";

async function project(name) {
  const p = await R.api(N, "POST", "/projects", { name, goal: `${name} at dusk` });
  await R.api(N, "POST", `/projects/${p.id}/tasks`, {
    title: "Write the counter in src/main.js",
    outcome: "src/main.js counts",
    specialist: "coder",
    riskTier: 1,
  });
  return p.id;
}
const cardsOf = async (P) =>
  ((await R.api(N, "GET", "/inbox")).requests ?? [])
    .filter((r) => r.projectId === P && /repositor/i.test(r.title ?? ""))
    .map((r) => ({ id: r.id, title: r.title, status: r.status, outcome: r.outcome }));
const warnings = async (name) =>
  ((await R.api(N, "GET", "/inbox")).messages ?? [])
    .filter((m) => m.body.includes(name) && /not applied|was not created/.test(m.body))
    .map((m) => m.body);
const linked = async (P) => ((await R.api(N, "GET", "/projects")).find((x) => x.id === P)?.repos ?? []);

async function startSession(page, P) {
  const b = R.bench(N);
  await page.goto(`${b.uiUrl}/projects/${P}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.getByRole("button", { name: /^(Start|Continue|Start session)$/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /^Start/ }).last().click();
  // The session plans the coder task (the offer, if any, is filed after the plan) and runs it.
  await R.until(
    async () => {
      const s = await R.api(N, "GET", `/projects/${P}/tasks`);
      return s.every((t) => ["done", "failed", "needs_human", "in_review"].includes(t.status));
    },
    240_000,
    3000,
    "the session's task finished",
  ).catch((e) => (out[`${which}-sessionErr`] = String(e)));
  await sleep(4000);
}

async function answerInInbox(page, id, label) {
  const b = R.bench(N);
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await sleep(1000);
  await page.locator(`[data-request-id="${id}"]`).getByRole("button", { name: label, exact: true }).click();
  await sleep(1500);
  const confirm = page.getByRole("dialog").getByRole("button", { name: new RegExp(`^(${label}|Create)`) });
  if (await confirm.count()) await confirm.last().click();
}

async function previewAndClose(page, P) {
  const b = R.bench(N);
  await page.goto(`${b.uiUrl}/projects/${P}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.getByRole("button", { name: /Create a repository/ }).first().click();
  await page.getByTestId("create-repo-preview").click();
  await sleep(2500);
  await R.step(page, `${which}-preview-shown`);
  // The dialog's close (x).
  await page.keyboard.press("Escape");
  await sleep(1000);
}

(async () => {
  const { browser, page } = await R.openApp(N);
  await R.skipSetup(page).catch(() => undefined);
  const b = R.bench(N);
  if (which === "A") {
    const NAME = "Bat census";
    const P = await project(NAME);
    await page.goto(`${b.uiUrl}/projects/${P}/chat`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const box = page.getByRole("textbox").last();
    await box.fill(`tool: repo_create {"project": "${NAME}", "private": true}`);
    await box.press("Enter");
    await sleep(8000);
    await R.step(page, "A-01-chat-asks-first");
    out.afterChat = await cardsOf(P);
    await startSession(page, P);
    out.afterSession = await cardsOf(P);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(1000);
    out.inboxText = (await R.step(page, "A-02-inbox-one-card")).slice(0, 1200);
    const open = out.afterSession.filter((c) => c.status === "open");
    if (open.length === 1) {
      await answerInInbox(page, open[0].id, "Yes");
      await R.until(async () => (await linked(P)).length > 0, 90_000, 2000, "linked").catch((e) => (out.linkErr = String(e)));
      await sleep(4000);
    }
    out.repos = await linked(P);
    out.afterYes = await cardsOf(P);
    out.warnings = await warnings(NAME);
    await R.step(page, "A-03-inbox-after-yes");
  } else if (which === "B") {
    const NAME = "Pond survey";
    const P = await project(NAME);
    await previewAndClose(page, P);
    out.afterPreview = await cardsOf(P);
    await startSession(page, P);
    out.afterSession = await cardsOf(P);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(1000);
    out.inboxText = (await R.step(page, "B-02-inbox-one-card")).slice(0, 1200);
    const open = out.afterSession.filter((c) => c.status === "open");
    if (open.length === 1) {
      await answerInInbox(page, open[0].id, "Yes");
      await R.until(async () => (await linked(P)).length > 0, 90_000, 2000, "linked").catch((e) => (out.linkErr = String(e)));
      await sleep(4000);
    }
    out.repos = await linked(P);
    out.afterYes = await cardsOf(P);
    out.warnings = await warnings(NAME);
    await R.step(page, "B-03-inbox-after-yes");
  } else {
    const NAME = "Moth count";
    const P = await project(NAME);
    await startSession(page, P);
    out.afterSession = await cardsOf(P);
    await previewAndClose(page, P);
    out.afterPreview = await cardsOf(P);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(1000);
    await R.step(page, "C-02-inbox-offer-and-preview");
    const offer = out.afterPreview.find((c) => c.status === "open" && /^Create a repository for/.test(c.title));
    if (offer) {
      await answerInInbox(page, offer.id, "Create the repository");
      await R.until(async () => (await linked(P)).length > 0, 90_000, 2000, "linked").catch((e) => (out.linkErr = String(e)));
      await sleep(4000);
    }
    out.repos = await linked(P);
    out.afterOffer = await cardsOf(P);
    out.pendingCommands = (await R.api(N, "GET", "/commands/pending")).map((p) => p.id);
    out.warnings = await warnings(NAME);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(1000);
    // The Answered list shows both cards closed.
    const answeredTab = page.getByRole("button", { name: /^Answered/ });
    if (await answeredTab.count()) await answeredTab.first().click().catch(() => undefined);
    await sleep(800);
    out.answeredText = (await R.step(page, "C-03-inbox-answered")).slice(0, 2000);
  }
  fs.writeFileSync(`${DIR}/walk-repo-${which}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error("WALK FAILED", e);
  fs.writeFileSync(`${DIR}/walk-repo-${which}.json`, JSON.stringify({ ...out, error: String(e) }, null, 2));
  process.exit(1);
});
