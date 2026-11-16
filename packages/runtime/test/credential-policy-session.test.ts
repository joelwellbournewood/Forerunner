import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { InboxView, TaskView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { TASK_CHECK_RUN_SPECIALIST } from "../src/models/ladder.ts";
import { CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
import { keptNotesOf } from "../src/session/task-list-notes.ts";
import { type CredWorld, credWorld, seedProject, setPolicy, startSession } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * d1109-cred-engine CE-3 and CE-4 (ADR 0120; the owner's answer 4 of 2026-11-09: one order for
 * every call, "tasks, chat, planning, reviews, the task check, jobs"): the daemon composed with
 * no injected provider (the routed provider over the Messages API stand-in and a scripted Claude
 * Code, `cred-world.ts`). The subscription serves the first task's run and then meets its limit
 * on the critic's review of it: under "then wait" and an unanswered "then ask me", the review
 * waits in review without a try, the agent's task check of the run's report is not made (no Run
 * row, nothing booked, its notes kept), the next task waits, chat holds and a plan from a brief
 * waits, and the API key gets no request; under "then the API key" each goes on the key.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const RESET = Date.parse("2026-10-31T14:00:00Z");
const REPORT =
  'Made index.html.\nFor the task list: "Write the copy" needs the page to exist first. Lesson: none.';

async function stoppedAtReview(world: CredWorld, policy: string | null) {
  const { rt, req } = await world.compose();
  if (policy) await setPolicy(rt, policy);
  world.setRunReport(REPORT);
  // The first Claude Code call (the run) is served; the next (its review) meets the limit.
  world.limitSubscriptionAfter(1, RESET);
  const { project, tasks } = await seedProject(rt, "Quote page", [
    "Style the page",
    "Write the copy",
  ]);
  const result = await startSession(rt, project.id);
  await settleSessions(rt);
  return { rt, req, project, tasks, result };
}

const taskCheckRuns = async (rt: RuntimeApp, sessionId: string) =>
  (await rt.store.run.list({ session_id: sessionId } as never, { limit: 100 })).filter(
    (r) => r.specialist === TASK_CHECK_RUN_SPECIALIST,
  );

const keyLedger = async (rt: RuntimeApp) => {
  const key = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
    (s) => s.kind === "api_key",
  );
  return (
    await rt.store.costLedger.list({ human_id: rt.human.id } as never, { limit: 1000 })
  ).filter((r) => r.billing_source_id === key?.id);
};

const chat = async (rt: RuntimeApp, req: Awaited<ReturnType<CredWorld["compose"]>>["req"]) =>
  (
    await req<{ reply: string }>("/chat", {
      humanId: rt.human.id,
      agentId: rt.agent.id,
      text: "what is next?",
    })
  ).body.reply;

describe("d1109-cred-engine, run C: every call follows the policy in a session (CE-3, CE-4)", () => {
  for (const policy of [null, "subscription_then_ask"] as const) {
    it(`${policy ?? "nothing chosen (subscription first, then wait)"}: the review waits in review, the task check is not made, chat and planning hold, and the API key gets no request`, async () => {
      const clock = new SimulatedClock("2026-10-31T09:00:00Z");
      const world = credWorld({ clock, prefix: "fr-policy-session-" });
      homes.push(world.home);
      const { rt, req, project, tasks, result } = await stoppedAtReview(world, policy);
      // The run on the subscription, then its review met the limit: two Claude Code calls, no
      // third (the task check and the second task's run are held before any call).
      expect(
        world.sdkCalls.map((c) => (c.review ? "review" : c.provider ? "call" : "run")),
      ).toEqual(["run", "review"]);
      // The reviewed task waits for its review without a counted try (back to ready, its run
      // kept so the next session reviews it without running it again, W15-27); the next waits.
      const [style, copy] = await Promise.all(tasks.map((t) => rt.store.task.mustGet(t.id)));
      expect([style?.status, style?.attempt]).toEqual(["ready", 0]);
      expect([copy?.status, copy?.attempt]).toEqual(["ready", 0]);
      // The task check: no Run row, nothing booked, its notes kept for the next boundary.
      expect(await taskCheckRuns(rt, result.sessionId)).toEqual([]);
      const kept = keptNotesOf(await rt.store.project.mustGet(project.id));
      expect(kept.flatMap((n) => n.lines.map((l) => l.text))).toEqual([
        '"Write the copy" needs the page to exist first. Lesson: none.',
      ]);
      // Chat holds: the hold reply, no call.
      expect(await chat(rt, req)).toBe(
        "Your Claude subscription is at its limit until 15:00, so I have not answered. I can still add, move and start tasks.",
      );
      // A plan from a brief waits for the subscription too.
      const created = (
        await req<{ id: string }>("/projects", {
          name: "Quotes",
          goal: "A page that shows a random quote",
          brief: "A page that shows a random quote.",
          intake: true,
        })
      ).body;
      await rt.intake.inFlight(created.id)?.catch(() => undefined);
      const plan = (
        await req<{ state: string; wait: { text: string } | null }>(
          `/projects/${created.id}/intake`,
        )
      ).body;
      expect(plan.state).toBe("waiting");
      expect(plan.wait?.text).toBe(
        policy === "subscription_then_ask"
          ? "Planning waits for your answer: use your API key? The card is in the Inbox."
          : "Planning waits until 15:00 (your subscription's limit) and starts by itself.",
      );
      // Nothing reached the API key, and nothing is booked on it.
      expect(world.keyCalls()).toHaveLength(0);
      expect(await keyLedger(rt)).toEqual([]);
      // Under 'ask': exactly one card for the stop, though the review, the check, the run and
      // planning all held on it.
      const asks = (
        await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })
      ).filter((r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY);
      expect(asks).toHaveLength(policy === "subscription_then_ask" ? 1 : 0);
      const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
      expect(rows.map((r) => r.display?.label)).toEqual(
        Array(2).fill(
          policy === "subscription_then_ask"
            ? "Waits for your answer: use your API key?"
            : "Waits until 15:00, your subscription's limit",
        ),
      );
      if (policy === "subscription_then_ask") {
        const inbox = (await req<InboxView>("/inbox")).body;
        expect(inbox.requests.filter((r) => r.status === "open").map((r) => r.title)).toContain(
          "Use your API key until 15:00?",
        );
      }
      await settleSessions(rt);
      await rt.close();
    }, 120_000);
  }

  it("subscription_then_key: the review, the task check and the next task go on with the API key, and the session log names it", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-policy-session-key-" });
    homes.push(world.home);
    const { rt, req, tasks, result } = await stoppedAtReview(world, "subscription_then_key");
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("done");
    // The task check ran once, on the key, its cost in the session.
    const checks = await taskCheckRuns(rt, result.sessionId);
    expect(checks).toHaveLength(1);
    const key = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "api_key",
    );
    expect(checks[0]?.billing_source_id).toBe(key?.id);
    expect(world.keyCalls().length).toBeGreaterThan(0);
    expect((await keyLedger(rt)).length).toBeGreaterThan(0);
    const lines = (
      await req<{ text: string; audience?: string }[]>(`/sessions/${result.sessionId}/events`)
    ).body.map((e) => e.text);
    expect(lines).toContain(
      "The Claude subscription reached its usage limit and rests until 15:00; the API key answered instead.",
    );
    await settleSessions(rt);
    await rt.close();
  }, 120_000);
});
