import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MemoryGitHost } from "@forerunner/capabilities";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, silenceSqliteExperimentalWarning } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SourceDiscovery } from "../src/sources/discovery.ts";
import { createSourcesRoutes } from "../src/sources/routes.ts";
import {
  AcceptCandidateView,
  ScanResultView,
  SourceCandidateView,
  SourceView,
} from "../src/sources/types.ts";
import { ScriptedProvider } from "./helpers.ts";

silenceSqliteExperimentalWarning();

type Loose = Record<string, unknown> & { id?: string; code?: string; message?: string };
const json = (method: string, path: string, body?: unknown) =>
  new Request(`http://local${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const read = async (r: Response): Promise<Loose> => (await r.json()) as Loose;

/**
 * The `/sources` routes (spec A.4): shapes, status codes and the owner rule over the
 * discovery with an in-memory host; then the same routes mounted in the composed daemon
 * behind its bearer check, where an accepted proposal shows up as a project card.
 */
describe("sources routes", () => {
  let store: StateStore;
  let host: MemoryGitHost;
  let discovery: SourceDiscovery;
  let root: string;
  const clock = new SimulatedClock("2026-10-23T09:00:00.000Z");
  const humans = { ada: "", bob: "" };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "fr-sources-routes-"));
    store = await openStore({ url: "sqlite::memory:", clock });
    humans.ada = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
    humans.bob = (await store.human.insert({ name: "Bob", email: "bob@example.test" })).id;
    host = new MemoryGitHost("someone");
    for (const name of ["alpha", "beta"])
      await host.createRepo({ owner: "acme", name, private: false });
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
  });
  afterAll(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const app = (humanId = humans.ada) =>
    createSourcesRoutes({ discovery, actor: () => ({ humanId }) });

  it("adds, lists, scans, lists candidates, accepts and removes with typed answers and status codes", async () => {
    const a = app();
    expect(await read(await a.fetch(json("GET", "/sources")))).toEqual([]);
    const bad = await a.fetch(json("POST", "/sources", { kind: "github_org" }));
    expect(bad.status).toBe(400);
    expect((await read(bad)).code).toBe("validation");
    const later = await a.fetch(json("POST", "/sources", { kind: "gitlab", locator: "x" }));
    expect(later.status).toBe(400);
    expect((await read(later)).code).toBe("not_supported");
    const value = await a.fetch(
      json("POST", "/sources", { kind: "github_org", locator: "acme", credentialRef: "ghp_x" }),
    );
    expect(value.status).toBe(400);
    expect((await read(value)).message).toMatch(/never stored/);

    const created = await a.fetch(
      json("POST", "/sources", { kind: "github_org", locator: "acme" }),
    );
    expect(created.status).toBe(201);
    const source = SourceView.parse(await created.json());
    expect(source).toMatchObject({
      kind: "github_org",
      locator: "acme",
      credentialRef: "secret:github_token",
    });
    const twice = await a.fetch(json("POST", "/sources", { kind: "github_org", locator: "acme" }));
    expect(twice.status).toBe(409);
    expect(await read(twice)).toMatchObject({ code: "conflict", details: { cause: "validation" } });
    expect((await a.fetch(json("GET", "/sources/nope"))).status).toBe(404);
    expect(
      SourceView.parse(await (await a.fetch(json("GET", `/sources/${source.id}`))).json()).id,
    ).toBe(source.id);

    const scanned = await a.fetch(json("POST", `/sources/${source.id}/scan`));
    expect(scanned.status).toBe(200);
    const scan = ScanResultView.parse(await scanned.json());
    expect(scan.candidates.map((c) => [c.name, c.status, c.existingInstall])).toEqual([
      ["alpha", "proposed", false],
      ["beta", "proposed", true],
    ]);
    expect(scan.summary).toMatchObject({ total: 2, proposed: 2, installs: 1 });
    const listed = (await (
      await a.fetch(json("GET", `/sources/${source.id}/candidates`))
    ).json()) as unknown[];
    expect(listed.map((c) => SourceCandidateView.parse(c).id)).toEqual(
      scan.candidates.map((c) => c.id),
    );
    expect(
      (await a.fetch(json("GET", `/sources/${source.id}/candidates?status=nope`))).status,
    ).toBe(400);
    expect(
      (await (
        await a.fetch(json("GET", `/sources/${source.id}/candidates?status=accepted`))
      ).json()) as unknown[],
    ).toEqual([]);

    const alpha = scan.candidates[0];
    if (!alpha) throw new Error("alpha");
    const accepted = await a.fetch(
      json("POST", `/sources/candidates/${alpha.id}/accept`, { name: "Alpha" }),
    );
    expect(accepted.status).toBe(201);
    const result = AcceptCandidateView.parse(await accepted.json());
    expect(result.candidate).toMatchObject({ id: alpha.id, status: "accepted" });
    expect(result.project.name).toBe("Alpha");
    expect((await store.project.mustGet(result.project.id)).repos).toEqual(["acme/alpha"]);
    const again = await a.fetch(json("POST", `/sources/candidates/${alpha.id}/accept`));
    expect(again.status).toBe(409);
    expect((await read(again)).code).toBe("conflict");
    expect((await a.fetch(json("POST", "/sources/candidates/nope/accept"))).status).toBe(404);
    expect(
      (await a.fetch(json("POST", `/sources/candidates/${alpha.id}/accept`, { extra: 1 }))).status,
    ).toBe(400);

    // The owner rule: Bob neither sees nor touches Ada's source.
    const b = app(humans.bob);
    expect(await read(await b.fetch(json("GET", "/sources")))).toEqual([]);
    for (const r of [
      await b.fetch(json("GET", `/sources/${source.id}`)),
      await b.fetch(json("POST", `/sources/${source.id}/scan`)),
      await b.fetch(json("GET", `/sources/${source.id}/candidates`)),
      await b.fetch(json("POST", `/sources/candidates/${alpha.id}/accept`)),
      await b.fetch(json("DELETE", `/sources/${source.id}`)),
    ]) {
      expect(r.status).toBe(403);
      expect((await read(r)).code).toBe("forbidden");
    }

    const removed = await a.fetch(json("DELETE", `/sources/${source.id}`));
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true, id: source.id, candidatesRemoved: 2 });
    expect((await a.fetch(json("DELETE", `/sources/${source.id}`))).status).toBe(404);
    expect(await store.project.get(result.project.id)).toBeDefined();
  });

  it("answers 503 for a host that refuses the credential and 404 for a missing folder", async () => {
    const failing = new SourceDiscovery({
      store,
      clock,
      hostFor: () => {
        throw new (class extends Error {
          code = "provider_auth";
        })("bad credentials");
      },
      createProject: async () => {
        throw new Error("never");
      },
    });
    const a = createSourcesRoutes({ discovery: failing, actor: () => ({ humanId: humans.ada }) });
    const missing = await a.fetch(
      json("POST", "/sources", { kind: "local_folder", locator: join(root, "nope") }),
    );
    expect(missing.status).toBe(404);
    const src = SourceView.parse(
      await (
        await a.fetch(json("POST", "/sources", { kind: "github_user", locator: "someone" }))
      ).json(),
    );
    const scanned = await a.fetch(json("POST", `/sources/${src.id}/scan`));
    // A plain Error from the host is the module's 500; a ForerunnerError provider_auth is 503.
    expect([500, 503]).toContain(scanned.status);
    expect(
      SourceView.parse(await (await a.fetch(json("GET", `/sources/${src.id}`))).json()).status,
    ).toBe("error");
  });
});

describe("sources routes in the composed daemon", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  let home: string;
  const clock = new SimulatedClock("2026-10-23T09:00:00.000Z");
  const req = (path: string, init: RequestInit = {}, auth = true) =>
    app.request(path, {
      ...init,
      headers: {
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "fr-sources-daemon-"));
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    const host = new MemoryGitHost("someone");
    await host.createRepo({ owner: "acme", name: "alpha", private: false });
    await host.createRepo({ owner: "acme", name: "beta", private: true });
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault: new MemoryVault(),
      provider: new ScriptedProvider([{ text: "Noted." }], clock),
      gitHost: host,
      registryDir: join(process.cwd(), "evals", "registry"),
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    await rt?.close();
    rmSync(home, { recursive: true, force: true });
  });
  afterEach(() => undefined);

  it("mounts the routes behind the bearer; an accepted proposal is a project card with the repo and no brief", async () => {
    expect((await req("/sources", {}, false)).status).toBe(401);
    expect(await (await req("/sources")).json()).toEqual([]);
    // A project typed in through POST /projects already links beta by URL.
    const typed = await req("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "Beta",
        goal: "typed in",
        repos: ["https://github.com/acme/beta"],
      }),
    });
    expect(typed.status).toBe(201);
    const added = await req("/sources", {
      method: "POST",
      body: JSON.stringify({ kind: "github_org", locator: "acme", displayName: "Acme" }),
    });
    expect(added.status).toBe(201);
    const source = SourceView.parse(await added.json());
    const scan = ScanResultView.parse(
      await (await req(`/sources/${source.id}/scan`, { method: "POST" })).json(),
    );
    expect(scan.candidates.map((c) => [c.name, c.status])).toEqual([
      ["alpha", "proposed"],
      ["beta", "duplicate"],
    ]);
    const alpha = scan.candidates[0];
    if (!alpha) throw new Error("alpha");
    const accepted = await req(`/sources/candidates/${alpha.id}/accept`, {
      method: "POST",
      body: "{}",
    });
    expect(accepted.status).toBe(201);
    const result = AcceptCandidateView.parse(await accepted.json());
    const card = (await (await req(`/projects/${result.project.id}`)).json()) as Record<
      string,
      unknown
    >;
    expect(card).toMatchObject({ id: result.project.id, name: "alpha", stage: "planning" });
    const row = await rt.store.project.mustGet(result.project.id);
    expect(row.repos).toEqual(["acme/alpha"]);
    expect(row.summary_cache).toEqual({});
    expect(row.settings).toEqual({ members: [rt.agent.id] });
    expect(await rt.store.queue.list({ project_id: row.id })).toEqual([]);
    const cards = (await (await req("/projects")).json()) as { name: string }[];
    expect(cards.map((c) => c.name).sort()).toEqual(["Beta", "alpha"]);
    const dir = join(home, "folders");
    mkdirSync(join(dir, "proj", ".git"), { recursive: true });
    const folder = SourceView.parse(
      await (
        await req("/sources", {
          method: "POST",
          body: JSON.stringify({ kind: "local_folder", locator: dir }),
        })
      ).json(),
    );
    const folderScan = ScanResultView.parse(
      await (await req(`/sources/${folder.id}/scan`, { method: "POST" })).json(),
    );
    expect(folderScan.candidates.map((c) => [c.name, c.isGit])).toEqual([["proj", true]]);
    const sources = (await (await req("/sources")).json()) as unknown[];
    expect(sources.map((s) => SourceView.parse(s).kind)).toEqual(["github_org", "local_folder"]);
    expect(await (await req(`/sources/${source.id}`, { method: "DELETE" })).json()).toEqual({
      ok: true,
      id: source.id,
      candidatesRemoved: 2,
    });
    expect(((await (await req("/projects")).json()) as unknown[]).length).toBe(2);
  });
});
