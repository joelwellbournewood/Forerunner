import { readFileSync } from "node:fs";
import { join } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { CreateTaskBody } from "../packages/runtime/src/daemon/api-types.ts";
import {
  buildContainerRunArgv,
  DEFAULT_RUNNER_IMAGE,
} from "../packages/runtime/src/sandbox/container.ts";
import {
  criticTiers,
  DEFAULT_IMAGE,
  FULL_REVIEW_TASK,
  parseArgs,
  parseDockerEvents,
  REPO as REPO_ROOT,
  SANDBOX_LABEL,
  summaryMarkdown,
  TASK_FILE,
  TASK_LABEL,
  taskSandboxEvidence,
  // @ts-expect-error plain JS module
} from "./sandbox-full-review.mjs";

/**
 * The pure parts of the Docker sandbox check (scripts/sandbox-full-review.mjs, phase F2): what
 * it asks the daemon for, and how it reads the engine's events and the model-call log. The
 * events are the ones Docker 29 printed for the check's own run on 2026-11-02 (ids shortened).
 */
const TASK = "01a19b45-6136-7246-8bcc-d174546fe99e";
const OTHER = "01a19b45-0000-7246-8bcc-d174546fe99e";
const NAME = `forerunner-${TASK}-4c795192`;
const attrs = (task: string, extra: Record<string, string> = {}) => ({
  "forerunner.sandbox": "1",
  "forerunner.task": task,
  image: "forerunner-runner:local",
  name: task === TASK ? NAME : `forerunner-${task}-0badc0de`,
  ...extra,
});
const event = (action: string, task = TASK, extra: Record<string, string> = {}, id = "4f76cd73") =>
  JSON.stringify({
    Type: "container",
    Action: action,
    Actor: { ID: id, Attributes: attrs(task, extra) },
    scope: "local",
    time: 1793606379,
  });
const RUN = [
  event("create"),
  event("start"),
  event("exec_create: timeout -s KILL 60 node --check src/greet.js", TASK, { execID: "397d" }),
  event("exec_start: timeout -s KILL 60 node --check src/greet.js", TASK, { execID: "397d" }),
  event("exec_die", TASK, { execID: "397d", exitCode: "0" }),
  event("kill", TASK, { signal: "9" }),
  event("die", TASK, { exitCode: "137" }),
  event("destroy"),
].join("\n");

describe("the Docker sandbox check's image and labels", () => {
  const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf8");

  it("checks the image CI builds, which is the daemon's own default in a checkout", () => {
    expect(DEFAULT_IMAGE).toBe(DEFAULT_RUNNER_IMAGE);
    const ci = read(".github", "workflows", "ci.yml");
    expect(ci).toContain(`tags: ${DEFAULT_IMAGE}`);
    expect(ci).toContain("node scripts/sandbox-full-review.mjs");
  });

  it("follows the labels the container sandbox puts on what it starts (container.ts)", () => {
    const argv = buildContainerRunArgv({
      engine: "docker",
      name: "n",
      image: DEFAULT_IMAGE,
      worktree: "/w",
      taskId: TASK,
      network: { mode: "none" },
      limits: { timeoutMs: 60_000 },
      env: {},
    });
    expect(argv).toContain(SANDBOX_LABEL);
    expect(argv).toContain(`${TASK_LABEL}=${TASK}`);
  });
});

describe("the Docker sandbox check's task and arguments", () => {
  it("asks for one full-review task (tier 2) the daemon's route accepts as it is", () => {
    expect(FULL_REVIEW_TASK.riskTier).toBe(2);
    expect(FULL_REVIEW_TASK.title).toContain(TASK_FILE);
    const parsed = CreateTaskBody.parse(FULL_REVIEW_TASK);
    expect(parsed).toMatchObject({ riskTier: 2, specialist: "coder", title: `Write ${TASK_FILE}` });
  });

  it("reads its options and refuses what it does not know", () => {
    expect(parseArgs([])).toEqual({ out: null, home: null, image: DEFAULT_IMAGE, timeoutMin: 15 });
    expect(
      parseArgs(["--out", "/o", "--home", "/h", "--image", "x:1", "--timeout-min", "3"]),
    ).toEqual({ out: "/o", home: "/h", image: "x:1", timeoutMin: 3 });
    expect(() => parseArgs(["--image"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--timeout-min", "0"])).toThrow(/positive/);
    expect(() => parseArgs(["--watch"])).toThrow(/unknown argument --watch/);
  });
});

describe("the engine's events for the task", () => {
  it("parses one JSON object a line and leaves out anything else", () => {
    const events = parseDockerEvents(`${RUN}\nnot json\n{"cut":\n\n`);
    expect(events).toHaveLength(8);
    expect(events[0]).toMatchObject({ Type: "container", Action: "create" });
  });

  it("sees the container start from the image, the command run in it and the container go", () => {
    const e = taskSandboxEvidence(parseDockerEvents(RUN), TASK);
    expect(e.started).toBe(true);
    expect(e.images).toEqual(["forerunner-runner:local"]);
    expect(e.execs).toEqual(["timeout -s KILL 60 node --check src/greet.js"]);
    expect(e.execExits).toEqual([0]);
    expect(e.allDestroyed).toBe(true);
    expect(e.containers).toEqual([
      {
        id: "4f76cd73",
        name: NAME,
        image: "forerunner-runner:local",
        actions: [
          "create",
          "start",
          "exec_create",
          "exec_start",
          "exec_die",
          "kill",
          "die",
          "destroy",
        ],
      },
    ]);
  });

  it("counts only the task's own containers, and a container left behind is not removed", () => {
    const other = [event("create", OTHER, {}, "aa"), event("start", OTHER, {}, "aa")].join("\n");
    const left = [event("create"), event("start")].join("\n");
    const e = taskSandboxEvidence(parseDockerEvents(`${other}\n${left}`), TASK);
    expect(e.containers.map((c: { id: string }) => c.id)).toEqual(["4f76cd73"]);
    expect(e.started).toBe(true);
    expect(e.allDestroyed).toBe(false);
    const none = taskSandboxEvidence(parseDockerEvents(other), TASK);
    expect(none).toMatchObject({ started: false, allDestroyed: false, execs: [], images: [] });
  });

  it("keeps the task's networks apart from its containers", () => {
    const net = JSON.stringify({
      Type: "network",
      Action: "create",
      Actor: { ID: "n1", Attributes: { name: `${NAME}-net`, "forerunner.task": TASK } },
    });
    const e = taskSandboxEvidence(parseDockerEvents(`${net}\n${RUN}`), TASK);
    expect(e.networks).toEqual([`${NAME}-net`]);
    expect(e.containers).toHaveLength(1);
  });

  it("reads a failed command's exit code", () => {
    const failed = RUN.replace('"exitCode":"0"', '"exitCode":"1"');
    expect(taskSandboxEvidence(parseDockerEvents(failed), TASK).execExits).toEqual([1]);
  });
});

describe("the critic's tier for the task", () => {
  const call = (role: string, label: string) => JSON.stringify({ role, label, model: "fake-opus" });

  it("reads the critic calls of that task from the model-call log", () => {
    const log = [
      call("specialist", `coder on Write ${TASK_FILE}`),
      call("critic", `critic tier 2 on task ${TASK}`),
      call("critic", `critic tier 1 on task ${OTHER}`),
      "not json",
      call("critic", `critic tier 3 on task ${TASK}`),
    ].join("\n");
    expect(criticTiers(log, TASK)).toEqual([2, 3]);
    expect(criticTiers(log, OTHER)).toEqual([1]);
    expect(criticTiers("", TASK)).toEqual([]);
  });
});

describe("the step summary", () => {
  it("says how many checks failed and lists each in one line", () => {
    const md = summaryMarkdown("Sandbox", [
      { name: "a", ok: true, detail: "fine" },
      { name: "b", ok: false, detail: "line one\nline two" },
    ]);
    expect(md).toContain("### Sandbox");
    expect(md).toContain("**1 of 2 checks failed.**");
    expect(md).toContain("- ok: a (fine)");
    expect(md).toContain("- FAILED: b (line one line two)");
    expect(summaryMarkdown("S", [{ name: "a", ok: true }])).toContain("All 1 checks passed.");
  });
});
