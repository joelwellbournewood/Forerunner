import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import {
  messagesApiStandIn,
  standInFetch,
  type WebSearchStandInOptions,
} from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { ModelCallLog } from "../../../testenv/src/bench/call-log.ts";
import { benchOptionsFromEnv, createRolePlayer } from "../../../testenv/src/bench/role-player.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";
import { WEB_SEARCH_OFF_LINE } from "../src/wiring/web-search.ts";

/**
 * 'web-search' (the owner's decision of 2026-11-02): an account whose administrator switched web
 * search off answers a request with the search tool with a 400 "not enabled". The daemon is
 * composed as `fr daemon --provider bench-api` composes it (the routed provider over the vault's
 * key, the Messages API stand-in with the bench's role-player behind it): the research task is
 * done all the same, the session's log says it once, the mark is kept on the key's billing source
 * after a restart (the next run is not offered search at all, so no 400 follows), and a new key
 * ends it.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const KEY = ["sk-ant-api03-", "search-off-", "3".repeat(40)].join(""); // not-a-secret
const NEW_KEY = ["sk-ant-api03-", "search-new-", "4".repeat(40)].join(""); // not-a-secret

const runtimes: RuntimeApp[] = [];
afterEach(async () => {
  for (const rt of runtimes.splice(0)) await rt.close();
});

function world() {
  const home = mkdtempSync(join(tmpdir(), "fr-search-off-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const clock = new SimulatedClock("2026-11-08T09:00:00Z");
  const vault = new MemoryVault({ [SECRET_NAMES.anthropic]: KEY });
  const model = createRolePlayer(
    benchOptionsFromEnv(
      { FORERUNNER_BENCH_DELAY_MS: "0" },
      new ModelCallLog({ file: join(home, "model-calls.jsonl") }),
    ),
  );
  // A live object: the account switches search back on for the last step.
  const search: WebSearchStandInOptions = { enabled: false };
  const standIn = messagesApiStandIn({ model, clock, search });
  const fetchImpl = standInFetch(standIn, {
    fallback: async () => new Response("not here", { status: 404 }),
  });
  const start = async () => {
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: `sqlite:${join(dirs.data, "state.sqlite")}`,
      vault,
      fetchImpl,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
    });
    runtimes.push(rt);
    const { app, token } = createDaemonApp(rt);
    const get = async <T>(path: string): Promise<T> =>
      (await (
        await app.request(path, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as T;
    return { rt, get };
  };
  return { vault, standIn, search, start };
}

/** One researcher task in a fresh project, run in a session as the daemon starts it. */
async function research(rt: RuntimeApp, title: string) {
  const project = await rt.store.project.insert({ name: title, goal: "g", autonomy_level: 2 });
  const task = await rt.store.task.insert({
    project_id: project.id,
    title,
    outcome: "research/notes.md compares the free tiers, with sources",
    acceptance_criteria: ["research/notes.md names its sources"],
    risk_tier: 1,
    status: "ready",
    priority: 5,
    specialist: "researcher",
    est_cost_usd_micro: 50_000,
    reason: "seed",
  });
  const grant = await rt.sessionGrant(project.id);
  const result = await rt.runner.start({
    agentId: rt.agent.id,
    projectId: project.id,
    trigger: "manual",
    budgetCapUsdMicro: 5_000_000,
    grant,
  });
  return { project, task, result };
}

describe("web search switched off for the account ('web-search')", () => {
  it("the task is done without it, the log says so once, the mark survives a restart and a new key ends it", async () => {
    const w = world();
    const first = await w.start();
    expect(first.rt.chooser.facts().keySearch).toBe(true);
    const one = await research(first.rt, "Compare static site hosts");
    expect((await first.rt.store.task.mustGet(one.task.id)).status).toBe("done");
    // The first specialist call offered search and was refused with the API's 400; the same call
    // went again without the tool, and the run went on reading pages by address.
    const messages = w.standIn.requests.filter((r) => r.path === "/v1/messages");
    const refused = messages.findIndex((r) => r.status === 400);
    expect(refused).toBeGreaterThanOrEqual(0);
    expect(messages[refused]?.webSearch).toBeDefined();
    expect(messages[refused + 1]).toMatchObject({ status: 200 });
    expect(messages[refused + 1]?.webSearch).toBeUndefined();
    expect(w.standIn.refusals).toEqual([
      "Web search is not enabled for this organization. An administrator can enable it in the Claude Console.",
    ]);
    // The session's log says it once.
    const lines = (
      await first.get<{ text: string }[]>(`/sessions/${one.result.sessionId}/events`)
    ).map((e) => e.text);
    expect(lines.filter((l) => l === WEB_SEARCH_OFF_LINE)).toHaveLength(1);
    // The chooser knows: the key does not search now.
    expect(first.rt.chooser.facts().keySearch).toBe(false);

    // After a restart the mark stands: the next research run is not offered search, no 400.
    await first.rt.close();
    runtimes.splice(runtimes.indexOf(first.rt), 1);
    const second = await w.start();
    expect(second.rt.chooser.facts().keySearch).toBe(false);
    const before = w.standIn.requests.length;
    const two = await research(second.rt, "Compare hosting offers");
    expect((await second.rt.store.task.mustGet(two.task.id)).status).toBe("done");
    const later = w.standIn.requests.slice(before).filter((r) => r.path === "/v1/messages");
    expect(later.every((r) => r.status === 200 && r.webSearch === undefined)).toBe(true);
    expect(w.standIn.refusals).toHaveLength(1);

    // A new key (saved in Settings), whose account has search on: research searches again.
    await w.vault.set(SECRET_NAMES.anthropic, NEW_KEY);
    w.search.enabled = true;
    const from = w.standIn.requests.length;
    const three = await research(second.rt, "Compare domain registrars");
    expect((await second.rt.store.task.mustGet(three.task.id)).status).toBe("done");
    const offered = w.standIn.requests.slice(from).filter((r) => r.webSearch !== undefined);
    expect(offered.length).toBeGreaterThan(0);
    expect(second.rt.chooser.facts().keySearch).toBe(true);
    expect(w.standIn.searches.length).toBeGreaterThan(0);
  }, 60_000);
});
