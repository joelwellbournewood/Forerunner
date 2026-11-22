// Review walk 3a (l4-chat-depth, L4-chat-204): a chat card read back, then Make one project.
const repo = process.argv[2];
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const N = "review-l4-chat-depth";
const UI = "http://127.0.0.1:2551";
const fs = require("fs");
const OUT = "/tmp/frbench/review-l4-chat-depth/walk3a.json";

(async () => {
  const out = { steps: {} };
  const save = () => fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  const { browser, page } = await R.openApp(N);
  const shot = async (label) => {
    out.steps[label] = await R.step(page, label);
    save();
  };
  try {
    const kite = JSON.parse(fs.readFileSync("/tmp/frbench/review-l4-chat-depth/walk2.json", "utf8")).kite;
    out.kite = kite;
    const site = await R.api(N, "POST", "/projects", { name: "Site", goal: "One site for the clubs" });
    out.site = site.id;
    await page.goto(`${UI}/projects/${kite}/chat`);
    await page.waitForTimeout(2500);
    const box = page.getByPlaceholder("Message your agent…");
    await box.fill("make the FAQ task depend on the README task");
    await box.press("Enter");
    await page.waitForTimeout(6000);
    await shot("w3-01-card-before-join");
    const join = await R.apiRaw(N, "POST", "/commands/execute", {
      commands: [{ name: "project.join", params: { keep: site.id, close: [kite] } }],
      wordsUsed: "Make one project (Overview)",
      source: "ui",
      projectId: site.id,
      confirm: "tap",
    });
    out.join = join;
    save();
    await page.goto(`${UI}/projects/${kite}/summary`);
    await page.waitForTimeout(2500);
    await shot("w3-02-kite-after-join");
  } finally {
    save();
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
