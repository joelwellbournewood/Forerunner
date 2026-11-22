const fs = require("node:fs");
const R = require("/home/user/Forerunner/.claude/worktrees/wf_7dea540b-2f3-2/scripts/bench/recorder.cjs");

const benchOf = (name) => JSON.parse(fs.readFileSync(`/tmp/frbench/${name}/bench.json`, "utf8"));

async function sessionsOf(name, projectId) {
  const list = await R.api(name, "GET", `/sessions?projectId=${encodeURIComponent(projectId)}`);
  return Array.isArray(list) ? list : list.sessions || [];
}

async function settle(name, projectId, ms = 180_000) {
  return R.until(
    async () => {
      const arr = await sessionsOf(name, projectId);
      if (arr.some((s) => s.status === "running")) return null;
      const tasks = await R.api(name, "GET", `/projects/${projectId}/tasks`);
      return tasks.every((t) => !["claimed", "in_progress", "in_review"].includes(t.status))
        ? tasks
        : null;
    },
    ms,
    1000,
    "the project to settle",
  );
}

async function openCards(name, projectId) {
  const ib = await R.api(name, "GET", "/inbox");
  return ib.requests.filter((r) => r.projectId === projectId && r.status === "open");
}

const cardWords = (c) => ({
  id: c.id,
  title: c.title,
  body: c.body,
  steps: c.steps,
  choices: (c.choices || []).map((x) => x.label),
});

module.exports = { R, benchOf, sessionsOf, settle, openCards, cardWords };
