import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { web } from "@forerunner/capabilities";
import { type JsonObject, openStore, type StateStore } from "@forerunner/state";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { LoopAgentDriver } from "../src/agent/loop.ts";
import type { ToolRegistry } from "../src/agent/tools.ts";
import { specialistSpecFrom } from "../src/daemon/compose.ts";
import { SessionBudget } from "../src/enforcement/budget.ts";
import { MemoryAudit } from "../src/enforcement/ports.ts";
import { loadRegistry } from "../src/registry/loader.ts";
import { WEB_FETCH_TOOL } from "../src/registry/tools.ts";
import {
  LoopTaskExecutor,
  NO_WEB_ACCESS_LINE,
  NO_WEB_SEARCH_LINE,
} from "../src/session/executor.ts";
import { stepLine } from "../src/session/runner.ts";
import { webSourceEvidence } from "../src/session/web-sources.ts";
import { webReadSitesResolver } from "../src/wiring/web-ports.ts";
import {
  flatPricing,
  harness,
  issue,
  registry,
  ScriptedProvider,
  type ScriptReply,
} from "./helpers.ts";

/**
 * Research on an API key (ADR 0107, the owner's decision of 2026-11-01). Live (2026-11-02) the
 * researcher and the science-evaluator were refused at once on an API key: the loop driver
 * offered no web tool, the executor routed the task to "the person" with no card, and nothing
 * ran, even for a data-only science check. Now `cc:WebFetch` is the web capability's
 * `web_fetch` on the loop driver: the researcher keeps its task, reads the page, and the critic
 * gets the page text it read; where a runtime offers no web reader the specialist still runs and
 * is told it has no web access.
 */
const REGISTRY = fileURLToPath(new URL("../../../evals/registry", import.meta.url));
const shipped = loadRegistry(REGISTRY);

const PAGE = `<!doctype html><html><head><title>Static site generators compared</title></head>
<body><main><h1>Static site generators compared</h1>
<p>Hugo builds a 10,000-page site in about 2 seconds.</p>
<p>Eleventy needs Node.js 18 or newer.</p></main></body></html>`;

let server: http.Server;
let pageUrl = "";
const hits: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ssg.html`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const stores: StateStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

/** The test tools plus, unless `noWeb`, the web capability's page reader as the daemon registers it. */
function toolsWith(
  store: StateStore,
  audit: MemoryAudit,
  h: ReturnType<typeof harness>,
  noWeb: boolean,
): ToolRegistry {
  const tools = registry();
  if (!noWeb)
    tools.register(
      web.webFetchTool({ sites: webReadSitesResolver(store.project), audit, clock: h.clock }),
    );
  return tools;
}

async function world(opts: {
  specialist: string;
  replies: ScriptReply[];
  noWeb?: boolean;
  settings?: JsonObject;
  title?: string;
}) {
  const h = harness();
  const store = await openStore({ url: "sqlite::memory:", clock: h.clock });
  stores.push(store);
  const human = (await store.human.insert({ name: "J", email: "j@x.test" })).id;
  const agent = (await store.agent.insert({ name: "Alice", owner_human_id: human })).id;
  // The fixture runs on this computer, so the project names it on its site list, as a person
  // names an intranet page; a public site needs no entry.
  const project = (
    await store.project.insert({
      name: "Docs site",
      settings: opts.settings ?? { browser: { allowedDomains: ["127.0.0.1"] } },
    })
  ).id;
  const session = await store.session.insert({
    agent_id: agent,
    project_id: project,
    trigger: "manual",
    status: "running",
    runner: "pc",
  });
  const task = await store.task.insert({
    project_id: project,
    title: opts.title ?? "Compare two static site generators",
    outcome: `docs/research.md says how fast Hugo builds, citing ${pageUrl}`,
    status: "in_progress",
    specialist: opts.specialist,
    budget_usd_micro: 2_000_000,
  });
  const audit = new MemoryAudit();
  const tools = toolsWith(store, audit, h, opts.noWeb ?? false);
  const specs = specialistSpecFrom(shipped, { driver: "loop", tools: () => tools.names() });
  const provider = new ScriptedProvider(opts.replies, h.clock);
  const events: string[] = [];
  const exec = new LoopTaskExecutor({
    store,
    clock: h.clock,
    tokens: h.tokens,
    driver: new LoopAgentDriver({ hooks: h.hooks, kill: h.kill, clock: h.clock }),
    provider,
    pricing: flatPricing,
    tools,
    billingSourceId: "bs",
    specialists: specs,
    specialistNames: () => shipped.runnableSpecialists().map((d) => d.name),
    onEvent: (_t, ev) => {
      if (ev.type === "warning") events.push(ev.message);
    },
  });
  const result = await exec.execute({
    task,
    session,
    token: issue(h, {
      agentId: agent,
      ownerHumanId: human,
      projectId: project,
      sessionId: session.id,
      allowedTools: tools.names(),
      budgetUsdMicro: 5_000_000,
    }),
    budget: new SessionBudget({
      sessionId: session.id,
      budgetUsdMicro: 5_000_000,
      stepCap: 100,
      deadlineMs: h.clock.now() + 3_600_000,
      reserveShare: 0.2,
    }),
    item: { taskId: task.id, title: task.title, specialist: opts.specialist, estimateUsdMicro: 1 },
    signal: new AbortController().signal,
  });
  const runs = await store.run.forTask(task.id);
  return { result, provider, events, runs, audit, specs, h };
}

/** Every tool_result block the specialist got back, as text. */
function toolResults(provider: ScriptedProvider): string {
  return JSON.stringify(provider.calls.map((c) => c.messages));
}

describe("the researcher runs on an API key and reads the web (ADR 0107)", () => {
  it("keeps its task on the loop driver, reads the page through web_fetch, and the result carries the page for the critic", async () => {
    hits.length = 0;
    const w = await world({
      specialist: "researcher",
      replies: [
        { tools: [{ name: WEB_FETCH_TOOL, input: { url: pageUrl } }] },
        { text: `Hugo builds 10,000 pages in about 2 seconds (${pageUrl}).` },
      ],
    });
    expect(w.result.outcome).toBe("done");
    // No hand-over and no refusal: the researcher ran, once, with the page reader offered.
    expect(w.events.join("\n")).not.toMatch(/web/);
    expect(w.runs.map((r) => r.specialist)).toEqual(["researcher"]);
    expect(w.provider.calls[0]?.tools?.map((t) => t.name)).toContain(WEB_FETCH_TOOL);
    // The brief says how to research without a search engine.
    expect(w.provider.calls[0]?.messages[0]?.content as string).toContain(NO_WEB_SEARCH_LINE);
    // The page reached the specialist as data, and the fixture saw one GET.
    expect(toolResults(w.provider)).toContain("Hugo builds a 10,000-page site in about 2 seconds.");
    expect(hits).toEqual(["GET /ssg.html"]);
    // The critic gets the page the specialist read (input files), the Run row its address.
    expect(w.result.webSources).toEqual([
      expect.objectContaining({
        url: pageUrl,
        status: 200,
        title: "Static site generators compared",
        text: expect.stringContaining("Eleventy needs Node.js 18 or newer."),
      }),
    ]);
    expect(webSourceEvidence(w.result.webSources).inputFiles).toEqual([
      { path: `web page ${pageUrl}`, content: expect.stringContaining("Hugo builds") },
    ]);
    expect(w.runs[0]?.artifacts).toContainEqual({
      webSources: [{ url: pageUrl, status: 200, title: "Static site generators compared" }],
    });
  });

  it("a page the network rules refuse comes back to the researcher in words, and the critic sees it was not read", async () => {
    hits.length = 0;
    const w = await world({
      specialist: "researcher",
      settings: {},
      replies: [
        { tools: [{ name: WEB_FETCH_TOOL, input: { url: pageUrl } }] },
        { text: "The page could not be read." },
      ],
    });
    expect(w.result.outcome).toBe("done");
    expect(hits).toEqual([]);
    expect(toolResults(w.provider)).toContain(
      "Refused: 127.0.0.1 is a private or local network address; research reads public web pages only",
    );
    const ev = webSourceEvidence(w.result.webSources);
    expect(ev.inputFiles).toEqual([]);
    expect(ev.artifacts).toEqual([
      expect.stringMatching(
        new RegExp(
          `^web page not read: ${pageUrl.replace(/[.]/g, "\\.")} \\(.*Refused: 127\\.0\\.0\\.1 is a private`,
        ),
      ),
    ]);
    // On record as a refusal by the rules, with the reason.
    expect(w.audit.entries).toEqual([
      expect.objectContaining({
        tool: WEB_FETCH_TOOL,
        allowed: false,
        deniedReason: expect.stringMatching(/^domain_not_allowed: Refused: /),
      }),
    ]);
  });

  it("the science-evaluator keeps a data-only task on the loop driver", async () => {
    const w = await world({
      specialist: "science-evaluator",
      title: "Check the 10% uplift claim against data/results.csv",
      replies: [{ text: "Not supported: the uplift is 10.58% with a CI of 4.9 to 16.7%." }],
    });
    expect(w.result.outcome).toBe("done");
    expect(w.runs.map((r) => r.specialist)).toEqual(["science-evaluator"]);
    expect(w.specs("science-evaluator")?.allowedTools).toContain(WEB_FETCH_TOOL);
  });

  it("where the runtime offers no web reader, the researcher still runs and is told it has no web access", async () => {
    const w = await world({
      specialist: "researcher",
      noWeb: true,
      replies: [{ text: "From the project's files only: nothing found about Hugo." }],
    });
    expect(w.result.outcome).toBe("done");
    expect(w.runs.map((r) => r.specialist)).toEqual(["researcher"]);
    expect(w.provider.calls).toHaveLength(1);
    expect(w.provider.calls[0]?.messages[0]?.content as string).toContain(NO_WEB_ACCESS_LINE);
    // No word about web_fetch on a run that has no page reader.
    expect(w.provider.calls[0]?.messages[0]?.content as string).not.toContain(NO_WEB_SEARCH_LINE);
    expect(w.events).toContain(
      "the researcher has no web access on this run (cc:WebFetch, cc:WebSearch not offered here); it works from what the project holds",
    );
  });
});

describe("one name for the page reader (ADR 0107)", () => {
  it("the capability's tool is the name the registry maps cc:WebFetch to", () => {
    expect(web.WEB_FETCH_TOOL_NAME).toBe(WEB_FETCH_TOOL);
    const tool = web.webFetchTool({
      sites: () => ({ allowed: [], blocked: [] }),
      audit: new MemoryAudit(),
      clock: harness().clock,
    });
    expect(tool.name).toBe(WEB_FETCH_TOOL);
  });
});

describe("the session log names the page a run read (design §3.7)", () => {
  it("one short line with the host and path, never the page", () => {
    expect(
      stepLine({
        kind: "tool",
        name: "web_fetch",
        input: { url: "https://gohugo.io/about/?x=1#y" },
        isError: false,
        denied: false,
      }),
    ).toBe("read the web page gohugo.io/about/");
    expect(
      stepLine({
        kind: "tool",
        name: "web_fetch",
        input: { url: "http://10.0.0.7/" },
        isError: true,
        denied: false,
      }),
    ).toBe("read the web page 10.0.0.7 (failed)");
  });
});
