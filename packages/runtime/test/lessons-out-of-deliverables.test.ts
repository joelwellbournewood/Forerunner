import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "../../../testenv/src/bench/role-player.ts";
import { detectRole } from "../../../testenv/src/bench/roles.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { ModelRequest } from "../src/provider/types.ts";

/**
 * Lessons stay out of the work (phase E #95). Live walk 4 (real model, 2026-11-02): the brief
 * said "End the report with one line per lesson worth keeping, as 'Lesson: ...'", and the
 * data-analyst and the science-evaluator, whose deliverable is a report, ended report.md and
 * evaluation.md with "Lesson:" lines; the writer-marketing left a scratch notes.md at the
 * project's root. The runner reads lessons from the specialist's final message only.
 *
 * Now the brief says lessons go only in the final message, never in a file, and that no scratch
 * notes stay in the project. The bench's stand-in reads the brief as the live model did, so
 * with the old line it writes the lesson into the report and leaves a notes.md: what the person
 * opens in the Files tab is asserted here, and the lesson still reaches the agent's memory.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

describe("lessons go in the final message, never in a deliverable (phase E #95)", () => {
  let rt: RuntimeApp;
  let req: (path: string, init?: RequestInit) => Promise<Response>;
  const specialistCalls: ModelRequest[] = [];

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-lessons-out-"));
    const clock = new SimulatedClock("2026-11-02T09:00:00Z");
    const provider = createRolePlayer(
      benchOptionsFromEnv(
        { FORERUNNER_BENCH_DELAY_MS: "0" },
        new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
      ),
    );
    const stream = provider.stream.bind(provider);
    provider.stream = (r) => {
      if (detectRole(r).role === "specialist") specialistCalls.push(r);
      return stream(r);
    };
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    const { app, token } = createDaemonApp(rt);
    req = async (path, init = {}) =>
      app.request(path, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      });
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const json = async (path: string, init: RequestInit = {}) => {
    const res = await req(path, init);
    expect(res.status, `${init.method ?? "GET"} ${path}`).toBeLessThan(300);
    return (await res.json()) as Json;
  };
  const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

  it("the report and the copy hold no 'Lesson:' line and no scratch notes file is left; the lesson reaches memory", async () => {
    const projectId = String(
      (await json("/projects", post({ name: "Sales summary", goal: "Know the best month" }))).id,
    );
    for (const [title, outcome, specialist] of [
      [
        "Write the sales report in report.md",
        "report.md gives the monthly totals and the best month",
        "data-analyst",
      ],
      [
        "Write the launch copy in docs/copy.md",
        "docs/copy.md has a headline and two short paragraphs",
        "writer-marketing",
      ],
    ] as const)
      await json(
        `/projects/${projectId}/tasks`,
        post({ title, outcome, specialist, riskTier: 1, status: "ready", dependsOn: [] }),
      );
    const started = await req(
      "/sessions",
      post({ agentId: rt.agent.id, projectId, trigger: "manual" }),
    );
    expect(started.status).toBe(202);
    const sessionId = String((((await started.json()) as Json).session as Json).id);
    // Polls in real time (at least 10 s); the error says what was seen last.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const s = await json(`/sessions/${sessionId}`);
      if (["completed", "stopped", "failed", "killed"].includes(String(s.status))) break;
      if (Date.now() > deadline) throw new Error(`session did not end: ${JSON.stringify(s)}`);
      await new Promise((r) => setTimeout(r, 25));
    }

    // The Files tab: the deliverables, as the person opens them.
    const files = (await json(`/projects/${projectId}/files`)) as {
      entries: { path: string }[];
    };
    const paths = files.entries.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["report.md", "docs/copy.md"]));
    for (const path of ["report.md", "docs/copy.md"]) {
      const file = await json(`/projects/${projectId}/files/${encodeURIComponent(path)}`);
      expect(String(file.content), path).not.toMatch(/^\s*(?:[-*]\s*)?Lesson\s*:/im);
    }
    expect(paths, paths.join(", ")).not.toContain("notes.md");

    // What every specialist was told: lessons in the final message only, no scratch notes.
    expect(specialistCalls.length).toBeGreaterThan(0);
    for (const call of specialistCalls) {
      const brief = JSON.stringify(call.messages[0]?.content ?? "");
      expect(brief).toContain("Lessons go only in your final message, never in a file");
      expect(brief).toContain("Leave no scratch notes in the project");
      expect(brief).not.toContain("End the report with one line per lesson");
    }

    // The lesson the final message spelled out is in the agent's memory.
    const memory = (await json(
      `/memory?scope=agent_private&agentId=${encodeURIComponent(rt.agent.id)}`,
    )) as { lessons: { text: string }[] };
    expect(memory.lessons.map((l) => l.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("data-analyst tasks in this project are small"),
      ]),
    );
  }, 120_000);
});
