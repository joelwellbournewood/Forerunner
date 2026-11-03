// Credentials journey (U-078, area credential-limits): what a person sees when Anthropic refuses
// the API key, or the key is at its usage limit. Run on a bench started with
// `--provider bench-api --api-key refused` (or `--api-key limited`): the app's own routed
// provider over the vault's key, with the Messages API stand-in answering that key.
//   node scripts/bench/journeys/credentials.cjs <bench> <label> [--save-key ok] [--wait-start <s>]
//     [--brief "<text>"]
// With `--brief`, New project with that brief instead: the planning call meets the key first and
// waits ("Planning waits for a new API key", no Try again); `--save-key ok` then drafts the plan
// by itself, and the walk approves it ("Approve and start") and waits for its tasks to finish.
// Otherwise it makes a project with two small tasks (no planning call),
// starts a session, and records the Tasks tab, the Inbox, the session page with its result,
// Settings (Advanced: Claude: which to use first) and the task rows. `--save-key ok` then saves
// a new key the stand-in serves through the setup assistant's route (as Settings -> Accounts and
// keys does) and waits up to 120 s for the waiting work to start by itself and finish.
// `--wait-start <s>` instead waits up to <s> seconds for a session to start by itself (a limit's
// reset; start the bench with `--env FORERUNNER_BENCH_API_LIMIT_MIN=2`).
// Steps: <bench>/steps/NN-<label>-*.png/.txt; result: <bench>/steps/<label>-credentials.json with
// the checks, the task rows, the cards, the session's result and the stand-in's request log
// (each request's key id and answer: which key each call used).
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const R = require("../recorder.cjs");

const NAME = process.argv[2] || "credentials";
const LABEL = process.argv[3] || "walk";
const flag = (f) => {
  const i = process.argv.indexOf(f);
  return i > 0 ? (process.argv[i + 1] ?? true) : undefined;
};
const SAVE_KEY = flag("--save-key");
const WAIT_START = Number(flag("--wait-start") ?? 0);
const BRIEF = flag("--brief");

const result = { label: LABEL, checks: [], tasks: {}, cards: [], requests: [] };
const out = (s) => console.log(`[credentials ${LABEL}] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const enc = encodeURIComponent;

function apiRequests(b) {
  const file = b.apiRequestLog ?? path.join(b.home, "bench", "api-requests.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function shots(page, b, project, session, tag) {
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}/tasks`);
  await page.waitForTimeout(2500);
  result[`${tag}TasksTab`] = (await R.step(page, `${LABEL} ${tag} tasks tab`)).slice(0, 3000);
  await page.goto(`${b.uiUrl}/inbox`);
  await page.waitForTimeout(2500);
  result[`${tag}Inbox`] = (await R.step(page, `${LABEL} ${tag} inbox`)).slice(0, 3000);
  if (session) {
    await page.goto(`${b.uiUrl}/sessions/${enc(session.id)}`);
    await page.waitForTimeout(2000);
    result[`${tag}SessionPage`] = (await R.step(page, `${LABEL} ${tag} session`)).slice(0, 3000);
  }
  await page.goto(`${b.uiUrl}/projects/${enc(project.id)}`);
  await page.waitForTimeout(2000);
  result[`${tag}Overview`] = (await R.step(page, `${LABEL} ${tag} overview`)).slice(0, 3000);
  await page.goto(`${b.uiUrl}/settings`);
  await page.waitForTimeout(2000);
  const advanced = page.getByTestId("settings-advanced-summary");
  if (await advanced.count()) {
    await advanced.first().click();
    await page.waitForTimeout(800);
  }
  const order = page.getByTestId("billing-order-section");
  if (await order.count()) await order.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  result[`${tag}Settings`] = (await R.step(page, `${LABEL} ${tag} settings`)).slice(0, 4000);
}

/**
 * `--brief "<text>"`: New project with a brief (the dialog's body), so the planning call meets
 * the refused or limited key first. The plan waits ("Planning waits for a new API key"), never
 * "Planning failed [Try again]"; `--save-key ok` then drafts it by itself, and the plan card is
 * approved ("Approve and start") so its task runs and finishes.
 */
async function planningWalk(b) {
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Planning (${LABEL} ${new Date().toISOString().slice(11, 19)})`,
    goal: BRIEF.replace(/\.$/, ""),
    brief: BRIEF,
    intake: true,
  });
  const intakeOf = () => R.api(NAME, "GET", `/projects/${enc(project.id)}/intake`);
  const first = await R.until(
    async () => {
      const s = await intakeOf();
      return s.state === "drafting" ? null : s;
    },
    120_000,
    1000,
    "the planning to end or wait",
  );
  result.intake = first;
  check("planning waits, it did not fail", first.state === "waiting", JSON.stringify(first));
  const card = await R.api(NAME, "GET", `/projects/${enc(project.id)}`);
  result.statusLine = card.statusLine;
  check(
    "the status says what planning waits for, with no Try again",
    /^Planning waits/.test(card.statusLine?.text ?? "") &&
      card.statusLine?.action?.kind !== "retry",
    JSON.stringify(card.statusLine),
  );
  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await shots(page, b, project, null, "first");
    if (WAIT_START > 0 && !SAVE_KEY) {
      // A limit: the plan is drafted by itself at the reset (within a scheduler tick).
      const pending = await R.until(
        async () => {
          const s = await intakeOf();
          return s.state === "pending" ? s : null;
        },
        WAIT_START * 1000,
        5000,
        "the plan to be drafted by itself at the reset",
      ).catch(() => null);
      check("the plan was drafted by itself at the reset", !!pending);
      await shots(page, b, project, null, "after-reset");
    }
    if (SAVE_KEY) {
      const key = `sk-ant-api03-bench-${SAVE_KEY}-${require("node:crypto").randomBytes(24).toString("hex")}`;
      const saved = await R.api(NAME, "POST", "/setup/anthropic", { value: key });
      check("the new key is saved", saved.ok === true, saved.summary);
      const pending = await R.until(
        async () => {
          const s = await intakeOf();
          return s.state === "pending" ? s : null;
        },
        120_000,
        2000,
        "the plan to be drafted by itself after the new key",
      ).catch(() => null);
      check("the plan was drafted by itself and waits for approval", !!pending);
      await shots(page, b, project, null, "after-key");
      if (pending) {
        const inbox = await R.api(NAME, "GET", "/inbox");
        const plan = inbox.requests.find((r) => r.id === pending.requestId);
        await R.api(NAME, "POST", `/requests/${enc(plan.id)}/answer`, {
          version: plan.version,
          answer: "approve",
        });
        const done = await R.until(
          async () => {
            const now = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
            return now.length && now.every((t) => t.status === "done") ? now : null;
          },
          300_000,
          3000,
          "the plan's tasks to finish after Approve and start",
        ).catch(() => null);
        check("the plan's tasks ran and finished", !!done);
        await shots(page, b, project, null, "after-approve");
      }
    }
  } finally {
    await browser.close();
  }
  return project;
}

async function main() {
  const b = R.bench(NAME);
  if (BRIEF) {
    const project = await planningWalk(b);
    const after = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
    for (const t of after) result.tasks[t.title] = { status: t.status, display: t.display };
    result.requests = apiRequests(b).map((r) => ({
      time: r.time,
      path: r.path,
      keyId: r.keyId,
      status: r.status,
      answer: r.answer,
    }));
    const file = path.join(b.steps, `${LABEL}-credentials.json`);
    fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
    out(`result: ${file}`);
    return;
  }
  const me = await R.api(NAME, "GET", "/me");
  const project = await R.api(NAME, "POST", "/projects", {
    name: `Credentials (${LABEL} ${new Date().toISOString().slice(11, 19)})`,
    goal: "Two small notes",
  });
  const create = (title, file) =>
    R.api(NAME, "POST", `/projects/${enc(project.id)}/tasks`, {
      title,
      outcome: `${file} exists with a short note`,
      acceptanceCriteria: [`${file} exists`],
      priority: "medium",
      status: "ready",
      dependsOn: [],
      specialist: "writer",
      riskTier: 0,
    });
  const tasks = [
    await create("Write notes/a.md", "notes/a.md"),
    await create("Write notes/b.md", "notes/b.md"),
  ];
  out(`project ${project.id}: ${tasks.map((t) => `"${t.title}"`).join(", ")}`);
  const started = await R.api(NAME, "POST", "/sessions", {
    agentId: me.agent.id,
    projectId: project.id,
    trigger: "manual",
    reason: "credentials walk",
  });
  const session = await R.waitForSession(NAME, started.session.id, 300_000);
  result.session = { id: session.id, status: session.status, summary: session.summary };
  out(`session ${session.status}: ${session.summary}`);

  const rows = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
  for (const t of rows) result.tasks[t.title] = { status: t.status, display: t.display };
  const inbox = await R.api(NAME, "GET", "/inbox").catch(() => null);
  result.cards = (inbox?.needsYou ?? inbox?.items ?? []).map((c) => ({
    title: c.title,
    body: c.body,
    choices: (c.choices ?? []).map((x) => x.label ?? x),
  }));
  const failed = rows.filter((t) => t.status === "failed");
  check("no task failed", failed.length === 0, failed.map((t) => t.title).join(", "));

  const { browser, page } = await R.openApp(NAME);
  try {
    await R.skipSetup(page).catch(() => undefined);
    await shots(page, b, project, session, "first");

    if (SAVE_KEY) {
      const key = `sk-ant-api03-bench-${SAVE_KEY}-${require("node:crypto").randomBytes(24).toString("hex")}`;
      const saved = await R.api(NAME, "POST", "/setup/anthropic", { value: key });
      check("the new key is saved", saved.ok === true, saved.summary);
      const done = await R.until(
        async () => {
          const now = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
          return now.every((t) => t.status === "done") ? now : null;
        },
        120_000,
        2000,
        "the waiting tasks to finish after the new key",
      ).catch(() => null);
      check("the waiting work started by itself and finished", !!done);
      await shots(page, b, project, null, "after-key");
    }
    if (WAIT_START > 0) {
      const next = await R.until(
        async () => {
          const list = await R.api(NAME, "GET", `/sessions?projectId=${enc(project.id)}`).catch(
            () => [],
          );
          const later = (Array.isArray(list) ? list : (list.sessions ?? [])).filter(
            (s) => s.id !== session.id,
          );
          return later.length ? later : null;
        },
        WAIT_START * 1000,
        5000,
        "a session to start by itself at the reset",
      ).catch(() => null);
      check("a session started by itself at the reset", !!next);
      if (next) {
        const s2 = await R.waitForSession(NAME, next[0].id, 300_000);
        result.secondSession = { status: s2.status, summary: s2.summary };
      }
      await shots(page, b, project, null, "after-reset");
    }
  } finally {
    await browser.close();
  }
  const after = await R.api(NAME, "GET", `/projects/${enc(project.id)}/tasks`);
  for (const t of after) result.tasks[t.title].after = { status: t.status, display: t.display };
  result.requests = apiRequests(b).map((r) => ({
    time: r.time,
    path: r.path,
    keyId: r.keyId,
    status: r.status,
    answer: r.answer,
  }));
  const file = path.join(b.steps, `${LABEL}-credentials.json`);
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  out(`result: ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
