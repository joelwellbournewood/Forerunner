import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { GitOps, MemoryGitHost } from "@forerunner/capabilities";
import { appDirs, join, run, SimulatedClock } from "@forerunner/platform";
import type { SessionRow } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * D9 (the owner's answer of 2026-11-09: "if 2 people are working on the same project they should
 * be able to work seamlessly in the same git. Isnt this already built in cleanly?"): two
 * Forerunners, on two homes, on one repository. The second one's New project is refused with the
 * offer; Work together makes the same project there, with its id read from the repository at the
 * press, and nothing is written to GitHub, then or later: no branch, no pull request, no comment,
 * no marker, its status kept in the app with the words that say why. Each install lists only its
 * own pull requests. The same after the second daemon starts again.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const identity = { name: "Forerunner", email: "agent@example.test" };
type Json = Record<string, unknown>;

describe("d1109-onerepo-link, run C: two Forerunners on one repository (OR-15)", () => {
  it("B's New project is refused with Work together only (A's account worked on it today); Work together makes A's project on B with nothing written to GitHub; each lists only its own pull requests; B's status stays in the app with the together note; the same after B starts again", async () => {
    const root = mkdtempSync(join(tmpdir(), "fr-two-homes-"));
    const bare = join(root, "kite.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    await seed.clone(bare);
    writeFileSync(join(root, "seed", "README.md"), "# kite\n");
    await seed.commitAll("seed");
    await seed.push("main");
    // One GitHub, two accounts: A's Forerunner runs as alice, B's as bob.
    const host = new MemoryGitHost("alice");
    const repo = { owner: "o", name: "kite" };
    await host.createRepo({ ...repo, private: true, cloneUrl: bare });
    // w8-two-homes (W8-homes-2): bob's own view of the same GitHub, so whatever B's Forerunner
    // writes carries bob (an Object.create copy overriding whoAmI wrote as alice).
    const asBob = host.asLogin("bob");
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    // GitHub stamps its pull requests on the daemons' day.
    host.now = () => clock.nowIso();
    const compose = async (name: string, gitHost: MemoryGitHost) => {
      const home = join(root, name);
      const rt = await composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
        config: null,
        clock,
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        vault: new MemoryVault(),
        provider: new ScriptedProvider([{ text: "Noted." }], clock),
        registryDir: REGISTRY,
        identity: { humanName: name, timezone: "UTC", agentName: "Alice" },
        appVersion: "0.1.0-test",
        gitHost,
        data: { projectsRoot: join(home, "projects") },
        startServices: false,
      });
      const { app, token } = createDaemonApp(rt);
      const call = async (method: string, path: string, body?: unknown) => {
        const r = await app.request(path, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        });
        return { status: r.status, body: (await r.json()) as Json };
      };
      return { rt, call };
    };
    const a = await compose("home-a", host);
    let b: Awaited<ReturnType<typeof compose>> | null = null;
    const closing: RuntimeApp[] = [a.rt];
    try {
      // A makes the project; its scaffold opens its docs pull request (alice's, marked with A's
      // id), and its marker reaches the default branch (as when that pull request is merged).
      const made = await a.call("POST", "/projects", {
        name: "Kite club",
        goal: "Kites",
        repos: ["o/kite"],
      });
      expect(made.status).toBe(201);
      const kiteId = String(made.body.id);
      await host.putFile(repo, {
        path: ".forerunner/project.json",
        content: `${JSON.stringify({ schema: 1, project: kiteId, name: "Kite club" }, null, 2)}\n`,
        message: "marker",
        branch: "main",
      });
      const prsA = await host.listPullRequests(repo, { state: "all" });
      expect(prsA.map((p) => p.head.ref)).toEqual(["fr/docs-scaffold"]);
      const branches = async () =>
        (await run(["git", "--git-dir", bare, "branch", "--list"])).stdout;
      const before = {
        branches: await branches(),
        prs: JSON.stringify(await host.listPullRequests(repo, { state: "all" })),
        comments: (await host.listPullRequestComments(repo, prsA[0]?.number ?? 0)).length,
        main: (await host.getFile(repo, ".forerunner/project.json"))?.content,
      };
      b = await compose("home-b", asBob);
      closing.push(b.rt);
      // A's account worked on it today: one repository is one project, so Work together only.
      const offer = await b.call("POST", "/projects", {
        name: "Mine",
        goal: "g",
        repos: ["https://github.com/O/kite.git"],
      });
      expect(offer.status).toBe(409);
      expect(offer.body.message).toBe(
        // The repository as the person spelled it.
        'O/kite is already the Forerunner project "Kite club"; another GitHub account worked on it on 5 Mar. One repository is one project, so work on it together here.',
      );
      expect(offer.body.details).toMatchObject({
        cause: "repository_used_elsewhere",
        projects: [kiteId],
        canWorkTogether: true,
        canTakeOver: false,
      });
      const takeOver = await b.call("POST", "/projects", {
        name: "Mine",
        goal: "g",
        repos: ["o/kite"],
        takeOver: { projects: [kiteId] },
      });
      expect(takeOver.status).toBe(409);
      const together = await b.call("POST", "/projects", {
        name: "Mine",
        goal: "g",
        repos: ["o/kite"],
        switch: true,
        together: { project: kiteId },
      });
      expect(together.status).toBe(201);
      expect(together.body.id).toBe(kiteId);
      expect(together.body.name).toBe("Kite club");
      const nothingWritten = async () => {
        expect(await branches()).toBe(before.branches);
        expect(JSON.stringify(await host.listPullRequests(repo, { state: "all" }))).toBe(
          before.prs,
        );
        expect((await host.listPullRequestComments(repo, prsA[0]?.number ?? 0)).length).toBe(
          before.comments,
        );
        expect((await host.getFile(repo, ".forerunner/project.json"))?.content).toBe(before.main);
      };
      await nothingWritten();
      // Each lists only its own pull requests: A its docs pull request, B none of A's.
      const listedA = await a.call("GET", `/projects/${kiteId}/pull-requests`);
      expect((listedA.body.waiting as Json[]).map((p) => p.number)).toEqual([prsA[0]?.number]);
      const listedB = await b.call("GET", `/projects/${kiteId}/pull-requests`);
      expect(listedB.body.waiting).toEqual([]);
      // B's Overview says it is shared; nothing to take over.
      const card = await b.call("GET", `/projects/${kiteId}`);
      expect(card.body.repositoryElsewhere).toMatchObject({
        kind: "together",
        text: "Shared on GitHub with another Forerunner: each keeps its own tasks.",
        canTakeOver: false,
      });
      // B's session status (with an earlier version's status pull request setting on): the
      // app's, nothing pushed (w8-status-write: GitHub's copy is the status issue, which B
      // writes once a task starts or a session ends, not at Work together, OR-15).
      const row = await b.rt.store.project.mustGet(kiteId);
      await b.rt.docs.writeSessionStatus({
        project: { ...row, settings: { ...row.settings, status_pull_request: true } },
        session: {
          id: "0196f1f2-8a7b-7c3d-9e4f-0a1b2c3d4e5f",
          started_at: clock.nowIso(),
        } as SessionRow,
        update: {
          sessionId: "0196f1f2-8a7b-7c3d-9e4f-0a1b2c3d4e5f",
          endedAt: clock.nowIso(),
          done: ["Write the kite guide"],
          inFlight: [],
          blocked: [],
          next: [],
          note: "Spent CHF 0.09.",
        },
      });
      await nothingWritten();
      const docsRow = async (call: typeof a.call) =>
        ((await call("GET", `/projects/${kiteId}/docs`)).body as unknown as Json[]).find((d) =>
          String(d.path).endsWith("status.md"),
        );
      expect((await docsRow(b.call))?.note).toBe(
        "Status on GitHub: the status issue is written when a task starts or a session ends.",
      );
      // C2-left-13: a together project never writes docs, so a doc it does not have is not
      // "not written yet": the row says who writes it, with no missing mark.
      const bCall = b.call;
      const missingB = async () =>
        ((await bCall("GET", `/projects/${kiteId}/docs`)).body as unknown as Json[]).filter(
          (d) => d.exists === false,
        );
      expect((await missingB()).length).toBeGreaterThan(0);
      for (const d of await missingB())
        expect({ note: d.note, notWrittenHere: d.notWrittenHere }).toEqual({
          note: 'The other Forerunner of "Kite club" writes this doc on GitHub; this project does not write docs.',
          notWrittenHere: true,
        });
      // B starts again: still the same project, still together, still nothing written.
      await b.rt.close();
      closing.pop();
      b = await compose("home-b", asBob);
      closing.push(b.rt);
      expect((await b.call("GET", `/projects/${kiteId}`)).body.repositoryElsewhere).toMatchObject({
        kind: "together",
      });
      expect((await docsRow(b.call))?.note).toBe(
        "Status on GitHub: the status issue is written when a task starts or a session ends.",
      );
      expect((await b.call("GET", `/projects/${kiteId}/pull-requests`)).body.waiting).toEqual([]);
      await nothingWritten();
    } finally {
      for (const rt of closing) await rt.close();
    }
  }, 120_000);
});

describe("l4-github-link, run L4", () => {
  it("L4-github-105: Work together stamps settings.together.at with the daemon's clock, kept after B starts again and on Work together for a removed project", async () => {
    const root = mkdtempSync(join(tmpdir(), "fr-together-clock-"));
    const bare = join(root, "kite.git");
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seed = new GitOps({ cwd: join(root, "seed"), identity });
    await seed.clone(bare);
    writeFileSync(join(root, "seed", "README.md"), "# kite\n");
    await seed.commitAll("seed");
    await seed.push("main");
    const host = new MemoryGitHost("alice");
    const repo = { owner: "o", name: "kite" };
    await host.createRepo({ ...repo, private: true, cloneUrl: bare });
    // w8-two-homes (W8-homes-2): bob's own view of the same GitHub.
    const asBob = host.asLogin("bob");
    const clock = new SimulatedClock("2026-03-05T08:00:00Z");
    host.now = () => clock.nowIso();
    const compose = async (name: string, gitHost: MemoryGitHost) => {
      const home = join(root, name);
      const rt = await composeRuntime({
        env: { FORERUNNER_HOME: home },
        dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
        config: null,
        clock,
        stateUrl: `sqlite:${join(home, "state.sqlite")}`,
        vault: new MemoryVault(),
        provider: new ScriptedProvider([{ text: "Noted." }], clock),
        registryDir: REGISTRY,
        identity: { humanName: name, timezone: "UTC", agentName: "Alice" },
        appVersion: "0.1.0-test",
        gitHost,
        data: { projectsRoot: join(home, "projects") },
        startServices: false,
      });
      const { app, token } = createDaemonApp(rt);
      const call = async (method: string, path: string, body?: unknown) => {
        const r = await app.request(path, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        });
        return { status: r.status, body: (await r.json()) as Json };
      };
      return { rt, call };
    };
    const closing: RuntimeApp[] = [];
    try {
      const a = await compose("home-a", host);
      closing.push(a.rt);
      const made = await a.call("POST", "/projects", {
        name: "Kite club",
        goal: "Kites",
        repos: ["o/kite"],
      });
      expect(made.status).toBe(201);
      const kiteId = String(made.body.id);
      await host.putFile(repo, {
        path: ".forerunner/project.json",
        content: `${JSON.stringify({ schema: 1, project: kiteId, name: "Kite club" }, null, 2)}\n`,
        message: "marker",
        branch: "main",
      });
      let b = await compose("home-b", asBob);
      closing.push(b.rt);
      // The daemon's day, not the computer's: the simulated clock is months from the wall clock.
      await clock.set("2026-03-05T09:15:00.000Z");
      const together = await b.call("POST", "/projects", {
        name: "Mine",
        goal: "g",
        repos: ["o/kite"],
        together: { project: kiteId },
      });
      expect(together.status).toBe(201);
      const at = async () => {
        const row = await b.rt.store.project.mustGet(kiteId);
        return (row.settings.together as Json | undefined)?.at;
      };
      expect(await at()).toBe("2026-03-05T09:15:00.000Z");
      // B starts again: the stamp is the one written at the press.
      await clock.set("2026-03-05T10:00:00.000Z");
      await b.rt.close();
      closing.pop();
      b = await compose("home-b", asBob);
      closing.push(b.rt);
      expect(await at()).toBe("2026-03-05T09:15:00.000Z");
      // Removed here, then Work together again: the same row comes back, stamped at that press.
      const row = await b.rt.store.project.mustGet(kiteId);
      await b.rt.store.project.update(row.id, row.version, {
        status: "archived",
        active: false,
        name: `Kite club (removed ${row.id.slice(-8)})`,
        settings: { ...row.settings, removed_name: row.name },
      });
      await clock.set("2026-03-06T07:30:00.000Z");
      const back = await b.call("POST", "/projects", {
        name: "Mine",
        goal: "g",
        repos: ["o/kite"],
        together: { project: kiteId },
      });
      expect(back.status).toBe(201);
      expect(back.body.id).toBe(kiteId);
      expect(await at()).toBe("2026-03-06T07:30:00.000Z");
    } finally {
      for (const rt of closing) await rt.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
