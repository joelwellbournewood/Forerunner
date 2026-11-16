import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { HumanRequestView, InboxView, TaskView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
import { credWorld, seedProject, setPolicy, startSession, until } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * d1109-cred-engine fix-up (ADR 0120, design §5: "a sentence promises only what the app does"):
 * the "waits for your answer ... The card is in the Inbox." form is said only while the one ask
 * card of the stop is open; a kept person Start counts as the person's waiting session when they
 * answer Use API key. Composed with no injected provider: the routed provider and the router over
 * the Messages API stand-in and a scripted Claude Code (`cred-world.ts`).
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const askCards = async (rt: RuntimeApp) =>
  (await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })).filter(
    (r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY,
  );

/** The person's lines of a session's log (no detail lines). */
async function logLines(
  req: Awaited<ReturnType<ReturnType<typeof credWorld>["compose"]>>["req"],
  sessionId: string,
) {
  const { body } = await req<{ text: string; audience?: string }[]>(
    `/sessions/${sessionId}/events`,
  );
  return body.filter((e) => e.audience !== "detail").map((e) => e.text);
}

describe("d1109-cred-engine, run C: the ask form only while its card is open", () => {
  it("under 'then ask me' with only an API key at its limit, no card is filed and nothing says one is", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, subscription: false, prefix: "fr-ask-nokey-" });
    homes.push(world.home);
    world.setKey({ limitUntilMs: Date.parse("2026-10-31T14:00:00Z") });
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project, tasks } = await seedProject(rt, "Quote page", [
      "Write the quote note",
      "Write the copy",
    ]);
    const result = await startSession(rt, project.id);
    await settleSessions(rt);
    expect(await askCards(rt)).toHaveLength(0);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("ready");
    // The session, its log and the rows say the plain wait (no card exists to answer).
    expect(result.summary).toContain(
      "Waits until 15:00 (your API key's limit); then your session goes on.",
    );
    expect(result.summary).not.toContain("The card is in the Inbox");
    const lines = await logLines(req, result.sessionId);
    expect(lines.filter((l) => l.includes("The card is in the Inbox"))).toEqual([]);
    expect(
      lines.filter((l) => l.includes("waits until 15:00")),
      lines.join("\n"),
    ).toEqual([
      'Your API key reached its usage limit; "Write the quote note" waits until 15:00 (your API key\'s limit); then your session goes on.',
    ]);
    const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(rows.map((r) => r.display?.label)).toEqual([
      "Waits until 15:00, your API key's limit",
      "Waits until 15:00, your API key's limit",
    ]);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("after Wait, a session started before the stop ends says the plain wait, not 'your answer'", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-afterwait-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-10-31T14:00:00Z"));
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project } = await seedProject(rt, "Quote page", ["Style the page", "Write the copy"]);
    const first = await startSession(rt, project.id);
    await settleSessions(rt);
    // While the card is open, the session says the work waits for the person's answer.
    expect(first.summary).toContain(
      "Waits for your answer: use your API key? The card is in the Inbox.",
    );
    const [card] = await askCards(rt);
    const inbox = (await req<InboxView>("/inbox")).body;
    const shown = inbox.requests.find((r) => r.id === card?.id);
    const answered = (
      await req<HumanRequestView>(`/requests/${card?.id}/answer`, {
        answer: shown?.choices?.[1]?.label,
        version: card?.version,
      })
    ).body;
    expect(answered.outcome).toBe("Nothing moves until 15:00; then your session goes on.");
    // A second session before the reset: no open card, so no "your answer" anywhere.
    const second = await startSession(rt, project.id);
    await settleSessions(rt);
    expect(await askCards(rt)).toHaveLength(0);
    expect(second.summary).not.toContain("your answer");
    expect(second.summary).toContain("Waits until 15:00 (your subscription's limit)");
    const lines = await logLines(req, second.sessionId);
    expect(lines.filter((l) => l.includes("your answer"))).toEqual([]);
    const rows = (await req<TaskView[]>(`/projects/${project.id}/tasks`)).body;
    expect(rows.map((r) => r.display?.label)).toEqual([
      "Waits until 15:00, your subscription's limit",
      "Waits until 15:00, your subscription's limit",
    ]);
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("a Start kept for the stop's end goes on at once after Use API key, and the Done line says so", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-keptstart-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-10-31T14:00:00Z"));
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    // The subscription is known to rest (an earlier call met its limit).
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    await rt.billing.pick.rest?.(sub?.id ?? "", "2026-10-31T14:00:00.000Z", "usage limit");
    const { project, tasks } = await seedProject(rt, "Quote page", [
      "Style the page",
      "Write the copy",
    ]);
    // The person presses Start during the stop: it is kept for the reset ("Start at 15:00").
    const kept = await rt.continuations.keepStart(project.id, rt.agent.id, {});
    expect(kept).toBe("A session of Quote page starts at 15:00.");
    const [card] = await askCards(rt);
    expect(card, "the kept Start's wait asks the person once").toBeDefined();
    const inbox = (await req<InboxView>("/inbox")).body;
    const shown = inbox.requests.find((r) => r.id === card?.id);
    expect(shown?.choices?.[1]?.explain).toBe(
      "Nothing moves until 15:00; then your session goes on with your subscription.",
    );
    const answered = (
      await req<HumanRequestView>(`/requests/${card?.id}/answer`, {
        answer: shown?.choices?.[0]?.label,
        version: card?.version,
      })
    ).body;
    expect(answered.outcome).toBe(
      "Your API key does the work until 15:00; your session goes on now.",
    );
    // The kept Start went on now, as the person's own start, on the key.
    await until("the kept Start's session to run both tasks", async () => {
      const s = await Promise.all(tasks.map((t) => rt.store.task.mustGet(t.id)));
      return s.every((t) => t.status === "done") ? null : s.map((t) => t.status).join(",");
    });
    expect(await rt.continuations.waiting(project.id)).toBeNull();
    const sessions = await rt.store.session.list({ project_id: project.id } as never, {
      limit: 10,
    });
    expect(sessions).toHaveLength(1);
    expect(world.keyCalls().length).toBeGreaterThan(0);
    expect(world.sdkCalls.filter((c) => !c.provider)).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});
