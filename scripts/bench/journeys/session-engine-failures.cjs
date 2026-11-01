// Session-engine failure journeys (core-experience design §4.3, §4.4): a step the critic sends
// back is reworked in the same session; a step that keeps failing gets one card after its
// retries and the steps after it are not attempted; a run whose model call fails reads
// "Claude did not answer (model call failed)". Each part restarts the daemon with its
// injection, on a bench started with FORERUNNER_BENCH_PLAN=chain:
//   node scripts/bench/journeys/session-engine-failures.cjs <bench> <label>
// Steps are <bench>/steps/NN-<label>-*.png and .txt; the result is
// <bench>/steps/<label>-session-engine-failures.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const R = require("../recorder.cjs");

const NAME = process.argv[2] || "se";
const LABEL = process.argv[3] || "failures";
const result = { label: LABEL, checks: [] };
const out = (s) => console.log(`[session-engine-failures ${LABEL}] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const restart = (env) => {
  const args = [path.join(__dirname, "..", "restart-daemon.mjs"), "--name", NAME];
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  const r = spawnSync(process.execPath, args, { encoding: "utf8" });
  out(`restart ${JSON.stringify(env)}: ${r.status}`);
};
const tasksOf = async (projectId) =>
  R.api(NAME, "GET", `/projects/${encodeURIComponent(projectId)}/tasks`);
const runOnce = async (project, brief) => {
  const p = await R.createPlannedProject(NAME, {
    project: `${project} (${LABEL})`,
    goal: `${project} in steps`,
    brief,
  });
  const started = await R.startSession(NAME, p.projectId);
  const id =
    started.session?.id ??
    (await R.until(
      async () =>
        (
          await R.api(NAME, "GET", `/sessions?projectId=${encodeURIComponent(p.projectId)}`)
        ).find((s) => !/^intake/.test(s.summary))?.id ?? null,
      30_000,
      500,
      "the session",
    ));
  const ended = await R.waitForSession(NAME, id, 600_000);
  const sessions = (
    await R.api(NAME, "GET", `/sessions?projectId=${encodeURIComponent(p.projectId)}`)
  ).filter((s) => !/^intake/.test(s.summary));
  return { projectId: p.projectId, session: ended, sessions, tasks: await tasksOf(p.projectId) };
};
const openTab = async (page, projectId, tab, label) => {
  await page.goto(`${R.bench(NAME).uiUrl}/projects/${encodeURIComponent(projectId)}/${tab}`);
  await page.waitForTimeout(2000);
  return R.step(page, `${LABEL} ${label}`);
};

(async () => {
  const { browser, page } = await R.openApp(NAME);
  try {
    // (b) The critic sends a step back once: the rework is accepted in the same session.
    restart({ FORERUNNER_BENCH_CRITIC_REJECT: "quote list", FORERUNNER_BENCH_FAIL: "" });
    await R.reconnect(page, NAME);
    const b = await runOnce("Rework page", "A one-page website with a greeting; plain HTML");
    const reworked = b.tasks.filter((t) => t.status === "done").length;
    const step2 = b.tasks.find((t) => /quote list/.test(t.title));
    const runs = (
      await R.api(NAME, "GET", `/projects/${encodeURIComponent(b.projectId)}/runs`)
    ).filter((r) => r.taskId === step2?.id && r.specialist !== "critic");
    check("the sent-back step ran twice", runs.length === 2, `${runs.length} run(s)`);
    check(
      "a sent-back step is reworked and accepted in the same session",
      reworked === b.tasks.length && b.sessions.length === 1,
      `${reworked} of ${b.tasks.length} done in ${b.sessions.length} session(s): ${JSON.stringify(b.session.summary)}`,
    );
    await openTab(page, b.projectId, "tasks", "rework tasks");

    // (c) A step that keeps failing (report mode): retries in one session, one card, the steps
    // after it not attempted.
    restart({ FORERUNNER_BENCH_CRITIC_REJECT: "", FORERUNNER_BENCH_FAIL: "random quote" });
    await R.reconnect(page, NAME);
    const c = await runOnce("Failing page", "A one-page website with a quote; plain HTML");
    const step3 = c.tasks.find((t) => /random quote/.test(t.title));
    const after = c.tasks.filter((t) => t.status === "ready" && t !== step3);
    const inbox = await R.api(NAME, "GET", "/inbox");
    const cards = inbox.requests.filter((r) => r.projectId === c.projectId);
    check(
      "the failing step's retries run in one session and end with one card",
      c.sessions.length === 1 && cards.length === 1,
      `${c.sessions.length} session(s), ${cards.length} card(s), step 3 ${step3?.status}`,
    );
    check(
      "the steps after it are not attempted",
      after.length >= 1 && after.every((t) => t.attempt === 0),
      after.map((t) => `${t.title}: ${t.status}`).join("; "),
    );
    check(
      "the result says the failing step needs a decision",
      /needs your decision/.test(String(c.session.summary)),
      JSON.stringify(c.session.summary),
    );
    await openTab(page, c.projectId, "tasks", "failing tasks");
    await page.goto(`${R.bench(NAME).uiUrl}/inbox`);
    await page.waitForTimeout(2000);
    await R.step(page, `${LABEL} failing inbox`);

    // (d) The model call fails: the reason is the error in words, not the model's first remark.
    restart({ FORERUNNER_BENCH_FAIL: "Create index.html", FORERUNNER_BENCH_FAIL_MODE: "error" });
    await R.reconnect(page, NAME);
    const d = await runOnce("Error page", "A one-page website with a clock; plain HTML");
    const failed = d.tasks.find((t) => t.status === "failed");
    check(
      "a run whose model call fails reads Claude did not answer (model call failed)",
      failed?.reason === "Claude did not answer (model call failed).",
      `${failed?.title}: ${failed?.reason}`,
    );
    const text = await openTab(page, d.projectId, "tasks", "error tasks");
    check(
      "the Tasks tab shows the error, not the model's first remark",
      /model call failed/.test(text) && !/I'll look at what is already/.test(text),
    );
  } finally {
    restart({
      FORERUNNER_BENCH_FAIL: "",
      FORERUNNER_BENCH_FAIL_MODE: "",
      FORERUNNER_BENCH_CRITIC_REJECT: "",
    });
    fs.writeFileSync(
      path.join(R.bench(NAME).steps, `${LABEL}-session-engine-failures.json`),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
