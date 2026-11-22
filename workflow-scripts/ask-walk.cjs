"use strict";
const path = require("node:path");
const fs = require("node:fs");
const R = require(path.join(process.argv[2], "scripts/bench/recorder.cjs"));
const NAME = process.argv[3] || "fixup-w15-words";
const enc = encodeURIComponent;
(async () => {
  const b = R.bench(NAME);
  const project = await R.api(NAME, "POST", "/projects", { name: "Colours", goal: "A club page" });
  const t = await R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
    title: "Choose the colours in colours.md",
    outcome: "colours.md names the club's colours",
    acceptanceCriteria: ["colours.md exists"],
    priority: "high",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 0,
    specialist: "coder",
    riskTier: 1,
  });
  const started = await R.startSession(NAME, project.id, "asked walk");
  const s = await R.waitForSession(NAME, started.session.id, 300_000);
  const events = await R.api(NAME, "GET", `/sessions/${enc(s.id)}/events`);
  const person = events.filter((e) => e.audience === "person").map((e) => e.text);
  const { browser, page } = await R.openApp(NAME);
  try {
    await page.goto(`${b.uiUrl}/sessions/${enc(s.id)}`);
    await page.waitForTimeout(2000);
    await R.step(page, "after asked session");
  } finally {
    await browser.close();
  }
  const row = (await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`)).find((x) => x.id === t.id);
  const res = { status: s.status, statusText: s.statusText, person, row: row?.display?.label };
  fs.writeFileSync(path.join(path.dirname(b.home), "steps", "after-asked.json"), JSON.stringify(res, null, 2));
  console.log(JSON.stringify(res, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
