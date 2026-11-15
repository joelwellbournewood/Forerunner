import { ForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { PROJECT_CREATE_DESCRIPTION } from "../src/commands/project.ts";
import type { ExecuteResult } from "../src/executor.ts";
import { toToolSpecs } from "../src/registry.ts";
import { world } from "./helpers.ts";

/**
 * D1 (the owner's words of 2026-11-09: "Make it such that multiple projects are not done on one
 * repo, in an intelligent way."): `project.create` by chat, voice or the palette made a second
 * project on a used repository and the model was told nothing (bench walk of 2026-11-15:
 * "Created the project Shop two" on bench/seeded beside "Site"). It now asks the daemon's
 * `repositoryUse` port in its plan, before any read-back, and again at its run.
 */
const SENTENCE = 'o/site is already the project "Site". Open it, or add this to it as new work.';

function refusalFor(repos: readonly string[], used: Set<string>): void {
  if (repos.some((r) => used.has(r)))
    throw new ForerunnerError("validation", SENTENCE, {
      details: {
        cause: "repository_in_use",
        projectId: "p-site",
        projectName: "Site",
        untrusted: { source: "repo_file", origin: "repository:o/site" },
      },
    });
}

describe("d1109-onerepo-link, run C: project.create on a link another project uses (OR-03)", () => {
  it("is refused in its plan, with no read-back card and nothing written; the refusal carries the untrusted mark", async () => {
    const w = await world();
    const used = new Set(["o/site"]);
    w.ports.repositoryUse = { check: async (repos) => refusalFor(repos, used) };
    const before = (await w.store.project.list()).length;
    const r = await w.executor.execute({
      name: "project.create",
      params: { name: "Shop", goal: "a shop", repos: ["o/site"] },
      // As chat makes it: the model's tool call, the agent as the actor.
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" }),
    });
    expect(r.status).toBe("refused");
    const refused = r as Extract<ExecuteResult, { status: "refused" }>;
    expect(refused.reason).toBe(SENTENCE);
    expect(refused.pendingId).toBeUndefined();
    expect(refused.details).toMatchObject({ cause: "repository_in_use", projectName: "Site" });
    expect(refused.untrusted).toEqual({ source: "repo_file", origin: "repository:o/site" });
    expect((await w.store.project.list()).length).toBe(before);
    expect(w.executor.pending(w.human.id)).toEqual([]);
    await w.store.close();
  });

  it("is checked again at its run: a link that became used before the yes is refused, nothing written", async () => {
    const w = await world();
    const used = new Set<string>();
    w.ports.repositoryUse = { check: async (repos) => refusalFor(repos, used) };
    const pending = await w.executor.execute({
      name: "project.create",
      params: { name: "Shop", goal: "a shop", repos: ["o/site"] },
      ctx: w.ctx({ recordsRead: true }),
    });
    expect(pending.status).toBe("pending");
    used.add("o/site");
    const before = (await w.store.project.list()).length;
    const answered = await w.executor.confirm(
      (pending as Extract<ExecuteResult, { status: "pending" }>).pendingId,
      { kind: "yes", by: { kind: "human", id: w.human.id } },
    );
    expect(answered.status).toBe("refused");
    expect((answered as Extract<ExecuteResult, { status: "refused" }>).reason).toBe(SENTENCE);
    expect((await w.store.project.list()).length).toBe(before);
    await w.store.close();
  });

  it("the model's definition says one repository is one project and to offer the project that uses it; the tool answer is the sentence, marked as data", async () => {
    const w = await world();
    const def = w.registry.get("project.create");
    expect(def?.description).toBe(
      "Create a project with a name, a goal and optional repositories (a GitHub repository or a folder). One repository or folder is one project: when another project already uses the link, this is refused with that project's name; then offer that project instead (open it with project.switch, or add the new work to it), never a second project.",
    );
    expect(def?.description).toBe(PROJECT_CREATE_DESCRIPTION);
    const spec = toToolSpecs(w.registry, {
      execute: async () => ({
        status: "refused",
        reason: SENTENCE,
        untrusted: { source: "repo_file", origin: "repository:o/site" },
      }),
      ctxFor: () => w.ctx(),
    }).find((s) => s.name === "project_create");
    const answer = await spec?.execute(
      { name: "Shop", goal: "a shop", repos: ["o/site"] },
      {} as never,
    );
    expect(answer).toEqual({
      content: `Refused: ${SENTENCE}`,
      isError: true,
      untrusted: { source: "repo_file", origin: "repository:o/site" },
    });
    await w.store.close();
  });
});
