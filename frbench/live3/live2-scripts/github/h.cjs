process.env.FRBENCH_ROOT = process.env.FRBENCH_ROOT || "/tmp/frbench/live2/github";
const R = require("/home/user/Forerunner/scripts/bench/recorder.cjs");
const fs = require("fs");
const N = process.env.BENCH || "github-a";
const REPO = "joelwellbournewood/forerunner-sandbox";
const GH = "https://api.github.com/repos/" + REPO;
async function gh(method, route, body) {
  const res = await fetch(route.startsWith("http") ? route : GH + route, {
    method,
    headers: {
      authorization: "Bearer " + process.env.FORERUNNER_TEST_GITHUB_TOKEN,
      accept: "application/vnd.github+json",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const t = await res.text();
  let j = t;
  try { j = JSON.parse(t); } catch {}
  return { status: res.status, body: j };
}
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function save(name, obj) {
  const p = "/tmp/frbench/live2/github/evidence/" + name;
  fs.mkdirSync("/tmp/frbench/live2/github/evidence", { recursive: true });
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  return p;
}
async function text(page) { return page.evaluate(() => document.body.innerText); }
async function goto(page, p) {
  const b = R.bench(N);
  await page.goto(b.uiUrl + p, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(800);
}
module.exports = { R, N, REPO, gh, log, save, text, goto, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
