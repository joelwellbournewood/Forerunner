"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_9ce7980a-103-9/scripts/bench/recorder.cjs");
const NAME = "fixup-w8-l4-leftovers";
const enc = encodeURIComponent;
(async () => {
  const { browser, page } = await R.openApp(NAME);
  try {
    const p = await R.api(NAME, "POST", "/projects", { name: "Newt notes", goal: "Notes about newts" });
    await R.api(NAME, "POST", `/projects/${enc(p.id)}/tasks`, {
      title: "Write the newt notes",
      outcome: "newts.md is written",
      acceptanceCriteria: ["newts.md exists"],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      specialist: "coder",
      riskTier: 1,
      budgetUsdMicro: 12_500,
    });
    await page.goto(`${R.bench(NAME).uiUrl}/projects/${enc(p.id)}/tasks`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await R.step(page, "fx newt tasks row unspent budget");
    await page.getByText("Write the newt notes").first().click();
    await page.waitForTimeout(1500);
    const text = await R.step(page, "fx newt drawer unspent budget");
    console.log(text.split("\n").filter((l) => /budget|spent|CHF/.test(l)).join("\n"));
  } finally {
    await browser.close();
  }
})();
