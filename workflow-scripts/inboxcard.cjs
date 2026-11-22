// Files a settings.set merge_mode change (as chat would, left waiting) and screenshots its Inbox
// card; then answers No so nothing changes.
const R = require("/home/user/Forerunner/.claude/worktrees/wf_06cd7061-9f6-7/scripts/bench/recorder.cjs");
const N = "review-polish-screens";
const out = {};
(async () => {
  const projects = await R.api(N, "GET", "/projects");
  const seeded = projects.find((p) => p.name === "Seeded site");
  const r = await R.api(N, "POST", "/commands/execute", {
    commands: [{ name: "settings.set", params: { key: "merge_mode", value: "after_review", project: seeded.id } }],
    wordsUsed: "merge automatically on Seeded site",
    source: "text",
    projectId: seeded.id,
  });
  out.status = r.status;
  out.readback = r.readback;
  const { browser, page } = await R.openApp(N);
  try {
    await page.goto(`${R.bench(N).uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    const card = page.locator('[data-testid="request-card"]', { hasText: "merges" }).first();
    out.card = await card.innerText().catch(() => null);
    await R.step(page, "inbox-merge-card-pending");
    if (r.pendingId) await R.api(N, "POST", `/commands/${r.pendingId}/confirm`, { answer: "no" });
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(out, null, 1));
})().catch((e) => {
  console.error(e);
  console.log(JSON.stringify(out, null, 1));
  process.exit(1);
});
