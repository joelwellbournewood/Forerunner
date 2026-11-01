// Smoke journey: a person gets a brief planned and worked on, through the UI.
// The plan card's Approve and start writes the tasks and starts a session at once (design §3.3,
// §3.8); the journey watches that session, then presses Start only while tasks are left.
//   node scripts/bench/start.mjs --name smoke --daemon-port 47310 --ui-port 47311 --fresh
//   node scripts/bench/journeys/smoke.cjs smoke [--live]
//   node scripts/bench/stop.mjs --name smoke
// With a real model (`start.mjs --provider bench-live`, or --live) the same checks run: they
// look at structure and states (a plan card with its tasks, a session that ends, files written,
// a chat reply that names a task), never at the stand-in's titles, file names or texts. When
// the project says planning failed, the journey asks the chat about it, then presses Try again
// up to twice, and records each failure as a finding with what the project page said.
// Every screen is a step (<bench>/steps/NN-*.png and .txt). The result, with every check, every
// product finding and what the model calls cost, is <bench>/steps/smoke-result.json. A product
// problem is recorded and the journey goes on (through the daemon API where the UI cannot), so
// later steps still run; the exit code is 0 when the bench itself worked, whatever the product did.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {
  openApp,
  step,
  api,
  bench,
  modelCalls,
  callSummary,
  formatCallSummary,
  daemonLog,
  problems,
  until,
} = require("../recorder.cjs");
const {
  planCardTasks,
  titlesMissing,
  replyNamesTask,
  allDone,
  agentsDone,
  workFiles,
  pageLinks,
} = require("./smoke-checks.cjs");

const NAME = process.argv.slice(2).find((a) => !a.startsWith("--")) || "smoke";
const b = bench(NAME);
const LIVE = process.argv.includes("--live") || b.live === true || b.provider === "bench-live";
const BRIEF =
  "A one-page website that shows a random quote each time it is opened; plain HTML, CSS and JavaScript; no build step";
const PROJECT = "Quote page";
const GOAL = "A page that shows a random quote each time it is opened";
const ENDED = new Set(["completed", "stopped", "failed", "killed"]);
// A real model takes longer than the stand-in: a plan about 40 s, a session minutes.
const WAIT = LIVE
  ? { plan: 300_000, session: 900_000, chat: 120_000 }
  : { plan: 90_000, session: 300_000, chat: 60_000 };
/** Try again presses after a failed plan, at most. */
const PLAN_RETRIES = 2;

const result = {
  bench: NAME,
  live: LIVE,
  startedAt: new Date().toISOString(),
  checks: [],
  findings: [],
  sessions: [],
  planTries: [],
  notes: [],
};
const out = (s) => console.log(`[smoke] ${s}`);
const check = (name, ok, detail = "") => {
  result.checks.push({ name, ok: !!ok, detail });
  out(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  return !!ok;
};
const finding = (title, detail, evidence = []) => {
  result.findings.push({ title, detail, evidence });
  out(`FINDING ${title}: ${detail}`);
};
const note = (s) => {
  result.notes.push(s);
  out(`note: ${s}`);
};
const lastStep = () => {
  const idx = path.join(b.steps, "index.jsonl");
  const lines = fs.existsSync(idx) ? fs.readFileSync(idx, "utf8").trim().split("\n") : [];
  return lines.length ? JSON.parse(lines.at(-1)).png : null;
};
const oneLine = (s, max = 300) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const clickButton = async (page, name, scope) => {
  await (scope ?? page).getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(800);
};

async function setup(page) {
  let text = await step(page, "first screen");
  check("the setup assistant opens first", /Set up Forerunner/.test(text));
  if (!/Set up Forerunner/.test(text)) return;
  await page.getByLabel("Your name").fill("Robin");
  await clickButton(page, "Continue");
  text = await step(page, "setup claude step");
  if (LIVE) {
    // start.mjs stored the key in the home's vault, as an install has it.
    check("the Claude step says the key is saved", /An API key is saved/.test(text));
    await page.getByTestId("setup-next").click();
    await page.waitForTimeout(800);
  } else {
    check("the Claude step offers a way past it without a key", /Skip for now/.test(text));
    await clickButton(page, "Skip for now");
  }
  text = await step(page, "setup github step");
  await clickButton(page, "Skip for now");
  text = await step(page, "setup done step");
  if (LIVE)
    check(
      "the Done step says Claude is connected and nothing that is untrue",
      /✓ Claude is connected/.test(text) && !/cannot start work/.test(text),
      oneLine(/✓ Claude[\s\S]*?(?=Spending)/.exec(text)?.[0] ?? text, 240),
    );
  else if (/cannot start work/.test(text))
    note(
      `the Done step says "Until Claude is connected your agent cannot start work" (true here: --provider bench serves a stand-in model and no key is saved)`,
    );
  await clickButton(page, "Start using Forerunner");
  text = await step(page, "home empty");
  check(
    "Home shows an empty project list with New project",
    /New project/.test(text) && /No projects yet/.test(text),
  );
}

/** What the project page says about the plan now: the banner's state and words, else the daemon's. */
async function planShown(page, projectId) {
  const banner = page.getByTestId("intake-banner").first();
  if (await banner.count()) {
    const state = await banner.getAttribute("data-state");
    const said = oneLine(await banner.innerText());
    if (state === "pending" || state === "failed") return { state, said };
  }
  const s = await api(NAME, "GET", `/projects/${encodeURIComponent(projectId)}/intake`);
  if (s.state === "pending" || s.state === "failed") {
    // The page has not followed yet: read it again as a person would.
    await page.reload();
    await page.waitForTimeout(1000);
    const again = page.getByTestId("intake-banner").first();
    const said = (await again.count())
      ? oneLine(await again.innerText())
      : `(no plan banner on the page; the daemon says ${s.state}${s.error ? `: ${s.error}` : ""})`;
    return { state: s.state, said };
  }
  return null;
}

async function waitForPlan(page, projectId, label) {
  const shown = await until(
    () => planShown(page, projectId),
    WAIT.plan,
    1500,
    "the intake to file its plan",
  ).catch((e) => ({ state: "timeout", said: e.message }));
  await step(page, label);
  return shown;
}

async function createProject(page) {
  await clickButton(page, "New project");
  await page.getByLabel("Name").fill(PROJECT);
  await page.getByLabel("Goal").fill(GOAL);
  await page.getByLabel("Brief").fill(BRIEF);
  await step(page, "new project dialog filled");
  await clickButton(page, "Create project");
  await page.waitForURL(/\/projects\/[^/]+/, { timeout: 15_000 });
  const projectId = decodeURIComponent(/\/projects\/([^/?#]+)/.exec(page.url())[1]);
  result.projectId = projectId;
  await step(page, "project created");
  // The intake runs in the background; the project page says when the plan waits in the Inbox,
  // or that planning failed, with Try again.
  let shown = await waitForPlan(page, projectId, "project plan waiting");
  result.planTries.push(shown);
  for (let retry = 1; shown.state === "failed" && retry <= PLAN_RETRIES; retry++) {
    finding(
      `planning failed (try ${retry} of ${PLAN_RETRIES + 1})`,
      `the project page said: "${shown.said}"`,
      [lastStep()],
    );
    // What the chat says while planning has failed (the live run: "no tasks yet… I can add
    // tasks…"). Once, before the first Try again.
    if (retry === 1) await chatWhilePlanningFailed(page, projectId);
    await openProject(page, projectId, "summary");
    const tryAgain = page.getByTestId("intake-retry").first();
    if (!(await tryAgain.count())) {
      finding("planning failed without a Try again button", `the page said: "${shown.said}"`, [
        lastStep(),
      ]);
      break;
    }
    await tryAgain.click();
    await page.waitForTimeout(1500);
    await step(page, `plan try ${retry + 1}`);
    shown = await waitForPlan(page, projectId, `project plan waiting (try ${retry + 1})`);
    result.planTries.push(shown);
  }
  if (shown.state === "failed")
    finding(
      `planning failed on every try (${result.planTries.length})`,
      `the project page said last: "${shown.said}"`,
      [lastStep()],
    );
  else if (result.planTries.length > 1)
    note(
      `the plan reached the Inbox on try ${result.planTries.length} of ${PLAN_RETRIES + 1} (Try again pressed ${result.planTries.length - 1} time(s))`,
    );
  result.projectPageSaid = shown.said;
  check("the plan from the brief reaches the Inbox", shown.state === "pending", shown.said);
  return projectId;
}

async function approve(page, projectId) {
  await page.getByRole("link", { name: "Inbox", exact: false }).first().click();
  await page.waitForTimeout(1500);
  let text = await step(page, "inbox with the plan");
  const card = page.getByTestId("request").filter({ hasText: `Plan for "${PROJECT}"` });
  if (!check("the Inbox shows the plan card", (await card.count()) === 1)) {
    finding(
      "plan card missing from the Inbox",
      `the project page said: "${result.projectPageSaid ?? "(nothing about the plan)"}"; the Inbox reads: "${oneLine(text, 400)}"`,
      [lastStep()],
    );
    return null;
  }
  const cardText = await card.first().innerText();
  const planned = planCardTasks(cardText, PROJECT);
  check(
    "the plan card says how many tasks it plans (at least one)",
    typeof planned === "number" && planned >= 1,
    planned === null ? oneLine(cardText, 200) : `${planned} task(s)`,
  );
  check(
    "the plan card has no change-card JSON or risk badges",
    !/Change card/.test(text) && !/high risk · approval/.test(text),
  );
  const approveButton = card.getByRole("button", { name: "Approve and start", exact: true });
  if (!check("the plan card offers Approve and start", (await approveButton.count()) === 1))
    return null;
  const sessionsBefore = new Set((await projectSessions(projectId)).map((x) => x.id));
  await approveButton.click();
  await page.waitForTimeout(2500);
  text = await step(page, "inbox after approve");
  const done = /Done: Plan approved: (\d+) tasks? written; working on them\./.exec(text);
  if (!check("approving says what happened", !!done, done ? done[0] : ""))
    finding(
      "approving the plan gives no confirmation",
      `after "Approve and start" the Inbox reads "${(/Nothing waits on you\./.exec(text) || ["(other text)"])[0]}"; nothing says the plan was written or that work started`,
      [lastStep()],
    );
  const tasks = await until(
    async () => {
      const list = await taskStates(projectId);
      return list.length ? list : null;
    },
    30_000,
    1000,
    "the approved plan's tasks",
  ).catch(() => []);
  check(
    "approving writes the plan's tasks, as many as the card said",
    tasks.length >= 1 && (planned === null || tasks.length === planned),
    `${tasks.length} task(s) written; the card said ${planned ?? "?"}`,
  );
  const missing = titlesMissing(
    cardText,
    tasks.map((t) => t.title),
  );
  check(
    "the plan card named every task it wrote",
    tasks.length >= 1 && missing.length === 0,
    missing.length ? `not on the card: ${missing.map((t) => `"${t}"`).join(", ")}` : "",
  );
  // Approve and start starts a session of the project without a Start click (design §3.3).
  const started = await until(
    async () =>
      (await projectSessions(projectId)).find((x) => !sessionsBefore.has(x.id))?.id ?? null,
    30_000,
    1000,
    "the session Approve and start started",
  ).catch(() => null);
  check("Approve and start starts a session", !!started, started ?? "no session in 30 s");
  return started;
}

async function openProject(page, projectId, tab) {
  await page.goto(`${b.uiUrl}/projects/${encodeURIComponent(projectId)}/${tab}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
}

async function projectViaHome(page, projectId) {
  // As a person gets there: Home, the project's card.
  await page.getByRole("link", { name: "Home", exact: true }).first().click();
  await page.waitForTimeout(1000);
  await step(page, "home with the project");
  const link = page.getByRole("link", { name: PROJECT, exact: true });
  if ((await link.count()) > 0) await link.first().click();
  else await openProject(page, projectId, "summary");
  await page.waitForTimeout(1200);
}

async function taskStates(projectId) {
  const t = await api(NAME, "GET", `/projects/${encodeURIComponent(projectId)}/tasks`);
  const list = Array.isArray(t) ? t : (t.tasks ?? []);
  return list.map((x) => ({
    id: x.id,
    title: x.title,
    status: x.status,
    specialist: x.specialist ?? null,
    dependsOn: x.dependsOn ?? [],
    display: x.display ? { key: x.display.key, label: x.display.label } : null,
    prUrl: x.prUrl ?? x.pr_url ?? null,
  }));
}

async function runningSessions() {
  const s = await api(NAME, "GET", "/sessions");
  const list = Array.isArray(s) ? s : (s.sessions ?? []);
  return list.filter((x) => !ENDED.has(x.status));
}

async function projectSessions(projectId) {
  const s = await api(NAME, "GET", `/sessions?projectId=${encodeURIComponent(projectId)}`);
  const list = Array.isArray(s) ? s : (s.sessions ?? []);
  return list.filter((x) => x.projectId === projectId);
}

/** Open the Start dialog and press Start; returns the session id, or null with the dialog's text. */
async function pressStart(page, projectId, n, attempt) {
  await openProject(page, projectId, "summary");
  await clickButton(page, "Start session");
  const dialogText = await step(
    page,
    `session ${n} start dialog${attempt > 1 ? ` (try ${attempt})` : ""}`,
  );
  const dialog = page.getByRole("dialog");
  const scope = (await dialog.count()) ? dialog : page;
  await clickButton(page, "Start", scope);
  try {
    // After Start the person stays on the page; the dialog says it started with "Open the
    // session" (design §3.6), which a person clicks to watch it.
    const open = page.getByTestId("start-session-open");
    await open.waitFor({ state: "visible", timeout: 30_000 });
    await step(page, `session ${n} started in the dialog`);
    await open.click();
    await page.waitForURL(/\/sessions\/[^/]+/, { timeout: 30_000 });
    return {
      dialogText,
      sessionId: decodeURIComponent(/\/sessions\/([^/?#]+)/.exec(page.url())[1]),
    };
  } catch {
    const text = await step(
      page,
      `session ${n} did not open${attempt > 1 ? ` (try ${attempt})` : ""}`,
    );
    return { dialogText, sessionId: null, refusal: text, refusalStep: lastStep() };
  }
}

async function runSession(page, projectId, n) {
  const before = await taskStates(projectId);
  let started = await pressStart(page, projectId, n, 1);
  // Something else holds the agent (on the 1st of a month: the critic calibration). A person
  // would try again; the journey waits until no session runs, then presses Start once more.
  if (
    !started.sessionId &&
    /already has an active session|is already working in another session/.test(started.refusal)
  ) {
    const heldBy = /already has an active session (\S+)/.exec(started.refusal)?.[1];
    const holder = heldBy
      ? await api(NAME, "GET", `/sessions/${encodeURIComponent(heldBy)}`).catch(() => null)
      : null;
    const holders = holder ? [holder] : await runningSessions();
    finding(
      `session ${n}: "Start" refused because the agent is busy with a session the person did not start`,
      `the dialog says "${(/agent .* already has an active session \S+/.exec(started.refusal) || [""])[0]}" (an id, no explanation, no hint to wait); the holder: ${holders.map((h) => `${h.trigger} session, ${h.status}: ${(h.summary || h.reason || "").slice(0, 100)}`).join("; ") || "(not found)"}`,
      [started.refusalStep],
    );
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    if (await cancel.count()) await cancel.first().click();
    await until(
      async () => (await runningSessions()).length === 0,
      600_000,
      2000,
      "the other session to end",
    ).catch(() => undefined);
    started = await pressStart(page, projectId, n, 2);
  }
  const dialogText = started.dialogText;
  const notIn = /Not in this session:([\s\S]*?)(Cancel|$)/.exec(dialogText);
  const willRun = /(In|Runs in) this session:([\s\S]*?)(Not in this session|Cancel|$)/.exec(
    dialogText,
  );
  const sessionId = started.sessionId;
  if (!sessionId) {
    finding(`session ${n}: Start did not open a session`, (started.refusal || "").slice(-400), [
      started.refusalStep,
    ]);
    return { n, sessionId: null, status: "not started", changed: [] };
  }
  return watchSession(page, n, sessionId, before, {
    trigger: "Start",
    notInThisSession: notIn ? notIn[1].trim().split("\n").filter(Boolean) : [],
    shownAsRunning: willRun ? willRun[2].trim() : null,
  });
}

/** Watch a session to its end on its page; returns what it changed. */
async function watchSession(page, n, sessionId, before, extra) {
  const projectId = result.projectId;
  if (extra.trigger !== "Start") {
    await page.goto(`${b.uiUrl}/sessions/${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(800);
  }
  await step(page, `session ${n} started`, { waitMs: 1500 });
  const status = await until(
    async () => {
      const s = await api(NAME, "GET", `/sessions/${encodeURIComponent(sessionId)}`);
      return ENDED.has(s.status) ? s.status : null;
    },
    WAIT.session,
    2000,
    `session ${n} to end`,
  ).catch((e) => `timeout: ${e.message}`);
  await page.waitForTimeout(1500);
  const endedText = await step(page, `session ${n} ended`);
  const shown = await page
    .getByTestId("session-status")
    .first()
    .innerText()
    .catch(() => "(no status badge)");
  const after = await taskStates(projectId);
  const changed = after.filter((t) => before.find((x) => x.id === t.id)?.status !== t.status);
  const rec = {
    n,
    sessionId,
    status,
    statusShown: shown,
    ...extra,
    changed: changed.map(
      (t) => `${t.title}: ${before.find((x) => x.id === t.id)?.status ?? "new"} -> ${t.status}`,
    ),
    endedPageChars: endedText.length,
  };
  result.sessions.push(rec);
  check(`session ${n} ends`, ENDED.has(status), `${status}; the page shows "${shown}"`);
  return rec;
}

async function tasksTab(page, projectId, label) {
  await openProject(page, projectId, "tasks");
  const text = await step(page, label);
  const buttons = (await page.getByRole("button").allInnerTexts())
    .map((s) => s.trim())
    .filter(Boolean);
  return { text, buttons };
}

function filesUnder(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const outFiles = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) outFiles.push(...filesUnder(p, base));
    else outFiles.push(path.relative(base, p).split(path.sep).join("/"));
  }
  return outFiles;
}

/**
 * Say a line in the project's Chat tab as a person does; the reply as shown once it is whole
 * (its bubble no longer streaming), or null when none came.
 */
async function askChat(page, projectId, line, label) {
  await openProject(page, projectId, "chat");
  const replies = page.getByTestId("chat-agent");
  const before = await replies.count();
  const box = page.getByTestId("chat-input");
  await box.fill(line);
  await box.press("Enter");
  const reply = await until(
    async () => {
      if ((await replies.count()) <= before) return null;
      const last = replies.last();
      if ((await last.getAttribute("data-streaming")) === "true") return null;
      const text = (await last.innerText()).trim();
      return text && !/^Thinking…$/.test(text) ? text : null;
    },
    WAIT.chat,
    1000,
    "a chat reply",
  ).catch(() => null);
  await step(page, label);
  return reply;
}

async function chatWhilePlanningFailed(page, projectId) {
  const reply = await askChat(
    page,
    projectId,
    "What is the state of my project?",
    "chat while planning failed",
  );
  result.chatWhilePlanningFailed = reply;
  check(
    "while planning failed, the chat says so and points to Try again",
    !!reply && /fail/i.test(reply) && /try again/i.test(reply),
    oneLine(reply ?? "no reply", 300),
  );
}

async function chat(page, projectId, titles) {
  const reply = await askChat(
    page,
    projectId,
    "What is the state of my project and what is left to do?",
    "chat reply",
  );
  check("the project Chat answers", !!reply, oneLine(reply ?? `no reply in ${WAIT.chat / 1000} s`));
  if (titles.length) {
    const named = reply ? replyNamesTask(reply, titles) : null;
    check("the chat reply names a task", !!named, named ? `"${named}"` : oneLine(reply ?? "", 200));
  }
  check(
    "the chat reply shows no markdown asterisks",
    !!reply && !/\*\*/.test(reply),
    oneLine(reply ?? "", 120),
  );
  const turn = modelCalls(NAME, "chat").at(-1);
  if (turn)
    result.chatContext = {
      model: turn.model,
      effort: turn.effort,
      thinking: turn.thinking,
      maxTokens: turn.max_tokens,
      messages: turn.messages.length,
      tools: turn.tools,
      systemChars: turn.system.length,
      userMessage:
        typeof turn.messages.at(-1)?.content === "string"
          ? turn.messages.at(-1).content
          : "(blocks)",
      reply: turn.reply.text,
      usd: turn.usd ?? null,
    };
}

async function files(projectId) {
  // The files the work wrote, in the project's folder (a project without a repository, U-037).
  const workspace = path.join(b.projectsRoot, projectId, "workspace");
  const all = filesUnder(workspace);
  const written = workFiles(all);
  result.workspace = workspace;
  result.workspaceFiles = written;
  check("the project's folder exists", fs.existsSync(workspace), workspace);
  check(
    "the work wrote files to the project's folder",
    written.length > 0,
    written.slice(0, 12).join(", "),
  );
  // The brief asks for one page in plain HTML, CSS and JavaScript: whatever the files are called.
  const html = written.filter((f) => f.endsWith(".html"));
  check(
    "the brief's page is there: an .html page, a stylesheet and a script",
    html.length > 0 &&
      written.some((f) => f.endsWith(".css")) &&
      written.some((f) => f.endsWith(".js")),
    `${html.length} .html, ${written.filter((f) => f.endsWith(".css")).length} .css, ${written.filter((f) => f.endsWith(".js")).length} .js`,
  );
  const page = html.find((f) => /(^|\/)index\.html$/.test(f)) ?? html[0];
  const links = page
    ? pageLinks(fs.readFileSync(path.join(workspace, page), "utf8"), written)
    : { css: [], js: [] };
  check(
    "the page links a stylesheet and a script that were written",
    links.css.length > 0 && links.js.length > 0,
    page ? `${page} links ${[...links.css, ...links.js].join(", ") || "nothing written"}` : "",
  );
  note(`the project's folder is ${workspace} (a project without a repository works there, U-037)`);
}

(async () => {
  out(
    `bench ${NAME}${LIVE ? " (live: the real model)" : ""}: UI ${b.uiUrl}, daemon ${b.daemonUrl}, home ${b.home}`,
  );
  const existing = await api(NAME, "GET", "/projects");
  const n = Array.isArray(existing) ? existing.length : (existing.projects ?? []).length;
  if (n > 0)
    note(
      `the home is not fresh (${n} project(s)); start the bench with --fresh for a first-run journey`,
    );
  const { browser, page } = await openApp(NAME, { freshProfile: true });
  try {
    await setup(page);
    const projectId = await createProject(page);
    const tasksBefore = await taskStates(projectId);
    const approvedSession = await approve(page, projectId);
    await projectViaHome(page, projectId);
    await step(page, "project summary after approval");
    const planned = await tasksTab(page, projectId, "tasks after approval");
    result.tasksAfterApproval = await taskStates(projectId);
    result.taskButtonsAfterApproval = [...new Set(planned.buttons)];

    // The session Approve and start started, then sessions until nothing is left to run (at
    // most six in all), as a person would press Start while work is left.
    let first = 1;
    if (approvedSession) {
      const rec = await watchSession(page, 1, approvedSession, tasksBefore, {
        trigger: "Approve and start",
      });
      await tasksTab(page, projectId, "tasks after session 1");
      await openProject(page, projectId, "summary");
      const summary = await step(page, "summary after session 1");
      const last = /Last session\n([\s\S]*?)\n(Next steps|Next session)/.exec(summary);
      result.lastSessionText = last ? last[1].trim() : null;
      if (rec.changed.length === 0)
        finding(
          "the session Approve and start started changed no task",
          `the session ended ${rec.status} and no task changed state`,
          [lastStep()],
        );
      first = 2;
    }
    for (let i = first; i <= 6; i++) {
      const states = await taskStates(projectId);
      if (!states.some((t) => ["ready", "in_progress", "draft"].includes(t.status))) break;
      // A ready task that waits on the person (or on a task that does) is not one Start runs.
      if (agentsDone(states).ok) break;
      const rec = await runSession(page, projectId, i);
      if (i === 1) {
        await tasksTab(page, projectId, "tasks after session 1");
        await openProject(page, projectId, "summary");
        const summary = await step(page, "summary after session 1");
        const last = /Last session\n([\s\S]*?)\n(Next steps|Next session)/.exec(summary);
        result.lastSessionText = last ? last[1].trim() : null;
      }
      if (rec.changed.length === 0) {
        finding(
          `session ${i} changed no task`,
          `the session ended ${rec.status} and no task changed state`,
          [lastStep()],
        );
        break;
      }
    }
    const final = await taskStates(projectId);
    result.tasksFinal = final;
    const sessionsUsed = result.sessions.length;
    const all = allDone(final);
    check(
      "every planned task is done",
      all.ok,
      `${all.detail} after ${sessionsUsed} session(s)${
        all.ok
          ? ""
          : `: ${final
              .filter((t) => t.status !== "done")
              .map((t) => `"${t.title}": ${t.display?.label ?? t.status}`)
              .join("; ")}`
      }`,
    );
    const agents = agentsDone(final);
    check("every task the agents can do is done (the rest wait on you)", agents.ok, agents.detail);
    const startClicks = result.sessions.filter((x) => x.trigger === "Start").length;
    if (startClicks > 0)
      finding(
        `${final.length} planned tasks needed ${sessionsUsed} sessions, ${startClicks} of them by a "Start session" click`,
        `each session ran only the tasks whose dependencies were done when it started (${result.sessions.map((s) => `session ${s.n}: ${s.changed.length} task(s) changed`).join("; ")}); a task unblocked during a session waited for the next manual start`,
        result.sessions.map((s) => s.sessionId),
      );
    const tf = await tasksTab(page, projectId, "tasks final");
    result.taskButtonsFinal = [...new Set(tf.buttons)];
    await openProject(page, projectId, "summary");
    const summary = await step(page, "summary final");
    const last = /Last session\n([\s\S]*?)\n(Next steps|Next session)/.exec(summary);
    result.lastSessionTextFinal = last ? last[1].trim() : null;

    await files(projectId);
    await chat(
      page,
      projectId,
      final.map((t) => t.title),
    );
  } catch (e) {
    await step(page, "journey error").catch(() => undefined);
    finding("journey stopped on an unexpected error", String(e?.stack ?? e).slice(0, 2000), [
      lastStep(),
    ]);
  } finally {
    await browser.close();
  }

  const calls = modelCalls(NAME);
  result.modelCalls = {};
  for (const c of calls) result.modelCalls[c.role] = (result.modelCalls[c.role] ?? 0) + 1;
  // What the calls cost, from the usd the daemon wrote on each log line (calls.mjs prints the same).
  result.cost = callSummary(calls);
  result.problems = problems(NAME);
  result.daemonErrors = daemonLog(NAME, 4000)
    .split("\n")
    .filter((l) => / ERROR /.test(l))
    .slice(-30);
  result.finishedAt = new Date().toISOString();
  const file = path.join(b.steps, "smoke-result.json");
  fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  const failed = result.checks.filter((c) => !c.ok);
  out(
    `${result.checks.length - failed.length}/${result.checks.length} checks passed, ${result.findings.length} finding(s), ${result.problems.length} recorded problem(s); model calls ${JSON.stringify(result.modelCalls)}`,
  );
  out(formatCallSummary(result.cost, { title: "what the model calls cost" }));
  out(`result: ${file}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
