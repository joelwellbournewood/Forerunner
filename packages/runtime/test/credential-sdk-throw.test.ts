import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { CredentialPolicyView } from "../src/daemon/credential-policy-types.ts";
import {
  credWorld,
  REFUSED_SIGN_IN_TEXT,
  type SdkMessage,
  sdkThrow,
  seedProject,
  setPolicy,
  syntheticError,
} from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * l4-cred-engine L4-creds-2 (live check 4, LC-C22, LC-C31 and L4-creds-17; the owner's D5c: "If
 * a credential is refused, follow the framework ... as if it has run out, but also give the
 * user some kind of notification"): Agent SDK 0.3.304 ends Claude Code's error result with a
 * throw, and its stream starts with Claude Code's own synthetic error message. Before, the
 * task read as Failed ("Claude Code returned an error result: ..."), Settings stayed "Works
 * now", chat said "I could not answer", every later call went to the refused sign-in again,
 * and Costs listed '<synthetic>'. Composed as `fr daemon` composes it (no injected provider):
 * the scripted Claude Code in `cred-world.ts` has the real SDK's shape.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

type Json = Record<string, unknown>;
interface Card {
  id: string;
  title?: string;
  body?: string;
  status: string;
  why?: string;
}

async function startByDialog(
  req: Awaited<ReturnType<ReturnType<typeof credWorld>["compose"]>>["req"],
  agentId: string,
  projectId: string,
) {
  // As the Start dialog sends it (StartSessionDialog: agentId, projectId, trigger).
  return req<Json>("/sessions", { agentId, projectId, trigger: "manual" });
}

describe("l4-cred-engine, run L4: Claude Code's refusal, usage limit and budget end, when the SDK throws", () => {
  it("a refused sign-in under 'then wait' is one refused card and a waiting task; chat holds; no second request; no '<synthetic>' in Costs", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-sdk-throw-refused-" });
    homes.push(world.home);
    world.refuseSubscription();
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_wait");
    const { project, tasks } = await seedProject(rt, "Pond notes", ["Write notes/pond.md"]);
    const started = await startByDialog(req, rt.agent.id, project.id);
    expect(started.status).toBe(202);
    await settleSessions(rt);

    // The task waits for a new sign-in; it is not Failed.
    const task = await rt.store.task.mustGet(tasks[0]?.id ?? "");
    expect(task.status).toBe("ready");
    const rows = (await req<{ display?: { label?: string } }[]>(`/projects/${project.id}/tasks`))
      .body;
    expect(rows.map((r) => r.display?.label)).toEqual(["Waits for a new Claude sign-in"]);

    // Exactly one card in the Inbox: the refusal, never a failed-task card.
    const inbox = (await req<{ requests: Card[] }>("/inbox")).body;
    const open = inbox.requests.filter((r) => r.status === "open");
    expect(open.map((c) => [c.title, c.body])).toEqual([
      [
        "Anthropic refused your Claude sign-in",
        "The sign-in has expired or was signed out. Save a new one in Settings; until then the work waits.",
      ],
    ]);

    // No "... failed" notification.
    const notes = (
      await req<{ notifications: { title: string; kind: string }[] }>(
        "/notifications/recent?limit=50",
      )
    ).body.notifications;
    expect(notes.filter((n) => / failed$/.test(n.title))).toEqual([]);

    // The sign-in is marked refused, and Settings says so.
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    expect(typeof (sub?.limits as { refusedAt?: unknown } | undefined)?.refusedAt).toBe("string");
    const policy = (await req<CredentialPolicyView>("/settings/credential-policy")).body;
    expect(policy.rows.find((r) => r.kind === "subscription")?.state).toBe(
      "Refused: save a new sign-in",
    );

    // A chat question gets the hold reply and asks the refused sign-in nothing.
    const calls = world.sdkCalls.length;
    const chat = (
      await req<{ reply: string }>("/chat", {
        humanId: rt.human.id,
        agentId: rt.agent.id,
        projectId: project.id,
        text: "What is next on this project?",
      })
    ).body.reply;
    expect(chat).toMatch(/^Anthropic refused your Claude sign-in, so I have not answered\./);
    expect(world.sdkCalls.length).toBe(calls);
    expect(world.sdkCalls).toHaveLength(1);
    expect(world.keyCalls()).toHaveLength(0);

    // Costs never list Claude Code's own error message as a model.
    const costs = JSON.stringify((await req<Json>(`/projects/${project.id}/costs`)).body);
    expect(costs).not.toContain("<synthetic>");
    const ledger = await rt.store.costLedger.list({ human_id: rt.human.id }, { limit: 100 });
    expect(ledger.map((r) => r.model)).not.toContain("<synthetic>");
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("a usage limit followed by the throw rests the task until the reset (not Failed)", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-sdk-throw-limit-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-11-17T14:40:00Z"));
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_wait");
    const { project, tasks } = await seedProject(rt, "Map notes", ["Write notes/map.md"]);
    // Started as chat or the Inbox would start it: the run meets the limit (the dialog keeps
    // its Start for the reset, so the scheduler is asked directly here).
    await rt.scheduler.requestStart({
      agentId: rt.agent.id,
      projectId: project.id,
      trigger: "manual",
      by: "person",
      reason: "test",
    } as never);
    await settleSessions(rt);
    const task = await rt.store.task.mustGet(tasks[0]?.id ?? "");
    expect(task.status).toBe("ready");
    const rows = (await req<{ display?: { label?: string } }[]>(`/projects/${project.id}/tasks`))
      .body;
    expect(rows[0]?.display?.label).toMatch(/^Waits until 15:40/);
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    expect((sub?.limits as { restingUntil?: string } | undefined)?.restingUntil).toBe(
      "2026-11-17T14:40:00.000Z",
    );
    const failed = (await req<{ requests: Card[] }>("/inbox")).body.requests.filter((r) =>
      (r.title ?? "").endsWith("failed"),
    );
    expect(failed).toEqual([]);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("Claude Code's own spending limit followed by the throw is a budget stop, never Failed", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-sdk-throw-budget-" });
    homes.push(world.home);
    world.setRunScript(async function* (): AsyncIterable<SdkMessage> {
      yield { type: "system", subtype: "init", session_id: "cc-budget" };
      yield {
        type: "assistant",
        message: {
          id: "m-budget",
          content: [{ type: "text", text: "Working." }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      };
      yield { type: "result", subtype: "error_max_budget_usd", is_error: true };
      throw sdkThrow("error_max_budget_usd");
    });
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_wait");
    const { project, tasks } = await seedProject(rt, "Budget notes", ["Write notes/budget.md"]);
    await startByDialog(req, rt.agent.id, project.id);
    await settleSessions(rt);
    const task = await rt.store.task.mustGet(tasks[0]?.id ?? "");
    expect(task.status).not.toBe("failed");
    const runs = await rt.store.run.forTask(task.id);
    // Each run ends as the budget stop it was (before: "error", a Failed task tried again).
    expect(runs.length).toBeGreaterThan(0);
    expect(new Set(runs.map((r) => r.outcome))).toEqual(new Set(["budget_exceeded"]));
    const failed = (await req<{ requests: Card[] }>("/inbox")).body.requests.filter((r) =>
      (r.title ?? "").endsWith("failed"),
    );
    expect(failed).toEqual([]);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("C5L-9: a task run and a chat question that meet the refusal at the same moment give one mark, one card and no second request", async () => {
    const clock = new SimulatedClock("2026-11-17T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-sdk-throw-tick-" });
    homes.push(world.home);
    world.refuseSubscription();
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_wait");
    const { project } = await seedProject(rt, "Bird notes", ["Write notes/bird.md"]);
    const [, chat] = await Promise.all([
      startByDialog(req, rt.agent.id, project.id),
      req<{ reply: string }>("/chat", {
        humanId: rt.human.id,
        agentId: rt.agent.id,
        projectId: project.id,
        text: "What is next?",
      }),
    ]);
    await settleSessions(rt);
    expect(chat.body.reply).toMatch(/^Anthropic refused your Claude sign-in/);
    // At most one call each went out before the mark stood, and never a third.
    expect(world.sdkCalls.length).toBeLessThanOrEqual(2);
    const before = world.sdkCalls.length;
    await req<{ reply: string }>("/chat", {
      humanId: rt.human.id,
      agentId: rt.agent.id,
      projectId: project.id,
      text: "And now?",
    });
    expect(world.sdkCalls.length).toBe(before);
    const cards = (await req<{ requests: Card[] }>("/inbox")).body.requests.filter(
      (r) => r.status === "open" && r.title === "Anthropic refused your Claude sign-in",
    );
    expect(cards).toHaveLength(1);
    const audits = (await rt.store.auditLog.list({}, { limit: 200 })).filter(
      (a) => (a as { action?: string }).action === "billing.credential_refused",
    );
    expect(audits.length).toBeLessThanOrEqual(1);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});

// Kept beside the world's own refusal for a reader of this file.
void syntheticError;
void REFUSED_SIGN_IN_TEXT;
