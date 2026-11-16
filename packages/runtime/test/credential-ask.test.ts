import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import { claudeCodeToolNames } from "../src/agent/cc-tools.ts";
import type { QueryLike } from "../src/agent/sdk.ts";
import type { HumanRequestView, InboxView, TaskView } from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { BILLING_GRANT_AUDIT_TOOL, CREDENTIAL_ASK_KEY } from "../src/session/credential-ask.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import {
  AcceptingCriticProvider,
  removeHomes,
  ScriptedProvider,
  settleSessions,
} from "./helpers.ts";

/**
 * d1109-cred-engine CE-7 (ADR 0120; the owner's 7a: "use subscription until runs out --> go to
 * API after asking human"): under 'Subscription first, then ask' one card per stop, answered once.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const OAUTH = ["sk-ant-oat01-", "askcard", "5".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "askcard", "6".repeat(40)].join(""); // not-a-secret
const RESET = "2026-10-31T14:00:00.000Z";

/** Claude Code at its limit on the first `limited` calls, then answering. */
function claudeCode(calls: string[], limited: () => boolean): QueryLike {
  return ({ prompt }) => {
    calls.push(prompt);
    const stop = limited();
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-ask" };
      if (!stop) {
        yield {
          type: "assistant",
          message: {
            id: `m${calls.length}`,
            content: [{ type: "text", text: "Done on the subscription. Lesson: none." }],
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Done on the subscription. Lesson: none.",
        };
        return;
      }
      yield {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: Date.parse(RESET) / 1000,
          rateLimitType: "five_hour",
        },
      };
      yield {
        type: "assistant",
        error: "rate_limit",
        message: { content: [{ type: "text", text: "You've hit your limit · resets 3pm" }] },
      };
      yield { type: "result", subtype: "success", is_error: true, result: "You've hit your limit" };
    })();
  };
}

const homes: string[] = [];

async function compose(
  home: string,
  clock: SimulatedClock,
  sdkQuery: QueryLike,
  provider: ScriptedProvider,
) {
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: `sqlite:${join(home, "state.sqlite")}`,
    vault: new MemoryVault({
      [SECRET_NAMES.anthropicOauth]: OAUTH,
      [SECRET_NAMES.anthropic]: API_KEY,
    }),
    provider: new AcceptingCriticProvider(provider),
    sdkQuery,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
    sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
    startServices: false,
  });
  const { app, token } = createDaemonApp(rt);
  const req = async <T>(path: string, body?: unknown): Promise<T> =>
    (await (
      await app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    ).json()) as T;
  return { rt, req };
}

async function seed(rt: RuntimeApp) {
  await rt.store.human.patch(rt.human.id, {
    notify_prefs: { credential_policy: "subscription_then_ask" } as never,
  });
  const project = await rt.store.project.insert({
    name: "Quote page",
    goal: "A quote page",
    autonomy_level: 2,
  });
  const tasks = [];
  for (const title of ["Style the page", "Write the copy"])
    tasks.push(
      await rt.store.task.insert({
        project_id: project.id,
        title,
        outcome: `${title} is done`,
        acceptance_criteria: ["it is done"],
        risk_tier: 0,
        status: "ready",
        priority: 5,
        est_cost_usd_micro: 100_000,
        reason: "seed",
      }),
    );
  return { project, tasks };
}

const start = (rt: RuntimeApp, projectId: string) =>
  rt.runner.start({
    agentId: rt.agent.id,
    projectId,
    trigger: "manual",
    by: "person",
    budgetCapUsdMicro: 5_000_000,
    grant: {
      allowedTools: [...rt.toolsForRun().names(), ...claudeCodeToolNames()],
      allowedPaths: [],
      allowedDomains: [],
      grantedSecrets: [],
    },
  });

const askCards = async (rt: RuntimeApp) =>
  (await rt.store.humanRequest.open({ humanId: rt.human.id }, { limit: 50 })).filter(
    (r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY,
  );

afterAll(() => removeHomes(homes));

describe("d1109-cred-engine, run C: the ask card (CE-7)", () => {
  it("one card per stop, no key request while it waits; Use API key grants this stop, the person's session goes on on the key, and a restart keeps the grant until the stop ends", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ask-use-"));
    homes.push(home);
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const sdkCalls: string[] = [];
    let limited = true;
    const provider = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
    let { rt, req } = await compose(
      home,
      clock,
      claudeCode(sdkCalls, () => limited),
      provider,
    );
    const { project, tasks } = await seed(rt);
    await start(rt, project.id);
    await settleSessions(rt);
    // One card for the stop, and nothing on the API key meanwhile.
    expect(await askCards(rt)).toHaveLength(1);
    const work = () =>
      provider.calls.filter((c) => !(c.tools ?? []).some((t) => t.name === "submit_review"));
    expect(work()).toHaveLength(0);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("ready");
    const rows = await req<TaskView[]>(`/projects/${project.id}/tasks`);
    expect(rows.map((r) => r.display?.label)).toEqual([
      "Waits for your answer: use your API key?",
      "Waits for your answer: use your API key?",
    ]);
    // The card as the Inbox shows it.
    const inbox = await req<InboxView>("/inbox");
    const card = inbox.requests.find((r) => (r.title ?? "").startsWith("Use your API key"));
    expect(card?.title).toBe("Use your API key until 15:00?");
    expect(card?.body).toMatch(
      /^Your Claude subscription is at its limit until 15:00\. Your API key can do the waiting work now: about CHF \d+\.\d\d\.$/,
    );
    expect(card?.choices?.map((c) => c.label)).toEqual(["Use API key", "Wait"]);
    expect(card?.choices?.[0]?.explain).toMatch(
      /^Your work and chat use your API key until 15:00: about CHF \d+\.\d\d for what waits now\.$/,
    );
    expect(card?.choices?.[1]?.explain).toBe(
      "Nothing moves until 15:00; then your session goes on with your subscription.",
    );
    expect(card?.details).toContain(
      "Forerunner's own monthly checks wait for your subscription; they cost nothing meanwhile.",
    );

    // Composed again between filing and answering: the card is still the one, and still works.
    await rt.close();
    ({ rt, req } = await compose(
      home,
      clock,
      claudeCode(sdkCalls, () => limited),
      provider,
    ));
    expect(await askCards(rt)).toHaveLength(1);
    const row = (await askCards(rt))[0];
    const answered = await req<HumanRequestView>(`/requests/${row?.id}/answer`, {
      answer: card?.choices?.[0]?.label,
      version: row?.version,
    });
    expect(answered.outcome).toBe(
      "Done: your API key does the work until 15:00; your session goes on now.",
    );
    const grants = await rt.store.auditLog.list({ tool: BILLING_GRANT_AUDIT_TOOL } as never, {
      limit: 10,
    });
    expect(grants).toHaveLength(1);
    await settleSessions(rt);
    for (const t of tasks) expect((await rt.store.task.mustGet(t.id)).status).toBe("done");
    expect(work().length).toBeGreaterThan(0);
    expect(sdkCalls).toHaveLength(1);

    // A restart before the stop ends: the next pick still uses the key; after it, the subscription.
    await rt.close();
    ({ rt, req } = await compose(
      home,
      clock,
      claudeCode(sdkCalls, () => limited),
      provider,
    ));
    const pick = () =>
      rt.billing.pick.pick({
        agentId: rt.agent.id,
        agentOwnerHumanId: rt.human.id,
        runner: "pc",
        modelTier: "sonnet",
        purpose: "chat",
      });
    expect((await pick()).source.kind).toBe("api_key");
    clock.set(Date.parse("2026-10-31T14:01:00Z"));
    limited = false;
    await rt.billing.waits.wake();
    expect((await pick()).source.kind).toBe("subscription");
    const sub = (await rt.store.billingSource.list({ human_id: rt.human.id }, { limit: 10 })).find(
      (s) => s.kind === "subscription",
    );
    expect((sub?.limits as { grant?: unknown } | undefined)?.grant).toBeUndefined();
    await settleSessions(rt);
    await rt.close();
  }, 90_000);

  it("Wait moves nothing and files no second card, after a restart too; at the reset the person's session goes on by itself on the subscription", async () => {
    const home = mkdtempSync(join(tmpdir(), "fr-ask-wait-"));
    homes.push(home);
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    const sdkCalls: string[] = [];
    let limited = true;
    const provider = new ScriptedProvider([{ text: "Done on the API key. Lesson: none." }], clock);
    let { rt, req } = await compose(
      home,
      clock,
      claudeCode(sdkCalls, () => limited),
      provider,
    );
    const { project, tasks } = await seed(rt);
    await start(rt, project.id);
    await settleSessions(rt);
    const [row] = await askCards(rt);
    const answered = await req<HumanRequestView>(`/requests/${row?.id}/answer`, {
      answer: "Wait",
      version: row?.version,
    });
    expect(answered.outcome).toBe("Done: nothing moves until 15:00; then your session goes on.");
    const work = () =>
      provider.calls.filter((c) => !(c.tools ?? []).some((t) => t.name === "submit_review"));
    // A second session before the reset: nothing on the key, no second card.
    await start(rt, project.id);
    await settleSessions(rt);
    await rt.close();
    ({ rt, req } = await compose(
      home,
      clock,
      claudeCode(sdkCalls, () => limited),
      provider,
    ));
    await start(rt, project.id);
    await settleSessions(rt);
    expect(await askCards(rt)).toHaveLength(0);
    expect(
      (await rt.store.humanRequest.list({ human_id: rt.human.id } as never, { limit: 50 })).filter(
        (r) => (r.change_card as { key?: unknown } | null)?.key === CREDENTIAL_ASK_KEY,
      ),
    ).toHaveLength(1);
    expect(work()).toHaveLength(0);
    // At the reset the person's session goes on by itself, on the subscription.
    clock.set(Date.parse("2026-10-31T14:01:00Z"));
    limited = false;
    await rt.scheduler.tick();
    const end = Date.now() + 20_000;
    while ((await rt.store.task.mustGet(tasks[1]?.id ?? "")).status !== "done" && Date.now() < end)
      await new Promise((r) => setTimeout(r, 100));
    for (const t of tasks)
      expect((await rt.store.task.mustGet(t.id)).status, "after the reset").toBe("done");
    expect(work()).toHaveLength(0);
    await settleSessions(rt);
    await rt.close();
  }, 90_000);
});
