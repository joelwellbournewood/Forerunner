process.env.FRBENCH_ROOT = "/tmp/frbench";
const R = require("/home/user/Forerunner/.claude/worktrees/wf_d49abaae-666-7/scripts/bench/recorder.cjs");
const fs = require("node:fs");
const path = require("node:path");
const N = "review-l3-handoff-checks";
const enc = encodeURIComponent;
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p.slice(dir.length));
  }
  return out;
}
(async () => {
  const existing = (await R.api(N, "GET", "/projects")).find((x) => x.name === "Quote page");
  const p = existing ? { projectId: existing.id } : await R.createPlannedProject(N, {
    project: "Quote page",
    goal: "A page that shows a random quote",
    brief:
      "A quote page: index.html shows a random quote from script.js on every load, styled in styles.css. A check makes sure a quote shows. A README says how to open it.\n- quotes\n- styles\n- a check",
  });
  const rows = await R.until(
    async () => {
      const s = await R.api(N, "GET", `/projects/${enc(p.projectId)}/sessions`);
      return s.rows?.length ? s.rows : null;
    },
    60000,
    1000,
    "session",
  );
  await R.until(
    async () => {
      const ts = await R.api(N, "GET", `/projects/${enc(p.projectId)}/tasks`);
      const w = (await R.api(N, "GET", `/projects/${enc(p.projectId)}/sessions`)).working ?? [];
      return w.length === 0 && ts.every((t) => !["in_progress", "in_review", "claimed"].includes(t.status)) ? ts : null;
    },
    500000,
    2000,
    "work to settle",
  );
  const all = (await R.api(N, "GET", `/projects/${enc(p.projectId)}/sessions`)).rows;
  console.log(all.map((r) => r.gist).join("\n"));
  const tasks = await R.api(N, "GET", `/projects/${enc(p.projectId)}/tasks`);
  for (const t of tasks) {
    const v = await R.api(N, "GET", `/tasks/${enc(t.id)}`);
    console.log(
      "==",
      t.title,
      t.status,
      JSON.stringify(v.verification?.check),
      JSON.stringify((v.verification?.evidence?.checks ?? []).map((c) => [c.name, c.passed])),
      JSON.stringify(v.verification?.evidence?.notChecked ?? []),
    );
  }
  console.log(walk(R.workspaceOf(N, p.projectId)).join("\n"));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
