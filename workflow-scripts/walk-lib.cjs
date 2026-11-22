// Helpers for the review walk of l4-cred-engine (bench review-l4-cred-engine).
process.env.FRBENCH_ROOT = process.env.FRBENCH_ROOT || "/tmp/frbench";
const REPO = "/home/user/Forerunner/.claude/worktrees/wf_a90568bf-2a3-2";
const R = require(`${REPO}/scripts/bench/recorder.cjs`);
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const N = "review-l4-cred-engine";
const enc = encodeURIComponent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function db(readOnly = true) {
  return new DatabaseSync(path.join(R.bench(N).home, "data", "state.sqlite"), { readOnly });
}
function q(sql, ...args) {
  const d = db();
  try {
    return d.prepare(sql).all(...args);
  } finally {
    d.close();
  }
}
function patchLimits(kind, fn) {
  const d = db(false);
  try {
    const row = d.prepare("select id, limits from billing_source where kind = ?").get(kind);
    const limits = fn(JSON.parse(row.limits || "{}"));
    d.prepare("update billing_source set limits = ?, version = version + 1 where id = ?").run(
      JSON.stringify(limits),
      row.id,
    );
    return limits;
  } finally {
    d.close();
  }
}
async function goto(page, route, waitMs = 2000) {
  const b = R.bench(N);
  await page.goto(`${b.uiUrl}${route}`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  if (await R.skipSetup(page)) {
    await page.waitForTimeout(1000);
    await page.goto(`${b.uiUrl}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  }
  if (waitMs) await page.waitForTimeout(waitMs);
}
async function say(page, projectId, line, label, waitMs = 60000) {
  await goto(page, `/projects/${enc(projectId)}/chat`, 1500);
  const replies = page.getByTestId("chat-agent");
  const before = await replies.count();
  const box = page.getByTestId("chat-input");
  await box.fill(line);
  await box.press("Enter");
  const reply = await R.until(
    async () => {
      if ((await replies.count()) <= before) return null;
      const last = replies.last();
      if ((await last.getAttribute("data-streaming")) === "true") return null;
      const t = (await last.innerText()).trim();
      return t && !/^Thinking…$/.test(t) ? t : null;
    },
    waitMs,
    1000,
    "a chat reply",
  ).catch(() => null);
  await page.waitForTimeout(1500);
  const shot = label ? await R.step(page, label) : null;
  return { reply, shot };
}
async function cmd(commands) {
  const set = await R.api(N, "POST", "/commands/execute", { commands, source: "ui" });
  if (set.status === "pending")
    return R.api(N, "POST", `/commands/${set.pendingId}/confirm`, { answer: "tap" });
  return set;
}
function save(file, obj) {
  const dir = path.join(R.bench(N).home, "..", "evidence");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 2));
  return path.join(dir, file);
}
module.exports = { R, N, enc, sleep, q, patchLimits, goto, say, cmd, save, fs, path };
