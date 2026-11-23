import { describe, expect, it } from "vitest";
import type { ExecuteResult } from "../src/executor.ts";
import { world } from "./helpers.ts";

/**
 * L4-github-103 (D9, the owner's words of 2026-11-09: "if 2 people are working on the same
 * project they should be able to work seamlessly in the same git"): a project worked on together
 * with another Forerunner writes nothing to the repository, so its status stays in the app
 * whatever the setting (loop/docs.ts). Settings offered the status pull request on it and the
 * yes promised one that never opened (live check 4, L4-l3-10). The command refuses it in one
 * sentence, so Settings, chat and voice say the same and nothing is written.
 */
const SENTENCE =
  'You work on "Kite club" together with another Forerunner, so its status stays in the app (Docs, Status); no status pull request is opened.';

describe("l4-github-link, run L4", () => {
  it("L4-github-103: settings.set status_pull_request=true on a together project is refused in one sentence from the app and from chat, nothing written; turning it off still acts; another project turns it on", async () => {
    const w = await world();
    const together = await w.store.project.insert({
      name: "Kite club",
      goal: "g",
      repos: ["o/kite"],
      settings: {
        together: {
          name: "Kite club",
          at: "2026-03-05T08:00:00.000Z",
          activeOn: null,
          login: null,
        },
      },
    });
    const changes = async () =>
      (await w.store.changeLog.list({ project_id: together.id } as never)).length;
    const before = await changes();
    const tap = { kind: "tap" as const, by: { kind: "human" as const, id: w.human.id } };
    for (const source of ["ui", "chat", "voice"] as const) {
      const r = await w.executor.execute({
        name: "settings.set",
        params: { key: "status_pull_request", value: true, project: together.id },
        ctx: w.ctx({ source, activeProjectId: together.id }),
        confirmation: tap,
      });
      expect(r, source).toMatchObject({ status: "refused", code: "validation", reason: SENTENCE });
      expect((r as Extract<ExecuteResult, { status: "refused" }>).details).toMatchObject({
        key: "status_pull_request",
        cause: "together",
      });
      expect((r as Extract<ExecuteResult, { status: "refused" }>).pendingId).toBeUndefined();
    }
    expect(w.executor.pending(w.human.id)).toEqual([]);
    expect(await changes()).toBe(before);
    expect((await w.store.project.mustGet(together.id)).settings.status_pull_request).toBe(
      undefined,
    );
    // Off acts (the safe side), so a value stored before this rule can still be turned off.
    await w.store.project.patch(together.id, {
      settings: { ...together.settings, status_pull_request: true },
    });
    const off = await w.executor.execute({
      name: "settings.set",
      params: { key: "status_pull_request", value: false, project: together.id },
      ctx: w.ctx({ source: "ui", activeProjectId: together.id }),
      confirmation: tap,
    });
    expect(off.status).toBe("done");
    expect((await w.store.project.mustGet(together.id)).settings.status_pull_request).toBe(false);
    // A project of its own takes it.
    const own = await w.store.project.insert({ name: "Site", goal: "g", repos: ["o/site"] });
    const on = await w.executor.execute({
      name: "settings.set",
      params: { key: "status_pull_request", value: true, project: own.id },
      ctx: w.ctx({ source: "ui", activeProjectId: own.id }),
      confirmation: tap,
    });
    expect(on.status).toBe("done");
    await w.store.close();
  });
});
