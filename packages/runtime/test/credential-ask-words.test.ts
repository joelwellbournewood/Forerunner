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
      "Waits until 15:00 (your API key's limit)",
      "Waits until 15:00 (your API key's limit)",
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
      "Waits until 15:00 (your subscription's limit)",
      "Waits until 15:00 (your subscription's limit)",
    ]);
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  // d1109-cred-screens fix-up (CS-3: "under ask it also records the person's Wait for this
  // stop, so no card follows"): the kept Start is the person's Wait; before, its own wait filed
  // the card. The kept Start still goes on at once when the person says Use API key, now in the
  // Start dialog (the card's Use API key for a kept start is d1109-cred-engine's FX-CE B3 path,
  // kept for a card filed by other work before the keep).
  it("a Start kept for the stop's end files no ask card (the person's Wait) and goes on at once after the Start dialog's Use API key", async () => {
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
    expect(await askCards(rt), "the person's own Wait asks nothing").toHaveLength(0);
    await rt.billing.waits.wake();
    expect(await askCards(rt)).toHaveLength(0);
    // "Use API key" in the Start dialog: the kept Start goes on now, as the person's own start,
    // on the key.
    const goes = await req<{ result: string }>("/sessions", {
      agentId: rt.agent.id,
      projectId: project.id,
      useOtherCredential: true,
    });
    expect(goes.status, JSON.stringify(goes.body)).toBeLessThan(300);
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

  it("an ask card another project's work filed for the stop is answered Wait by a Start kept for it, with its Done line; no second card follows", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-keptwait-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-10-31T14:00:00Z"));
    let { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project: first } = await seedProject(rt, "Quote page", ["Style the page"]);
    await startSession(rt, first.id);
    await settleSessions(rt);
    const [card] = await askCards(rt);
    expect(card).toBeDefined();
    const { project: other } = await seedProject(rt, "Recipes", ["Write a recipe"]);
    expect(await rt.continuations.keepStart(other.id, rt.agent.id, {})).toBe(
      "A session of Recipes starts at 15:00.",
    );
    expect(await askCards(rt)).toHaveLength(0);
    const { row, shown } = await askCardNow(rt, req, card?.id ?? "");
    expect(row.status).toBe("answered");
    expect(shown?.outcome).toBe("Nothing moves until 15:00; then your session goes on.");
    expect(world.keyCalls()).toHaveLength(0);
    // After a restart the wake asks nothing again for this stop.
    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await world.compose());
    await rt.billing.waits.wake();
    expect(await askCards(rt)).toHaveLength(0);
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});

/** The ask card's row and what the Inbox shows of it now (Needs you or Answered). */
async function askCardNow(
  rt: RuntimeApp,
  req: Awaited<ReturnType<ReturnType<typeof credWorld>["compose"]>>["req"],
  id: string,
) {
  const row = await rt.store.humanRequest.mustGet(id);
  const inbox = (await req<InboxView & { answered?: HumanRequestView[] }>("/inbox")).body;
  const shown = [...inbox.requests, ...(inbox.answered ?? [])].find((r) => r.id === id);
  return { row, shown };
}

describe("d1109-cred-engine, run C: an open ask card closes when it no longer applies (CE-7)", () => {
  it("its stop ended while Forerunner was closed: the first wake closes it and the person's session goes on, on the subscription", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-down-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-10-31T14:00:00Z"));
    let { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project, tasks } = await seedProject(rt, "Quote page", [
      "Style the page",
      "Write the copy",
    ]);
    await startSession(rt, project.id);
    await settleSessions(rt);
    const [card] = await askCards(rt);
    expect(card).toBeDefined();
    // Closed before the reset; opened again after it.
    await rt.close();
    clock.set(Date.parse("2026-10-31T14:01:00Z"));
    world.limitSubscription(null);
    ({ rt, req } = await world.compose());
    await rt.billing.waits.wake();
    const { row, shown } = await askCardNow(rt, req, card?.id ?? "");
    expect(row.status).toBe("withdrawn");
    expect((row.change_card as { closed_why?: unknown }).closed_why).toBe("stop_ended");
    if (shown) expect(shown.outcome).toBe("Closed: your Claude subscription can work again.");
    await until("the person's session to go on on the subscription", async () => {
      const s = await Promise.all(tasks.map((t) => rt.store.task.mustGet(t.id)));
      return s.every((t) => t.status === "done") ? null : s.map((t) => t.status).join(",");
    });
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("a change to 'then wait' closes it, and the next pick waits", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-policy-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-10-31T14:00:00Z"));
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
    await startSession(rt, project.id);
    await settleSessions(rt);
    const [card] = await askCards(rt);
    await setPolicy(rt, "subscription_then_wait");
    await rt.billing.waits.wake();
    const { row, shown } = await askCardNow(rt, req, card?.id ?? "");
    expect(row.status).toBe("withdrawn");
    if (shown)
      expect(shown.outcome).toBe(
        'Closed: "Which Claude does the work" changed, so this question no longer applies.',
      );
    await expect(
      rt.billing.pick.pick({
        agentId: rt.agent.id,
        agentOwnerHumanId: rt.human.id,
        runner: "pc",
        modelTier: "sonnet",
        purpose: "session",
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("the API key cannot do the work either (at its own limit): the card closes, its yes could move nothing", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-othercannot-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-10-31T14:00:00Z"));
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
    await startSession(rt, project.id);
    await settleSessions(rt);
    const [card] = await askCards(rt);
    const key = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "api_key",
    );
    await rt.billing.pick.rest?.(key?.id ?? "", "2026-10-31T13:00:00.000Z", "usage limit");
    await rt.billing.waits.wake();
    const { row, shown } = await askCardNow(rt, req, card?.id ?? "");
    expect(row.status).toBe("withdrawn");
    expect((row.change_card as { closed_why?: unknown }).closed_why).toBe("other_cannot");
    if (shown) expect(shown.outcome).toBe("Closed: your API key cannot do the work now either.");
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("with the month cap reached no card is filed: Use API key could spend nothing", async () => {
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const world = credWorld({ clock, prefix: "fr-ask-cap-" });
    homes.push(world.home);
    world.limitSubscription(Date.parse("2026-10-31T14:00:00Z"));
    const { rt } = await world.compose();
    await setPolicy(rt, "subscription_then_ask");
    // A month cap already spent on the key this month.
    await rt.store.human.patch(rt.human.id, { monthly_cap_usd_micro: 1_000_000 } as never);
    const key = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "api_key",
    );
    await rt.store.costLedger.insert({
      human_id: rt.human.id,
      billing_source_id: key?.id ?? null,
      kind: "api",
      usd_micro: 1_200_000,
      model: "claude-sonnet-5-5",
      occurred_at: clock.nowIso(),
    } as never);
    // The subscription rests; the person presses Start during the stop (kept for its end).
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    await rt.billing.pick.rest?.(sub?.id ?? "", "2026-10-31T14:00:00.000Z", "usage limit");
    const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
    expect(await rt.continuations.keepStart(project.id, rt.agent.id, {})).toBe(
      "A session of Quote page starts at 15:00.",
    );
    expect(await askCards(rt)).toHaveLength(0);
    expect(world.keyCalls()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});

/**
 * l4-cred-engine L4-creds-7 (live check 4, L4-creds-6): after the ask card is answered, the
 * ended session's stored result still said "Waits for your answer: use your API key? The card
 * is in the Inbox." on its session page, the Overview's Last result and the Inbox's Update. Every
 * reader now reads it as it is now (`resultAfterWait`), also after composing again.
 */
describe("l4-cred-engine, run L4: a stored result's ask form after the card is answered", () => {
  for (const choice of ["Wait", "Use API key"] as const) {
    it(`after ${choice}: the session page, the Last result and the Update no longer say the card is in the Inbox`, async () => {
      const clock = new SimulatedClock("2026-10-31T09:00:00Z");
      const world = credWorld({ clock, prefix: "fr-ask-stored-" });
      homes.push(world.home);
      world.limitSubscription(Date.parse("2026-10-31T14:00:00Z"));
      let { rt, req } = await world.compose();
      await setPolicy(rt, "subscription_then_ask");
      const { project } = await seedProject(rt, "Quote page", ["Style the page", "Write the copy"]);
      const first = await startSession(rt, project.id);
      await settleSessions(rt);
      expect(first.summary).toContain(
        "Waits for your answer: use your API key? The card is in the Inbox.",
      );
      const [card] = await askCards(rt);
      const inbox = (await req<InboxView>("/inbox")).body;
      const shown = inbox.requests.find((r) => r.id === card?.id);
      const label = choice === "Wait" ? shown?.choices?.[1]?.label : shown?.choices?.[0]?.label;
      expect(label).toBe(choice);
      await req<HumanRequestView>(`/requests/${card?.id}/answer`, {
        answer: label,
        version: card?.version,
      });
      await settleSessions(rt);
      const read = async () => {
        const page = (await req<{ summary: string }>(`/sessions/${first.sessionId}`)).body.summary;
        const last = (
          await req<{ lastSession: { id: string; summary: string } | null }>(
            `/projects/${project.id}/summary`,
          )
        ).body.lastSession;
        const updates = (await req<InboxView>("/inbox")).body.messages.map((m) => m.body);
        return { page, last, updates };
      };
      for (let round = 0; round < 2; round++) {
        const { page, last, updates } = await read();
        expect(page).not.toContain("The card is in the Inbox");
        for (const u of updates) expect(u).not.toContain("The card is in the Inbox");
        if (last?.id === first.sessionId) expect(last.summary).not.toContain("The card is in");
        if (choice === "Wait") {
          expect(page).toContain(
            "Waits until 15:00 (your subscription's limit); then your session goes on.",
          );
          if (last?.id === first.sessionId)
            expect(last.summary).toContain(
              "Waits until 15:00 (your subscription's limit); then your session goes on.",
            );
        } else expect(page).toContain("Went on with your API key.");
        // Composed again on the same home: the same words.
        await settleSessions(rt);
        await rt.close();
        ({ rt, req } = await world.compose());
      }
      await settleSessions(rt);
      await rt.close();
    }, 120_000);
  }
});
