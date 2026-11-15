import { ForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/executor.ts";
import { toToolSpecs } from "../src/registry.ts";
import type { RepositoryTakeOverPort, RepoTakeOverFacts } from "../src/types.ts";
import { world } from "./helpers.ts";

/**
 * D1 and D9 (the owner's answers of 2026-11-09): a project whose repository names a Forerunner
 * project that is not on this computer may take it over only when nobody else worked on it for
 * 14 days. `repo.take_over` is that step from the Overview's line or from chat: medium risk for
 * every actor (the press is the yes; chat reads it back), never an agent's own, and undone only
 * while its docs pull request does not exist.
 */
const KITE = "01a1a000-0000-7000-8000-00000000c1ab";
const FACTS: RepoTakeOverFacts = { locator: "o/kite", projects: [KITE], name: "Kite club" };

type Calls = { writes: string[]; blocked: string | null; facts: RepoTakeOverFacts | Error };

function port(calls: Calls): RepositoryTakeOverPort {
  return {
    check: async () => {
      if (calls.facts instanceof Error) throw calls.facts;
      return calls.facts;
    },
    writeMarker: async (projectId) => {
      calls.writes.push(projectId);
      return { prUrl: "https://github.com/o/kite/pull/4" };
    },
    undoBlocked: async () => calls.blocked,
  };
}

describe("d1109-onerepo-link, run C: repo.take_over (OR-07)", () => {
  it("the Overview's press takes it over at once: one change row 'Took over o/kite from \"Kite club\".', took_over on the project, its marker written; Undo puts it back while no docs pull request names it", async () => {
    const w = await world();
    const calls: Calls = { writes: [], blocked: null, facts: FACTS };
    w.ports.repositoryTakeOver = port(calls);
    const r = await w.executor.execute({
      name: "repo.take_over",
      params: { project: w.pharma.id },
      ctx: w.ctx({ source: "ui" }),
      confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
    });
    expect(r.status).toBe("done");
    const done = r as Extract<ExecuteResult, { status: "done" }>;
    expect(done.sentence).toBe('Took over o/kite from "Kite club".');
    expect(done.untrusted).toEqual({ source: "repo_file", origin: "repository:o/kite" });
    expect(calls.writes).toEqual([w.pharma.id]);
    const row = await w.store.changeLog.mustGet(done.changeLogId);
    expect(row.sentence).toBe('Took over o/kite from "Kite club".');
    expect((await w.store.project.mustGet(w.pharma.id)).settings.took_over).toMatchObject({
      projects: [KITE],
      name: "Kite club",
    });
    // Its docs pull request is open on GitHub: Undo would promise what it cannot take back.
    calls.blocked = "its pull request on GitHub already names this project. Close it there first";
    const refused = await w.executor.undo(done.changeLogId, w.ctx({ source: "ui" }));
    expect(refused).toMatchObject({
      status: "refused",
      reason: "its pull request on GitHub already names this project. Close it there first",
    });
    expect((await w.store.project.mustGet(w.pharma.id)).settings.took_over).toBeDefined();
    // Closed there: Undo removes the take-over.
    calls.blocked = null;
    const undone = await w.executor.undo(done.changeLogId, w.ctx({ source: "ui" }));
    expect(undone.status).toBe("done");
    expect((undone as Extract<ExecuteResult, { status: "done" }>).sentence).toBe(
      'o/kite is no longer taken over from "Kite club".',
    );
    expect((await w.store.project.mustGet(w.pharma.id)).settings.took_over).toBeUndefined();
    await w.store.close();
  });

  it("from chat it is read back with Yes and No, the question quoting the marker's name as data; the yes takes it over", async () => {
    const w = await world();
    const calls: Calls = { writes: [], blocked: null, facts: FACTS };
    w.ports.repositoryTakeOver = port(calls);
    const chat = w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "chat" });
    const r = await w.executor.execute({
      name: "repo.take_over",
      params: { project: "PharmaWatch" },
      ctx: chat,
    });
    expect(r.status).toBe("pending");
    const pending = r as Extract<ExecuteResult, { status: "pending" }>;
    expect(pending.card.ask).toBe(
      'Take over o/kite from "Kite club"? The repository then names this project: choose it only if no Forerunner uses "Kite club" now.',
    );
    expect(pending.card.untrusted).toEqual({ source: "repo_file", origin: "repository:o/kite" });
    expect(calls.writes).toEqual([]);
    // The tool answer the model gets for the read-back carries the mark (the hooks wrap it).
    const spec = toToolSpecs(w.registry, {
      execute: async () => ({
        status: "pending",
        pendingId: pending.pendingId,
        card: pending.card,
        readback: pending.readback,
      }),
      ctxFor: () => chat,
    }).find((s) => s.name === "repo_take_over");
    const answer = await spec?.execute({}, {
      agentId: w.agent.id,
      sessionId: null,
      step: 1,
    } as never);
    expect(answer?.untrusted).toEqual({ source: "repo_file", origin: "repository:o/kite" });
    const yes = await w.executor.confirm(pending.pendingId, {
      kind: "yes",
      by: { kind: "human", id: w.human.id },
    });
    expect(yes.status).toBe("done");
    expect(calls.writes).toEqual([w.pharma.id]);
    await w.store.close();
  });

  it("an agent acting on its own is refused: 'Only you can take over a repository.'; nothing is written", async () => {
    const w = await world();
    const calls: Calls = { writes: [], blocked: null, facts: FACTS };
    w.ports.repositoryTakeOver = port(calls);
    const r = await w.executor.execute({
      name: "repo.take_over",
      params: { project: w.pharma.id },
      ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id }, source: "api" }),
    });
    expect(r).toMatchObject({ status: "refused", reason: "Only you can take over a repository." });
    expect(calls.writes).toEqual([]);
    expect((await w.store.project.mustGet(w.pharma.id)).settings.took_over).toBeUndefined();
    await w.store.close();
  });

  it("another GitHub account active within 14 days: the check's refusal is the answer, nothing is written; the answer quoting the marker keeps the untrusted mark", async () => {
    const w = await world();
    const sentence =
      'o/kite is also the Forerunner project "Kite club", which is not on this computer; another GitHub account worked on it on 3 Mar, so it cannot be taken over now.';
    const calls: Calls = {
      writes: [],
      blocked: null,
      facts: new ForerunnerError("validation", sentence, {
        details: {
          cause: "repository_used_elsewhere",
          untrusted: { source: "repo_file", origin: "repository:o/kite" },
        },
      }),
    };
    w.ports.repositoryTakeOver = port(calls);
    const r = await w.executor.execute({
      name: "repo.take_over",
      params: { project: w.pharma.id },
      ctx: w.ctx({ source: "ui" }),
      confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
    });
    expect(r).toMatchObject({ status: "refused", reason: sentence });
    expect((r as Extract<ExecuteResult, { status: "refused" }>).untrusted).toEqual({
      source: "repo_file",
      origin: "repository:o/kite",
    });
    expect(calls.writes).toEqual([]);
    await w.store.close();
  });

  it("is medium risk with a read-back from chat, reversible, and says to the model it is the person's step", async () => {
    const w = await world();
    const def = w.registry.get("repo.take_over");
    expect(def?.risk).toBe("medium");
    expect(def?.askFromChat).toBe(true);
    expect(def?.reversible).toBe(true);
    expect(def?.description).toBe(
      "Take over the project's GitHub repository from a Forerunner project that is not on this computer, when nobody worked on it for 14 days: the repository then names this project through its docs pull request. Only for the repository the Overview says is also another Forerunner project, and only when the person asks.",
    );
    await w.store.close();
  });
});
