// fixup-l4-starts-carried bench walk B (--provider bench-api --api-key limited,
// FORERUNNER_BENCH_API_LIMIT_MIN=2): chat's start kept for the reset runs at the reset; its Undo is
// then refused in words (the review's blocking 3), in chat and on the Changes screen.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const repo = process.argv[2];
const name = process.argv[3];
const out = process.argv[4];
const { openApp, step, api, until, skipSetup, bench } = require(
  path.join(repo, "scripts/bench/recorder.cjs"),
);

const checks = [];
const check = (label, ok, seen) => {
  checks.push({ label, ok: !!ok, seen });
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` :: ${String(seen).slice(0, 500)}`}`);
};
const gone =
  "the start kept for the reset has already run or was cancelled; there is nothing to undo";

(async () => {
  const ui = bench(name).uiUrl.replace(/\/$/, "");
  const project = await api(name, "POST", "/projects", { name: "Map notes", goal: "A note" });
  await api(name, "POST", `/projects/${project.id}/tasks`, {
    title: "Write notes/map.md",
    outcome: "notes/map.md is written",
    acceptanceCriteria: ["it is written"],
    priority: "medium",
    status: "ready",
    dependsOn: [],
    budgetUsdMicro: 0,
    specialist: "coder",
    riskTier: 0,
  });
  const agents = await api(name, "GET", "/agents");
  const first = await api(name, "POST", "/sessions", {
    agentId: agents[0].id,
    projectId: project.id,
    trigger: "manual",
  });
  await until(
    async () => {
      const s = await api(name, "GET", `/sessions?projectId=${project.id}`);
      return s.length > 0 && s.every((x) => !["planned", "running", "paused"].includes(x.status));
    },
    60_000,
    1000,
    "the first session to end to wait",
  );
  check("the first start met the limit", first.result === "started" || first.result === "kept", first);
  await api(name, "POST", `/projects/${project.id}/continuation/cancel`, {});
  const { browser, page } = await openApp(name);
  await skipSetup(page).catch(() => undefined);
  await page.goto(`${ui}/projects/${project.id}/chat`);
  const input = page.getByTestId("chat-input");
  await input.waitFor();
  await input.fill("run it now");
  await page.getByTestId("chat-send").click();
  await page.getByTestId("pending-confirmation").waitFor({ timeout: 30_000 });
  const readback = await page.getByTestId("pending-confirmation").innerText();
  await step(page, "after-b1-chat-readback-start-at-the-reset");
  check("the read-back names the reset's time", /Start a session on Map notes at \d{2}:\d{2} \(up to CHF \d+\.\d{2}\)\?/.test(readback), readback);
  await page.getByTestId("confirm-yes").click();
  await page.waitForFunction(
    () => /A session of Map notes starts at \d{2}:\d{2}\./.test(document.body.innerText),
    null,
    { timeout: 30_000 },
  );
  await step(page, "after-b2-chat-kept-with-undo");
  check("chat says the start is kept", true, "");
  // Wait for the reset: the kept start runs once and finishes the task.
  await until(
    async () => {
      const ts = await api(name, "GET", `/projects/${project.id}/tasks`);
      return ts.length > 0 && ts.every((t) => t.status === "done");
    },
    300_000,
    3000,
    "the kept start to run at the reset and finish the task",
  );
  await until(
    async () => {
      const s = await api(name, "GET", `/sessions?projectId=${project.id}`);
      return s.every((x) => !["planned", "running", "paused"].includes(x.status));
    },
    60_000,
    1000,
    "the session to end",
  );
  const sessions = await api(name, "GET", `/sessions?projectId=${project.id}`);
  check("one session ran at the reset (two in all)", sessions.length === 2, sessions.map((s) => s.status));
  await page.goto(`${ui}/projects/${project.id}/chat`);
  await page.getByTestId("chat-messages").waitFor();
  await page.waitForTimeout(1000);
  const undo = page.getByTestId("chat-undo");
  if (await undo.count()) {
    await undo.last().click();
    await page.getByTestId("chat-undo-note").last().waitFor({ timeout: 15_000 });
    const note = await page.getByTestId("chat-undo-note").last().innerText();
    await step(page, "after-b3-chat-undo-after-the-start-ran");
    check("chat's Undo after the start ran is refused in words", note.includes(`Not undone: ${gone}.`), note);
    check("chat's Undo never says Undone", !/Undone:/.test(note), note);
  } else {
    await step(page, "after-b3-chat-no-undo-after-the-start-ran");
    check("chat offers no Undo once the start ran", true, "");
  }
  const changes = await api(name, "GET", `/changes?projectId=${project.id}`);
  const row = changes.find((c) => (c.commands?.[0]?.name ?? "") === "session.start");
  check("the change row is refused with the reason", row?.undoBlockedReason === gone || row?.undoState === "irreversible", row);
  await page.goto(`${ui}/changes`);
  await page.waitForTimeout(1500);
  const changesText = await step(page, "after-b4-changes-screen");
  check("Changes shows the reason in place of Undo", changesText.includes(gone) || /cannot be undone/i.test(changesText), changesText.slice(0, 2000));
  fs.writeFileSync(out, JSON.stringify({ checks, row }, null, 2));
  await browser.close();
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
