// l4-cred-screens bench walk (before and after): node walk.cjs <label> <repo>
// Bench: --provider bench-api --api-key ok --subscription (no real key, no money).
const path = require("node:path");
const fs = require("node:fs");
const label = process.argv[2] || "before";
const repo = process.argv[3];
const R = require(path.join(repo, "scripts/bench/recorder.cjs"));
const { DatabaseSync } = require("node:sqlite");
const N = "fix-l4-cred-screens";
const bench = JSON.parse(fs.readFileSync(`/tmp/frbench/${N}/bench.json`, "utf8"));
const db = new DatabaseSync(path.join(bench.home, "data", "state.sqlite"));
db.exec("PRAGMA busy_timeout = 5000");
const out = { label, checks: {} };
const save = () =>
  fs.writeFileSync(`/tmp/frbench/${N}/steps/${label}-walk.json`, JSON.stringify(out, null, 1));

const sources = () => db.prepare("select id, kind, limits from billing_source").all();
const src = (kind) => sources().find((s) => s.kind === kind);
function setLimits(kind, fn) {
  const s = src(kind);
  const limits = fn(JSON.parse(s.limits || "{}"));
  db.prepare("update billing_source set limits = ? where id = ?").run(JSON.stringify(limits), s.id);
}
function setHuman(fn) {
  const h = db.prepare("select id, notify_prefs from human").get();
  const prefs = fn(JSON.parse(h.notify_prefs || "{}"));
  db.prepare("update human set notify_prefs = ?, timezone = 'Europe/Zurich' where id = ?").run(
    JSON.stringify(prefs),
    h.id,
  );
}
const iso = (ms) => new Date(ms).toISOString();

async function project(name, titles, deps = {}) {
  const p = await R.api(N, "POST", "/projects", { name, goal: `${name} goal` });
  const ids = {};
  for (const t of titles) {
    const r = await R.api(N, "POST", `/projects/${p.id}/tasks`, {
      title: t,
      outcome: `${t} is written`,
      acceptanceCriteria: ["the file exists"],
      priority: "medium",
      dependsOn: (deps[t] || []).map((d) => ids[d]),
    });
    ids[t] = r.task?.id ?? r.taskId ?? r.id;
  }
  return { id: p.id, ids };
}

async function openStartDialog(page, projectId, what) {
  await page.goto(`${bench.uiUrl}/projects/${projectId}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const start = page.getByRole("button", { name: /^(Start|Start session|Continue)$/ }).first();
  if (await start.count()) await start.click().catch(() => undefined);
  await page.waitForTimeout(1500);
  return R.step(page, what);
}

(async () => {
  const { browser, page } = await R.openApp(N);
  await R.skipSetup(page);
  const reset = Date.now() + 2 * 3600_000;
  // A: subscription first, then ask; the subscription at its limit (LC-C24's figures).
  setHuman((p) => ({ ...p, credential_policy: "subscription_then_ask" }));
  setLimits("subscription", (l) => ({ ...l, restingUntil: iso(reset) }));
  const a = await project("Quote page", ["Write the intro in intro.md", "Write the outro in outro.md"], {
    "Write the outro in outro.md": ["Write the intro in intro.md"],
  });
  out.projectA = a;
  const check0 = await R.api(N, "GET", `/projects/${a.id}/start-check`);
  out.checks.startCheckBefore = { credential: check0.credential, runnable: check0.runnable, later: check0.later };
  await openStartDialog(page, a.id, `${label}-a-start-dialog-ask`);
  await page.keyboard.press("Escape").catch(() => undefined);
  const started = await R.startSession(N, a.id);
  out.checks.started = started;
  await R.until(
    async () => {
      const inbox = await R.api(N, "GET", "/inbox");
      return inbox.requests.find((r) => (r.title || "").startsWith("Use your API key")) || null;
    },
    60_000,
    1000,
    "the ask card",
  ).catch((e) => (out.checks.askCardError = String(e)));
  const inbox = await R.api(N, "GET", "/inbox");
  const card = inbox.requests.find((r) => (r.title || "").startsWith("Use your API key"));
  out.checks.askCard = card ? { title: card.title, body: card.body, choices: card.choices } : null;
  const check1 = await R.api(N, "GET", `/projects/${a.id}/start-check`);
  out.checks.startCheckAtCard = { credential: check1.credential, blocked: check1.blocked };
  await page.goto(`${bench.uiUrl}/inbox`, { waitUntil: "domcontentloaded" });
  await R.step(page, `${label}-a-inbox-ask-card`, { waitMs: 1500 });
  await openStartDialog(page, a.id, `${label}-a-start-dialog-at-card`);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.goto(`${bench.uiUrl}/settings`, { waitUntil: "domcontentloaded" });
  await R.step(page, `${label}-a-settings-under-ask`, { waitMs: 1500 });
  // The person presses Use API key on the card.
  if (card) {
    await page.goto(`${bench.uiUrl}/inbox`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const use = page.getByRole("button", { name: card.choices?.[0]?.label || "Use API key" }).first();
    await use.click().catch((e) => (out.checks.useClick = String(e)));
    await page.waitForTimeout(3000);
    await R.step(page, `${label}-a-after-use-api-key`);
  }
  await R.until(
    async () => {
      const tasks = await R.api(N, "GET", `/projects/${a.id}/tasks`);
      return tasks.every((t) => t.status === "done") ? tasks : null;
    },
    180_000,
    2000,
    "project A's tasks done",
  ).catch((e) => (out.checks.tasksDoneError = String(e)));
  out.checks.tasksA = (await R.api(N, "GET", `/projects/${a.id}/tasks`)).map((t) => ({
    title: t.title,
    status: t.status,
    display: t.display,
  }));
  const sessions = await R.api(N, "GET", `/projects/${a.id}/sessions`).catch(() => null);
  out.checks.sessionsA = sessions;
  const sid = started.sessionId || started.id || started.session?.id;
  if (sid) {
    await page.goto(`${bench.uiUrl}/sessions/${sid}`, { waitUntil: "domcontentloaded" });
    await R.step(page, `${label}-a-session-page-zone`, { waitMs: 1500 });
  }
  await page.goto(`${bench.uiUrl}/projects/${a.id}/sessions`, { waitUntil: "domcontentloaded" });
  await R.step(page, `${label}-a-sessions-tab-zone`, { waitMs: 1500 });
  await page.goto(`${bench.uiUrl}/projects/${a.id}/costs`, { waitUntil: "domcontentloaded" });
  out.checks.costsText = await R.step(page, `${label}-a-costs`, { waitMs: 1500 });
  save();

  // B: API key first, then subscription; the key at its limit (LC-C26's dialog).
  setLimits("subscription", (l) => {
    const { restingUntil, grant, asking, waiting, ...rest } = l;
    return rest;
  });
  setLimits("api_key", (l) => ({ ...l, restingUntil: iso(Date.now() + 3600_000) }));
  setHuman((p) => ({ ...p, credential_policy: "key_then_subscription" }));
  const b = await project("Map notes", ["Write the map notes in map.md"]);
  out.projectB = b;
  const checkB = await R.api(N, "GET", `/projects/${b.id}/start-check`);
  out.checks.startCheckKeyFirst = { credential: checkB.credential, runnable: checkB.runnable };
  await openStartDialog(page, b.id, `${label}-b-start-dialog-key-rests`);
  await page.keyboard.press("Escape").catch(() => undefined);
  setLimits("api_key", (l) => {
    const { restingUntil, ...rest } = l;
    return rest;
  });

  // C: the subscription refused under ask (the Use API key line's length).
  setHuman((p) => ({ ...p, credential_policy: "subscription_then_ask" }));
  setLimits("subscription", (l) => ({ ...l, refusedAt: iso(Date.now()) }));
  const checkC = await R.api(N, "GET", `/projects/${b.id}/start-check`);
  out.checks.startCheckRefused = { credential: checkC.credential, blocked: checkC.blocked };
  await openStartDialog(page, b.id, `${label}-c-start-dialog-sub-refused`);
  await page.keyboard.press("Escape").catch(() => undefined);
  setLimits("subscription", (l) => {
    const { refusedAt, ...rest } = l;
    return rest;
  });

  // D: chat's one-off Use API key under wait, the subscription at its limit.
  setHuman((p) => ({ ...p, credential_policy: "subscription_then_wait" }));
  setLimits("subscription", (l) => ({ ...l, restingUntil: iso(reset) }));
  await page.goto(`${bench.uiUrl}/projects/${b.id}/chat`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const box = page.getByRole("textbox").last();
  await box.fill("what is left in this project?");
  await box.press("Enter");
  await page.waitForTimeout(4000);
  await R.step(page, `${label}-d-chat-held`);
  const oneOff = page.getByRole("button", { name: "Use API key" }).first();
  if (await oneOff.count()) {
    await oneOff.click();
    await page.waitForTimeout(6000);
  } else out.checks.noOneOff = true;
  const chatText = await R.step(page, `${label}-d-chat-after-one-off`);
  out.checks.questionShown = (chatText.match(/what is left in this project\?/g) || []).length;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  const reloaded = await R.step(page, `${label}-d-chat-after-reload`);
  out.checks.questionShownAfterReload = (reloaded.match(/what is left in this project\?/g) || []).length;
  const chatCalls = R.modelCalls(N, "chat");
  const last = chatCalls[chatCalls.length - 1];
  out.checks.lastChatRequestUserTurnsWithQuestion = last
    ? last.messages.filter(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("what is left in this project?"),
      ).length
    : null;
  out.checks.lastChatRequestHoldReply = last
    ? last.messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("not answered"))
    : null;
  setLimits("subscription", (l) => {
    const { restingUntil, ...rest } = l;
    return rest;
  });
  save();
  await browser.close();
  console.log(JSON.stringify(out.checks, null, 1).slice(0, 6000));
})().catch((e) => {
  out.error = String(e && e.stack ? e.stack : e);
  save();
  console.error(e);
  process.exit(1);
});
