// Review walk 3b (l4-chat-depth, L4-chat-204): after the join and a restart, the card's yes, the
// Data tab's Add, and the plan route.
const repo = process.argv[2];
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-depth";
const UI = "http://127.0.0.1:2551";
const fs = require("fs");
const OUT = "/tmp/frbench/review-l4-chat-depth/walk3b.json";

(async () => {
  const out = { steps: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const { browser, page } = await R.openApp(N);
  const shot = async (label) => {
    out.steps[label] = await R.step(page, label);
    save();
  };
  try {
    const a = JSON.parse(fs.readFileSync("/tmp/frbench/review-l4-chat-depth/walk3a.json", "utf8"));
    const kite = a.kite;
    const tasksBefore = await R.api(N, "GET", `/projects/${kite}/tasks`);
    out.tasksBefore = tasksBefore.map((t) => ({ title: t.title, dependsOn: t.dependsOn }));
    await page.goto(`${UI}/projects/${kite}/chat`);
    await page.waitForTimeout(3000);
    await shot("w3-03-kite-chat-after-restart");
    await page.goto(`${UI}/inbox`);
    await page.waitForTimeout(3000);
    await shot("w3-04-inbox-after-restart");
    const inbox = await R.api(N, "GET", "/inbox");
    out.inbox = inbox.requests.map((r) => ({ id: r.id, title: r.title, why: r.why, options: r.options, project: r.projectName ?? r.project_id }));
    save();
    // Press Yes on the read-back's card in the Inbox, as the person does.
    const card = page.locator('[data-testid="inbox-card"], [data-testid="request-card"]').filter({ hasText: "Write the FAQ" });
    out.cardCount = await card.count();
    if (out.cardCount) {
      const btns = await card.first().getByRole("button").allTextContents();
      out.cardButtons = btns;
      const yes = card.first().getByRole("button", { name: /^Yes/ });
      if (await yes.count()) {
        await yes.first().click();
        await page.waitForTimeout(3000);
        await shot("w3-05-inbox-after-yes");
      }
    }
    const tasksAfter = await R.api(N, "GET", `/projects/${kite}/tasks`);
    out.tasksAfter = tasksAfter.map((t) => ({ title: t.title, dependsOn: t.dependsOn }));
    // The Data tab's Add on the closed project.
    await page.goto(`${UI}/projects/${kite}/data`);
    await page.waitForTimeout(3000);
    await shot("w3-06-data-tab");
    const locator = page.getByTestId("data-locator");
    out.dataAdd = await locator.count();
    if (out.dataAdd) {
      await locator.fill("https://example.com/members.csv");
      const kind = page.getByTestId("data-kind");
      const opts = await kind.locator("option").allTextContents();
      out.kindOptions = opts;
      await kind.selectOption({ index: 1 }).catch(() => undefined);
      await page.getByTestId("data-register").click();
      await page.waitForTimeout(2500);
      await shot("w3-07-data-add-refused");
    }
    out.dataAssets = await R.api(N, "GET", `/projects/${kite}/data`).catch((e) => String(e));
    out.plan = await R.apiRaw(N, "POST", `/projects/${kite}/plan`, {
      reason: "planned from the brief",
      milestones: [{ name: "Phase 1", successCriteria: ["The page loads"], tasks: [{ key: "page", title: "Write the page", outcome: "index.html" }] }],
    });
    out.importData = await R.apiRaw(N, "POST", `/projects/${kite}/data/import`, { source: "folder", locator: "/tmp/nothing-here" });
  } finally {
    save();
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
