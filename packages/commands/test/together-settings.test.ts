import { describe, expect, it } from "vitest";
import { world } from "./helpers.ts";

/**
 * w8-status-write (W8-write-6; amendment 1, D9): a project worked on together with another
 * Forerunner has the status issue as any project has: it writes its own comment on the shared
 * issue, and its switch acts like any project's. L4-github-103's refusal of the status pull
 * request went with the status pull request (amendment 2).
 */
describe("l4-github-link, run L4", () => {
  it("w8-status-write (W8-write-6): a together project's status issue switch acts like any project's: off and on again from the app and from chat, each with its change row; the status pull request setting is gone", async () => {
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
    for (const [source, value] of [
      ["ui", false],
      ["chat", true],
    ] as const) {
      const r = await w.executor.execute({
        name: "settings.set",
        params: { key: "status_issue", value, project: together.id },
        ctx: w.ctx({ source, activeProjectId: together.id }),
        confirmation: tap,
      });
      expect(r.status, source).toBe("done");
      expect((await w.store.project.mustGet(together.id)).settings.status_issue).toBe(value);
    }
    expect(await changes()).toBe(before + 2);
    // Amendment 2: the status pull request went, and so did its setting.
    const old = await w.executor.execute({
      name: "settings.set",
      params: { key: "status_pull_request", value: true, project: together.id },
      ctx: w.ctx({ source: "ui", activeProjectId: together.id }),
      confirmation: tap,
    });
    expect(old.status).toBe("refused");
    expect((await w.store.project.mustGet(together.id)).settings.status_pull_request).toBe(
      undefined,
    );
    await w.store.close();
  });
});
