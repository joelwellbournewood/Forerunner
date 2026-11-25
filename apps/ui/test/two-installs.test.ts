// @vitest-environment node

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, run } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { GitOps } from "../../../packages/capabilities/src/githost/git.ts";
import type { MemoryGitHost } from "../../../packages/capabilities/src/githost/memory.ts";
import type { PullRequestInfo, RepoRef } from "../../../packages/capabilities/src/githost/types.ts";
import { scaffoldBranchesOf } from "../../../packages/runtime/src/loop/docs.ts";
import { readStatusIssueKey } from "../../../packages/runtime/src/loop/status-board-words.ts";
import { removeHomes } from "../../../packages/runtime/test/helpers.ts";
import { detectRole } from "../../../testenv/src/bench/roles.ts";
import { ApiError, type DaemonClient } from "../src/api/client.ts";
import {
  composeTwo,
  followDefaultBranch,
  type Home,
  MEMORY_ACTIONS,
  seedBranch,
  type TwoHomes,
  writeOfRequest,
} from "./two-installs.ts";

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
        // Bob's home wrote no docs, marker, guide or status file: only its task's branch and
        // pull request (a together project writes nothing else to the repository), and
        // (w8-status-write, W8-write-6) its own comment on the project's status issue.
        await bob.rt.statusBoard.settled();
        const statusIssue = new Set(
          (await bob.rt.gitHost.listIssues(two.repo, { state: "all" }))
            .filter((i) => readStatusIssueKey(i.body) === made.id)
            .map((i) => i.number),
        );
        const onStatusIssue = (w: (typeof bobWrites)[number]) =>
          ["issue.create", "issue.update", "issue.pin", "comment", "comment.update"].includes(
            w.action,
          ) &&
          (w.number === undefined || statusIssue.has(w.number));
        expect(
          two
            .writesBy("bob")
            .filter(
              (w) => !["push", "pull_request.create"].includes(w.action) && !onStatusIssue(w),
            ),
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
    it(`Bob's unmarked fr/docs-scaffold pull request whose branch ${label}: Ada's scaffold and her take-over push nothing to it and comment nothing on it, and open her docs pull request on her own branch (W8a-left-22); her Overview lists it without Merge`, async () => {
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
        // w8-together (W8a-left-22): Ada's scaffold passes over Bob's branch and opens her one
        // docs pull request on her own (before: it stopped at fr/docs-scaffold, with none).
        const own = (await two.pullRequests()).filter((p) => p.authorLogin === "ada");
        expect(own.map((p) => p.head.ref)).toEqual(["fr/docs-scaffold-team-site"]);
        // fixup-w8-repo-guide: listed apart ("listed", the Overview's "Also open on GitHub"),
        // with a title that claims nothing about it (before: "docs", "The project's standard
        // docs", under "Waiting for you to merge").
        const listed = (await ada.client.projectPullRequests(made.id)).waiting;
        expect(
          listed
            .filter((r) => r.number === bobs.pr.number)
            .map((r) => [r.number, r.kind, r.title, r.merge?.canMerge, r.merge?.sentence]),
        ).toEqual([
          [
            bobs.pr.number,
            "listed",
            `Docs pull request #${bobs.pr.number}`,
            false,
            LISTED_ONLY(bobs.pr.number),
          ],
        ]);
        expect(
          listed.filter((r) => r.number === own[0]?.number).map((r) => [r.kind, r.merge?.canMerge]),
        ).toEqual([["docs", true]]);
        // Merge on it is refused with its line, and nothing is written to it.
        expect(await ada.client.mergePullRequest(made.id, bobs.pr.number)).toEqual({
          state: "refused",
          sentence: LISTED_ONLY(bobs.pr.number),
          order: [],
        });

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
        // w8-together (W8a-left-22): the take-over's docs pull request goes on Ada's own branch,
        // so the take-over lands and there is no Try again (before: 'took_over_no_pull_request'
        // and a Try again refused with 'another docs pull request is open on team/old').
        const elsewhere = (await ada.client.project(took.id)).repositoryElsewhere;
        expect(elsewhere?.outcome).toBeUndefined();
        expect(elsewhere?.tryAgainLine).toBeUndefined();
        expect(await branchSha(old)).toBe(bobsOld.sha);
        expect(two.writesBy("ada").filter((w) => w.number === bobsOld.pr.number)).toEqual([]);
        const oldPrs = (await two.pullRequests(oldRepo)).map((p) => [
          p.number,
          p.head.ref,
          p.authorLogin,
        ]);
        expect(oldPrs).toHaveLength(2);
        expect(oldPrs[0]).toEqual([bobsOld.pr.number, "fr/docs-scaffold", "bob"]);
        expect(oldPrs[1]?.slice(1)).toEqual(["fr/docs-scaffold-old-site-again", "ada"]);
        const oldListed = (await ada.client.projectPullRequests(took.id)).waiting;
        expect(
          oldListed
            .map((r) => [r.number, r.kind, r.title, r.merge?.canMerge])
            .filter((r) => r[0] === bobsOld.pr.number),
        ).toEqual([
          [bobsOld.pr.number, "listed", `Docs pull request #${bobsOld.pr.number}`, false],
        ]);
        expect(
          two
            .writesBy("ada")
            .filter((w) => w.repo === "team/shared" && w.number === bobs.pr.number),
        ).toEqual([]);
      } finally {
        removeHomes([work]);
        await two.close();
      }
    }, 120_000);
  }

  it("L4i-left-8: a take-over made with a brief whose plan's docs pull request could not be opened says so on the Overview with Try again, also after her daemon starts again; Try again opens it", async () => {
    const two = await composeTwo({ host: "memory" });
    const work = mkdtempSync(join(tmpdir(), "fr-repo-guide-"));
    try {
      const { ada } = two;
      await seedRepo(two, work, "old", {
        "README.md": "# old\n",
        ".forerunner/project.json": markerOf(OLD, "Old site"),
      });
      const took = await ada.client.createProject({
        name: "Old site again",
        goal: "The old site, kept going",
        repos: ["team/old"],
        switch: true,
        takeOver: { projects: [OLD] },
        brief: "A one-page site for the club: plain HTML and CSS.",
        intake: true,
      });
      await ada.rt.intake.inFlight(took.id);
      const me = await ada.client.me();
      const card = (await ada.client.inbox(me.id)).requests.find(
        (r) => r.projectId === took.id && r.status === "open",
      );
      if (!card) throw new Error("no plan card");
      // GitHub does not answer while the plan's docs go out: no docs pull request names the
      // project. Before, the Overview said nothing (no scaffold record).
      ada.githubOff();
      await ada.client.answerRequest(card.id, {
        version: card.version,
        answer: "Approve and start",
      });
      ada.githubOn();
      const oldRepo = { owner: "team", name: "old" };
      expect(
        (await two.pullRequests(oldRepo)).filter((p) => p.head.ref.startsWith("fr/intake-")),
      ).toEqual([]);
      const line = {
        outcome: "took_over_no_pull_request",
        tryAgainLine: "Tries again to open the docs pull request that names this project.",
        text: 'Took over team/old from "Old site" here, but the docs pull request that names this project could not be opened, so GitHub still names "Old site".',
      };
      expect((await ada.client.project(took.id)).repositoryElsewhere).toMatchObject(line);
      await ada.restart();
      expect((await ada.client.project(took.id)).repositoryElsewhere).toMatchObject(line);
      // Try again opens the docs pull request that names the project, and the line goes.
      const again = await ada.client.retryTakeOver(took.id);
      expect(again.state, again.sentence).toBe("opened");
      const opened = (await two.pullRequests(oldRepo)).filter((p) => p.state === "open");
      expect(opened.map((p) => [p.head.ref, p.authorLogin])).toEqual([["fr/docs-scaffold", "ada"]]);
      expect((await ada.client.project(took.id)).repositoryElsewhere?.outcome).toBeUndefined();
    } finally {
      removeHomes([work]);
      await two.close();
    }
  }, 180_000);

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

describe("w8-repo-guide, wave 8: the guide is written by the Forerunner that made the project (W8-guide-1, -2, -3)", () => {
  const WORK_TOGETHER =
    'This repository is the Forerunner project "Team site". To work on it with Forerunner, link this repository in your own Forerunner and choose Work together; do not start a second project on it.';
  const AFTER_REVIEW =
    "- The Forerunner that made this project merges its pull requests itself once its critic accepted them.";

  /** A file on a branch of the stand-in's bare repository, or null. */
  async function show(bare: string, ref: string, path: string): Promise<string | null> {
    const r = await run(["git", "--git-dir", bare, "show", `${ref}:${path}`], {
      allowFailure: true,
    });
    return r.code === 0 ? r.stdout : null;
  }
  const head = async (bare: string, ref: string) =>
    (await run(["git", "--git-dir", bare, "rev-parse", ref], { allowFailure: true })).stdout.trim();

  /** Presses Merge in the home's Overview and waits for GitHub to say the pull request merged. */
  async function merge(home: Home, two: TwoHomes, projectId: string, number: number) {
    const answer = await home.client.mergePullRequest(projectId, number);
    expect(answer.state, answer.sentence).toBe("queued");
    await until(
      `#${number} to merge`,
      async () => !!(await two.pullRequests()).find((p) => p.number === number)?.merged,
      async () => JSON.stringify((await two.pullRequests()).map((p) => [p.number, p.state])),
    );
  }

  it("http: Ada's docs pull request brings AGENTS.md, CLAUDE.md and no docs/status.md; a fact she changes gives one docs pull request, none after her restart; Bob's together project writes no doc set, marker or guide over two sessions, a change of its own and a restart, and his Docs tab says whose the guide is; each home's decision file goes in its own task pull request under the day's name and both merge", async () => {
    const two = await composeTwo({ host: "http" });
    try {
      const { ada, bob } = two;
      const bare = two.http?.repo(two.repo)?.dir ?? "";
      expect(bare).not.toBe("");
      const day = new Date().toISOString().slice(0, 10);

      // 1. Ada makes the project: its one docs pull request carries the guide, no status file.
      const made = await ada.client.createProject({
        name: "Team site",
        goal: "A small site for the team",
        repos: ["team/shared"],
      });
      const [docsPr, ...others] = await two.pullRequests();
      expect(others).toEqual([]);
      expect([docsPr?.head.ref, docsPr?.authorLogin]).toEqual(["fr/docs-scaffold", "ada"]);
      const agents = (await show(bare, "fr/docs-scaffold", "AGENTS.md")) ?? "";
      expect(agents).toContain(WORK_TOGETHER);
      expect(agents).toContain(
        "- The person who made this project presses Merge in Forerunner for its pull requests.",
      );
      expect(agents).toContain("- Never push to `main`.");
      expect(await show(bare, "fr/docs-scaffold", "CLAUDE.md")).toBe("@AGENTS.md\n");
      expect(await show(bare, "fr/docs-scaffold", "docs/status.md")).toBeNull();
      // The repository's own README is kept as it is.
      expect(await show(bare, "fr/docs-scaffold", "README.md")).toBe("# shared\n");
      await merge(ada, two, made.id, docsPr?.number ?? 0);
      expect(await show(bare, "main", "AGENTS.md")).toBe(agents);

      // 2. Ada's task records a decision under the day's name; her session's end opens no
      // second docs pull request (nothing in the guide's facts changed).
      const adaRun = await runOneTask(
        ada,
        two,
        made.id,
        `Record the hosting choice in docs/decisions/${day}-hosting.md`,
      );
      expect(adaRun.pr, await adaRun.statuses()).toBeDefined();
      expect(adaRun.pr?.authorLogin).toBe("ada");
      expect(
        await show(bare, adaRun.pr?.head.ref ?? "", `docs/decisions/${day}-hosting.md`),
      ).not.toBeNull();
      expect(
        (await two.pullRequests()).filter((p) => p.head.ref.startsWith("fr/docs-scaffold")),
      ).toHaveLength(1);

      // 3. Bob works on it together: nothing written to GitHub, and his Docs tab names whose the
      // guide is.
      const docsHead = await head(bare, "fr/docs-scaffold");
      const together = await bob.client.createProject({
        name: "Bob's site",
        goal: "The team's site",
        repos: ["team/shared"],
        switch: true,
        together: { project: made.id },
      });
      expect(together.id).toBe(made.id);
      expect(two.writesBy("bob")).toEqual([]);
      const bobRun = await runOneTask(
        bob,
        two,
        made.id,
        `Record the domain choice in docs/decisions/${day}-domain.md`,
      );
      expect(bobRun.pr, await bobRun.statuses()).toBeDefined();
      expect(bobRun.pr?.authorLogin).toBe("bob");
      expect(
        await show(bare, bobRun.pr?.head.ref ?? "", `docs/decisions/${day}-domain.md`),
      ).not.toBeNull();
      // One decision pull request from each home: both merge, with no name conflict.
      await merge(ada, two, made.id, adaRun.pr?.number ?? 0);
      await merge(bob, two, made.id, bobRun.pr?.number ?? 0);
      expect(await show(bare, "main", `docs/decisions/${day}-hosting.md`)).not.toBeNull();
      expect(await show(bare, "main", `docs/decisions/${day}-domain.md`)).not.toBeNull();

      // Bob changes a fact of his own project, runs a second session and starts again: still
      // no doc set, marker or guide from his home, and no write to the docs branch.
      const bobRow = await bob.rt.store.project.mustGet(made.id);
      await bob.client.updateProjectSettings(made.id, {
        version: bobRow.version,
        settings: { merge_mode: "after_review" },
      });
      const bobAgain = await runOneTask(bob, two, made.id, "Write the contact page in contact.md");
      expect(bobAgain.pr, await bobAgain.statuses()).toBeDefined();
      await bob.restart();
      await bob.rt.docs.refreshGuide(await bob.rt.store.project.mustGet(made.id));
      const bobWrites = two.writesBy("bob");
      // w8-status-write (W8-write-6): beside its task pull requests, Bob's Forerunner writes
      // only its own comment on the project's status issue (and may rebuild its body).
      await bob.rt.statusBoard.settled();
      const statusIssue = new Set(
        (await bob.rt.gitHost.listIssues(two.repo, { state: "all" }))
          .filter((i) => readStatusIssueKey(i.body) === made.id)
          .map((i) => i.number),
      );
      expect(
        bobWrites.filter(
          (w) =>
            !["push", "pull_request.create", "pull_request.merge"].includes(w.action) &&
            !(
              ["issue.create", "issue.update", "issue.pin", "comment", "comment.update"].includes(
                w.action,
              ) &&
              (w.number === undefined || statusIssue.has(w.number))
            ),
        ),
      ).toEqual([]);
      const bobsPrs = (await two.pullRequests()).filter((p) => p.authorLogin === "bob");
      expect(
        bobsPrs.map((p) => p.head.ref).filter((r) => /^fr\/(docs|intake|status)/.test(r)),
      ).toEqual([]);
      expect(bobsPrs).toHaveLength(
        bobWrites.filter((w) => w.action === "pull_request.create").length,
      );
      expect(await head(bare, "fr/docs-scaffold")).toBe(docsHead);
      expect(await show(bare, "main", "AGENTS.md")).toBe(agents);
      const bobDocs = await bob.client.docs(made.id);
      for (const path of ["AGENTS.md", "CLAUDE.md"])
        expect(bobDocs.find((d) => d.path === path)).toMatchObject({
          exists: true,
          notWrittenHere: true,
          note: 'The other Forerunner of "Team site" writes this doc on GitHub; this project does not write docs.',
        });

      // 4. Ada changes a fact (who merges): her next session's end opens exactly one docs pull
      // request with the new sentence; after her daemon starts again, none more.
      const adaRow = await ada.rt.store.project.mustGet(made.id);
      await ada.client.updateProjectSettings(made.id, {
        version: adaRow.version,
        settings: { merge_mode: "after_review" },
      });
      await runOneTask(ada, two, made.id, "Write the team page in team.md");
      const guidePrs = async () =>
        (await two.pullRequests()).filter(
          (p) => p.state === "open" && p.head.ref.startsWith("fr/docs-scaffold"),
        );
      const opened = await guidePrs();
      expect(opened.map((p) => p.authorLogin)).toEqual(["ada"]);
      const updated = (await show(bare, opened[0]?.head.ref ?? "", "AGENTS.md")) ?? "";
      expect(updated).toContain(AFTER_REVIEW);
      expect(updated).toContain(WORK_TOGETHER);
      await ada.restart();
      await runOneTask(ada, two, made.id, "Write the news page in news.md");
      expect((await guidePrs()).map((p) => p.number)).toEqual(opened.map((p) => p.number));
    } finally {
      await two.close();
    }
  }, 300_000);
});

describe("w8-status-write, wave 8: one pinned status issue, one comment per Forerunner", () => {
  const ISSUE_TITLE = "Forerunner status: Team site";
  /** The lines a person reads (the hidden markers are the one place an id stands, D-W8-35). */
  const visible = (text: string) =>
    text
      .split("\n")
      .filter((l) => !/^<!-- \/?forerunner:[\w-]+.*-->$/.test(l.trim()))
      .join("\n");
  const statusIssues = async (home: Home, repo: RepoRef) =>
    (await home.rt.gitHost.listIssues(repo, { state: "all" })).filter(
      (i) => i.title === ISSUE_TITLE && readStatusIssueKey(i.body) !== null,
    );
  const commentsOf = async (home: Home, repo: RepoRef, n: number) =>
    (await home.rt.gitHost.listIssueComments(repo, n)).comments;
  /** Ada makes "Team site" on team/shared; Bob works on it together. */
  async function teamSite(two: TwoHomes) {
    const made = await two.ada.client.createProject({
      name: "Team site",
      goal: "A small site for the team",
      repos: ["team/shared"],
    });
    const together = await two.bob.client.createProject({
      name: "Bob's site",
      goal: "The team's site",
      repos: ["team/shared"],
      switch: true,
      together: { project: made.id },
    });
    expect(together.id).toBe(made.id);
    // OR-15: the Work together press writes nothing, the status issue neither.
    expect(two.writesBy("bob")).toEqual([]);
    return made;
  }

  it("http: Ada's and Bob's Forerunners keep one pinned issue with the marker and the label and two comments, each edited only by its writer and the same comments across sessions and restarts; the body lists both; no raw device id, no money, no status pull request; Bob's Docs row and Settings say where; the issue's creation gives Ada no docs pull request (W8-write-1, -2, -3, -5, -6, W8a-left-1)", async () => {
    const two = await composeTwo({ host: "http" });
    try {
      const { ada, bob } = two;
      const repo = two.repo;
      const made = await teamSite(two);
      const adaDevice = (await ada.client.me()).desktopDeviceId ?? "";
      const bobDevice = (await bob.client.me()).desktopDeviceId ?? "";
      expect(adaDevice).not.toBe("");
      expect(bobDevice).not.toBe("");
      const docsPrs = async () =>
        (await two.pullRequests()).filter((p) => /^fr\/(docs-scaffold|intake)/.test(p.head.ref));
      const docsBefore = (await docsPrs()).map((p) => p.number);

      // Ada's first task start opens the issue (no issue at linking or at Work together).
      await runOneTask(ada, two, made.id, "Write the about page in about.md");
      await ada.rt.statusBoard.settled();
      const [issue, ...more] = await statusIssues(ada, repo);
      expect(more).toEqual([]);
      expect(issue).toMatchObject({ state: "open", labels: ["forerunner:status"] });
      expect(issue?.body.split("\n")[0]).toBe(`<!-- forerunner:status v1 key=${made.id} -->`);
      expect(two.http?.pinnedIssues(repo)).toEqual([issue?.number]);
      // W8a-left-1 (D-W8-44): the issue's number is no guide fact: its creation opened no docs
      // pull request of Ada's.
      expect((await docsPrs()).map((p) => p.number)).toEqual(docsBefore);

      // Bob's first task adds his comment to the same issue; no second issue.
      await runOneTask(bob, two, made.id, "Write the contact page in contact.md");
      await bob.rt.statusBoard.settled();
      expect((await statusIssues(bob, repo)).map((i) => i.number)).toEqual([issue?.number]);
      const first = await commentsOf(ada, repo, issue?.number ?? 0);
      expect(first.map((c) => c.author)).toEqual(["ada", "bob"]);
      const ids = first.map((c) => c.id);
      expect(first[0]?.body).toContain("**Ada's agent (Forerunner)** · ada · updated ");
      expect(first[1]?.body).toContain("**Bob's agent (Forerunner)** · bob · updated ");
      expect(first[0]?.body).toContain('did 1 task: "Write the about page in about.md"');
      // The body lists both writers.
      const body = (await ada.rt.gitHost.getIssue(repo, issue?.number ?? 0)).body;
      expect(body).toContain("**ada's Forerunner**");
      expect(body).toContain("**bob's Forerunner**");

      // Restarts, then one more session each: the same two comments, edited in place.
      await ada.restart();
      await bob.restart();
      await runOneTask(ada, two, made.id, "Write the news page in news.md");
      await runOneTask(bob, two, made.id, "Write the team page in team.md");
      await ada.rt.statusBoard.settled();
      await bob.rt.statusBoard.settled();
      const after = await commentsOf(ada, repo, issue?.number ?? 0);
      expect(after.map((c) => c.id)).toEqual(ids);
      expect(after[0]?.body).toContain('did 1 task: "Write the news page in news.md"');
      expect(after[1]?.body).toContain('did 1 task: "Write the team page in team.md"');
      // Each comment edited only by its writer; neither wrote to the other's pull requests.
      for (const [login, own] of [
        ["ada", ids[0]],
        ["bob", ids[1]],
      ] as const) {
        const edits = two.writesBy(login).filter((w) => w.action === "comment.update");
        expect(edits.length, login).toBeGreaterThan(0);
        for (const e of edits) expect(e.op.endsWith(`/issues/comments/${own}`), e.op).toBe(true);
      }
      const prs = await two.pullRequests();
      for (const [login, other] of [
        ["ada", "bob"],
        ["bob", "ada"],
      ] as const) {
        const theirs = prs.filter((p) => p.authorLogin === other).map((p) => p.number);
        expect(two.writesBy(login).filter((w) => w.number && theirs.includes(w.number))).toEqual(
          [],
        );
      }
      // W8-write-5: no status pull request and no fr/status branch, from either home.
      expect(prs.filter((p) => p.head.ref === "fr/status")).toEqual([]);
      // W8-write-3, -2: no raw device id anywhere on GitHub; no money, email or mention.
      const texts = [
        (await ada.rt.gitHost.getIssue(repo, issue?.number ?? 0)).body,
        ...after.map((c) => c.body),
      ];
      for (const t of texts) {
        expect(t).not.toContain(adaDevice);
        expect(t).not.toContain(bobDevice);
        expect(visible(t)).not.toMatch(/CHF|USD|EUR|Spent|@|[0-9a-f]{8}-[0-9a-f]{4}-/);
      }
      // W8-write-6: Bob's Docs row and Settings say where his status is.
      const bobStatus = (await bob.client.docs(made.id)).find((d) => d.path === "docs/status.md");
      expect(bobStatus?.note).toBe(`In the app; also on GitHub: issue #${issue?.number}`);
      expect(bobStatus?.notWrittenHere).toBeUndefined();
      const bobRow = (await bob.client.settings()).find(
        (r) => r.key === "project.status_issue" && r.scopeId === made.id,
      );
      expect(bobRow?.description).toContain(`Status on GitHub: issue #${issue?.number} (pinned)`);
      // Run C's Details line names the status issue (exact text).
      expect((await bob.client.project(made.id)).repositoryElsewhere?.details).toBe(
        "What the other Forerunner does shows in its comment on the status issue and its pull requests on GitHub. You merge yours; its person merges theirs.",
      );
    } finally {
      await two.close();
    }
  }, 300_000);

  it("memory: a write that waits while GitHub is off is kept across a restart and sent once when GitHub answers; Settings says it waits meanwhile; Quit with nothing running writes nothing", async () => {
    const two = await composeTwo({ host: "memory" });
    try {
      const { ada } = two;
      const repo = two.repo;
      const made = await teamSite(two);
      await runOneTask(ada, two, made.id, "Write the about page in about.md");
      await ada.rt.statusBoard.settled();
      const [issue] = await statusIssues(ada, repo);
      const [mine] = await commentsOf(ada, repo, issue?.number ?? 0);
      ada.githubOff();
      await runOneTask(ada, two, made.id, "Write the news page in news.md");
      await ada.rt.statusBoard.settled();
      const row = async () =>
        (await ada.client.settings()).find(
          (r) => r.key === "project.status_issue" && r.scopeId === made.id,
        );
      expect((await row())?.description).toMatch(
        /Status on GitHub: last updated \d\d:\d\d; it updates when GitHub answers\.$/,
      );
      const writesBefore = two.writesBy("ada").length;
      // Quit with nothing running: nothing of the writer is sent (no Working on now lines).
      await ada.restart();
      expect(two.writesBy("ada").length).toBe(writesBefore);
      ada.githubOn();
      // Opening Settings (or the Docs tab) sends what waited, once.
      await row();
      await until(
        "the waiting status to reach GitHub",
        async () =>
          two
            .writesBy("ada")
            .slice(writesBefore)
            .some((w) => w.action === "comment.update"),
        async () => JSON.stringify(two.writesBy("ada").slice(writesBefore)),
      );
      await ada.rt.statusBoard.settled();
      expect((await commentsOf(ada, repo, issue?.number ?? 0))[0]?.body).not.toBe(mine?.body);
      const sent = two.writesBy("ada").slice(writesBefore);
      expect(sent.filter((w) => w.action === "comment.update")).toHaveLength(1);
      expect((await commentsOf(ada, repo, issue?.number ?? 0)).map((c) => c.id)).toEqual([
        mine?.id,
      ]);
      await row();
      await ada.rt.statusBoard.settled();
      expect(
        two
          .writesBy("ada")
          .slice(writesBefore)
          .filter((w) => w.action === "comment.update"),
      ).toHaveLength(1);
    } finally {
      await two.close();
    }
  }, 300_000);

  /**
   * fixup-w8-status-write: Ada's home runs a task whose specialist call is held, until the
   * comment on GitHub says she works on it ("Working on now"). The issue's number, her comment
   * and a read of the comments on the host itself (no home's client: one may be stopped).
   */
  async function adaWorkingOnNews(two: TwoHomes, made: { id: string }) {
    const { ada } = two;
    const memory = two.memory as MemoryGitHost;
    await runOneTask(ada, two, made.id, "Write the about page in about.md");
    await ada.rt.statusBoard.settled();
    const [issue] = await statusIssues(ada, two.repo);
    const n = issue?.number ?? 0;
    const onHost = async () => (await memory.listIssueComments(two.repo, n)).comments;
    const [mine] = await onHost();
    const held = ada.holdModelCalls((req) => detectRole(req).role === "specialist");
    await ada.client.createTask(made.id, {
      title: "Write the news page in news.md",
      outcome: "news.md lists the team's news",
      riskTier: 1,
      specialist: "coder",
    });
    const agent = await principalOf(ada.client);
    await ada.client.startSession({ agentId: agent.id, projectId: made.id });
    await held.waiting;
    await until(
      "Ada's Working on now line on GitHub",
      async () => {
        await ada.rt.statusBoard.settled();
        return ((await onHost())[0]?.body ?? "").includes(
          'Working on now\n- "Write the news page in news.md"',
        );
      },
      async () => (await onHost())[0]?.body ?? "",
    );
    return { n, mine, onHost };
  }

  it("memory: Quit while a task runs and GitHub does not answer: at the next start, with GitHub back and no screen open, the comment loses its Working on now line, in one edit of the same comment", async () => {
    const two = await composeTwo({ host: "memory" });
    try {
      const { ada } = two;
      const made = await teamSite(two);
      const { mine, onHost } = await adaWorkingOnNews(two, made);
      ada.githubOff();
      await ada.quit();
      // GitHub still shows the line Quit could not clear.
      expect((await onHost())[0]?.body).toContain("Working on now");
      const atQuit = two.writesBy("ada").length;
      ada.githubOn();
      await ada.start();
      // No Settings, no Docs tab, no new work: the start itself sends what waited.
      await until(
        "the waiting text to reach GitHub with no screen open",
        async () =>
          two
            .writesBy("ada")
            .slice(atQuit)
            .some((w) => w.action === "comment.update"),
        async () => JSON.stringify(two.writesBy("ada").slice(atQuit)),
      );
      await ada.rt.statusBoard.settled();
      const after = await onHost();
      expect(after.map((c) => c.id)).toEqual([mine?.id]);
      expect(after[0]?.body).not.toContain("Working on now");
      const sent = two.writesBy("ada").slice(atQuit);
      expect(sent.filter((w) => w.action === "comment.update")).toHaveLength(1);
      expect(sent.filter((w) => w.action === "comment" || w.action === "issue.create")).toEqual([]);
    } finally {
      await two.close();
    }
  }, 300_000);

  it("memory: Quit while a task runs with GitHub answering clears its Working on now line before the daemon ends; nothing of the writer runs after, and the next start writes nothing", async () => {
    const two = await composeTwo({ host: "memory" });
    try {
      const { ada } = two;
      const made = await teamSite(two);
      const { mine, onHost } = await adaWorkingOnNews(two, made);
      await ada.quit();
      const atQuit = two.writesBy("ada").length;
      const after = await onHost();
      expect(after.map((c) => c.id)).toEqual([mine?.id]);
      expect(after[0]?.body).not.toContain("Working on now");
      expect(ada.rt.statusBoard.read(made.id).pending).toBeNull();
      await ada.start();
      await ada.rt.statusBoard.settled();
      expect(
        two
          .writesBy("ada")
          .slice(atQuit)
          .filter((w) => /^(comment|issue)/.test(w.action)),
      ).toEqual([]);
    } finally {
      await two.close();
    }
  }, 300_000);

  it("memory: W8-write-9: Bob's 'Site' on team/shared, whose default branch's marker names Ada's 'Team site', writes no issue and no comment over a session and a restart, and its status stays in the app with its sentence", async () => {
    const two = await composeTwo({ host: "memory" });
    try {
      const { ada, bob } = two;
      const repo = two.repo;
      const made = await ada.client.createProject({
        name: "Team site",
        goal: "A small site for the team",
        repos: ["team/shared"],
      });
      // Ada's marker is on the default branch (as when her docs pull request merged).
      await two.memory?.putFile(repo, {
        path: ".forerunner/project.json",
        content: `${JSON.stringify({ schema: 1, project: made.id, name: "Team site" })}\n`,
        message: "marker",
        branch: "main",
      });
      // Bob made "Site" while GitHub did not answer him (the link check fails open then).
      bob.githubOff();
      const site = await bob.client.createProject({
        name: "Site",
        goal: "Another site",
        repos: ["team/shared"],
      });
      bob.githubOn();
      expect(site.id).not.toBe(made.id);
      const sentence =
        'Status stays in the app: team/shared is the Forerunner project "Team site"; Work together on the Overview shares its status issue.';
      const check = async () => {
        await runOneTask(bob, two, site.id, "Write the shop page in shop.md");
        await bob.rt.statusBoard.settled();
        expect(
          two
            .writesBy("bob")
            .filter((w) => w.action.startsWith("issue") || w.action.startsWith("comment")),
        ).toEqual([]);
        const row = (await bob.client.settings()).find(
          (r) => r.key === "project.status_issue" && r.scopeId === site.id,
        );
        expect(row?.description).toContain(sentence);
        const status = (await bob.client.docs(site.id)).find((d) => d.path === "docs/status.md");
        expect(status?.note).toBe(sentence);
      };
      await check();
      await bob.restart();
      await check();
    } finally {
      await two.close();
    }
  }, 300_000);

  it("memory: W8-write-10 and W8a-left-1: switched off, Bob writes no issue and no comment and his row says so after a restart too; Ada's comment is untouched; Ada switching hers off gives one docs pull request whose guide says so, and Bob's together project opens none", async () => {
    const two = await composeTwo({ host: "memory" });
    try {
      const { ada, bob } = two;
      const repo = two.repo;
      const made = await teamSite(two);
      await runOneTask(ada, two, made.id, "Write the about page in about.md");
      await ada.rt.statusBoard.settled();
      const [issue] = await statusIssues(ada, repo);
      const adaComment = (await commentsOf(ada, repo, issue?.number ?? 0))[0];
      const off = async (home: Home) => {
        const r = await home.client.executeCommands({
          commands: [
            {
              name: "settings.set",
              params: { key: "status_issue", value: false, project: made.id },
            },
          ],
          source: "ui",
          projectId: made.id,
          confirm: "tap",
        });
        expect(r.status).toBe("done");
      };
      await off(bob);
      await runOneTask(bob, two, made.id, "Write the contact page in contact.md");
      await bob.rt.statusBoard.settled();
      const bobIssueWrites = () =>
        two
          .writesBy("bob")
          .filter((w) => w.action.startsWith("issue") || w.action.startsWith("comment"));
      expect(bobIssueWrites()).toEqual([]);
      const offWords =
        'Status stays in the app: the status issue is turned off for "Bob\'s site" in Settings.';
      const bobRow = async () =>
        (await bob.client.settings()).find(
          (r) => r.key === "project.status_issue" && r.scopeId === made.id,
        );
      expect(await bobRow()).toMatchObject({ value: false });
      expect((await bobRow())?.description).toContain(offWords);
      await bob.restart();
      expect(await bobRow()).toMatchObject({ value: false });
      await runOneTask(bob, two, made.id, "Write the team page in team.md");
      await bob.rt.statusBoard.settled();
      expect(bobIssueWrites()).toEqual([]);
      expect((await commentsOf(ada, repo, issue?.number ?? 0)).map((c) => [c.id, c.body])).toEqual([
        [adaComment?.id, adaComment?.body],
      ]);
      // Ada switches hers off: her next session's end opens one docs pull request whose guide
      // says the status is kept in the app; Bob's together project opens none.
      const guidePrs = async () =>
        (await two.pullRequests()).filter((p) => p.head.ref.startsWith("fr/docs-scaffold"));
      const before = await guidePrs();
      const atOff = two.writesBy("ada").length;
      await off(ada);
      await runOneTask(ada, two, made.id, "Write the news page in news.md");
      await ada.rt.statusBoard.settled();
      // Exactly one docs pull request carries it: the intake's, still open, gets the guide and
      // one comment; no second docs pull request is opened.
      expect(before.map((p) => [p.number, p.state])).toEqual([[1, "open"]]);
      expect((await guidePrs()).map((p) => p.number)).toEqual([1]);
      const sinceOff = two.writesBy("ada").slice(atOff);
      expect(
        sinceOff.filter(
          (w) => w.action === "pull_request.create" && w.detail?.startsWith("fr/docs-scaffold"),
        ),
      ).toEqual([]);
      expect(sinceOff.filter((w) => w.action === "comment" && w.number === 1)).toHaveLength(1);
      const bare = (await two.memory?.getRepo(repo))?.cloneUrl ?? "";
      const branch = (await guidePrs()).at(-1)?.head.ref ?? "fr/docs-scaffold";
      const guide = (
        await run(["git", "--git-dir", bare, "show", `${branch}:AGENTS.md`], {
          allowFailure: true,
        })
      ).stdout;
      expect(guide).toContain(
        "- Status: the Forerunner that made this project keeps its status in the app; its status issue is switched off for this project, so it announces nothing on GitHub.",
      );
      expect(two.writesBy("bob").filter((w) => w.detail?.startsWith("fr/docs-scaffold"))).toEqual(
        [],
      );
    } finally {
      await two.close();
    }
  }, 300_000);
});

describe("w8-together, wave 8: join together", () => {
  const KITE_LINE =
    'team/shared is also the Forerunner project "Kite club", which is not on this computer; another GitHub account worked on it on';
  const UNREADABLE = "GitHub did not answer, so the project cannot be checked. Try again.";

  /** Ada's "Kite club" on team/shared; its marker on the default branch when `merged`. */
  async function kiteClub(two: TwoHomes, merged: boolean) {
    const { ada } = two;
    const kite = await ada.client.createProject({
      name: "Kite club",
      goal: "The kite club's site",
      repos: ["team/shared"],
    });
    const docs = (await two.pullRequests()).find((p) => p.head.ref === "fr/docs-scaffold");
    expect(docs?.authorLogin).toBe("ada");
    if (merged) {
      if (two.memory)
        // The memory host's merge leaves the bare repository as it was: the marker goes on
        // main as when Ada's docs pull request merged.
        await seedBranch(two, "main", {
          ".forerunner/project.json": `${JSON.stringify({ schema: 1, project: kite.id, name: "Kite club" })}\n`,
        });
      else {
        const answer = await ada.client.mergePullRequest(kite.id, docs?.number ?? 0);
        expect(answer.state, answer.sentence).toBe("queued");
        await until(
          "Ada's docs pull request to merge",
          async () => !!(await two.pullRequests()).find((p) => p.number === docs?.number)?.merged,
          async () => JSON.stringify((await two.pullRequests()).map((p) => [p.number, p.state])),
        );
      }
    }
    return { kite, docs: docs as PullRequestInfo };
  }

  /**
   * Bob's "Site" on team/shared, made while GitHub did not answer him (the one-repository rule
   * could not read the repository then), with two tasks and the status pull request an earlier
   * version of his Forerunner opened for it on fr/status (Site's mark, his session's record).
   */
  async function bobsSite(two: TwoHomes) {
    const { bob } = two;
    bob.githubOff();
    const site = await bob.client.createProject({
      name: "Site",
      goal: "Another site",
      repos: ["team/shared"],
    });
    bob.githubOn();
    const tasks = [];
    for (const title of ["Write the home page in index.html", "Write the contact page"])
      tasks.push(
        await bob.client.createTask(site.id, {
          title,
          outcome: `${title} is done`,
          riskTier: 1,
          specialist: "coder",
        }),
      );
    await seedBranch(two, "fr/status", { "docs/status.md": "# Status\n\nWorking on the site.\n" });
    const pr = await bob.rt.gitHost.createPullRequest(two.repo, {
      title: "docs: project status",
      body: `Status of the project, from an earlier version.\n\n<!-- forerunner:pr project=${site.id} -->`,
      head: "fr/status",
      base: "main",
    });
    const agent = (await bob.rt.store.agent.list({}))[0]?.id as string;
    const session = await bob.rt.store.session.insert({
      agent_id: agent,
      project_id: site.id,
      trigger: "manual",
      plan: {},
      budget_cap_usd_micro: 1,
      step_cap: 1,
      spent_usd_micro: 0,
      steps: 0,
      status: "completed",
      summary: "",
      handoff: {},
      runner: "pc",
    });
    await bob.rt.store.event.append(session.id, "docs.status_written", {
      location: "repo",
      branch: "fr/status",
      prUrl: pr.htmlUrl,
    } as never);
    return { site, tasks, pr };
  }

  /** The press: Work together on the Overview's line, through the UI's own client. */
  const workTogether = (home: Home, projectId: string) =>
    home.client.executeCommands({
      commands: [
        { name: "project.join", params: { keep: { together: true }, close: [projectId] } },
      ],
      wordsUsed: "Work together (Overview)",
      source: "ui",
      projectId,
      confirm: "tap",
    });

  it("W8a-left-5: every write the memory host records and every write route of the stand-in GitHub has a name, so 'wrote nothing' sees it", () => {
    const root = join(process.cwd(), "..", "..");
    const memory = readFileSync(
      join(root, "packages", "capabilities", "src", "githost", "memory.ts"),
      "utf8",
    );
    const ops = [...memory.matchAll(/this\.wrote\("(\w+)"/g)].map((m) => m[1] as string);
    expect(ops.length).toBeGreaterThan(15);
    expect(ops.filter((op) => !MEMORY_ACTIONS[op])).toEqual([]);
    const dir = join(root, "testenv", "src", "githost");
    const routes: string[] = [];
    for (const file of readdirSync(dir).filter((f) => /^routes-.*\.ts$/.test(f)))
      for (const m of readFileSync(join(dir, file), "utf8").matchAll(
        /app\.(post|patch|put|delete)\("([^"]+)"/g,
      ))
        routes.push(`${(m[1] as string).toUpperCase()} ${m[2]}`);
    expect(routes.length).toBeGreaterThan(40);
    const sample = (path: string) =>
      path
        .replace(":owner", "team")
        .replace(":repo", "shared")
        .replace(":org", "team")
        .replace(/:(number|id|sha)/g, "7")
        .replace("*", "x");
    const unnamed = routes.filter((r) => {
      const [method, path] = r.split(" ") as [string, string];
      return writeOfRequest("ada", method, sample(path)).action === "other";
    });
    expect(unnamed).toEqual([]);
    // A git push and a GraphQL mutation have their names too.
    expect(writeOfRequest("ada", "POST", "/team/shared.git/git-receive-pack").action).toBe("push");
    expect(writeOfRequest("ada", "POST", "/graphql", { operation: "Other" }).action).toBe(
      "graphql.mutation",
    );
  });

  it("http: W8-join-1, -2: Work together on Bob's 'Site' makes it Ada's 'Kite club' with its id, moves its two tasks, and writes on GitHub only the close of Site's own old status pull request; Undo after Bob's daemon starts twice puts Site back and says the pull request stays closed", async () => {
    const two = await composeTwo({ host: "http" });
    try {
      const { bob } = two;
      const { kite, docs } = await kiteClub(two, true);
      const { site, tasks, pr } = await bobsSite(two);
      // Before the join Bob wrote no issue and no comment for Site (W8-write-9).
      const setup = two.writesBy("bob");
      expect(setup.filter((w) => /^(issue|comment)/.test(w.action))).toEqual([]);
      // Ada's own writes (her docs pull request's merge may be logged after GitHub says merged).
      const adaOwn = (w: { action: string; number?: number }) =>
        !(w.action === "pull_request.merge" && w.number === docs.number);
      const adaBefore = two.writesBy("ada").filter(adaOwn).length;
      // Bob's Overview: the line, with Work together first (another GitHub account worked on
      // "Kite club" within 14 days, so no Take it over).
      await followDefaultBranch(bob, site.id);
      const card = await bob.client.project(site.id);
      expect(card.repositoryElsewhere?.text.startsWith(KITE_LINE)).toBe(true);
      expect(card.repositoryElsewhere).toMatchObject({
        kind: "elsewhere",
        canWorkTogether: true,
        togetherLine:
          'This project\'s tasks, plan and cards move into "Kite club"; both Forerunners work on it.',
        canTakeOver: false,
      });
      // The together form: the sentence, the one line on GitHub, what stays.
      const preview = await bob.client.togetherPreview(site.id);
      expect(preview.together).toEqual({
        projectId: kite.id,
        name: "Kite club",
        sentence:
          '"Site" becomes "Kite club", the project GitHub knows: its tasks, plan and cards move into it, and this Forerunner works on it together with the other one.',
        github: `On GitHub only the old status pull request #${pr.number} of "Site" is closed, with one line saying why; nothing of the other Forerunner is touched.`,
        stays: '"Site" keeps its sessions, changes and spending to read; no budget changes.',
        refusal: null,
      });
      // The dialog read GitHub; it wrote nothing.
      expect(two.writesBy("bob")).toEqual(setup);

      const done = await workTogether(bob, site.id);
      expect(done.status, done.reason).toBe("done");
      expect(done.sentence).toBe(
        `"Site" joined "Kite club", which this Forerunner works on together with another one; its old status pull request #${pr.number} is closed.`,
      );
      // Bob's together project has Ada's id and the marker's name; Site's two tasks are in it.
      const made = await bob.client.project(kite.id);
      expect(made.name).toBe("Kite club");
      expect(made.repositoryElsewhere?.kind).toBe("together");
      expect((await bob.client.tasks(kite.id)).map((t) => t.id).sort()).toEqual(
        tasks.map((t) => t.id).sort(),
      );
      expect((await bob.client.project(site.id)).joinedInto?.name).toBe("Kite club");
      // The whole log: from Bob only the line on and the close of Site's own old status pull
      // request; nothing on Ada's pull requests, comments or issue; Ada wrote nothing.
      expect(
        two
          .writesBy("bob")
          .slice(setup.length)
          .map((w) => [w.action, w.number]),
      ).toEqual([
        ["comment", pr.number],
        ["pull_request.update", pr.number],
      ]);
      expect((await two.pullRequests()).find((p) => p.number === pr.number)?.state).toBe("closed");
      expect(two.writesBy("ada").filter(adaOwn).slice(adaBefore)).toEqual([]);

      // Bob's daemon starts again, twice; Undo from Changes then puts Site back with its link
      // and its tasks, says what stays closed, and removes the together project here.
      await bob.restart();
      await bob.restart();
      const change = (await bob.client.changes({ limit: 20 })).find(
        (c) => (c.commands[0] as { name?: string } | undefined)?.name === "project.join",
      );
      expect(change?.sentence).toBe(done.sentence);
      const undone = await bob.client.undoChange(change?.id ?? "");
      expect(undone.status, undone.reason).toBe("done");
      expect(undone.sentence).toBe(
        `"Site" is its own project again; its old status pull request #${pr.number} stays closed on GitHub.`,
      );
      const back = await bob.client.project(site.id);
      expect(back.joinedInto ?? null).toBeNull();
      expect(back.repos).toEqual(["team/shared"]);
      expect((await bob.client.tasks(site.id)).map((t) => t.id).sort()).toEqual(
        tasks.map((t) => t.id).sort(),
      );
      expect((await bob.client.projects()).some((p) => p.id === kite.id)).toBe(false);
      expect((await two.pullRequests()).find((p) => p.number === pr.number)?.state).toBe("closed");
      // The Undo wrote nothing on GitHub; Site's line offers Work together again.
      expect(two.writesBy("bob").length).toBe(setup.length + 2);
      expect((await bob.client.project(site.id)).repositoryElsewhere?.canWorkTogether).toBe(true);
    } finally {
      await two.close();
    }
  }, 300_000);

  // fixup-w8-together (the review's non-blocking 1): the acceptance's "afterwards B writes no
  // docs or status pull request and its status goes to its own comment on A's issue".
  it("http: W8-join-1, afterwards: Bob's session in the together project opens only its task's pull request, no docs or status pull request, and his status goes to his own comment on Ada's status issue", async () => {
    const two = await composeTwo({ host: "http" });
    try {
      const { ada, bob } = two;
      const repo = two.repo;
      const { kite } = await kiteClub(two, true);
      // Ada's first session opens the status issue with her comment (W8-write-1).
      await runOneTask(ada, two, kite.id, "Write the about page in about.md");
      await ada.rt.statusBoard.settled();
      const statusIssues = async () =>
        (await ada.rt.gitHost.listIssues(repo, { state: "all" })).filter(
          (i) => readStatusIssueKey(i.body) !== null,
        );
      const [issue, ...more] = await statusIssues();
      expect(more).toEqual([]);
      const number = issue?.number ?? 0;
      const adas = (await ada.rt.gitHost.listIssueComments(repo, number)).comments;
      expect(adas.map((c) => c.author)).toEqual(["ada"]);

      const { site, pr: oldStatus } = await bobsSite(two);
      await followDefaultBranch(bob, site.id);
      const done = await workTogether(bob, site.id);
      expect(done.status, done.reason).toBe("done");
      const before = two.writesBy("bob").length;
      const ran = await runOneTask(bob, two, kite.id, "Write the contact page in contact.md");
      await bob.rt.statusBoard.settled();
      const after = two.writesBy("bob").slice(before);

      // Bob's new pull requests are the task pull requests of the together project (his new
      // task's and the two Site brought, which were ready too): no docs or status pull request.
      const bobs = (await two.pullRequests()).filter(
        (p) => p.authorLogin === "bob" && p.number !== oldStatus.number,
      );
      const branches = (await bob.rt.store.task.list({ project_id: kite.id } as never))
        .map((t) => t.branch)
        .filter((b): b is string => !!b);
      expect(bobs.map((p) => p.head.ref)).toContain(ran.task.branch);
      expect(bobs.filter((p) => !branches.includes(p.head.ref)).map((p) => p.head.ref)).toEqual([]);
      expect(bobs.filter((p) => /^fr\/(docs-scaffold|status|intake)/.test(p.head.ref))).toEqual([]);
      expect(after.filter((w) => w.action === "pull_request.create")).toHaveLength(bobs.length);
      // His status: one comment of his on Ada's issue; no issue of his; Ada's comment untouched.
      expect((await statusIssues()).map((i) => i.number)).toEqual([number]);
      expect(after.filter((w) => w.action === "issue.create")).toEqual([]);
      const comments = (await ada.rt.gitHost.listIssueComments(repo, number)).comments;
      expect(comments.map((c) => c.author)).toEqual(["ada", "bob"]);
      expect(comments[0]?.body).toBe(adas[0]?.body);
      const adaComment = adas[0]?.id;
      expect(
        after.filter(
          (w) => w.action === "comment.update" && w.op.endsWith(`/issues/comments/${adaComment}`),
        ),
      ).toEqual([]);
      // Nothing on Ada's pull requests.
      const adaPrs = (await two.pullRequests())
        .filter((p) => p.authorLogin === "ada")
        .map((p) => p.number);
      expect(after.filter((w) => w.number && adaPrs.includes(w.number))).toEqual([]);
    } finally {
      await two.close();
    }
  }, 300_000);

  for (const kind of ["memory", "http"] as const)
    it(`${kind}: W8a-left-6: GitHub unreachable at the press, and again after Bob's daemon starts again with it off: the dialog and the press are refused in words, nothing moves, nothing is written`, async () => {
      const two = await composeTwo({ host: kind });
      try {
        const { bob } = two;
        const { kite } = await kiteClub(two, true);
        const { site, tasks } = await bobsSite(two);
        const log = two.writesBy("bob");
        const check = async () => {
          const preview = await bob.client.togetherPreview(site.id);
          expect(preview.together?.refusal).toBe(UNREADABLE);
          expect(preview.together?.name ?? null).toBeNull();
          const r = await workTogether(bob, site.id);
          expect(r.status).toBe("refused");
          expect(r.reason).toBe(UNREADABLE);
          expect((await bob.client.tasks(site.id)).map((t) => t.id).sort()).toEqual(
            tasks.map((t) => t.id).sort(),
          );
          expect((await bob.client.projects()).some((p) => p.id === kite.id)).toBe(false);
          expect((await bob.client.project(site.id)).joinedInto ?? null).toBeNull();
          expect(two.writesBy("bob")).toEqual(log);
        };
        bob.githubOff();
        await check();
        await bob.restart();
        await check();
        // GitHub back: the same press goes through.
        bob.githubOn();
        const r = await workTogether(bob, site.id);
        expect(r.status, r.reason).toBe("done");
        expect((await bob.client.project(kite.id)).name).toBe("Kite club");
      } finally {
        await two.close();
      }
    }, 240_000);

  it("http: W8a-left-7: before Ada's docs pull request merges, Bob's together project is 'Kite club' (the marker on its branch), made both ways: New project's Work together, and the Overview's after that one was undone", async () => {
    const two = await composeTwo({ host: "http" });
    try {
      const { bob } = two;
      const { kite } = await kiteClub(two, false);
      // New project's Work together, with a name Bob typed: the repository's name wins.
      const made = await bob.client.createProject({
        name: "Bob's site",
        goal: "The team's site",
        repos: ["team/shared"],
        switch: true,
        together: { project: kite.id },
      });
      expect(made.id).toBe(kite.id);
      expect(made.name).toBe("Kite club");
      // Undone (the row stays, removed); then Bob's "Site" from before the rule joins it from
      // its Overview: the same row comes back, under the same name.
      const created = (await bob.client.changes({ limit: 20 })).find(
        (c) => (c.commands[0] as { name?: string } | undefined)?.name === "project.create",
      );
      expect((await bob.client.undoChange(created?.id ?? "")).status).toBe("done");
      const { site } = await bobsSite(two);
      const preview = await bob.client.togetherPreview(site.id);
      expect(preview.together?.name, JSON.stringify(preview.together)).toBe("Kite club");
      const r = await workTogether(bob, site.id);
      expect(r.status, r.reason).toBe("done");
      const joined = await bob.client.project(kite.id);
      expect(joined.name).toBe("Kite club");
      expect(joined.repositoryElsewhere?.kind).toBe("together");
    } finally {
      await two.close();
    }
  }, 240_000);

  it("http: a pair here of which one is worked on together keeps the together one, with its sentence", async () => {
    const two = await composeTwo({ host: "http" });
    try {
      const { bob } = two;
      const { kite } = await kiteClub(two, true);
      await bob.client.createProject({
        name: "Kite club",
        goal: "The team's site",
        repos: ["team/shared"],
        together: { project: kite.id },
      });
      // "Site" on the same repository, made before the one-repository rule (no entry point makes
      // a second project on a link here now), so it is written to the store as it was then.
      const site = await bob.rt.store.project.insert({
        name: "Site",
        goal: "Another site",
        repos: ["team/shared"],
        stage: "planning",
        status: "active",
        budget_usd_micro: 0,
        autonomy_level: 2,
        summary_cache: {},
        data_assets: [],
        settings: { members: [(await bob.rt.store.agent.list({}))[0]?.id ?? ""] },
        small_project_mode: false,
        active: true,
        author_human: (await bob.client.me()).id,
      });
      const preview = await bob.client.joinPreview(site.id);
      expect(preview.keepOnly).toBe(kite.id);
      expect(preview.keepOnlyLine).toBe('"Kite club" is the project GitHub knows, so it is kept.');
      // Site's Overview has the pair's line, not Work together (its id is here).
      const card = await bob.client.project(site.id);
      expect(card.repositoryElsewhere ?? null).toBeNull();
      expect(card.sharesRepositoryWith?.projects.map((p) => p.id)).toEqual([kite.id]);
    } finally {
      await two.close();
    }
  }, 240_000);

  /** A file on a branch of the stand-in's bare repository, or null. */
  async function show(bare: string, ref: string, path: string): Promise<string | null> {
    const r = await run(["git", "--git-dir", bare, "show", `${ref}:${path}`], {
      allowFailure: true,
    });
    return r.code === 0 ? r.stdout : null;
  }
  const headOf = async (bare: string, ref: string) =>
    (await run(["git", "--git-dir", bare, "rev-parse", ref], { allowFailure: true })).stdout.trim();
  const GUIDE_STOPPED =
    "The repository guide on GitHub was not updated: every branch this project may write its docs on holds someone else's pull request.";

  /**
   * Bob (a person on GitHub, with his own account) opens a pull request on `branch`, cut from
   * the default branch, which carries Ada's marker once her doc set merged: the branch's
   * `.forerunner/project.json` is Ada's, and the body names no project.
   */
  async function bobsDocsPr(two: TwoHomes, branch: string, files: Record<string, string>) {
    await seedBranch(two, branch, files, "docs: Bob's notes");
    return two.bob.rt.gitHost.createPullRequest(two.repo, {
      title: "docs: notes",
      body: "Bob's notes for the repository.",
      head: branch,
      base: "main",
    });
  }

  it("http: W8a-left-22, -27: Bob's unmarked fr/docs-scaffold pull request cut from a main that carries Ada's marker gets no write from Ada over a scaffold run, a guide refresh after a fact change and her restart; she opens exactly one docs pull request, on her own branch; her Overview lists Bob's without Merge and her Docs tab does not list its files", async () => {
    const two = await composeTwo({ host: "http" });
    try {
      const { ada } = two;
      const bare = two.http?.repo(two.repo)?.dir ?? "";
      expect(bare).not.toBe("");
      const { kite, docs } = await kiteClub(two, true);
      await followDefaultBranch(ada, kite.id);
      const marker = await show(bare, "main", ".forerunner/project.json");
      expect(marker).toContain(kite.id);
      // Bob's pull request on fr/docs-scaffold: the branch carries Ada's marker, as main does.
      const bobs = await bobsDocsPr(two, "fr/docs-scaffold", {
        "docs/notes.md": "# Notes\n\nBob's notes.\n",
        "docs/runbook.md": "# Runbook\n\nBob's steps.\n",
      });
      expect(await show(bare, "fr/docs-scaffold", ".forerunner/project.json")).toBe(marker);
      const bobsHead = await headOf(bare, "fr/docs-scaffold");
      // Ada's writes on Bob's pull request (a comment, an edit, a close); a push onto his branch
      // shows in its head, checked beside.
      const onBobs = () => two.writesBy("ada").filter((w) => w.number === bobs.number);
      const adaDocsPrs = async () =>
        (await two.pullRequests()).filter(
          (p) => p.state === "open" && p.authorLogin === "ada" && p.head.ref.startsWith("fr/docs-"),
        );

      // A scaffold run (as a take-over's Try again runs it), then a fact Ada changes (who
      // merges) and the guide's refresh at her session's end.
      await ada.rt.docs.scaffoldProject(await ada.rt.store.project.mustGet(kite.id));
      const row = await ada.rt.store.project.mustGet(kite.id);
      await ada.client.updateProjectSettings(kite.id, {
        version: row.version,
        settings: { merge_mode: "after_review" },
      });
      const refreshed = await ada.rt.docs.refreshGuide(await ada.rt.store.project.mustGet(kite.id));
      expect(refreshed.changed).toBe(true);
      const opened = await adaDocsPrs();
      expect(opened.map((p) => [p.head.ref, p.authorLogin])).toEqual([
        ["fr/docs-scaffold-kite-club", "ada"],
      ]);
      expect(await show(bare, "fr/docs-scaffold-kite-club", "AGENTS.md")).toContain(
        "merges its pull requests itself once its critic accepted them.",
      );
      expect(onBobs()).toEqual([]);
      expect(await headOf(bare, "fr/docs-scaffold")).toBe(bobsHead);

      // Her Overview lists Bob's without Merge, hers with it; her Docs tab does not count Bob's
      // files as hers waiting there.
      const listed = (await ada.client.projectPullRequests(kite.id)).waiting;
      expect(
        listed
          .map((r) => [r.number, r.kind, r.merge?.canMerge])
          .sort((a, b) => Number(a[0]) - Number(b[0])),
      ).toEqual([
        [bobs.number, "listed", false],
        [opened[0]?.number, "docs", true],
      ]);
      const waiting = await ada.rt.docs.docsInPullRequests(
        await ada.rt.store.project.mustGet(kite.id),
      );
      expect(waiting.filter((d) => d.number === bobs.number)).toEqual([]);
      const docsTab = await ada.client.docs(kite.id);
      expect(docsTab.filter((d) => d.pullRequest?.number === bobs.number)).toEqual([]);
      expect(docs.number).not.toBe(bobs.number);
      expect((await ada.client.project(kite.id)).guideStopped ?? null).toBeNull();

      // Her daemon starts again and the refresh runs twice: no second pull request, still
      // nothing on Bob's.
      await ada.restart();
      for (let i = 0; i < 2; i++)
        await ada.rt.docs.refreshGuide(await ada.rt.store.project.mustGet(kite.id));
      await ada.rt.docs.scaffoldProject(await ada.rt.store.project.mustGet(kite.id));
      expect((await adaDocsPrs()).map((p) => p.number)).toEqual(opened.map((p) => p.number));
      expect(onBobs()).toEqual([]);
      expect(await headOf(bare, "fr/docs-scaffold")).toBe(bobsHead);
    } finally {
      await two.close();
    }
  }, 300_000);

  it("http: W8a-left-22: with every branch Ada's project may write its docs on holding someone else's pull request, her guide refresh writes nothing and her Overview says why in one line, also after her daemon starts again; once one is closed, the next refresh opens her one docs pull request there and the line goes", async () => {
    const two = await composeTwo({ host: "http" });
    try {
      const { ada, bob } = two;
      const bare = two.http?.repo(two.repo)?.dir ?? "";
      const { kite } = await kiteClub(two, true);
      await followDefaultBranch(ada, kite.id);
      const branches = scaffoldBranchesOf(kite);
      expect(branches).toHaveLength(3);
      const prs = [];
      for (const branch of branches)
        prs.push(await bobsDocsPr(two, branch, { "docs/notes.md": `# Notes\n\n${branch}\n` }));
      const heads = await Promise.all(branches.map((b) => headOf(bare, b)));
      const before = two.writesBy("ada").length;
      const row = await ada.rt.store.project.mustGet(kite.id);
      await ada.client.updateProjectSettings(kite.id, {
        version: row.version,
        settings: { merge_mode: "after_review" },
      });
      const out = await ada.rt.docs.refreshGuide(await ada.rt.store.project.mustGet(kite.id));
      expect(out).toEqual({ changed: false, prUrl: null });
      expect(
        two
          .writesBy("ada")
          .slice(before)
          .filter((w) => !/^(issue|comment)/.test(w.action)),
      ).toEqual([]);
      expect(await Promise.all(branches.map((b) => headOf(bare, b)))).toEqual(heads);
      expect((await ada.client.project(kite.id)).guideStopped).toBe(GUIDE_STOPPED);
      await ada.restart();
      expect((await ada.client.project(kite.id)).guideStopped).toBe(GUIDE_STOPPED);

      // Bob closes his pull request on the second branch and deletes that branch: the next
      // refresh opens Ada's one docs pull request there, and the line goes.
      await bob.rt.gitHost.updatePullRequest(two.repo, prs[1]?.number ?? 0, { state: "closed" });
      await run(["git", "--git-dir", bare, "branch", "-D", branches[1] ?? ""]);
      await ada.rt.docs.refreshGuide(await ada.rt.store.project.mustGet(kite.id));
      const ours = (await two.pullRequests()).filter(
        (p) => p.state === "open" && p.authorLogin === "ada" && p.head.ref.startsWith("fr/docs-"),
      );
      expect(ours.map((p) => p.head.ref)).toEqual([branches[1]]);
      expect((await ada.client.project(kite.id)).guideStopped ?? null).toBeNull();
      for (const n of [prs[0]?.number, prs[2]?.number])
        expect(two.writesBy("ada").filter((w) => w.number === n)).toEqual([]);
    } finally {
      await two.close();
    }
  }, 300_000);
});
