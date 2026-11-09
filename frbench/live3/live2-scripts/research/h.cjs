process.env.FRBENCH_ROOT = process.env.FRBENCH_ROOT || "/tmp/frbench/live2/research";
const R = require("/home/user/Forerunner/scripts/bench/recorder.cjs");
const fs = require("fs");
const N = process.env.BENCH || "research-a";
const EV = "/tmp/frbench/live2/research/evidence/";
function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function save(name, obj) {
  fs.mkdirSync(EV, { recursive: true });
  const p = EV + name;
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
const enc = encodeURIComponent;
module.exports = { R, N, EV, log, save, text, goto, enc, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
