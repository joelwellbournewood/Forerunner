import { readdir, stat } from "node:fs/promises";
import { matchProjects } from "@forerunner/commands";
import { join, relative, toPosix } from "@forerunner/platform";
import type { ProjectRow, StateStore, TaskRow } from "@forerunner/state";
import { z } from "zod";
import type { ToolResult, ToolSpec } from "../agent/tools.ts";
import {
  loadTaskDisplayContext,
  runOrder,
  taskDetail,
  taskDisplay,
} from "../daemon/task-display.ts";
import { taskView } from "../daemon/views.ts";
import { lastSessionBlock, tasksBlock } from "./project-facts.ts";

/**
 * The chat's read-only tools (design §3.9: "It can look up more (a task's runs and report, a
 * review, a file list) with read-only tools"). They change nothing, so they are no commands of
 * the registry: no change card, no change log row, no Undo. Before (the 2026-11-01 walks), all
 * twenty tools changed something and none could read a task, a session or a file.
 */
export interface ReadToolDeps {
  store: StateStore;
  /** The turn's project: the default when a call names none. */
  projectId: string | null;
  /** Whether the Docker sandbox is ready (a full-review task waits for it otherwise). */
  sandboxReady?: () => boolean | null;
  /** The project's folder (a linked folder, its checkout, or the data-dir workspace). */
  folderOf?: (projectId: string) => Promise<string | null>;
  chfPerUsd?: () => number;
}

const projectParam = z
  .string()
  .optional()
  .describe("The project's name; leave it out for the project of this conversation.");

const ok = (content: string): ToolResult => ({ content });
const err = (content: string): ToolResult => ({ content, isError: true });

async function projectOf(deps: ReadToolDeps, named?: string): Promise<ProjectRow | string> {
  if (named?.trim()) {
    const all = await deps.store.project.list({}, { limit: 500 });
    const hits = matchProjects(all, named);
    if (hits.length === 1) return hits[0] as ProjectRow;
    return hits.length
      ? `Several projects match "${named}": ${hits.map((p) => p.name).join(", ")}.`
      : `No project is called "${named}".`;
  }
  if (!deps.projectId) return "This conversation is about no project: name one.";
  return (await deps.store.project.get(deps.projectId)) ?? "The project no longer exists.";
}

async function findTask(
  store: StateStore,
  project: ProjectRow,
  needle: string,
): Promise<TaskRow | string> {
  const tasks = await store.task.forProject(project.id, {}, { limit: 10_000 });
  const direct = tasks.find((t) => t.id === needle.trim());
  if (direct) return direct;
  const n = needle.trim().toLowerCase().replace(/^"|"$/g, "");
  const exact = tasks.filter((t) => t.title.toLowerCase() === n);
  if (exact.length === 1) return exact[0] as TaskRow;
  const hits = tasks.filter((t) => t.title.toLowerCase().includes(n));
  if (hits.length === 1) return hits[0] as TaskRow;
  return hits.length
    ? `Several tasks match "${needle}": ${hits.map((t) => `"${t.title}"`).join(", ")}.`
    : `No task of ${project.name} matches "${needle}".`;
}

/** Files under the folder, newest first, at most `max`; `.git` and `node_modules` are skipped. */
async function listFiles(root: string, max: number): Promise<{ path: string; at: string }[]> {
  const out: { path: string; at: string; ms: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 6 || out.length > 2000) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules" || e.name === ".forerunner") continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs, depth + 1);
      else if (e.isFile()) {
        const s = await stat(abs).catch(() => null);
        if (s)
          out.push({
            path: toPosix(relative(root, abs)),
            at: s.mtime.toISOString(),
            ms: s.mtimeMs,
          });
      }
    }
  };
  await walk(root, 0);
  return out
    .sort((a, b) => b.ms - a.ms || a.path.localeCompare(b.path))
    .slice(0, max)
    .map(({ path, at }) => ({ path, at }));
}

export function readTools(deps: ReadToolDeps): ToolSpec[] {
  const chf = () => deps.chfPerUsd?.() ?? 1;
  const tasksList: ToolSpec<{ project?: string | undefined }> = {
    name: "tasks_list",
    description:
      "List every task of a project in run order with its status as the person sees it, what it waits for, why it failed and the critic's last word. Reads only.",
    schema: z.object({ project: projectParam }),
    actionClass: "read",
    risk: "low",
    async execute(input) {
      const project = await projectOf(deps, input.project);
      if (typeof project === "string") return err(project);
      return ok(
        await tasksBlock(deps.store, project.id, {
          sandboxReady: deps.sandboxReady?.() ?? null,
          max: 200,
          heading: `# Tasks of ${project.name}`,
        }),
      );
    },
  };
  const taskGet: ToolSpec<{ task: string; project?: string | undefined }> = {
    name: "task_get",
    description:
      "One task in detail: what it asks for, its status, what it waits for and what waits on it, each run (specialist, outcome, report, files changed), the critic's review and open cards. Reads only.",
    schema: z.object({
      task: z.string().min(1).describe("The task's title (or part of it)."),
      project: projectParam,
    }),
    actionClass: "read",
    risk: "low",
    async execute(input) {
      const project = await projectOf(deps, input.project);
      if (typeof project === "string") return err(project);
      const task = await findTask(deps.store, project, input.task);
      if (typeof task === "string") return err(task);
      const rows = await deps.store.task.forProject(project.id, {}, { limit: 10_000 });
      const ctx = await loadTaskDisplayContext(deps.store, rows, deps.sandboxReady?.() ?? null);
      const views = runOrder(rows).map((t, i) =>
        taskView(t, chf(), undefined, { display: taskDisplay(t, ctx), runOrder: i }),
      );
      const view = views.find((v) => v.id === task.id);
      if (!view) return err("The task is gone.");
      const d = await taskDetail(deps.store, view, task, views, chf());
      const lines = [
        `Task "${task.title}" of ${project.name}: ${view.display?.label ?? task.status}`,
        task.outcome ? `What done looks like: ${task.outcome}` : "",
        task.acceptance_criteria.length ? `Criteria: ${task.acceptance_criteria.join("; ")}` : "",
        d.waitsOn.length
          ? `Waits for: ${d.waitsOn.map((w) => `"${w.title ?? "a task that is gone"}" (${w.status})`).join(", ")}`
          : "",
        d.waitedOnBy.length
          ? `Waited on by: ${d.waitedOnBy.map((w) => `"${w.title}"`).join(", ")}`
          : "",
        ...d.runs.map(
          (r) =>
            `Run (${r.kind}, ${r.specialist ?? "agent"}, ${r.startedAt}): ${r.outcome}${r.report ? `. Report: ${r.report.replace(/\n/g, " ")}` : ""}${r.files.length ? `. Files: ${r.files.join(", ")}` : ""}`,
        ),
        d.review
          ? `Review: ${d.review.verdict} ${d.review.summary.replace(/\n/g, " ")}${d.review.open.length ? ` Still asked for: ${d.review.open.join("; ")}` : ""}`
          : "",
        ...d.cards.map((c) => `Open card: ${c.question}`),
      ].filter(Boolean);
      return ok(lines.join("\n"));
    },
  };
  const sessionLast: ToolSpec<{ project?: string | undefined }> = {
    name: "session_last",
    description:
      "The last session of a project: its result, what it did, what failed and why, what needs the person, what is next and what it spent. Reads only.",
    schema: z.object({ project: projectParam }),
    actionClass: "read",
    risk: "low",
    async execute(input) {
      const project = await projectOf(deps, input.project);
      if (typeof project === "string") return err(project);
      return ok(lastSessionBlock(project) || `${project.name} has had no session yet.`);
    },
  };
  const filesList: ToolSpec<{ project?: string | undefined }> = {
    name: "files_list",
    description:
      "The files in a project's folder, newest first (at most 100), with when each changed, and where the folder is. Reads only.",
    schema: z.object({ project: projectParam }),
    actionClass: "read",
    risk: "low",
    async execute(input) {
      const project = await projectOf(deps, input.project);
      if (typeof project === "string") return err(project);
      const folder = (await deps.folderOf?.(project.id)) ?? null;
      if (!folder) return ok(`${project.name} has no folder yet: nothing written.`);
      const files = await listFiles(folder, 100);
      if (!files.length)
        return ok(`The folder of ${project.name} is ${folder}. Nothing written yet.`);
      return ok(
        [
          `The folder of ${project.name} is ${folder}. Files, newest first:`,
          ...files.map((f) => `- ${f.path} (${f.at})`),
        ].join("\n"),
      );
    },
  };
  return [tasksList, taskGet, sessionLast, filesList] as ToolSpec[];
}

/** The read tools' names, for the role prompt and the tests. */
export const READ_TOOL_NAMES = ["files_list", "session_last", "task_get", "tasks_list"] as const;
