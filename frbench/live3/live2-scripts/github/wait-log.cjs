// usage: node wait-log.cjs <regex> <maxSec> [sinceIso]
const fs = require("fs");
const [re, maxS, since] = process.argv.slice(2);
const file = "/tmp/frbench/live2/github/github-a/daemon.log";
const t0 = Date.now();
const rx = new RegExp(re);
const sinceT = since || new Date().toISOString();
(async () => {
  while (Date.now() - t0 < Number(maxS) * 1000) {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.slice(0, 24) >= sinceT && rx.test(l));
    if (lines.length) { for (const l of lines) console.log(l.slice(0, 600)); return; }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("no match for", re, "in", maxS, "s"); process.exit(4);
})();
