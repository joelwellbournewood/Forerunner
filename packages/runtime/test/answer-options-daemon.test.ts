import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { SIGNOFF_OPTIONS, signoffCard } from "@forerunner/critic";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import type { HumanRequestRow, JsonObject } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { requestView } from "../src/daemon/views.ts";
import { EXTENSION_APPROVAL_OPTIONS } from "../src/extensions/approvals.ts";
import { StateModelWatchApprovals } from "../src/models/watch.ts";
import { SPECIALIST_APPROVAL_OPTIONS, specialistKeyOf } from "../src/registry/approval.ts";
import { BLOCKED_FINDINGS_KEY, BLOCKED_FINDINGS_OPTIONS } from "../src/session/findings.ts";
import { INTAKE_OPTIONS, intakeKey } from "../src/session/intake.ts";
import { PLAN_APPROVAL_OPTIONS, planKeyOf } from "../src/session/plan-approval.ts";
import { StateApprovals } from "../src/wiring/state-ports.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-034: a typed answer that matches none of a structured card's options closed the card (the
 * request became `answered`) and the reader then recorded `unrecognized_answer`, so the task sat
 * in review or `needs_human` with no card to answer. The daemon's `POST /requests/:id/answer`
 * now refuses such an answer with a `validation` error that lists the options as the Inbox
 * shows them, and the request stays open. A matching typed answer ("approve", any case,
 * surrounding spaces, the words the card's reader takes) is accepted; a question that takes
 * free text still does.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
type Json = Record<string, unknown>;

describe("the daemon refuses an answer a structured card cannot act on (U-034)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let projectId = "";
  const clock = new SimulatedClock("2026-03-05T08:00:00Z");

  beforeAll(async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-answer-options-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
    projectId = (await rt.store.project.insert({ name: "Answers", goal: "Cards that act" })).id;
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
  });

  /** The answer exactly as the Inbox sends it: the version it loaded and the typed text. */
  const answer = (r: HumanRequestRow, text: unknown) =>
    app.request(`/requests/${r.id}/answer`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ version: r.version, answer: text }),
    });

  const card = (fields: {
    options: readonly unknown[];
    key?: string;
    kind?: HumanRequestRow["kind"];
    extra?: JsonObject;
  }) =>
    rt.store.humanRequest.insert({
      human_id: rt.human.id,
      project_id: projectId,
      kind: fields.kind ?? "approval",
      why: "A structured card",
      steps: [],
      options: [...fields.options] as string[],
      blocking: true,
      risk: "low",
      change_card: fields.key ? { key: fields.key, applied_at: null, ...fields.extra } : null,
    });

  /** The cards whose answer can only be one of their options, as their producers file them. */
  const structured: Array<[string, () => Promise<HumanRequestRow>, string]> = [
    [
      "critic sign-off",
      () =>
        card({
          options: SIGNOFF_OPTIONS,
          key: "critic:signoff",
          extra: signoffCard({
            taskId: "t-missing",
            reviewId: null,
            runId: null,
            findingIds: [],
            reason: "verdict",
          }),
        }),
      "  Accept ",
    ],
    [
      "blocked findings",
      () => card({ options: BLOCKED_FINDINGS_OPTIONS, key: BLOCKED_FINDINGS_KEY }),
      "REWORK",
    ],
    ["session plan", () => card({ options: PLAN_APPROVAL_OPTIONS, key: planKeyOf("s-1") }), "no"],
    ["intake", () => card({ options: INTAKE_OPTIONS, key: intakeKey("p-none") }), "Decline"],
    [
      "specialist proposal",
      () => card({ options: SPECIALIST_APPROVAL_OPTIONS, key: specialistKeyOf("ghost") }),
      "reject",
    ],
    [
      "model watch",
      async () => {
        const out = await new StateModelWatchApprovals(rt.store).ask({
          reportId: "report-1",
          humanId: rt.human.id,
          summary: "A cheaper model is available",
          options: ["adopt", "ignore", "remind"],
          recommendations: [],
          pricingProposal: {} as never,
          steps: [],
        });
        return rt.store.humanRequest.mustGet(String(out.status === "pending" && out.requestId));
      },
      "Ignore",
    ],
    [
      "tool approval",
      async () => {
        const session = await rt.store.session.insert({
          agent_id: rt.agent.id,
          project_id: projectId,
          trigger: "manual",
          status: "running",
          started_at: clock.nowIso(),
        });
        await new StateApprovals(rt.store).request({
          sessionId: session.id,
          runId: "r-tool",
          agentId: rt.agent.id,
          humanId: rt.human.id,
          projectId,
          tool: "Bash",
          actionClass: "external_write",
          risk: "low",
          why: "Push the branch",
          input: { command: "git push" },
        });
        const [row] = await rt.store.humanRequest.list({ session_id: session.id });
        return row as HumanRequestRow;
      },
      "Approve",
    ],
    ["extension", () => card({ options: EXTENSION_APPROVAL_OPTIONS }), "deny"],
  ];

  for (const [name, make, typed] of structured) {
    it(`${name}: an unmatched answer is refused with the options and the card stays open; "${typed.trim()}" is accepted`, async () => {
      const row = await make();
      const shown = requestView(row, null).options;
      const refused = await answer(row, "maybe later");
      expect(refused.status).toBe(400);
      const body = (await refused.json()) as Json;
      expect(body.code).toBe("validation");
      expect(body.message).toContain(`Choose one of: ${shown.join(", ")}`);
      expect((body.details as Json).options).toEqual(shown);
      const after = await rt.store.humanRequest.mustGet(row.id);
      expect(after.status).toBe("open");
      expect(after.version).toBe(row.version);
      const inbox = (await (
        await app.request(`/inbox?humanId=${rt.human.id}`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).json()) as { requests: { id: string }[] };
      expect(inbox.requests.map((r) => r.id)).toContain(row.id);

      const accepted = await answer(after, typed);
      expect(accepted.status).toBe(200);
      expect((await rt.store.humanRequest.mustGet(row.id)).status).toBe("answered");
    });
  }

  it("each shown option is accepted as the click sends it", async () => {
    for (const [, make] of structured) {
      const row = await make();
      const option = requestView(row, null).options[0] as string;
      expect((await answer(row, option)).status).toBe(200);
    }
  });

  it("chat and voice (`request.answer`) refuse the same answer with the same options", async () => {
    const row = await card({ options: BLOCKED_FINDINGS_OPTIONS, key: BLOCKED_FINDINGS_KEY });
    if (!rt.conversation) throw new Error("no conversation agent");
    const turn = {
      humanId: rt.human.id,
      agentId: rt.agent.id,
      activeProjectId: projectId,
      sessionId: await rt.conversation.conversationSessionId(rt.agent.id, null),
      source: "text" as const,
      wordsUsed: "answer the findings card: maybe later",
    };
    const refused = await rt.commands.execute(
      { name: "request.answer", params: { request: row.id, answer: "maybe later" } },
      turn,
    );
    expect(refused).toMatchObject({ status: "refused", code: "validation" });
    expect(refused.reason).toContain("Choose one of: rework, accept, cancel");
    expect((await rt.store.humanRequest.mustGet(row.id)).status).toBe("open");
    const accepted = await rt.commands.execute(
      { name: "request.answer", params: { request: row.id, answer: "Rework" } },
      turn,
    );
    expect(accepted.status).not.toBe("refused");
  });

  it("a question that takes free text still accepts it", async () => {
    const question = await card({ kind: "decision", options: ["eu-central", "us-east"] });
    expect((await answer(question, "Frankfurt, close to the users")).status).toBe(200);
    const note = await card({ kind: "info", options: [] });
    expect((await answer(note, "Thanks, noted")).status).toBe(200);
  });
});
