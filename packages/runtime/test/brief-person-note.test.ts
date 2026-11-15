import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { TaskRow, TaskStatus } from "@forerunner/state";
import { FakeProvider, type ModelRequest, textReply, toolReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProjectCard, TaskTransitionView, TaskView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";

/**
 * l3-small, run L3 (live check 3, L3-github-4): the brief told the agent '## The person's note
 * on this task "Redo"' after the person pressed Redo with the note field empty, and '"Edit
 * Write the kite guide in kite/guide/"' after they changed only a budget. `personNoteOn` read
 * the change log's `words_used`, which for a change in the app is the button's label when no
 * note was typed. What the person types reaches the brief once, as the queued note that names
 * the task, and is used up by the work that finished (design §4.6, §4.7). The moves go through
 * the Tasks tab's own routes; each brief is the specialist's first message the stand-in got.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

describe("l3-small, run L3: the brief carries what the person typed, never a button's label (L3-github-4)", () => {
  const clock = new SimulatedClock("2026-11-15T06:00:00Z");
  const home = mkdtempSync(join(tmpdir(), "fr-brief-note-"));
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let provider: FakeProvider;

  const compose = async () => {
    // The critic accepts each run (its submit_review, then its last words); the coder reports.
    const reviewing = (req: ModelRequest) =>
      (req.tools ?? []).some((t) => t.name === "submit_review");
    const answered = (req: ModelRequest) =>
      JSON.stringify(req.messages.at(-1)?.content ?? "").includes("tool_result");
    provider = new FakeProvider({
      replies: [
        toolReply(
          "submit_review",
          {
            grade: 92,
            confidence: "high",
            verdict: "accept",
            summary: "The motto is set as asked.",
            findings: [],
            criteria: [],
            checks_run: [],
          },
          undefined,
          { when: (r) => reviewing(r) && !answered(r), times: Number.POSITIVE_INFINITY },
        ),
        textReply("Done as asked.", { times: Number.POSITIVE_INFINITY }),
      ],
      clock,
      latency: "none",
    });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: `sqlite:${join(home, "state.sqlite")}`,
      vault: new MemoryVault(),
      provider,
      registryDir: REGISTRY,
      identity: { humanName: "Robin", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    });
    ({ app, token } = createDaemonApp(rt));
  };
  beforeAll(compose, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  const send = async (method: string, path: string, body: unknown = {}) => {
    const res = await app.request(path, {
      method,
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    const json = (await res.json()) as Json;
    expect(res.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
    return json;
  };
  const rowOf = async (projectId: string, taskId: string) => {
    const res = await app.request(`/projects/${projectId}/tasks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const row = TaskView.array()
      .parse(await res.json())
      .find((t) => t.id === taskId);
    if (!row) throw new Error(`no row for ${taskId}`);
    return row;
  };
  /** A task in the state the person sees before pressing the button (done, running). */
  const taskIn = async (projectId: string, title: string, status: TaskStatus) =>
    (await rt.store.task.insert({
      project_id: projectId,
      title,
      outcome: `${title} is written`,
      status,
      specialist: "coder",
      risk_tier: 0,
    } as never)) as TaskRow;
  /** Start a session as Start does and give back the specialist's first message for `title`. */
  const briefsFor = async (projectId: string, title: string): Promise<string[]> => {
    const before = provider.calls.length;
    await rt.runner.start({
      agentId: rt.agent.id,
      projectId,
      trigger: "manual",
      budgetCapUsdMicro: 5_000_000,
      grant: {
        allowedTools: rt.toolsForRun().names(),
        allowedPaths: [],
        allowedDomains: [],
        grantedSecrets: [],
      },
    });
    return provider.calls
      .slice(before)
      .map((c) => {
        const first = c.request.messages[0]?.content;
        return typeof first === "string" ? first : JSON.stringify(first ?? "");
      })
      .filter((m) => m.startsWith("# Task brief") && m.includes(title));
  };
  const project = async (name: string) =>
    ProjectCard.parse(await send("POST", "/projects", { name, goal: `${name} for the club` }));

  it("Redo with the note field empty gives no person's note: the label 'Redo' is not the person's words", async () => {
    const p = await project("Motto");
    const t = await taskIn(p.id, "Set the motto to Sunday wind", "done");
    const row = await rowOf(p.id, t.id);
    TaskTransitionView.parse(
      await send("POST", `/tasks/${t.id}/action`, { version: row.version, action: "redo" }),
    );
    const [brief] = await briefsFor(p.id, t.title);
    expect(brief, "the coder got a brief for the redone task").toBeDefined();
    expect(brief).not.toContain("## The person's note on this task");
    expect(brief).not.toContain('"Redo"');
  });

  it("Edit that changes only the budget, note empty, puts no 'Edit <title>' in the brief", async () => {
    const p = await project("Kite guide");
    const t = await taskIn(p.id, "Write the kite guide in kite/guide/", "ready");
    const row = await rowOf(p.id, t.id);
    await send("PUT", `/tasks/${t.id}`, { version: row.version, budgetUsdMicro: 900_000 });
    const [brief] = await briefsFor(p.id, t.title);
    expect(brief).toBeDefined();
    expect(brief).not.toContain("Edit Write the kite guide in kite/guide/");
    expect(brief).not.toContain("## The person's note on this task");
  });

  it("a typed note reaches the brief once, after a restart too, and a later run after that work finished does not carry it again", async () => {
    const p = await project("Strings");
    const t = await taskIn(p.id, "Set the motto to Strings tight", "done");
    const note = "Make the motto shorter";
    const row = await rowOf(p.id, t.id);
    await send("POST", `/tasks/${t.id}/action`, { version: row.version, action: "redo", note });
    // The note waits for the next session across a restart of the app.
    await rt.close();
    await compose();
    const [first] = await briefsFor(p.id, t.title);
    expect(first).toBeDefined();
    expect(first?.split(note).length, "the note is in the brief exactly once").toBe(2);
    // The work finished (the critic accepted it); the person presses Redo again, nothing typed.
    const again = await rowOf(p.id, t.id);
    expect(again.status).toBe("done");
    await send("POST", `/tasks/${t.id}/action`, { version: again.version, action: "redo" });
    const [second] = await briefsFor(p.id, t.title);
    expect(second).toBeDefined();
    expect(second).not.toContain(note);
  });

  it("Stop, then Resume, with nothing typed: neither 'Stop' nor 'Resume' reaches the brief as a note", async () => {
    const p = await project("Resume");
    const t = await taskIn(p.id, "Write the packing list", "in_progress");
    const row = await rowOf(p.id, t.id);
    const stopped = TaskTransitionView.parse(
      await send("POST", `/tasks/${t.id}/action`, { version: row.version, action: "stop" }),
    );
    await send("POST", `/tasks/${t.id}/action`, {
      version: stopped.version,
      action: "resume",
    });
    const [brief] = await briefsFor(p.id, t.title);
    expect(brief).toBeDefined();
    expect(brief).not.toContain("## The person's note on this task");
    expect(brief).not.toContain('"Resume"');
    expect(brief).not.toContain('"Stop"');
  });
});
