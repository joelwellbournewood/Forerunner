// Review walk part 7: does the plan card's note stay on the Inbox screen over time?
"use strict";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_15a781ce-056-5/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const N = "review-d1109-oversize-start";
const out = { samples: [], inboxCalls: [] };

(async () => {
  const { browser, page } = await R.openApp(N);
  const ui = R.bench(N).uiUrl;
  page.on("response", async (res) => {
    if (!/\/inbox(\?|$)/.test(res.url())) return;
    try {
      const body = await res.json();
      const reqs = body.requests ?? [];
      const plan = reqs.find((r) => r.planTasks);
      out.inboxCalls.push({
        url: res.url().replace(/token=[^&]+/, "token=…"),
        at: Date.now(),
        planTasks: plan ? plan.planTasks.map((t) => t.oversized ?? null) : null,
      });
    } catch {
      out.inboxCalls.push({ url: res.url(), at: Date.now(), error: "no json" });
    }
  });
  await page.goto(`${ui}/inbox`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    out.samples.push({
      at: Date.now(),
      notes: await page.getByTestId("intake-task-oversized").count(),
      visible: await page
        .getByTestId("intake-task-oversized")
        .first()
        .isVisible()
        .catch(() => false),
    });
  }
  await R.step(page, "plan card after eight seconds");
  fs.writeFileSync("/tmp/frbench/review-d1109-oversize-start/walk7.json", JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
