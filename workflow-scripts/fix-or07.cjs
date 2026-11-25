const fs = require("fs");
const f = process.argv[2];
let s = fs.readFileSync(f, "utf8");
const TL = '        // w8-together (OJ-11): Work together is offered first on this line now.\n        canWorkTogether: true,\n        togetherLine: \'This project\\\'s tasks, plan and cards move into "Kite club"; both Forerunners work on it.\',\n';
const a = '        text: `o/kite is also the Forerunner project "Kite club", which is not on this computer; another GitHub account worked on it on ${dayWords(daysAgo(3))}.`,\n        canTakeOver: false,\n        takeOverLine: null,\n        details: null,\n      });';
const b = "        text: 'o/kite is also the Forerunner project \"Kite club\", which is not on this computer.',\n        canTakeOver: true,\n        takeOverLine:\n          'The repository then names this project: choose it only if no Forerunner uses \"Kite club\" now.',\n        details: 'The pull requests of \"Kite club\" stay as they are.',\n      });";
for (const x of [a, b]) {
  const n = s.split(x).length - 1;
  if (n !== 1) { console.log("count", n); process.exit(1); }
  s = s.replace(x, x.replace(/\n {6}\}\);$/, "\n" + TL + "      });"));
}
fs.writeFileSync(f, s);
console.log("ok");
