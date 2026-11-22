const L = require("./lib.cjs");
(async () => {
  const s = L.loadState();
  const tasks = await L.tasksOf(s.shop);
  console.log(JSON.stringify(tasks.map((t) => [t.title.slice(0, 30), t.status, t.display?.label]), null, 0));
  console.log(
    JSON.stringify((await L.prsOf(s.shop)).waiting.map((w) => [w.kind, w.number, w.title, w.merge?.state])),
  );
  const card = await L.R.api(L.n, "GET", `/projects/${s.shop}`);
  console.log(JSON.stringify(card.statusLine), !!card.working);
})();
