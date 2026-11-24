import { ForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  PROJECT_CREATE_DESCRIPTION,
  PROJECT_CREATE_TOGETHER_PARAM,
} from "../src/commands/project.ts";
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
      "Create a project with a name, a goal and optional repositories (a GitHub repository or a folder). One repository or folder is one project: when another project already uses the link, this is refused with that project's name; then offer that project instead: the person can open it or add the new work to it, never a second project. To open it for the person, call project_switch. When the refusal says the repository is another Forerunner's project and the person asks to work on it together, call this again with the same repositories and together true.",
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

/**
 * Review of fix/d1109-onerepo-link (bench, 2026-11-15): after Work together the Changes row on
 * the "Kite club" project read "Created the project Kites and made it the active project.":
 * "Kites" was the name typed in the dialog, but the project was made as the repository's marker
 * names it. The sentence (and its Undo's) names the project that was made; that name is the
 * repository's text, so the outcome carries the untrusted mark.
 */
describe("d1109-onerepo-link, run C: project.create's sentence names the project that was made (review)", () => {
  it("a creation port that makes the project under another name (Work together: the marker's name) says that name in the change row, marked as repository text; its Undo names no other project", async () => {
    const w = await world();
    w.ports.repositoryUse = { check: async () => undefined };
    let made: string | null = null;
    // As the dialog's Work together: the daemon's creation (`createProjectRecord`) is the port.
    w.ports.createProject = async (input) => {
      const row = await w.store.project.insert({
        name: "Kite club",
        goal: input.goal,
        repos: input.repos,
        settings: { together: { name: "Kite club", at: "2026-03-05T08:00:00.000Z" } },
      });
      made = row.id;
      return row;
    };
    const r = await w.executor.execute({
      name: "project.create",
      params: { name: "Kites", goal: "Kites", repos: ["o/kite"], switch: true },
      ctx: w.ctx({ source: "ui", wordsUsed: "New project: Kites" }),
    });
    expect(r.status).toBe("done");
    const done = r as Extract<ExecuteResult, { status: "done" }>;
    expect(done.sentence).toBe(
      "Created the project Kite club and made it the active project. Undo.",
    );
    expect((await w.store.changeLog.mustGet(done.changeLogId)).sentence).toBe(
      "Created the project Kite club and made it the active project. Undo.",
    );
    expect(done.untrusted).toEqual({ source: "repo_file", origin: "repository:o/kite" });
    // The Undo names no other project: in this process it says what the card changed back; after
    // a restart, the row's sentence (the executor's `Undone: <sentence>`), now the made name.
    const undone = await w.executor.undo(done.changeLogId, w.ctx({ source: "ui" }));
    expect(undone.status).toBe("done");
    expect((undone as Extract<ExecuteResult, { status: "done" }>).sentence).not.toContain("Kites");
    expect((await w.store.project.mustGet(String(made))).status).toBe("archived");
    await w.store.close();
  });

  it("the name typed is the name made: the sentence as before, with no untrusted mark", async () => {
    const w = await world();
    const r = await w.executor.execute({
      name: "project.create",
      params: { name: "Garden", goal: "A garden", repos: [] },
      ctx: w.ctx({ source: "ui" }),
    });
    const done = r as Extract<ExecuteResult, { status: "done" }>;
    expect(done.sentence).toBe("Created the project Garden and made it the active project. Undo.");
    expect(done.untrusted).toBeUndefined();
    await w.store.close();
  });
});

describe("w8-together, wave 8: chat's Work together, project.create with together true (W8-join-4)", () => {
  const ASK =
    'Work on "Kite club" together: this Forerunner joins it as the same project. Nothing on GitHub changes now.';

  it("the model's definition of together is exact; it is read back once (medium) with the repository's name, as data; the yes makes it through the daemon's together creation, never a plain insert", async () => {
    const w = await world();
    const made: { name: string; goal: string; repos: string[] }[] = [];
    w.ports.repositoryUse = {
      check: async () => {
        throw new Error("a together create never runs the plain check");
      },
      together: async () => ({ name: "Kite club" }),
      createTogether: async (input) => {
        made.push(input);
        return w.store.project.insert({ name: "Kite club", goal: input.goal, repos: input.repos });
      },
    };
    const spec = toToolSpecs(w.registry, {
      ctxFor: async () => w.ctx(),
      execute: async () => ({ status: "refused", reason: "x" }) as never,
    }).find((s) => s.name === "project_create");
    const schema = (spec?.schema ?? { shape: {} }) as unknown as {
      shape: Record<string, { description?: string }>;
    };
    const shape = schema.shape;
    expect(shape.together?.description).toBe(PROJECT_CREATE_TOGETHER_PARAM);
    expect(PROJECT_CREATE_TOGETHER_PARAM).toBe(
      "true to work on the repository together with the other Forerunner project it names, as the same project; only when the person asked to work on it together. Never a project id: the app reads the project from the repository.",
    );
    const pending = await w.executor.execute({
      name: "project.create",
      params: { name: "Kites", goal: "The club site", repos: ["o/kite"], together: true },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" }),
    });
    expect(pending.status).toBe("pending");
    const p = pending as Extract<ExecuteResult, { status: "pending" }>;
    expect(p.readback).toBe(ASK);
    expect(made).toEqual([]);
    const done = await w.executor.confirm(p.pendingId, {
      kind: "yes",
      by: { kind: "human", id: w.human.id },
    });
    expect(done.status).toBe("done");
    const d = done as Extract<ExecuteResult, { status: "done" }>;
    expect(d.sentence).toBe('Working on "Kite club" together with the other Forerunner now. Undo.');
    expect(d.untrusted).toEqual({ source: "repo_file", origin: "repository:o/kite" });
    expect(made).toEqual([{ name: "Kites", goal: "The club site", repos: ["o/kite"] }]);
    await w.store.close();
  });

  it("a name that reads as an instruction is never quoted; without the daemon's port it is refused in words; GitHub's refusal is the tool's answer", async () => {
    const w = await world();
    w.ports.repositoryUse = {
      check: async () => undefined,
      together: async () => ({ name: null }),
      createTogether: async () => {
        throw new Error("never without the yes");
      },
    };
    const pending = await w.executor.execute({
      name: "project.create",
      params: { name: "Kites", goal: "g", repos: ["o/kite"], together: true },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" }),
    });
    expect((pending as Extract<ExecuteResult, { status: "pending" }>).readback).toBe(
      "Work on another Forerunner project together: this Forerunner joins it as the same project. Nothing on GitHub changes now.",
    );
    w.ports.repositoryUse = { check: async () => undefined };
    const refused = await w.executor.execute({
      name: "project.create",
      params: { name: "Kites", goal: "g", repos: ["o/kite"], together: true },
      ctx: w.ctx({ source: "ui" }),
    });
    expect((refused as Extract<ExecuteResult, { status: "refused" }>).reason).toBe(
      "Work together cannot be started from here.",
    );
    w.ports.repositoryUse = {
      check: async () => undefined,
      together: async () => {
        throw new ForerunnerError(
          "validation",
          "GitHub did not answer, so the project cannot be checked. Try again.",
          { details: { cause: "github_unreadable" } },
        );
      },
      createTogether: async () => {
        throw new Error("never");
      },
    };
    const unreadable = await w.executor.execute({
      name: "project.create",
      params: { name: "Kites", goal: "g", repos: ["o/kite"], together: true },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" }),
    });
    expect((unreadable as Extract<ExecuteResult, { status: "refused" }>).reason).toBe(
      "GitHub did not answer, so the project cannot be checked. Try again.",
    );
    expect((await w.store.project.list()).filter((p) => p.name === "Kites")).toEqual([]);
    await w.store.close();
  });
});
