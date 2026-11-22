// Screens area walk (g): a coder task that fails twice; the third attempt's lines on the session
// page name who ran it. Bench started with --env FORERUNNER_BENCH_FAIL=Ladder --env
// FORERUNNER_BENCH_FAIL_TIMES=2. Usage: node screens-walk-g.cjs <repo> <bench> <tag>
"use strict";
const [repo, N, tag] = process.argv.slice(2);
const R = require(`${repo}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");

(async () => {
  const me = await R.api(N, "GET", "/me");
  const project = await R.api(N, "POST", "/projects", { name: `Ladder ${tag}`, goal: "Who runs" });
  const task = await R.api(N, "POST", `/projects/${project.id}/tasks`, {
    title: "Ladder notes: write notes/ladder.md",
    outcome: "notes/ladder.md lists the steps",
    specialist: "coder",
  });
  const sessions = [];
  for (let i = 0; i < 4; i++) {
    const t = (await R.api(N, "GET", `/projects/${project.id}/tasks`)).find((x) => x.id === task.id);
    if (t.status === "done") break;
    if (t.status === "failed")
      await R.api(N, "POST", `/tasks/${t.id}/action`, { version: t.version, action: "try_again" });
    else if (t.status !== "ready") break;
    const st = await R.api(N, "POST", "/sessions", {
      agentId: me.agent.id,
      projectId: project.id,
      trigger: "manual",
    }).catch((e) => ({ error: String(e) }));
    if (!st.session) break;
    sessions.push(st.session.id);
    await R.waitForSession(N, st.session.id, 240_000);
  }
  const { browser, page } = await R.openApp(N);
  await R.skipSetup(page);
  const ui = R.bench(N).uiUrl;
  const lines = [];
  for (const id of sessions) {
    const ev = await R.api(N, "GET", `/sessions/${id}/events`);
    for (const e of ev)
      if (e.payload?.taskId === task.id && /^task\.(started|finished)$/.test(e.type))
        lines.push({ type: e.type, audience: e.audience, specialist: e.payload.specialist, handedFrom: e.payload.handedFrom ?? null, text: e.text });
    await page.goto(`${ui}/sessions/${id}`);
    await page.waitForTimeout(2000);
    await R.step(page, `${tag} g session page`);
  }
  const detail = await R.api(N, "GET", `/tasks/${task.id}`);
  await page.goto(`${ui}/projects/${project.id}/tasks?task=${task.id}`);
  await page.waitForTimeout(2000);
  await R.step(page, `${tag} g drawer`);
  const out = {
    tag,
    lines,
    runs: detail.runs.map((r) => [r.kind, r.specialist, r.outcome]),
    status: detail.task.status,
  };
  fs.writeFileSync(`/tmp/frbench/${N}/walk-g-${tag}.json`, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
