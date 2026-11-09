// Write a project's web_access straight into the state DB (past the clean-up), as another install would.
const { R, N, log, enc } = require("./h.cjs");
const { DatabaseSync } = require("node:sqlite");
const [PID, RULE] = process.argv.slice(2);
(async () => {
  const b = R.bench(N);
  const db = new DatabaseSync(`${b.home}/data/state.sqlite`);
  const row = db.prepare("SELECT settings FROM project WHERE id = ?").get(PID);
  const settings = { ...JSON.parse(row.settings || "{}"), web_access: JSON.parse(RULE) };
  db.prepare("UPDATE project SET settings = ? WHERE id = ?").run(JSON.stringify(settings), PID);
  db.close();
  const card = await R.api(N, "GET", `/projects/${enc(PID)}`);
  log("stored:", RULE, "| card researchReads:", card.researchReads);
})().catch((e) => { console.error(String(e).slice(0, 800)); process.exit(1); });
