import { formatChf } from "@forerunner/billing";
import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { EventView, SessionView, TaskDetailView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { credWorld, type Req, seedProject, setPolicy, startSession } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * C5-left-1 (d1109-cred-screens, run C; CE-11, ADR 0120; the owner's 7a: "allow the task to be
 * completed by the API, but in a transparent way"): a session that moves onto the API key at the
 * subscription's limit says so once in its log, as its data: '"Style the page" goes on with your
 * API key from where it stopped: ...' once (a later task's switch a detail line), 'Your Claude
 * subscription can work again; the next tasks use it.' once when the subscription serves again,
 * `switchedFrom` on the Run rows, `SessionResult.switched` summed from the ledger, and the session
 * page's line read from the ledger. Before, the log said '...; "Style the page" continues on your
 * API key now.' and nothing recorded the switch. The daemon is composed with no injected provider
 * (`cred-world.ts`), twice on one home for the restart.
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const START = Date.parse("2026-11-16T13:00:00Z"); // 14:00 in Zurich
const RESET = START + 60_000; // 14:01 in Zurich

const personLines = (events: EventView[]) =>
  events.filter((e) => e.audience !== "detail").map((e) => e.text);

async function keySource(rt: RuntimeApp) {
  return (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
    (s) => s.kind === "api_key",
  );
}

describe("d1109-cred-screens, run C: the switch's data and its session log line (C5-left-1)", () => {
  it("under 'then the API key': one switch line, a detail for the next task, the back line, the Run rows, the result and the page's line; nothing written twice after a restart", async () => {
    const clock = new SimulatedClock(new Date(START).toISOString());
    const world = credWorld({ clock, prefix: "fr-cred-switch-" });
    homes.push(world.home);
    let { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_key");
    // The subscription is at its limit from the first call until 14:01.
    world.limitSubscription(RESET);
    // The subscription serves again while the second task works on the key.
    const stream = world.keyModel.stream.bind(world.keyModel);
    world.keyModel.stream = (r) => {
      if (JSON.stringify(r.messages).includes("Write the copy")) clock.set(RESET + 60_000);
      return stream(r);
    };
    const { project, tasks } = await seedProject(rt, "Quote page", [
      "Style the page",
      "Write the copy",
      "Check the links",
    ]);
    const result = await startSession(rt, project.id);
    await settleSessions(rt);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("done");

    const events = async (r: Req) =>
      (await r<EventView[]>(`/sessions/${result.sessionId}/events`)).body;
    const all = await events(req);
    const lines = personLines(all);
    expect(
      lines.filter((l) => l.includes("goes on with your API key")),
      "the switch's line, once",
    ).toEqual([
      '"Style the page" goes on with your API key from where it stopped: your subscription is at its limit until 14:01.',
    ]);
    // The second task's switch is a detail line; the back line once, before the third task.
    const details = all.filter((e) => e.audience === "detail").map((e) => e.text);
    expect(details).toContain(
      '"Write the copy" runs on your API key: your subscription is at its limit until 14:01.',
    );
    expect(lines.filter((l) => l.includes("can work again"))).toEqual([
      "Your Claude subscription can work again; the next tasks use it.",
    ]);
    expect(all.some((e) => e.text.includes("continues on your API key now"))).toBe(false);

    // The Run rows: the key's runs carry switchedFrom; the third task ran on the subscription.
    const key = await keySource(rt);
    const runs = await rt.store.run.list({ session_id: result.sessionId } as never, {
      limit: 100,
    });
    const workRuns = (taskId: string) =>
      runs.filter((r) => r.task_id === taskId && r.specialist !== "critic");
    for (const t of tasks.slice(0, 2)) {
      const onKey = workRuns(t.id).filter((r) => r.billing_source_id === key?.id);
      expect(onKey.length, t.title).toBeGreaterThan(0);
      for (const r of onKey)
        expect(r.artifacts).toContainEqual({
          switchedFrom: {
            kind: "subscription",
            stop: "limit",
            until: expect.any(String),
            by: "policy",
          },
        });
    }
    const third = tasks[2]?.id ?? "";
    expect(workRuns(third).some((r) => r.billing_source_id === key?.id)).toBe(false);
    expect(
      workRuns(third).every(
        (r) =>
          !(r.artifacts as unknown[]).some(
            (a) => !!a && typeof a === "object" && "switchedFrom" in a,
          ),
      ),
    ).toBe(true);

    // The task drawer's run line (CS-6), its CHF the Run row's; none for the third task's runs.
    const drawer = async (taskId: string) =>
      (await req<TaskDetailView>(`/tasks/${taskId}`)).body.runs;
    const styleRuns = await drawer(tasks[0]?.id ?? "");
    const keyRun = styleRuns.find((r) => r.switchLine);
    expect(keyRun?.switchLine).toBe(
      `On your API key after your subscription's limit · ${formatChf(keyRun?.cost.chfMicro ?? -1)}`,
    );
    expect((await drawer(third)).some((r) => r.switchLine)).toBe(false);

    // SessionResult.switched: the two tasks, each with the ledger's sum on the key.
    const booked = async (taskId: string) =>
      (
        await rt.store.costLedger.sum({
          sessionId: result.sessionId,
          taskId,
          billingSourceId: key?.id ?? "",
        })
      ).usd_micro;
    expect(result.switched).toEqual([
      {
        taskId: tasks[0]?.id,
        from: "subscription",
        to: "api_key",
        usdMicro: await booked(tasks[0]?.id ?? ""),
      },
      {
        taskId: tasks[1]?.id,
        from: "subscription",
        to: "api_key",
        usdMicro: await booked(tasks[1]?.id ?? ""),
      },
    ]);
    expect(result.switched?.[0]?.usdMicro).toBeGreaterThan(0);

    // The session page's line after its end, its figures the ledger's split.
    const page = async (r: Req) =>
      (await r<SessionView>(`/sessions/${result.sessionId}`)).body.switchLine;
    const onKey = await rt.store.costLedger.sum({
      sessionId: result.sessionId,
      billingSourceId: key?.id ?? "",
    });
    const total = await rt.store.costLedger.sum({ sessionId: result.sessionId });
    const line = await page(req);
    expect(line).toBe(
      `Your API key took over at 14:00 (your subscription's limit): ${formatChf(onKey.chf_micro)} of ${formatChf(total.chf_micro)}.`,
    );

    // Composed again on the same home: the log, the Run rows and the page's line are as they
    // were, and nothing wrote the switch again.
    const switchEvents = all.filter((e) => e.type === "billing.switch").length;
    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await world.compose());
    const again = await events(req);
    expect(again.filter((e) => e.type === "billing.switch")).toHaveLength(switchEvents);
    expect(personLines(again).filter((l) => l.includes("goes on with your API key"))).toHaveLength(
      1,
    );
    expect(await page(req)).toBe(line);
    await settleSessions(rt);
    await rt.close();
  }, 120_000);

  it("a session that never moved has no switch line, no switchedFrom and no switched", async () => {
    const clock = new SimulatedClock(new Date(START).toISOString());
    const world = credWorld({ clock, prefix: "fr-cred-noswitch-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    await setPolicy(rt, "subscription_then_key");
    const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
    const result = await startSession(rt, project.id);
    await settleSessions(rt);
    const all = (await req<EventView[]>(`/sessions/${result.sessionId}/events`)).body;
    expect(all.some((e) => e.type === "billing.switch" || e.type === "billing.back")).toBe(false);
    expect(result.switched).toBeUndefined();
    expect((await req<SessionView>(`/sessions/${result.sessionId}`)).body.switchLine).toBeNull();
    await settleSessions(rt);
    await rt.close();
  }, 120_000);
});
