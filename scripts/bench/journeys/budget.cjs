// Budget journey (ADR 0111, area budget-stop): a task whose budget is a few times its run's
// reserve hears the wrap-up and pauses with its report kept, and a tiny budget pauses with the
// save only. Run on a bench started with --provider bench (and, for the long task,
// --env FORERUNNER_BENCH_LONG=guide so the stand-in keeps writing until it hears the wrap-up):
//   node scripts/bench/journeys/budget.cjs <bench> <label> [--long-chf 0.08] [--tiny-chf 0.01]
// Steps are <bench>/steps/NN-<label>-*.png and .txt; the result (checks, the run's budget line,
// the wrap-up requests, the critic calls per task, the next brief's previous-attempt section) is
// <bench>/steps/<label>-budget.json.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const R = require("../recorder.cjs");

const NAME = process.argv[2] || "budget";
const LABEL = process.argv[3] || "walk";
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const LONG_CHF = arg("--long-chf", 0.08);
const TINY_CHF = arg("--tiny-chf", 0.01);
// The bench's rate (compose's default): CHF 0.80 per USD.
const usdMicro = (chf) => Math.round((chf / 0.8) * 1_000_000);
const WRAP_UP = "About a fifth of this task's budget is left";

const result = { label: LABEL, checks: [], tasks: {} };
const out = (s) => console.log(`[budget ${LABEL}] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const enc = encodeURIComponent;

const textOf = (m) =>
  typeof m.content === "string"
    ? m.content
    : (m.content ?? [])
        .map((b) => (b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
        .join("\n");

async function main() {
  const b = R.bench(NAME);
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Budget walk (${LABEL} ${new Date().toISOString().slice(11, 19)})`,
    goal: "Notes and a guide, each within its budget",
  });
  const create = (title, outcome, file, chf) =>
    R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title,
      outcome,
      acceptanceCriteria: [`${file} exists`],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      budgetUsdMicro: usdMicro(chf),
      specialist: "coder",
      riskTier: 1,
    });
  const long = await create("Write the guide", "guide.md explains the club", "guide.md", LONG_CHF);
  const tiny = await create("Write the notes", "notes.md lists the meetings", "notes.md", TINY_CHF);
  out(`project ${project.id}: "${long.title}" CHF ${LONG_CHF}, "${tiny.title}" CHF ${TINY_CHF}`);

  const started = await R.api(NAME, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    reason: "budget walk",
  });
  const session = await R.waitForSession(NAME, started.session.id, 300_000);
  result.session = { status: session.status, summary: session.summary };
  out(`session ${session.status}: ${session.summary}`);

  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} tasks tab`);
    for (const t of [long, tiny]) {
      await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
      await page.waitForTimeout(1500);
      const row = page.getByText(t.title).first();
      if (await row.count()) {
        await row.click();
        await page.waitForTimeout(1500);
        await R.step(page, `${LABEL} drawer ${t.title}`);
        await page.keyboard.press("Escape").catch(() => undefined);
      }
    }
    await page.goto(`${b.uiUrl}/inbox`);
    await page.waitForTimeout(2500);
    await R.step(page, `${LABEL} inbox`);
    await page.goto(`${b.uiUrl}/sessions/${enc(session.id)}`);
    await page.waitForTimeout(2000);
    const sessionText = await R.step(page, `${LABEL} session`);
    result.sessionPage = sessionText.slice(0, 3000);
    // Details: the runs' budget lines (the reserve, or "save only") and the wrap-up.
    const details = page.getByLabel("Details");
    if (await details.count()) {
      await details.first().check();
      await page.waitForTimeout(1000);
      await R.step(page, `${LABEL} session details`);
    }
  } finally {
    await browser.close();
  }

  const calls = R.modelCalls(NAME);
  const tasks = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
  for (const t of [long, tiny]) {
    const view = tasks.find((x) => x.id === t.id);
    const detail = await R.api(NAME, "GET", `/tasks/${enc(t.id)}`);
    // A specialist's label names the task's title, the critic's its id.
    const mine = calls.filter(
      (c) =>
        c.sessionId === session.id &&
        ((c.label ?? "").includes(t.title) || (c.label ?? "").includes(t.id)),
    );
    const specialist = mine.filter((c) => c.role === "specialist");
    const critic = mine.filter((c) => c.role === "critic");
    const wrapUps = specialist.filter((c) =>
      (c.messages ?? []).some((m) => m.role === "user" && textOf(m).includes(WRAP_UP)),
    );
    const firstWrap = specialist.findIndex((c) =>
      (c.messages ?? []).some((m) => m.role === "user" && textOf(m).includes(WRAP_UP)),
    );
    const wrapMessage =
      firstWrap >= 0
        ? (specialist[firstWrap].messages ?? []).filter(
            (m) => m.role === "user" && textOf(m).includes(WRAP_UP),
          )
        : [];
    result.tasks[t.title] = {
      status: view?.status,
      display: view?.display,
      reason: view?.reason,
      specialistCalls: specialist.length,
      criticCalls: critic.length,
      wrapUpRequests: wrapUps.length,
      // How many wrap-up blocks the request that first carried one held (exactly one).
      wrapUpBlocks: wrapMessage.reduce(
        (n, m) =>
          n +
          (Array.isArray(m.content)
            ? m.content.filter((blk) => blk.type === "text" && blk.text.includes(WRAP_UP)).length
            : 0),
        0,
      ),
      runs: (detail.runs ?? []).map((r) => ({
        kind: r.kind,
        outcome: r.outcome,
        report: (r.report ?? "").slice(0, 600),
      })),
      lastReply: specialist.at(-1)?.reply?.text?.slice(0, 800) ?? null,
      // The request that first carried the wrap-up: its last message's blocks, in order.
      wrapUpRequest:
        firstWrap >= 0
          ? (specialist[firstWrap].messages ?? [])
              .slice(-1)
              .map((m) =>
                Array.isArray(m.content)
                  ? m.content.map((blk) =>
                      blk.type === "text"
                        ? { type: "text", text: blk.text }
                        : { type: blk.type, chars: String(blk.content ?? "").length },
                    )
                  : [{ type: "text", text: String(m.content).slice(0, 200) }],
              )[0]
          : null,
    };
  }
  const events = await R.api(NAME, "GET", `/sessions/${enc(session.id)}/events`).catch(() => null);
  const lines = (events?.events ?? events ?? [])
    .map((e) => e.text ?? "")
    .filter((s) => /wrap|reserve|budget|paus/i.test(s));
  result.budgetLines = lines;
  out(`budget lines:\n  ${lines.join("\n  ")}`);

  const L = result.tasks[long.title];
  const T = result.tasks[tiny.title];
  check(
    "the long task heard the wrap-up once",
    L.wrapUpRequests >= 1 && L.wrapUpBlocks === 1,
    JSON.stringify({ requests: L.wrapUpRequests, blocks: L.wrapUpBlocks }),
  );
  check(
    "the long task is paused, not reviewed",
    L.criticCalls === 0 && /paus/i.test(JSON.stringify(L.display)),
    JSON.stringify({ critic: L.criticCalls, display: L.display?.label }),
  );
  check(
    "the long task's report is kept",
    L.runs.some((r) => /Left to do/i.test(r.report)),
    JSON.stringify(L.runs),
  );
  check("the tiny task heard no wrap-up", T.wrapUpRequests === 0, String(T.wrapUpRequests));
  check(
    "the tiny task is paused, not reviewed",
    T.criticCalls === 0 && /paus/i.test(JSON.stringify(T.display)),
    JSON.stringify({ critic: T.criticCalls, display: T.display?.label }),
  );
  check(
    "the run's log line names the reserve",
    lines.some((l) => /reserve|wrap/i.test(l)),
    lines.join(" | "),
  );

  const file = path.join(
    R.bench(NAME).steps ?? path.join(path.dirname(b.home), "steps"),
    `${LABEL}-budget.json`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  out(`result: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
