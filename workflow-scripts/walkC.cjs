// Review walk C: Talk on a joined project (C4-left-9): the header's Talk, then the palette's Talk
// (which starts a push-to-talk turn, as the desktop hotkey does). Usage: node walkC.cjs <repo> <bench> <label>
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const [repo, n, label] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { label, texts: {}, checks: {} };
(async () => {
  const atlas = await R.api(n, "POST", "/projects", { name: "Atlas", goal: "A site" });
  const beacon = await R.api(n, "POST", "/projects", { name: "Beacon", goal: "A site too" });
  const db = `${R.bench(n).home}/data/state.sqlite`;
  execFileSync(
    "python3",
    [
      "-I",
      "-c",
      `
import json, sqlite3, sys, datetime
c = sqlite3.connect(sys.argv[1])
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
s = json.loads(c.execute("select settings from project where id=?", (sys.argv[2],)).fetchone()[0] or '{}')
s['joined_into'] = {"project": sys.argv[3], "name": "Atlas", "at": now}
c.execute("update project set status='archived', settings=?, version=version+1 where id=?", (json.dumps(s), sys.argv[2]))
c.commit()
`,
      db,
      beacon.id,
      atlas.id,
    ],
    { encoding: "utf8" },
  );
  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${R.bench(n).uiUrl}/projects/${beacon.id}`);
    await sleep(3000);
    out.texts.page = await R.step(page, `${label}-joined-page`);
    await page.getByTestId("talk-open").click();
    await sleep(2500);
    out.texts.talk = await R.step(page, `${label}-talk-header`);
    const panel = page.getByTestId("conversation");
    out.checks.closedLine = await page.getByTestId("conversation-closed").textContent().catch(() => null);
    out.checks.textareas = await panel.locator("textarea").count();
    out.checks.voiceTalk = await page.getByTestId("voice-talk").count();
    out.checks.voicePhase = await page.getByTestId("voice-phase").count();
    // Close the panel, then the palette's Talk: a push-to-talk turn, as the hotkey's press.
    await page.keyboard.press("Escape");
    await sleep(800);
    await page.keyboard.press("Control+k");
    await sleep(800);
    await page.keyboard.type("Talk");
    await sleep(800);
    out.texts.palette = await R.step(page, `${label}-palette`);
    await page.keyboard.press("Enter");
    await sleep(3000);
    out.texts.paletteTalk = await R.step(page, `${label}-palette-talk`);
    out.checks.afterPalette = {
      closedLine: await page.getByTestId("conversation-closed").count(),
      voicePhase: await page.getByTestId("voice-phase").count(),
      reason: await page.locator("output").allTextContents(),
    };
    out.voiceRequests = R.problems(n).slice(-5);
    // Open it leads to Atlas's Chat.
    await page.getByRole("link", { name: "Open it" }).first().click().catch(() => {});
    await sleep(2500);
    out.texts.openIt = await R.step(page, `${label}-open-it`);
    out.checks.urlAfterOpenIt = page.url().replace(/token=[^&]+/, "token=…");
  } finally {
    await browser.close();
  }
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.checks, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
