"use strict";
// Fix-up walk S-10 "Start at HH:MM": a Start pressed while the API key rests is kept for the reset
// and starts once then; the person's session that waited goes on once (bench-api, limited key).
const R = require("/home/user/Forerunner/.claude/worktrees/wf_415a6fe9-606-6/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const NAME = "fixup-d1109-starts-engine";
const out = {};
const log = (k, v) => {
  out[k] = v;
  console.log(k, JSON.stringify(v));
};
const sessionsOf = async (pid) =>
  (await R.api(NAME, "GET", `/sessions?projectId=${encodeURIComponent(pid)}`)).filter(
    (s) => !/^intake/.test(s.summary || ""),
  );
const addTask = (pid, title) =>
  R.api(NAME, "POST", `/projects/${pid}/tasks`, {
    title,
    outcome: `${title} is written`,
    acceptanceCriteria: [],
    status: "ready",
  });
(async () => {
  const { browser, page } = await R.openApp(NAME, { freshProfile: true });
  const ui = R.bench(NAME).uiUrl;
  try {
    await R.skipSetup(page).catch(() => false);
    // P1: the person's session meets the key's limit and keeps its continuation.
    const p1 = await R.api(NAME, "POST", "/projects", { name: "Walk goes on", goal: "Notes", switch: true });
    await addTask(p1.id, "Write note A in a.md");
    const s1 = await R.startSession(NAME, p1.id);
    const s1id = s1.session?.id ?? (await sessionsOf(p1.id))[0].id;
    await R.waitForSession(NAME, s1id, 300000);
    const s1row = await R.api(NAME, "GET", `/sessions/${s1id}`);
    log("p1 session ended", [s1row.status, s1row.summary]);

    // P2: nothing kept; the Start dialog offers "Start at HH:MM".
    const p2 = await R.api(NAME, "POST", "/projects", { name: "Walk kept start", goal: "Notes", switch: true });
    await addTask(p2.id, "Write note K in k.md");
    const check = await R.api(NAME, "GET", `/projects/${p2.id}/start-check`);
    log("p2 check blocked", check.blocked);
    await page.goto(`${ui}/projects/${p2.id}`);
    await page.waitForTimeout(1500);
    await page.getByTestId("start-session").click();
    const dialog = page.getByTestId("start-session-dialog");
    await dialog.waitFor();
    await page.waitForTimeout(1500);
    log("p2 dialog before", await R.step(page, "k-dialog-start-at"));
    log("p2 button", await page.getByTestId("confirm-start-session").innerText());
    await page.getByTestId("confirm-start-session").click();
    await page.getByTestId("start-session-notice").waitFor();
    log("p2 notice", await page.getByTestId("start-session-notice").innerText());
    log("p2 dialog after", await R.step(page, "k-dialog-kept"));
    log("p2 sessions now", (await sessionsOf(p2.id)).length);
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.goto(`${ui}/projects/${p2.id}`);
    await page.waitForTimeout(2000);
    log("p2 project page", await R.step(page, "k-project-starts-at"));
    const card = (await R.api(NAME, "GET", "/projects")).find((p) => p.id === p2.id);
    log("p2 status line", card?.statusLine?.text ?? null);
    const again = await R.apiRaw(NAME, "POST", "/sessions", {
      agentId: (await R.api(NAME, "GET", "/agents"))[0].id,
      projectId: p2.id,
      trigger: "manual",
    });
    log("p2 second Start", [again.status, again.body?.message ?? again.body]);

    // The reset: each goes on once, P2 by the person.
    const t0 = Date.now();
    await R.until(
      async () =>
        (await sessionsOf(p2.id)).some((s) => !["running", "planned", "paused"].includes(s.status)) &&
        (await sessionsOf(p1.id)).length >= 2 &&
        (await sessionsOf(p1.id)).every((s) => !["running", "planned", "paused"].includes(s.status)),
      420000,
      2000,
      "both sessions after the reset",
    );
    log("after the reset (ms)", Date.now() - t0);
    const p2s = await sessionsOf(p2.id);
    log(
      "p2 sessions",
      p2s.map((s) => [s.status, s.trigger, s.summary, s.startedBy ?? null]),
    );
    const p1s = await sessionsOf(p1.id);
    log(
      "p1 sessions",
      p1s.map((s) => [s.status, s.trigger, s.summary]),
    );
    const ev = await R.api(NAME, "GET", `/sessions/${p1s.find((s) => s.id !== s1id)?.id}/events`);
    log("p1 continuation first lines", ev.filter((e) => e.audience === "person").slice(0, 2).map((e) => e.text));
    await page.goto(`${ui}/projects/${p2.id}`);
    await page.waitForTimeout(2000);
    log("p2 after", await R.step(page, "k-project-after-reset"));
    await new Promise((r) => setTimeout(r, 65000));
    log("p2 sessions a tick later", (await sessionsOf(p2.id)).length);
  } finally {
    fs.writeFileSync("/tmp/frbench/fixup-d1109-starts-engine/walk-k.json", JSON.stringify(out, null, 1));
    await browser.close();
  }
})().catch((e) => {
  console.error("WALK FAILED", e);
  process.exit(1);
});
