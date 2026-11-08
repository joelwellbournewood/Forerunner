import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { MemoryGitHost } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolExecutionContext } from "../src/agent/tools.ts";
import { webReadLoopbackFor } from "../src/cli/main.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { domainCovered } from "../src/enforcement/token.ts";
import { WEB_FETCH_TOOL } from "../src/registry/tools.ts";
import { browserSettingsOf } from "../src/wiring/browser-ports.ts";
import {
  cleanSite,
  cleanSiteList,
  researchReadsLine,
  webAccessNarrows,
  webAccessOf,
  webAccessWords,
} from "../src/wiring/web-access.ts";
import { webSearchListsOf } from "../src/wiring/web-ports.ts";
import { ScriptedProvider } from "./helpers.ts";

const REGISTRY = join(process.cwd(), "evals", "registry");

/**
 * "Web pages research may read" ('sites', the owner's decision of 2026-11-02): the one clean-up
 * every entry goes through, the rule read from a project's settings (both keys), the block list
 * the agent browser enforces, the lists web search is sent, and the page reader's loopback seam
 * that only the scripted bench modes compose with.
 */
describe("the one clean-up of a site entry ('sites')", () => {
  it("a pasted address is cleaned to its site and shown back, never dropped", () => {
    const r = cleanSiteList(
      "https://www.Example.com/page?q=1\nexample.org.\n*.docs.python.org\nhttp://bücher.de:8080/x",
      "only",
    );
    expect(r.sites).toEqual(["example.com", "example.org", "docs.python.org", "xn--bcher-kva.de"]);
    expect(r.changed).toEqual([
      { entry: "https://www.Example.com/page?q=1", site: "example.com" },
      { entry: "example.org.", site: "example.org" },
      { entry: "*.docs.python.org", site: "docs.python.org" },
      { entry: "http://bücher.de:8080/x", site: "xn--bcher-kva.de" },
    ]);
    expect(r.refused).toEqual([]);
  });

  it("an IP address, a local name and (in the only list) a public suffix are refused with their reason", () => {
    const only = cleanSiteList(
      ["192.168.1.1", "localhost", "printer.local", "co.uk", "github.io", "[::1]"],
      "only",
    );
    expect(only.sites).toEqual([]);
    expect(only.refused.map((r) => [r.entry, r.why])).toEqual([
      ["192.168.1.1", "an IP address: name the website instead"],
      ["localhost", "a name on this computer or the local network, which research never reads"],
      ["printer.local", "a name on this computer or the local network, which research never reads"],
      ["co.uk", "too broad: anyone can have a site under it; name the site itself"],
      ["github.io", "too broad: anyone can have a site under it; name the site itself"],
      ["[::1]", "an IP address: name the website instead"],
    ]);
    // A public suffix is a fine thing to block.
    expect(cleanSite("github.io", "never")).toEqual({
      ok: true,
      entry: "github.io",
      site: "github.io",
    });
    expect(cleanSite("user.github.io", "only")).toMatchObject({ ok: true, site: "user.github.io" });
  });
});

describe("the rule a project's settings hold ('sites')", () => {
  it("reads web_access and the blocks still under browser.blockedDomains; browser.allowedDomains changes nothing", () => {
    const v = webAccessOf({
      web_access: { mode: "any", only: [], never: ["facebook.com"] },
      browser: {
        allowedDomains: ["127.0.0.1", "localhost", "intranet.corp"],
        blockedDomains: ["*.example.org", "https://tracker.example.net/x", "10.1.2.3"],
      },
    });
    expect(v).toEqual({
      mode: "any",
      only: [],
      never: ["facebook.com", "example.org", "tracker.example.net", "10.1.2.3"],
    });
    expect(webAccessWords({ mode: "any", only: [], never: [] })).toBe("Any public website");
    expect(researchReadsLine(v)).toBe(
      "Research reads: any public website, never facebook.com, example.org, tracker.example.net and 1 more",
    );
    const only = webAccessOf({
      web_access: { mode: "only", only: ["developer.mozilla.org"], never: [] },
    });
    expect(researchReadsLine(only)).toBe("Research reads: only developer.mozilla.org");
    expect(webAccessWords(only)).toBe("Only these websites: developer.mozilla.org");
  });

  it("the agent browser enforces the same block list, each site with its subdomains", () => {
    const s = browserSettingsOf({
      web_access: { mode: "any", only: [], never: ["facebook.com"] },
      browser: {
        allowedDomains: ["https://docs.example.com/a"],
        blockedDomains: ["*.example.org"],
      },
    });
    expect(s.blockedDomains).toEqual([
      "*.example.org",
      "*.facebook.com",
      "example.org",
      "facebook.com",
    ]);
    // A pasted address on the browser's own list is read as its host, not dropped.
    expect(s.allowedDomains).toEqual(["docs.example.com"]);
  });

  it("the capability token's matcher is unchanged: 'example.com' covers that host only", () => {
    expect(domainCovered("example.com", ["example.com"])).toBe(true);
    expect(domainCovered("www.example.com", ["example.com"])).toBe(false);
    expect(domainCovered("www.example.com", ["*.example.com"])).toBe(true);
  });

  it("web search gets 'only' as allowed_domains, otherwise the never list as blocked_domains, never both", () => {
    expect(webSearchListsOf({ mode: "only", only: ["developer.mozilla.org"], never: [] })).toEqual({
      allowedDomains: ["developer.mozilla.org"],
      dropped: [],
      key: JSON.stringify({ allowed: ["developer.mozilla.org"] }),
    });
    expect(webSearchListsOf({ mode: "any", only: [], never: ["example.org", "10.1.2.3"] })).toEqual(
      {
        blockedDomains: ["example.org"],
        dropped: ["10.1.2.3"],
        key: JSON.stringify({ blocked: ["example.org"] }),
      },
    );
    // A blocked site inside an allowed one cannot be told in one request: no search for the run.
    const both = webSearchListsOf({
      mode: "only",
      only: ["example.com"],
      never: ["private.example.com"],
    });
    expect(both.blockedDomains).toBeUndefined();
    expect(both.withheld).toMatch(/never private\.example\.com/);
  });
});

describe("widening asks a yes, narrowing acts at once ('sites')", () => {
  const any = (never: string[] = []) => ({ mode: "any", only: [], never });
  const only = (o: string[], never: string[] = []) => ({ mode: "only", only: o, never });
  it("narrowing: a new block, any to only, a shorter only list, a sub-site", () => {
    expect(webAccessNarrows(any(["a.com"]), any())).toBe(true);
    expect(webAccessNarrows(only(["a.com"]), any())).toBe(true);
    expect(webAccessNarrows(only(["a.com"]), only(["a.com", "b.org"]))).toBe(true);
    expect(webAccessNarrows(only(["docs.a.com"]), only(["a.com"]))).toBe(true);
    // A blocked site stays out of reach under "only" when no entry reaches it.
    expect(webAccessNarrows(only(["b.org"]), any(["a.com"]))).toBe(true);
  });
  it("widening: a block removed, only to any, a site added, an only entry that reaches a block", () => {
    expect(webAccessNarrows(any(), any(["a.com"]))).toBe(false);
    expect(webAccessNarrows(any(), only(["a.com"]))).toBe(false);
    expect(webAccessNarrows(only(["a.com", "b.org"]), only(["a.com"]))).toBe(false);
    expect(webAccessNarrows(only(["a.com"]), any(["docs.a.com"]))).toBe(false);
    expect(webAccessNarrows(only(["a.com"], ["docs.a.com"]), any(["docs.a.com"]))).toBe(true);
  });
});

describe("the page reader's loopback seam: the scripted bench modes only ('sites')", () => {
  let server: http.Server;
  let pageUrl = "";
  const homes: string[] = [];
  const runtimes: RuntimeApp[] = [];
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("the daemon's own page");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/health`;
  });
  afterAll(async () => {
    for (const rt of runtimes) await rt.close();
    for (const h of homes) rmSync(h, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function compose(env: Record<string, string>, webReadLoopback?: boolean) {
    const clock = new SimulatedClock(Date.parse("2026-11-08T10:00:00Z"));
    const home = mkdtempSync(join(tmpdir(), "fr-sites-"));
    homes.push(home);
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    mkdirSync(dirs.config, { recursive: true });
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home, ...env },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault({}),
      provider: new ScriptedProvider([], clock),
      gitHost: new MemoryGitHost("alice"),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "1.0.0",
      sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
      startServices: false,
      ...(webReadLoopback === undefined ? {} : { webReadLoopback }),
    });
    runtimes.push(rt);
    // 127.0.0.1 and localhost on every list a person could fill: none of them opens this PC.
    const project = await rt.store.project.insert({
      name: "Lists",
      goal: "g",
      repos: [],
      settings: {
        browser: { allowedDomains: ["127.0.0.1", "localhost"] },
        web_access: { mode: "only", only: ["127.0.0.1", "localhost"], never: [] },
      },
    });
    return { rt, projectId: project.id };
  }

  const ctx = (projectId: string): ToolExecutionContext => ({
    runId: "r1",
    sessionId: "s1",
    agentId: "a1",
    humanId: "h1",
    projectId,
    allowedPaths: [],
    signal: new AbortController().signal,
  });

  it("--provider bench and bench-api compose with it; bench-live, fake, anthropic and an installed app never do", () => {
    expect(webReadLoopbackFor("bench")).toBe(true);
    expect(webReadLoopbackFor("bench-api")).toBe(true);
    for (const p of ["bench-live", "fake", "anthropic", undefined, "BENCH", "bench "])
      expect(webReadLoopbackFor(p), String(p)).toBe(false);
  });

  it("without the seam, 127.0.0.1 is refused whatever the environment or the lists say", async () => {
    const { rt, projectId } = await compose({
      FORERUNNER_BENCH_LIVE_API: "http://127.0.0.1:1",
      FORERUNNER_WEB_READ_LOOPBACK: "1",
      FORERUNNER_BENCH: "1",
    });
    const tool = rt.toolsForRun().get(WEB_FETCH_TOOL);
    expect(tool).toBeDefined();
    await expect(tool?.execute({ url: pageUrl }, ctx(projectId))).rejects.toMatchObject({
      code: "domain_not_allowed",
      message: expect.stringMatching(
        /^Refused: 127\.0\.0\.1 is a private or local network address/,
      ),
    });
    await expect(
      tool?.execute({ url: pageUrl.replace("127.0.0.1", "localhost") }, ctx(projectId)),
    ).rejects.toMatchObject({ code: "domain_not_allowed" });
  });

  it("on a computer with a proxy set, the Settings row says the reader does not use it", async () => {
    const { rt, projectId } = await compose({ HTTPS_PROXY: "http://proxy.example.test:3128" });
    const { app, token } = createDaemonApp(rt);
    const res = await app.request(`/settings?scope=project&scopeId=${projectId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const rows = (await res.json()) as { key: string; description: string }[];
    const row = rows.find((r) => r.key === "project.web_access");
    expect(row?.description).toContain(
      "This computer names a proxy for the internet, which Forerunner's page reader does not use yet: where the internet is reached only through it, pages cannot be read here; web search still works",
    );
    const plain = await compose({});
    const { app: app2, token: token2 } = createDaemonApp(plain.rt);
    const rows2 = (await (
      await app2.request(`/settings?scope=project&scopeId=${plain.projectId}`, {
        headers: { authorization: `Bearer ${token2}` },
      })
    ).json()) as { key: string; description: string }[];
    expect(rows2.find((r) => r.key === "project.web_access")?.description).not.toContain("proxy");
  });

  it("with the seam (the bench's composition), the stand-in page on 127.0.0.1 is read", async () => {
    const { rt, projectId } = await compose({}, true);
    const r = await rt.toolsForRun().get(WEB_FETCH_TOOL)?.execute({ url: pageUrl }, ctx(projectId));
    expect(r?.content).toContain("the daemon's own page");
  });
});

describe("'Web pages research may read' survives a restart and an undo ('sites')", () => {
  it("settings.set stores the cleaned rule, the next daemon enforces it, and Undo puts the old rule back", async () => {
    const clock = new SimulatedClock(Date.parse("2026-11-08T10:00:00Z"));
    const home = mkdtempSync(join(tmpdir(), "fr-sites-restart-"));
    const compose = () =>
      composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
        config: null,
        clock,
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        vault: new MemoryVault({}),
        provider: new ScriptedProvider([], clock),
        gitHost: new MemoryGitHost("alice"),
        registryDir: REGISTRY,
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "1.0.0",
        sandboxDetection: { engine: "none", reason: "test: no engine", checkedAt: clock.nowIso() },
        startServices: false,
        webReadLoopback: true,
      });
    let rt = await compose();
    const post = async (path: string, body: unknown) => {
      const { app, token } = createDaemonApp(rt);
      const r = await app.request(path, {
        method: "POST",
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      });
      return (await r.json()) as Record<string, unknown>;
    };
    try {
      const project = await rt.store.project.insert({ name: "Docs", goal: "g", repos: [] });
      const ctx: ToolExecutionContext = {
        runId: "r1",
        sessionId: "s1",
        agentId: rt.agent.id,
        humanId: rt.human.id,
        projectId: project.id,
        allowedPaths: [],
        signal: new AbortController().signal,
      };
      const set = await post("/commands/execute", {
        commands: [
          {
            name: "settings.set",
            params: {
              key: "web_access",
              value: { mode: "only", only: ["https://www.Example.com/docs/"], never: [] },
              project: project.id,
            },
          },
        ],
        source: "ui",
        wordsUsed: "Settings: Web pages research may read to Only these websites: example.com",
      });
      expect(set.status).toBe("done");
      await rt.close();
      rt = await compose();
      const stored = (await rt.store.project.mustGet(project.id)).settings.web_access;
      expect(stored).toEqual({ mode: "only", only: ["example.com"], never: [] });
      await expect(
        rt.toolsForRun().get(WEB_FETCH_TOOL)?.execute({ url: "http://127.0.0.1:9/x" }, ctx),
      ).rejects.toMatchObject({
        message:
          'Refused: 127.0.0.1 is not on this project\'s "only these websites" list (example.com).',
      });
      // Undo from the change log, after the restart: a widening, so it asks a yes first.
      const undo = await post(`/changes/${String(set.changeLogId)}/undo`, {});
      expect(undo.status).toBe("pending");
      const yes = await post(`/commands/${String(undo.pendingId)}/confirm`, { answer: "tap" });
      expect(yes.status).toBe("done");
      expect(webAccessOf((await rt.store.project.mustGet(project.id)).settings)).toEqual({
        mode: "any",
        only: [],
        never: [],
      });
    } finally {
      await rt.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
