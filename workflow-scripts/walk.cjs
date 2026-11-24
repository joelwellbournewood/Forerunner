// l4-chat-carried bench walk: a suggestion card through a daemon restart (C4-left-7), a split and
// its Undo (C4-left-6, L4-selftasks-129), and Talk on a joined project (C4-left-9).
// Usage: node walk.cjs <repoRoot> <benchName> <label>
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const [repo, n, label] = process.argv.slice(2);
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const out = { label, checks: {}, texts: {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function db() {
  const b = JSON.parse(fs.readFileSync(`/tmp/frbench/${n}/bench.json`, "utf8"));
  const found = execFileSync("find", [b.home, "-name", "*.sqlite"], { encoding: "utf8" })
    .split("\n")
    .filter((f) => f && !f.includes("vault"));
  return found.find((f) => f.endsWith("state.sqlite")) ?? found[0];
}
function sql(script) {
  return execFileSync("python3", ["-I", "-c", script, db()], { encoding: "utf8" });
}

(async () => {
  const me = await R.api(n, "GET", "/me");
  // 1. A project at Assisted: "Style the page" waits for the person's logo, "Publish the page"
  // waits for it; the session's task check suggests splitting it (a suggestion card).
  const project = await R.api(n, "POST", "/projects", {
    name: "Quote page",
    goal: "A page that quotes prices",
    autonomyLevel: 1,
  });
  const pid = project.id ?? project.project?.id;
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
  const sid = started.session?.id ?? started.id;
  await R.waitForSession(n, sid, 180_000);
  await sleep(1500);

  const { browser, page } = await R.openApp(n, { freshProfile: true });
  try {
    await R.skipSetup(page).catch(() => {});
    await page.goto(`${R.bench(n).uiUrl}/inbox`);
    await sleep(1500);
    // Assisted: the session plan waits for the person's approve; then the session runs and its
    // task check suggests the split.
    await page.getByRole("button", { name: "approve", exact: true }).first().click();
    const proposalId = () =>
      sql(`
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
for i, cc in c.execute("select id, change_card from human_request where status='open'").fetchall():
    d = json.loads(cc or 'null') or {}
    if d.get('key') == 'task_proposal':
        print(i)
        break
`).trim();
    await R.until(async () => !!proposalId(), 180_000, 2000, "the suggestion card");
    await sleep(1500);
    await page.goto(`${R.bench(n).uiUrl}/inbox`);
    await sleep(2000);
    out.texts.inboxBefore = await R.step(page, `${label}-1-suggestion-card`);

    // 2. The person answers Make the changes and the daemon stops before it is done: the card is
    // left at 'applying' (what a crash mid-apply leaves), then the daemon starts again.
    const card = sql(`
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
rows = c.execute("select id, change_card from human_request where status='open'").fetchall()
for i, cc in rows:
    d = json.loads(cc or 'null') or {}
    if d.get('key') == 'task_proposal':
        print(i)
        break
`).trim();
    out.checks.cardFiled = !!card;

    // A joined project for Talk: Beacon closed into Atlas (what Make one project leaves).
    const atlas = await R.api(n, "POST", "/projects", { name: "Atlas", goal: "A site" });
    const beacon = await R.api(n, "POST", "/projects", { name: "Beacon", goal: "A site too" });
    const atlasId = atlas.id ?? atlas.project?.id;
    const beaconId = beacon.id ?? beacon.project?.id;
    {
      sql(`
import json, sqlite3, sys, datetime
c = sqlite3.connect(sys.argv[1])
now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
row = c.execute("select change_card from human_request where id=?", ("${card}",)).fetchone()
if row:
    cc = json.loads(row[0])
    cc['outcome'] = 'applying'
    cc['applying_at'] = now
    c.execute("update human_request set status='answered', answer=?, answered_by=?, answered_at=?, change_card=?, version=version+1 where id=?",
      (json.dumps({"choice": "Make these changes"}), "${me.id}", now, json.dumps(cc), "${card}"))
s = json.loads(c.execute("select settings from project where id=?", ("${beaconId}",)).fetchone()[0] or '{}')
s['joined_into'] = {"project": "${atlasId}", "name": "Atlas", "at": now}
c.execute("update project set status='archived', settings=?, version=version+1 where id=?", (json.dumps(s), "${beaconId}"))
c.commit()
print("patched")
`);
    }
    execFileSync("node", [path.join(repo, "scripts/bench/restart-daemon.mjs"), "--name", n], {
      stdio: "inherit",
    });
    await sleep(6000);
    await R.reconnect(page, n).catch(() => {});
    await page.goto(`${R.bench(n).uiUrl}/inbox`);
    await sleep(2500);
    await page.getByText(/^Answered \(/).first().click().catch(() => {});
    await sleep(800);
    out.texts.inboxAfterRestart = await R.step(page, `${label}-2-card-after-restart`);
    out.checks.stuckMaking = /Making the changes/.test(out.texts.inboxAfterRestart);
    const titles = (await R.api(n, "GET", `/projects/${pid}/tasks`)).map((t) => t.title);
    out.checks.tasksAfterRestart = titles;
    await page.goto(`${R.bench(n).uiUrl}/projects/${pid}/tasks`);
    await sleep(1500);
    await R.step(page, `${label}-3-tasks-after-restart`);

    // 3. After the split, "Publish the page" is made to wait for one more task; the split's Undo
    // on Changes then says why it cannot be undone (after) or offers Undo (before).
    const all = await R.api(n, "GET", `/projects/${pid}/tasks`);
    const publish = all.find((t) => t.title === "Publish the page");
    const check = await task({
      title: "Check that the links work",
      outcome: "Every link opens",
      acceptanceCriteria: ["no link is broken"],
      riskTier: 1,
      specialist: "coder",
      dependsOn: [logo.id],
    });
    const deps = [...(publish?.dependsOn ?? []), check.id];
    const set = await R.apiRaw(n, "POST", `/tasks/${publish?.id}/dependencies`, {
      version: publish?.version,
      dependsOn: deps,
    });
    out.checks.dependenciesSet = set.status;
    await page.goto(`${R.bench(n).uiUrl}/changes`);
    await sleep(2000);
    out.texts.changes = await R.step(page, `${label}-4-changes-split-undo`);
    out.checks.refusalShown = /Cannot be undone now: "Publish the page" was made to wait/.test(out.texts.changes);

    // 4. Talk on the joined project.
    await page.goto(`${R.bench(n).uiUrl}/projects/${beaconId}`);
    await sleep(1500);
    await page.getByTestId("talk-open").click().catch(() => {});
    await sleep(1500);
    out.texts.talk = await R.step(page, `${label}-5-talk-joined`);
    out.checks.talkClosedLine = /This chat is kept to read; ask about its work in the Chat of "Atlas"/.test(out.texts.talk);
    out.checks.talkHasBox = (await page.locator("textarea").count()) > 0;
  } finally {
    await browser.close();
  }
  out.problems = R.problems(n).slice(-10);
  fs.writeFileSync(`/tmp/frbench/${n}/steps/${label}-walk.json`, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out.checks, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
