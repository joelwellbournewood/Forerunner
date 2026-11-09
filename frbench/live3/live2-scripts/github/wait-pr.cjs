// usage: node wait-pr.cjs <n> <merged|closed|open-mergeable|headchange:<sha>> [maxSec]
const { gh, log } = require("./h.cjs");
(async () => {
  const [n, want, maxS] = process.argv.slice(2);
  const t0 = Date.now();
  while (Date.now() - t0 < Number(maxS || 300) * 1000) {
    const p = (await gh("GET", "/pulls/" + n)).body;
    const ok = want === "merged" ? p.merged : want === "closed" ? p.state === "closed" : want.startsWith("headchange:") ? !p.head.sha.startsWith(want.slice(11)) : want === "mergeable-false" ? p.mergeable === false : p.mergeable === true;
    if (ok) { log("#" + n, want, "after", Math.round((Date.now() - t0) / 1000), "s; head", p.head.sha.slice(0, 10), "state", p.state, "merged", p.merged, "mergeable", p.mergeable); return; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  log("#" + n, "timed out waiting for", want); process.exit(4);
})();
