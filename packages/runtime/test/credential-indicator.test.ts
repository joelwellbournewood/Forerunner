import { SimulatedClock } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import type { ProjectCard, RunningView, SessionView } from "../src/daemon/api-types.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
import { credWorld, seedProject, setPolicy, startSession } from "./cred-world.ts";
import { removeHomes, settleSessions } from "./helpers.ts";

/**
 * CS-7 (d1109-cred-screens, run C; D8, the owner, 2026-11-09: "it should at least be very clear
 * to a user when a run is ongoing. That should also be very visually clear no matter where the
 * person is."; 7a: "allow the task to be completed by the API, but in a transparent way"): the
 * run indicator (GET /running), the project's status line and the session page say a person's
 * session waiting on the subscription's share or a key's monthly cap in their own forms, with
 * the time in the person's clock (the stop ends at the month's start, UTC), Change the allowance
 * for the share, Answer while the ask card is open, and ' on your API key' while the running task
 * went on with the credential the person's choice puts second. Before, a month's stop read
 * 'waiting for Claude, then it goes on' and nothing said which credential the task ran on.
 *
 * The daemon is composed as `fr daemon` composes it, with no injected provider (`cred-world.ts`).
 */
const homes: string[] = [];
afterAll(() => removeHomes(homes));

const START = Date.parse("2026-11-16T13:00:00Z"); // 14:00 in Zurich
const ALLOWANCE = { label: "Change the allowance", to: "/settings#plan-allowance" };

async function sourceOf(rt: RuntimeApp, kind: string) {
  const row = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
    (s) => s.kind === kind,
  );
  if (!row) throw new Error(`no ${kind} row`);
  return row;
}

/** A ledger row on a source this month: the share the plan reported, or a key's spend. */
async function book(rt: RuntimeApp, sourceId: string, kind: string, over: Record<string, unknown>) {
  await rt.store.costLedger.record({
    human_id: rt.human.id,
    agent_id: rt.agent.id,
    billing_source_id: sourceId,
    kind,
    usd_micro: 0,
    chf_micro: 0,
    rate_chf_per_usd: 0.8,
    model: "claude-sonnet-5-5",
    tokens_in: 0,
    tokens_out: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    occurred_at: rt.clock.nowIso(),
    ...over,
  } as never);
}

describe("d1109-cred-screens, run C: the run indicator's credential forms (CS-7)", () => {
  it("a person's session waiting on the share: 'waiting until Tue 1 Dec, 01:00, then it goes on' with Cancel and Change the allowance; the status line and the session page say the same stop", async () => {
    const clock = new SimulatedClock(new Date(START).toISOString());
    const world = credWorld({ clock, prefix: "fr-cred-indicator-share-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      const sub = await sourceOf(rt, "subscription");
      // The plan reported 95% of its allowance used: the share Forerunner may use is used.
      await book(rt, sub.id, "subscription", { plan_usage_share: 0.95 });
      const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
      const result = await startSession(rt, project.id);
      await settleSessions(rt);
      const running = (await req<RunningView[]>("/running")).body;
      expect(running).toEqual([
        expect.objectContaining({
          projectId: project.id,
          state: "waiting",
          text: "Quote page · waiting until Tue 1 Dec, 01:00, then it goes on",
          cancel: true,
          stop: [],
          links: [ALLOWANCE],
        }),
      ]);
      expect(JSON.stringify(running)).not.toContain("waiting for Claude");
      const card = (await req<ProjectCard[]>("/projects")).body.find((p) => p.id === project.id);
      expect(card?.statusLine?.text).toBe(
        "Waiting until Tue 1 Dec, 01:00 (your subscription's share), then it goes on",
      );
      const page = (await req<SessionView>(`/sessions/${result.sessionId}`)).body;
      expect(page.waitBlock?.text).toBe(
        'Waiting until Tue 1 Dec, 01:00 (your subscription\'s share), then it goes on with "Style the page".',
      );
      // Nothing reached the API key: under 'then wait' the work waits.
      expect(world.keyCalls()).toHaveLength(0);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 60_000);

  it("a person's session waiting on the API key's monthly cap names the cap, with Cancel only", async () => {
    const clock = new SimulatedClock(new Date(START).toISOString());
    const world = credWorld({ clock, prefix: "fr-cred-indicator-month-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "key_only");
      const key = await sourceOf(rt, "api_key");
      await rt.store.billingSource.update(key.id, key.version, {
        limits: { ...(key.limits as Record<string, unknown>), monthlyUsdMicro: 10_000 } as never,
      });
      await book(rt, key.id, "api", { usd_micro: 20_000, chf_micro: 16_000 });
      const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
      const result = await startSession(rt, project.id);
      await settleSessions(rt);
      const [waiting, ...more] = (await req<RunningView[]>("/running")).body;
      expect(more).toEqual([]);
      expect(waiting).toMatchObject({
        state: "waiting",
        text: "Quote page · waiting until Tue 1 Dec, 01:00 (your API key's monthly cap), then it goes on",
        cancel: true,
      });
      expect(waiting?.links).toBeUndefined();
      expect(waiting?.text.length).toBeLessThanOrEqual(90);
      const card = (await req<ProjectCard[]>("/projects")).body.find((p) => p.id === project.id);
      expect(card?.statusLine?.text).toBe(
        "Waiting until Tue 1 Dec, 01:00 (your API key's monthly cap), then it goes on",
      );
      const page = (await req<SessionView>(`/sessions/${result.sessionId}`)).body;
      expect(page.waitBlock?.text).toBe(
        'Waiting until Tue 1 Dec, 01:00 (your API key\'s monthly cap), then it goes on with "Style the page".',
      );
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 60_000);

  it("under 'ask', the waiting session's bar offers Answer opening the card while it is open; the session page says the time and offers it too", async () => {
    const clock = new SimulatedClock(new Date(START).toISOString());
    const world = credWorld({ clock, prefix: "fr-cred-indicator-ask-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "subscription_then_ask");
      world.limitSubscription(START + 2 * 3_600_000); // 16:00 in Zurich
      const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
      const result = await startSession(rt, project.id);
      await settleSessions(rt);
      const open = (
        await rt.store.humanRequest.list({ human_id: rt.human.id } as never, { limit: 50 })
      ).filter(
        (r) =>
          r.status === "open" &&
          (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY,
      );
      expect(open).toHaveLength(1);
      const to = `/inbox#card-${encodeURIComponent(open[0]?.id ?? "")}`;
      const [waiting] = (await req<RunningView[]>("/running")).body;
      expect(waiting).toMatchObject({
        state: "waiting",
        text: "Quote page · waiting until 16:00, then it goes on",
        cancel: true,
        links: [{ label: "Answer", to }],
      });
      const card = (await req<ProjectCard[]>("/projects")).body.find((p) => p.id === project.id);
      expect(card?.statusLine?.text).toBe("Waiting for you: use your API key?");
      const page = (await req<SessionView>(`/sessions/${result.sessionId}`)).body;
      expect(page.waitBlock?.text).toBe(
        'Waiting until 16:00 (your subscription\'s limit), then it goes on with "Style the page".',
      );
      expect(page.waitBlock?.answer).toEqual({ label: "Answer", to });
      // Once the card is answered (its Wait, as the Inbox sends it), no Answer is offered.
      const shown = (
        await req<{ requests: { id: string; choices?: { label: string }[] }[] }>("/inbox")
      ).body.requests.find((r) => r.id === open[0]?.id);
      const wait = shown?.choices?.find((c) => c.label.startsWith("Wait"))?.label;
      expect(wait).toBeTruthy();
      const answered = await req(`/requests/${open[0]?.id}/answer`, {
        version: open[0]?.version,
        answer: wait,
      });
      expect(answered.status).toBeLessThan(300);
      const [after] = (await req<RunningView[]>("/running")).body;
      expect(after?.links).toBeUndefined();
      expect(
        (await req<SessionView>(`/sessions/${result.sessionId}`)).body.waitBlock?.answer,
      ).toBeFalsy();
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
  }, 60_000);

  it("while the running task works on the API key the subscription's limit moved it to, the bar says ' on your API key'; a session on its first choice does not", async () => {
    const clock = new SimulatedClock(new Date(START).toISOString());
    const world = credWorld({ clock, prefix: "fr-cred-indicator-on-" });
    homes.push(world.home);
    const { rt, req } = await world.compose();
    try {
      await setPolicy(rt, "subscription_then_key");
      world.limitSubscription(START + 2 * 3_600_000);
      const seen: string[] = [];
      const stream = world.keyModel.stream.bind(world.keyModel);
      world.keyModel.stream = (r) =>
        (async function* () {
          // The run's first call on the key: read the bar once its switch line is written.
          if (seen.length === 0 && JSON.stringify(r.messages).includes("Style the page")) {
            const end = Date.now() + 10_000;
            for (;;) {
              const sessions = await rt.store.session.list({ status: ["running"] } as never, {
                limit: 5,
              });
              const switched = sessions.length
                ? await rt.store.event.ofTypes(sessions[0]?.id ?? "", ["billing.switch"], {
                    limit: 1,
                  })
                : [];
              if (switched.length > 0 || Date.now() > end) break;
              await new Promise((res) => setTimeout(res, 20));
            }
            seen.push(...(await req<RunningView[]>("/running")).body.map((v) => v.text));
          }
          yield* stream(r);
        })();
      const { project } = await seedProject(rt, "Quote page", ["Style the page"]);
      await startSession(rt, project.id);
      await settleSessions(rt);
      expect(seen).toEqual(['Quote page · the coder works on "Style the page" on your API key']);
    } finally {
      await settleSessions(rt);
      await rt.close();
    }
    // On its first choice: no fragment.
    const clock2 = new SimulatedClock(new Date(START).toISOString());
    const plain = credWorld({ clock: clock2, prefix: "fr-cred-indicator-plain-" });
    homes.push(plain.home);
    const second = await plain.compose();
    try {
      const texts: string[] = [];
      const { project } = await seedProject(second.rt, "Quote page", ["Style the page"]);
      second.rt.events.on("session", () => undefined);
      const run = startSession(second.rt, project.id);
      const end = Date.now() + 10_000;
      while (Date.now() < end && texts.length === 0) {
        const views = (await second.req<RunningView[]>("/running")).body;
        const working = views.find((v) => v.state === "working");
        if (working) texts.push(working.text);
        await new Promise((res) => setTimeout(res, 10));
      }
      await run;
      for (const t of texts) expect(t).not.toContain(" on your ");
    } finally {
      await settleSessions(second.rt);
      await second.rt.close();
    }
  }, 60_000);
});
