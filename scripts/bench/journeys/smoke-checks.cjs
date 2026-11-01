// The smoke journey's checks on structure and states (smoke.cjs), apart so they can be tested
// (scripts/bench-scripts.test.ts). They hold for the stand-in model and for a real one: no task
// title, file name or reply text of the stand-in is assumed (the live run of 2026-11-01 failed
// 10 of 14 checks on the bench's own assumptions, not on the product).
"use strict";

/** "Plan for "<project>": N tasks" on the plan card: N, or null when the title is not there. */
function planCardTasks(text, project) {
  const esc = project.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`Plan for "${esc}": (\\d+) tasks?`).exec(text);
  return m ? Number(m[1]) : null;
}

/** The start of a title a screen or a reply is checked for (a card or a reply may cut it). */
function titleHead(title) {
  const t = title.replace(/\s+/g, " ").trim();
  return t.length <= 24 ? t : t.slice(0, 24);
}

/** The titles whose start the text does not show (case-insensitive). */
function titlesMissing(text, titles) {
  const t = text.replace(/\s+/g, " ").toLowerCase();
  return titles.filter((title) => !t.includes(titleHead(title).toLowerCase()));
}

/** The first title a reply names (its start, case-insensitive), or null. */
function replyNamesTask(reply, titles) {
  const r = reply.replace(/\s+/g, " ").toLowerCase();
  return titles.find((title) => r.includes(titleHead(title).toLowerCase())) ?? null;
}

/** Every planned task done: false for no tasks at all (0 of 0 is no plan, not a finished one). */
function allDone(tasks) {
  const done = tasks.filter((t) => t.status === "done").length;
  return { ok: tasks.length > 0 && done === tasks.length, detail: `${done}/${tasks.length} done` };
}

const ON_THE_PERSON = new Set(["answer", "paused", "docker"]);

/**
 * Every task the agents can do is done: the others wait on the person (a question, a pause),
 * on Docker, or on such a task (through what they wait for). A real plan may hold a task for
 * the person (the live run: "Human decisions: hosting, repository, quote source"); the stand-in's
 * default plan holds none. False for no tasks at all.
 */
function agentsDone(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const held = new Set(
    tasks.filter((t) => t.status !== "done" && ON_THE_PERSON.has(t.display?.key)).map((t) => t.id),
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (held.has(t.id) || t.status === "done") continue;
      if ((t.dependsOn ?? []).some((d) => held.has(d) && byId.has(d))) {
        held.add(t.id);
        grew = true;
      }
    }
  }
  const open = tasks.filter((t) => t.status !== "done" && !held.has(t.id));
  const words = (t) => `"${t.title}": ${t.display?.label ?? t.status}`;
  return {
    ok: tasks.length > 0 && open.length === 0 && tasks.some((t) => t.status === "done"),
    detail: `${tasks.filter((t) => t.status === "done").length}/${tasks.length} done${
      held.size
        ? `; waiting on you or Docker: ${tasks
            .filter((t) => held.has(t.id))
            .map(words)
            .join("; ")}`
        : ""
    }${open.length ? `; not done: ${open.map(words).join("; ")}` : ""}`,
  };
}

/** The files the work wrote: not the doc set, not git's or Forerunner's own folders. */
function workFiles(files) {
  return files.filter(
    (f) =>
      !f.startsWith(".git/") &&
      !f.startsWith(".forerunner/") &&
      !f.startsWith("docs/") &&
      !f.startsWith("checks/"),
  );
}

/** Which written stylesheets and scripts an HTML page refers to (by file name). */
function pageLinks(html, files) {
  const base = (f) => f.split("/").at(-1);
  const named = (ext) =>
    files.filter((f) => f.endsWith(ext) && html.includes(base(f))).map((f) => base(f));
  return { css: named(".css"), js: named(".js") };
}

module.exports = {
  planCardTasks,
  titlesMissing,
  replyNamesTask,
  allDone,
  agentsDone,
  workFiles,
  pageLinks,
};
