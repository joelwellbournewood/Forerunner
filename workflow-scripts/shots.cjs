// fixup-w8-status-write: after screens. Bob's Docs tab (the together line) and Ada's Settings
// row and Docs tab, from the benches the journey and the restart re-walk left.
const { openApp, step, api, skipSetup } = require(
  "/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-3/scripts/bench/recorder.cjs",
);

async function shoot(name, route, label) {
  const { browser, page } = await openApp(name, { path: route });
  try {
    const b = require("/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-3/scripts/bench/recorder.cjs").bench(name);
    await page.goto(`${b.uiUrl}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
    await skipSetup(page).catch(() => undefined);
    await step(page, label, { settleMs: 3000 });
  } finally {
    await browser.close();
  }
}

(async () => {
  const projects = await api("fixup-w8-status-write-bob", "GET", "/projects");
  const id = (projects.find((p) => p.name === "Team site") ?? projects[0]).id;
  await shoot("fixup-w8-status-write-bob", `/projects/${id}/docs`, "fx-docs-bob");
  await shoot("fixup-w8-status-write", `/projects/${id}/docs`, "fx-docs-ada");
  await shoot("fixup-w8-status-write", "/settings", "fx-settings-ada");
  const settings = await api("fixup-w8-status-write", "GET", "/settings");
  const row = settings.find((r) => r.key === "project.status_issue");
  console.log(JSON.stringify({ adaStatusRow: row?.description }));
  const bobDocs = await api("fixup-w8-status-write-bob", "GET", `/projects/${id}/docs`);
  console.log(JSON.stringify({ bobStatus: bobDocs.find((d) => d.path === "docs/status.md")?.note }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
