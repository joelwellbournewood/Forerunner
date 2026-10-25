import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryGitHost } from "@forerunner/capabilities";
import { join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, silenceSqliteExperimentalWarning } from "@forerunner/state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/main.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";
import { SourceDiscovery } from "../src/sources/discovery.ts";

silenceSqliteExperimentalWarning();

/**
 * `fr sources` (spec A.4): list, add, scan, candidates, accept and remove through the same
 * SourceDiscovery as the daemon's routes, composed without background services. In process
 * through `buildProgram()` with a composed stand-in over a sqlite store and an in-memory host.
 */
describe("fr sources", () => {
  let store: StateStore;
  let home: string;
  let humanId: string;
  let lines: string[];
  let composeCalls: Record<string, unknown>[];
  let discovery: SourceDiscovery;
  const clock = new SimulatedClock("2026-10-23T09:00:00.000Z");

  beforeEach(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
    home = mkdtempSync(join(tmpdir(), "fr-sources-cli-"));
    humanId = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
    const host = new MemoryGitHost("someone");
    await host.createRepo({ owner: "acme", name: "alpha", private: false });
    await host.createRepo({ owner: "acme", name: "beta", private: false });
    await host.putFile(
      { owner: "acme", name: "beta" },
      { path: ".forerunner/project.json", content: "{}", message: "mark", branch: "main" },
    );
    discovery = new SourceDiscovery({
      store,
      clock,
      hostFor: () => host,
      createProject: async (input, actor) => {
        const p = await store.project.insert({
          name: input.name,
          goal: input.goal,
          repos: input.repos,
          author_human: actor.humanId,
        });
        return { id: p.id, name: p.name };
      },
    });
    lines = [];
    composeCalls = [];
  });
  afterEach(async () => {
    await store.close();
    rmSync(home, { recursive: true, force: true });
  });

  function program() {
    const rt = {
      store,
      clock,
      sources: discovery,
      human: { id: humanId, name: "Ada", timezone: "UTC" },
      agent: { id: "agent", name: "Alice" },
      close: async () => undefined,
    } as unknown as RuntimeApp;
    const p = buildProgram({
      env: { FORERUNNER_HOME: home },
      compose: async (o) => {
        composeCalls.push(o);
        return rt;
      },
      out: (l) => lines.push(l),
    });
    p.exitOverride();
    return p;
  }
  const fr = (...args: string[]) => program().parseAsync(["node", "fr", ...args]);

  it("is registered as `fr sources` with list, add, scan, candidates, accept and remove", () => {
    const p = program();
    const sources = p.commands.find((c) => c.name() === "sources");
    expect(sources).toBeDefined();
    expect(sources?.commands.map((c) => c.name()).sort()).toEqual(
      ["accept", "add", "candidates", "list", "remove", "scan"].sort(),
    );
    const add = sources?.commands.find((c) => c.name() === "add");
    expect(add?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(["--name", "--credential"]),
    );
    expect(add?.registeredArguments.map((a) => a.name())).toEqual(["kind", "locator"]);
  });

  it("connects, scans, accepts and removes a source through the composed runtime without services", async () => {
    await fr("sources", "list");
    expect(lines).toEqual(["No sources connected (fr sources add <kind> <locator>)."]);
    expect(composeCalls[0]).toMatchObject({ startServices: false });
    lines = [];

    await fr("sources", "add", "github_org", "acme", "--name", "Acme");
    expect(lines[0]).toMatch(
      /^Connected: \S+ {2}github_org acme secret:github_token {2}connected {2}not scanned yet$/,
    );
    expect(lines[1]).toMatch(/^Scan it with: fr sources scan \S+$/);
    const sourceId = lines[1]?.split(" ").at(-1) ?? "";
    lines = [];

    await fr("sources", "scan", sourceId);
    expect(lines[0]).toBe(
      "2 found: 2 proposed, 0 accepted, 0 duplicate, 0 gone, 1 with an existing install",
    );
    expect(lines[1]).toMatch(/^\S+ {2}proposed {2}acme\/alpha {2}-> "alpha"$/);
    expect(lines[2]).toMatch(
      /^\S+ {2}proposed {2}acme\/beta {2}-> "beta" {2}\[existing install \(\.forerunner\/project\.json\)\]$/,
    );
    expect(lines[3]).toMatch(/^Accept one with: fr sources accept/);
    const alphaId = lines[1]?.split(" ")[0] ?? "";
    lines = [];

    await fr("sources", "accept", alphaId, "--name", "Alpha", "--goal", "Keep alpha going");
    expect(lines[0]).toMatch(/^Project created: \S+ \(Alpha\) from acme\/alpha$/);
    const project = await store.project.byName("Alpha");
    expect(project?.repos).toEqual(["acme/alpha"]);
    expect(project?.goal).toBe("Keep alpha going");
    lines = [];

    await fr("sources", "candidates", sourceId, "--status", "accepted");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/accepted {2}acme\/alpha {2}-> "alpha" {2}\[project \S+\]$/);
    lines = [];
    // A status outside the four is refused the way the route refuses it, not an empty list.
    await expect(fr("sources", "candidates", sourceId, "--status", "nope")).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/proposed, accepted, duplicate, gone/),
    });
    expect(lines).toEqual([]);

    await fr("sources", "list", "--json");
    const listed = JSON.parse(lines.join("\n")) as {
      id: string;
      candidates: { accepted: number };
    }[];
    expect(listed.map((s) => [s.id, s.candidates.accepted])).toEqual([[sourceId, 1]]);
    lines = [];

    await fr("sources", "remove", sourceId);
    expect(lines).toEqual([`Removed source ${sourceId} (2 candidates forgotten; projects kept)`]);
    expect(await store.project.byName("Alpha")).toBeDefined();
    expect(await store.source.get(sourceId)).toBeUndefined();
  });

  it("refuses a token value, an unknown kind and a missing folder before anything is stored", async () => {
    const tokenValue = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""); // not-a-secret
    await expect(
      fr("sources", "add", "github_org", "acme", "--credential", tokenValue),
    ).rejects.toMatchObject({ code: "validation" });
    // An unknown kind is a refusal with a code that names the kinds, not a parser's stack.
    await expect(fr("sources", "add", "bitbucket", "acme")).rejects.toMatchObject({
      code: "validation",
      message: expect.stringMatching(/github_org.*local_folder/),
    });
    const missing = join(home, "nope");
    await expect(fr("sources", "add", "local_folder", missing)).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await store.source.list()).toEqual([]);
    expect(lines.join("\n")).not.toContain(tokenValue);
    mkdirSync(join(home, "work", "one"), { recursive: true });
    await fr("sources", "add", "local_folder", join(home, "work"));
    expect(lines[0]).toContain(`local_folder ${join(home, "work")}  connected`);
    expect(lines[0]).not.toContain("secret:");
  });
});
