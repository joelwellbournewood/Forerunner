// Fix-up walk (R-rebuildcard, the conflict variant's Redo), on the fixup-leftovers7-merge bench.
// A chain A <- B on the stand-in GitHub where B rewrites A's own file; A's PR is closed on GitHub;
// the Inbox has one card "B could not be rebuilt without pull request #A" with Redo and Leave it
// open. Redo: a session starts by itself; B ends done again on its pull request with only its own
// commit on main, and no second conflict card.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_8c348d94-071-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "fixup-leftovers7-merge";
const DIR = `/tmp/frbench/${N}`;
const gh = JSON.parse(fs.readFileSync(`${DIR}/githost.json`, "utf8"));
const tag = process.argv[2] || "conflict";
const out = { tag };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gh_(method, path, body) {
  const res = await fetch(`${gh.url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${gh.token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
(async () => {
  const { browser, page } = await R.openApp(N);
  await R.skipSetup(page).catch(() => undefined);
  const b = R.bench(N);
  const project = await R.api(N, "POST", "/projects", {
    name: `Chain ${tag}`,
    goal: "A page and its rewrite",
    repos: ["bench/seeded"],
  });
  const P = project.id;
  out.projectId = P;
  const A = await R.api(N, "POST", `/projects/${P}/tasks`, {
    title: `Write the intro ${tag} in shared-${tag}.md`,
    outcome: `shared-${tag}.md is written`,
    specialist: "coder",
    riskTier: 1,
  });
  const aId = A.task?.id ?? A.id;
  const B = await R.api(N, "POST", `/projects/${P}/tasks`, {
    title: tag === "clean" ? `Write the outline ${tag} in outline-${tag}.md` : `Rewrite the intro ${tag} in shared-${tag}.md`,
    outcome: tag === "clean" ? `outline-${tag}.md is written` : `shared-${tag}.md is rewritten`,
    specialist: "coder",
    riskTier: 1,
    dependsOn: [aId],
  });
  const bId = B.task?.id ?? B.id;
  out.ids = { aId, bId };
  await page.goto(`${b.uiUrl}/projects/${P}`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.getByRole("button", { name: /^(Start|Continue|Start session)$/ }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /^Start/ }).last().click();
  await R.until(
    async () => (await R.api(N, "GET", `/projects/${P}/tasks`)).every((t) => ["done", "failed", "needs_human"].includes(t.status)),
    300_000,
    3000,
    "both tasks finished",
  );
  await sleep(4000);
  const ta = (await R.api(N, "GET", `/tasks/${aId}`)).task;
  const tb = (await R.api(N, "GET", `/tasks/${bId}`)).task;
  out.before = { a: [ta.status, ta.prUrl, ta.display?.label], b: [tb.status, tb.prUrl, tb.display?.label] };
  const aNum = Number(String(ta.prUrl).split("/").pop());
  const bNum = Number(String(tb.prUrl).split("/").pop());
  out.bFilesBefore = (await gh_("GET", `/repos/bench/seeded/pulls/${bNum}/files`)).body?.map((f) => f.filename);
  out.bCommitsBefore = (await gh_("GET", `/repos/bench/seeded/pulls/${bNum}/commits`)).body?.map((c) => c.commit.message.split("\n")[0]);
  await R.step(page, `rb-${tag}-01-overview-chain`);
  out.closeA = (await gh_("PATCH", `/repos/bench/seeded/pulls/${aNum}`, { state: "closed" })).status;
  let card = null;
  await R.until(
    async () => {
      const inbox = await R.api(N, "GET", "/inbox");
      card = (inbox.requests ?? []).find((r) => r.status === "open" && r.taskId === bId);
      return !!card;
    },
    200_000,
    3000,
    "the rebuild card",
  ).catch((e) => (out.cardWaitErr = String(e)));
  out.card = card && { title: card.title, body: card.body, choices: (card.choices ?? []).map((c) => [c.label, c.explain]) };
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await sleep(1500);
  await R.step(page, `rb-${tag}-02-inbox-rebuild-card`);
  if (card) {
    await page.locator(`[data-request-id="${card.id}"]`).getByRole("button", { name: "Redo", exact: true }).click();
    await sleep(1500);
    const confirm = page.getByRole("dialog").getByRole("button", { name: /^Redo/ });
    if (await confirm.count()) await confirm.last().click();
    await sleep(3000);
    await R.step(page, `rb-${tag}-03-inbox-after-redo`);
    const t0 = Date.now();
    await R.until(
      async () => {
        const t = (await R.api(N, "GET", `/tasks/${bId}`)).task;
        return t.status === "done" || t.status === "needs_human" || t.status === "failed";
      },
      300_000,
      3000,
      "the redone task settled",
    ).catch((e) => (out.redoWaitErr = String(e)));
    out.redoMs = Date.now() - t0;
    await sleep(4000);
    const tb2 = (await R.api(N, "GET", `/tasks/${bId}`)).task;
    out.bAfter = [tb2.status, tb2.prUrl, tb2.branch, tb2.display?.label, tb2.reason];
    const inbox = await R.api(N, "GET", "/inbox");
    out.openCardsForB = (inbox.requests ?? []).filter((r) => r.status === "open" && r.taskId === bId).map((r) => r.title);
    const answered = (inbox.requests ?? []).find((r) => r.id === card.id);
    out.cardAfter = answered && { status: answered.status, outcome: answered.outcome };
    const prB = (await gh_("GET", `/repos/bench/seeded/pulls/${bNum}`)).body;
    out.prB = prB && { number: prB.number, state: prB.state, merged: prB.merged, head: prB.head?.sha };
    out.bFilesAfter = (await gh_("GET", `/repos/bench/seeded/pulls/${bNum}/files`)).body?.map((f) => f.filename);
    out.bCommitsAfter = (await gh_("GET", `/repos/bench/seeded/pulls/${bNum}/commits`)).body?.map((c) => c.commit.message.split("\n")[0]);
    const main = (await gh_("GET", "/repos/bench/seeded/branches/main")).body;
    const head = (await gh_("GET", `/repos/bench/seeded/commits/${prB.head.sha}`)).body;
    out.headParentIsMain = head?.parents?.[0]?.sha === main?.commit?.sha;
    await page.goto(`${b.uiUrl}/projects/${P}`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(1500);
    out.overviewAfter = (await R.step(page, `rb-${tag}-04-overview-after`)).slice(0, 1500);
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await sleep(1500);
    await R.step(page, `rb-${tag}-05-inbox-later`);
  }
  fs.writeFileSync(`${DIR}/walk-rebuild-${tag}.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error("WALK FAILED", e);
  fs.writeFileSync(`${DIR}/walk-rebuild-${tag}.json`, JSON.stringify({ ...out, error: String(e) }, null, 2));
  process.exit(1);
});
