// @vitest-environment node

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, run } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { GitOps } from "../../../packages/capabilities/src/githost/git.ts";
import type { MemoryGitHost } from "../../../packages/capabilities/src/githost/memory.ts";
import type { PullRequestInfo, RepoRef } from "../../../packages/capabilities/src/githost/types.ts";
import { removeHomes } from "../../../packages/runtime/test/helpers.ts";
import { detectRole } from "../../../testenv/src/bench/roles.ts";
import { ApiError, type DaemonClient } from "../src/api/client.ts";
import { composeTwo, type Home, type TwoHomes } from "./two-installs.ts";

/**
 * Two people's Forerunners on one repository, as people run them (the owner's D9 of 2026-11-09:
 * "if 2 people are working on the same project they should be able to work seamlessly in the
 * same git"). Each later wave 8 area appends its own describe block, '<key>, wave 8', below.
 */

/** What a refused call answered: the status, the message and the details. */
async function refusalOf(call: Promise<unknown>) {
  try {
    await call;
  } catch (e) {
    if (e instanceof ApiError) return { status: e.status, message: e.message, details: e.details };
    throw e;
  }
  throw new Error("the call was not refused");
}

/** Polls until `ok`; after 60 s fails with what it saw last. */
async function until(what: string, ok: () => Promise<boolean>, saw: () => Promise<string>) {
  const end = Date.now() + 60_000;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`still waiting after 60 s for ${what}: ${await saw()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const principalOf = async (client: DaemonClient) => {
  const me = await client.me();
  const agent = (await client.agents()).find(
    (a) => a.ownerHumanId === me.id && a.kind === "principal",
  );
  if (!agent) throw new Error("no principal agent");
  return agent;
};

/** One task of the person's, run in a session they start; its row and its pull request. */
async function runOneTask(home: Home, two: TwoHomes, projectId: string, title: string) {
  const task = await home.client.createTask(projectId, {
    title,
    outcome: `${title} is done`,
    riskTier: 1,
    specialist: "coder",
  });
  const agent = await principalOf(home.client);
  const started = await home.client.startSession({ agentId: agent.id, projectId });
  const sessionId = started.session?.id ?? "";
  const statuses = async () =>
    (await home.client.tasks(projectId)).map((t) => `${t.title}=${t.status}`).join(", ");
  expect(sessionId, await statuses()).not.toBe("");
  await until(
    `${home.humanName}'s session to end`,
    async () => (await home.client.session(sessionId)).status !== "running",
    statuses,
  );
  const row = await home.rt.store.task.mustGet(task.id);
  const pr = (await two.pullRequests()).find((p) => p.head.ref === row.branch);
  return { task: row, pr, sessionId, statuses };
}

describe("w8-two-homes, wave 8: harness", () => {
  for (const kind of ["memory", "http"] as const) {
    it(`${kind}: Ada makes "Team site" on team/shared, Bob works on it together; the pull request Bob's first task opens carries bob; neither writes to the other's pull requests; each home keeps its own install id; Bob's restart keeps the project and its id`, async () => {
      const two = await composeTwo({ host: kind });
      try {
        const { ada, bob } = two;
        // Each home is its own install: its own device row, its own person and agent name.
        const adaMe = await ada.client.me();
        const bobMe = await bob.client.me();
        expect(adaMe.desktopDeviceId).toBeTruthy();
        expect(bobMe.desktopDeviceId).toBeTruthy();
        expect(adaMe.desktopDeviceId).not.toBe(bobMe.desktopDeviceId);
        expect(adaMe.name).toBe("Ada");
        expect(bobMe.name).toBe("Bob");
        expect((await principalOf(ada.client)).name).not.toBe((await principalOf(bob.client)).name);

        // Ada makes the project; its docs pull request is ada's.
        const made = await ada.client.createProject({
          name: "Team site",
          goal: "A small site for the team",
          repos: ["team/shared"],
        });
        const adaPrs = await two.pullRequests();
        expect(adaPrs.map((p) => [p.head.ref, p.authorLogin])).toEqual([
          ["fr/docs-scaffold", "ada"],
        ]);
        const adaDocs = adaPrs[0] as PullRequestInfo;

        // Bob's New project on the same repository is the offer; Work together makes the
        // same project, with its id, and writes nothing to GitHub.
        const body = { name: "Bob's site", goal: "The team's site", repos: ["team/shared"] };
        const offer = await refusalOf(bob.client.createProject(body));
        expect(offer.status).toBe(409);
        expect(offer.details).toMatchObject({
          cause: "repository_used_elsewhere",
          projects: [made.id],
          canWorkTogether: true,
          canTakeOver: false,
        });
        const together = await bob.client.createProject({
          ...body,
          switch: true,
          together: { project: made.id },
        });
        // The same project: its id read from the repository at the press. (Its name is the
        // marker's once Ada's docs pull request is merged; before that it is the name Bob typed,
        // a finding for w8-together, not asserted here.)
        expect(together.id).toBe(made.id);
        expect(two.writesBy("bob")).toEqual([]);

        // Bob's first task opens its pull request as bob (before the per-login host it carried
        // ada's login through an Object.create copy of her host).
        const bobRun = await runOneTask(bob, two, made.id, "Write the about page in about.md");
        expect(bobRun.pr, await bobRun.statuses()).toBeDefined();
        expect(bobRun.pr?.authorLogin).toBe("bob");
        expect(bobRun.pr?.base.ref).toBe("main");
        // Neither Forerunner wrote to the other's pull request.
        const bobWrites = two.writesBy("bob");
        expect(bobWrites.filter((w) => w.action === "pull_request.create")).toHaveLength(1);
        expect(bobWrites.filter((w) => w.number === adaDocs.number)).toEqual([]);
        expect(two.writesBy("ada").filter((w) => w.number === bobRun.pr?.number)).toEqual([]);
        // Bob's home wrote no docs, marker, guide or status: only its task's branch and pull
        // request (a together project writes nothing else to the repository).
        expect(
          bobWrites.filter((w) => !["push", "pull_request.create", "other"].includes(w.action)),
        ).toEqual([]);
        // Each lists only its own pull requests.
        const listedBob = await bob.client.projectPullRequests(made.id);
        expect(listedBob.waiting.map((w) => w.number)).toEqual([bobRun.pr?.number]);
        const listedAda = await ada.client.projectPullRequests(made.id);
        expect(listedAda.waiting.map((w) => w.number)).not.toContain(bobRun.pr?.number);

        // Bob's daemon starts again: the same project, still together, the same install id.
        await bob.restart();
        const again = await bob.client.project(made.id);
        expect(again.id).toBe(made.id);
        expect(again.name).toBe(together.name);
        expect(again.repositoryElsewhere).toMatchObject({
          kind: "together",
          text: "Shared on GitHub with another Forerunner: each keeps its own tasks.",
        });
        expect((await bob.client.me()).desktopDeviceId).toBe(bobMe.desktopDeviceId);
        await ada.restart();
        expect((await ada.client.me()).desktopDeviceId).toBe(adaMe.desktopDeviceId);
        expect(
          (await bob.client.projectPullRequests(made.id)).waiting.map((w) => w.number),
        ).toEqual([bobRun.pr?.number]);
      } finally {
        await two.close();
      }
    }, 240_000);
  }

  it("holds: Bob's task waits at its specialist's first model call until released, and opens nothing on GitHub meanwhile", async () => {
    const two = await composeTwo({ host: "memory" });
    try {
      const { ada, bob } = two;
      const made = await ada.client.createProject({
        name: "Team site",
        goal: "A small site for the team",
        repos: ["team/shared"],
      });
      await bob.client.createProject({
        name: "Bob's site",
        goal: "g",
        repos: ["team/shared"],
        switch: true,
        together: { project: made.id },
      });
      const held = bob.holdModelCalls((req) => detectRole(req).role === "specialist");
      const task = await bob.client.createTask(made.id, {
        title: "Write the contact page in contact.md",
        outcome: "contact.md says how to reach the team",
        riskTier: 1,
        specialist: "coder",
      });
      const agent = await principalOf(bob.client);
      const started = await bob.client.startSession({ agentId: agent.id, projectId: made.id });
      await held.waiting;
      expect((await bob.client.session(started.session?.id ?? "")).status).toBe("running");
      expect((await bob.client.tasks(made.id)).find((t) => t.id === task.id)?.status).toBe(
        "in_progress",
      );
      expect(two.writesBy("bob").filter((w) => w.action === "pull_request.create")).toEqual([]);
      held.release();
      await until(
        "Bob's session to end",
        async () => (await bob.client.session(started.session?.id ?? "")).status !== "running",
        async () => String((await bob.client.tasks(made.id)).find((t) => t.id === task.id)?.status),
      );
      expect(two.writesBy("bob").filter((w) => w.action === "pull_request.create")).toHaveLength(1);
    } finally {
      await two.close();
    }
  }, 120_000);

  it("GitHub off for one home: only that home finds GitHub unreachable, and on again it reads it", async () => {
    const two = await composeTwo({ host: "memory" });
    try {
      const { ada, bob } = two;
      const made = await ada.client.createProject({
        name: "Team site",
        goal: "A small site for the team",
        repos: ["team/shared"],
      });
      bob.githubOff();
      expect(bob.githubIsOff).toBe(true);
      // Bob's Work together reads the repository at the press: refused in words while his
      // GitHub does not answer; Ada's home reads it as before.
      const down = await refusalOf(
        bob.client.createProject({
          name: "Bob's site",
          goal: "g",
          repos: ["team/shared"],
          switch: true,
          together: { project: made.id },
        }),
      );
      expect(down.message).toBe(
        "GitHub did not answer, so the project cannot be checked. Try again.",
      );
      expect(await bob.client.projects()).toEqual([]);
      expect((await ada.client.projectPullRequests(made.id)).waiting.length).toBe(1);
      bob.githubOn();
      const together = await bob.client.createProject({
        name: "Bob's site",
        goal: "g",
        repos: ["team/shared"],
        switch: true,
        together: { project: made.id },
      });
      expect(together.id).toBe(made.id);
    } finally {
      await two.close();
    }
  }, 120_000);
});

describe("w8-issue-host, wave 8: issue host", () => {
  /** Every file under `dir` that holds `text` (nothing of a GitHub read is kept on disk). */
  const filesHolding = (dir: string, text: string): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile() && readFileSync(p).includes(text)) out.push(p);
      }
    };
    walk(dir);
    return out;
  };

  for (const kind of ["memory", "http"] as const) {
    it(`${kind}: a comment Ada's Forerunner writes on the status issue is listed to Bob's with author ada and MEMBER, and the reverse with bob; each reads the other's write access; a repeated read is not modified; Bob's restart starts with no copy and nothing of it is on disk (W8-host-7)`, async () => {
      const two = await composeTwo({ host: kind });
      try {
        const { ada, bob } = two;
        const repo = two.repo;
        // The memory host follows roles only once they are declared: team, as on the stand-in.
        two.memory?.setOrg("team", { members: ["ada", "bob"], basePermission: "write" });
        const issue = await ada.rt.gitHost.createIssue(repo, {
          title: "Forerunner status: Team site",
          body: "",
        });
        const adas = await ada.rt.gitHost.commentOnIssue(repo, issue.number, "Ada's agent");
        const seenByBob = await bob.rt.gitHost.listIssueComments(repo, issue.number);
        expect(
          seenByBob.comments.map((c) => [c.id, c.author, c.authorAssociation, c.authorType]),
        ).toEqual([[adas.id, "ada", "MEMBER", "User"]]);
        const bobs = await bob.rt.gitHost.commentOnIssue(repo, issue.number, "Bob's agent");
        const seenByAda = await ada.rt.gitHost.listIssueComments(repo, issue.number);
        expect(seenByAda.comments.map((c) => [c.id, c.author, c.authorAssociation])).toEqual([
          [adas.id, "ada", "MEMBER"],
          [bobs.id, "bob", "MEMBER"],
        ]);
        // Each writes only its own comment; neither touched the other's.
        const comments = (login: string) =>
          two.writesBy(login).filter((w) => w.action === "comment" && w.number === issue.number);
        expect(comments("ada")).toHaveLength(1);
        expect(comments("bob")).toHaveLength(1);
        for (const login of ["ada", "bob"])
          expect(two.writesBy(login).filter((w) => w.action === "comment.update")).toEqual([]);
        // Write access is read from the repository (association is only a first filter).
        expect(await bob.rt.gitHost.getRepoPermission(repo, "ada")).toBe("write");
        expect(await ada.rt.gitHost.getRepoPermission(repo, "bob")).toBe("write");
        // Bob reads with what Ada saw: not modified for him either (his own copy was older, so
        // the stand-in answered in full); read again, the stand-in answers 304.
        const again = await bob.rt.gitHost.listIssueComments(repo, issue.number, {
          etag: seenByAda.etag ?? "",
        });
        expect(again.notModified).toBe(true);
        expect(again.comments.map((c) => c.id)).toEqual([adas.id, bobs.id]);
        const third = await bob.rt.gitHost.listIssueComments(repo, issue.number, {
          etag: again.etag ?? "",
        });
        expect(third.notModified).toBe(true);
        const path = `/repos/team/shared/issues/${issue.number}/comments`;
        const bobsReads = () =>
          (two.http?.requests() ?? []).filter(
            (r) => r.method === "GET" && r.path === path && r.auth?.login === "bob",
          );
        if (two.http) expect(bobsReads().map((r) => r.status)).toEqual([200, 200, 304]);
        // Bob's daemon starts again: his first read is a full read, and his home holds nothing
        // of what he read (the copy was in memory only).
        await bob.restart();
        const after = await bob.rt.gitHost.listIssueComments(repo, issue.number);
        expect(after.comments.map((c) => [c.author, c.authorAssociation])).toEqual([
          ["ada", "MEMBER"],
          ["bob", "MEMBER"],
        ]);
        if (two.http) {
          const reads = bobsReads();
          expect(reads.map((r) => r.status)).toEqual([200, 200, 304, 200]);
          // Before the restart he offered his copy's ETag; after it, none.
          expect(reads[2]?.ifNoneMatch).toBeTruthy();
          expect(reads[3]?.ifNoneMatch).toBeNull();
        }
        const etag = after.etag ?? "";
        expect(etag).toBeTruthy();
        expect(filesHolding(bob.home, etag)).toEqual([]);
        expect(filesHolding(ada.home, etag)).toEqual([]);
      } finally {
        await two.close();
      }
    }, 120_000);
  }
});

describe("w8-repo-guide, wave 8: a docs pull request this install did not open is nobody's (L4i-left-2)", () => {
  /** Bob's other project (on Bob's computer only) and a project no computer here has. */
  const BOB_OTHER = "01a1b000-0000-7000-8000-00000000b0b0";
  const OLD = "01a1b000-0000-7000-8000-0000000001d0";
  const markerOf = (project: string, name: string) =>
    `${JSON.stringify({ schema: 1, project, name }, null, 2)}\n`;
  const identity = { name: "Seed", email: "seed@example.test" };

  /** A repository of the organisation, made before either person: its files on main. */
  async function seedRepo(
    two: TwoHomes,
    work: string,
    name: string,
    files: Record<string, string>,
  ): Promise<string> {
    const bare = join(work, `${name}.git`);
    await run(["git", "init", "--bare", "-b", "main", bare]);
    const seedDir = join(work, `${name}-seed`);
    const seed = new GitOps({ cwd: seedDir, identity });
    await seed.clone(bare);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(seedDir, ...path.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(seedDir, ...path.split("/")), text);
    }
    await seed.commitAll("seed");
    await seed.push("main");
    const memory = two.memory as MemoryGitHost;
    await memory.createRepo({ owner: "team", name, private: true, cloneUrl: bare });
    for (const [path, text] of Object.entries(files))
      await memory.putFile(
        { owner: "team", name },
        { path, content: text, message: "seed", branch: "main" },
      );
    return bare;
  }

  /**
   * Bob's `fr/docs-scaffold` on the repository (as Bob's Forerunner, a person or an older
   * version leaves it): its own `.forerunner/project.json` names `onBranch`, or it has none; and
   * an open pull request on it whose body names no project.
   */
  async function bobsScaffoldPr(
    two: TwoHomes,
    work: string,
    repo: RepoRef,
    bare: string,
    onBranch: string | null,
  ) {
    const dir = join(work, `${repo.name}-bob`);
    const clone = new GitOps({ cwd: dir, identity: { name: "Bob", email: "bob@example.test" } });
    await clone.clone(bare);
    await run(["git", "-C", dir, "checkout", "-q", "-b", "fr/docs-scaffold"]);
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "notes.md"), "# Notes\n\nBob's notes.\n");
    if (onBranch) {
      mkdirSync(join(dir, ".forerunner"), { recursive: true });
      writeFileSync(join(dir, ".forerunner", "project.json"), markerOf(onBranch, "Bob's notes"));
    }
    await clone.commitAll("docs: notes");
    await clone.push("fr/docs-scaffold", { defaultBranch: "main" });
    const pr = await (two.memory as MemoryGitHost).openPullRequestAs(repo, "bob", {
      title: "docs: notes",
      body: "Bob's notes for the repository.",
      head: "fr/docs-scaffold",
    });
    return { pr, sha: await branchSha(bare) };
  }

  const branchSha = async (bare: string) =>
    (await run(["git", "--git-dir", bare, "rev-parse", "fr/docs-scaffold"])).stdout.trim();

  const LISTED_ONLY = (n: number) =>
    `#${n} names no project, so it is only listed here: open it on GitHub to see whose it is.`;

  for (const [label, onBranch] of [
    ["names Bob's other project", BOB_OTHER],
    ["has no marker file", null],
    ["names the project Ada takes over", OLD],
  ] as const) {
    it(`Bob's unmarked fr/docs-scaffold pull request whose branch ${label}: Ada's scaffold, her take-over and its rebuild, and her Try again push nothing to it and comment nothing on it; her Overview lists it without Merge`, async () => {
      const two = await composeTwo({ host: "memory" });
      const work = mkdtempSync(join(tmpdir(), "fr-repo-guide-"));
      try {
        const { ada } = two;
        // 1. A plain project: Ada's "Team site" is the only project on her computer linked to
        // team/shared; Bob's open docs pull request is there first.
        const shared = (await (two.memory as MemoryGitHost).getRepo(two.repo)).cloneUrl;
        const bobs = await bobsScaffoldPr(two, work, two.repo, shared, onBranch);
        const made = await ada.client.createProject({
          name: "Team site",
          goal: "A small site for the team",
          repos: ["team/shared"],
        });
        expect(await branchSha(shared)).toBe(bobs.sha);
        expect(two.writesBy("ada").filter((w) => w.number === bobs.pr.number)).toEqual([]);
        const listed = (await ada.client.projectPullRequests(made.id)).waiting;
        expect(listed.map((r) => [r.number, r.kind, r.merge?.canMerge, r.merge?.sentence])).toEqual(
          [[bobs.pr.number, "docs", false, LISTED_ONLY(bobs.pr.number)]],
        );

        // 2. A take-over: team/old's main names "Old site", which no computer here has; Bob's
        // unmarked pull request is open on its fr/docs-scaffold. Ada takes it over.
        const old = await seedRepo(two, work, "old", {
          "README.md": "# old\n",
          ".forerunner/project.json": markerOf(OLD, "Old site"),
        });
        const oldRepo = { owner: "team", name: "old" };
        const bobsOld = await bobsScaffoldPr(two, work, oldRepo, old, onBranch);
        const took = await ada.client.createProject({
          name: "Old site again",
          goal: "The old site, kept going",
          repos: ["team/old"],
          switch: true,
          takeOver: { projects: [OLD] },
        });
        expect(await branchSha(old)).toBe(bobsOld.sha);
        expect(two.writesBy("ada").filter((w) => w.number === bobsOld.pr.number)).toEqual([]);
        expect((await ada.client.project(took.id)).repositoryElsewhere).toMatchObject({
          outcome: "took_over_no_pull_request",
          tryAgainLine: "Tries again to open the docs pull request that names this project.",
        });
        // Try again through the client: refused in one sentence, and still nothing on Bob's.
        expect(await ada.client.retryTakeOver(took.id)).toEqual({
          state: "refused",
          sentence:
            "The docs pull request still could not be opened: another docs pull request is open on team/old; close it on GitHub, then try again.",
          prUrl: null,
        });
        expect(await branchSha(old)).toBe(bobsOld.sha);
        expect(two.writesBy("ada").filter((w) => w.number === bobsOld.pr.number)).toEqual([]);
        expect(
          (await two.pullRequests(oldRepo)).map((p) => [p.number, p.head.ref, p.authorLogin]),
        ).toEqual([[bobsOld.pr.number, "fr/docs-scaffold", "bob"]]);
        const oldListed = (await ada.client.projectPullRequests(took.id)).waiting;
        expect(oldListed.map((r) => [r.number, r.merge?.canMerge])).toEqual([
          [bobsOld.pr.number, false],
        ]);
      } finally {
        removeHomes([work]);
        await two.close();
      }
    }, 120_000);
  }

  it("a docs pull request Ada's install opened stays hers by its recorded address after its body lost the mark, also after her daemon starts again", async () => {
    const two = await composeTwo({ host: "memory" });
    try {
      const { ada } = two;
      const made = await ada.client.createProject({
        name: "Team site",
        goal: "A small site for the team",
        repos: ["team/shared"],
      });
      const [own] = await two.pullRequests();
      expect(own?.authorLogin).toBe("ada");
      // Someone edits the body on GitHub: the hidden mark is gone.
      await (two.memory as MemoryGitHost).updatePullRequest(two.repo, own?.number ?? 0, {
        body: "Our docs.",
      });
      await ada.restart();
      const listed = (await ada.client.projectPullRequests(made.id)).waiting;
      expect(listed.map((r) => [r.number, r.kind, r.merge?.canMerge])).toEqual([
        [own?.number, "docs", true],
      ]);
    } finally {
      await two.close();
    }
  }, 120_000);
});
