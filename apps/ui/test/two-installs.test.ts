// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { PullRequestInfo } from "../../../packages/capabilities/src/githost/types.ts";
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
