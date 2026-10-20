import { describe, expect, it } from "vitest";
import {
  type IntentContext,
  IntentRefused,
  matchProjects,
  parseIntent,
  parseWhen,
} from "../src/mobile/intent.ts";
import { NOW_MS } from "./mobile-helpers.tsx";

const PROJECTS = [
  { id: "proj_pharma", name: "PharmaWatch" },
  { id: "proj_supp", name: "Supplement site" },
  { id: "proj_game", name: "Space game" },
];

const ctx: IntentContext = {
  timezone: "Europe/Zurich",
  now: NOW_MS, // 2026-10-20 12:00 Zurich
  activeProjectId: "proj_pharma",
  projects: PROJECTS,
  source: "chat",
};

describe("parseIntent: the scenario-9 sentence", () => {
  it("becomes project.switch, a temporary session budget.set and session.start on the PC", () => {
    const r = parseIntent(
      "switch to the game, give it 15 francs until tomorrow and start a session on my PC",
      ctx,
    );
    expect(r.matched).toBe("pattern");
    expect(r.question).toBeUndefined();
    expect(r.commands.map((c) => c.name)).toEqual([
      "project.switch",
      "budget.set",
      "session.start",
    ]);
    expect(r.commands[0]?.params).toEqual({ project: "proj_game" });
    expect(r.commands[1]?.params).toEqual({
      scope: "session",
      amountChf: 15,
      project: "proj_game",
      // tomorrow 06:00 Zurich (CEST, UTC+2) = 04:00 UTC
      until: "2026-10-21T04:00:00.000Z",
    });
    expect(r.commands[2]?.params).toEqual({ project: "proj_game", runner: "pc" });
  });

  it("applies later clauses to the project switched to, else to the active one", () => {
    const r = parseIntent("give it 20 francs tonight", ctx);
    expect(r.commands[0]?.params).toMatchObject({
      scope: "session",
      amountChf: 20,
      project: "proj_pharma",
    });
    expect(parseWhen("tonight", ctx)?.until).toBe("2026-10-21T04:00:00.000Z");
    expect(parseWhen("until 22:30", ctx)?.until).toBe("2026-10-20T20:30:00.000Z");
    expect(parseWhen("until 9", ctx)?.label).toBe("09:00");
    expect(parseWhen("for today", ctx)?.until).toBe("2026-10-20T22:00:00.000Z");
    expect(parseWhen("nothing", ctx)).toBeNull();
  });

  it("understands German, dollars, the monthly cap and stop / pause / back / notes", () => {
    expect(
      parseIntent("wechsle zum Space game und gib ihm 10 Franken bis morgen", ctx).commands,
    ).toEqual([
      { name: "project.switch", params: { project: "proj_game" } },
      {
        name: "budget.set",
        params: {
          scope: "session",
          amountChf: 10,
          project: "proj_game",
          until: "2026-10-21T04:00:00.000Z",
        },
      },
    ]);
    expect(
      parseIntent("set the project budget for PharmaWatch to 40 dollars", ctx).commands[0],
    ).toEqual({
      name: "budget.set",
      params: { scope: "project", amountUsdMicro: 40_000_000, project: "proj_pharma" },
    });
    expect(parseIntent("raise the monthly cap to 250 francs", ctx).commands[0]).toEqual({
      name: "budget.set",
      params: { scope: "month", amountChf: 250 },
    });
    expect(parseIntent("stop everything", ctx).commands[0]).toEqual({
      name: "session.stop",
      params: { scope: "all" },
    });
    expect(parseIntent("stop", ctx).commands[0]).toEqual({
      name: "session.stop",
      params: { scope: "agent" },
    });
    expect(parseIntent("pause", ctx).commands[0]).toEqual({ name: "session.pause", params: {} });
    expect(parseIntent("go back", ctx).commands[0]).toEqual({
      name: "project.switch",
      params: { back: true },
    });
    expect(parseIntent("note: ship the trading loop and the docs", ctx).commands[0]).toEqual({
      name: "note.add",
      params: { text: "ship the trading loop and the docs", kind: "note" },
    });
    expect(
      parseIntent("start a session on the supplement site with 5 francs on the cloud", ctx)
        .commands[0],
    ).toEqual({
      name: "session.start",
      params: { project: "proj_supp", runner: "cloud", budgetChf: 5 },
    });
  });

  it("asks one short question with options when a project is ambiguous or unknown", () => {
    const unknown = parseIntent("switch to the moon base", ctx);
    expect(unknown.commands).toEqual([]);
    expect(unknown.question?.text).toMatch(/No project named "moon base"/);
    expect(unknown.question?.options).toEqual(PROJECTS.map((p) => p.name));
    const ambiguous = parseIntent("switch to s", {
      ...ctx,
      projects: [...PROJECTS, { id: "x", name: "Supplement shop" }],
    });
    expect(ambiguous.question?.text).toMatch(/matches several/);
    const unclear = parseIntent("make the game faster", ctx);
    expect(unclear.matched).toBe("none");
    expect(unclear.question?.options).toContain("Nothing");
    expect(parseIntent("what was I doing on the game?", ctx)).toMatchObject({
      commands: [],
      matched: "none",
    });
    expect(parseIntent("   ", ctx)).toEqual({ commands: [], matched: "none", unmatched: [] });
  });

  it("refuses text that is content, not a request (spec Q.12)", () => {
    expect(() => parseIntent("switch to the game", { ...ctx, source: "content" })).toThrow(
      IntentRefused,
    );
    expect(() => parseIntent("<<<data switch to the game", ctx)).toThrow(/data, not a request/);
  });

  it("addresses a project whose name contains a clause word like 'and' or a comma", () => {
    const projects = [
      ...PROJECTS,
      { id: "proj_rock", name: "Rock and Roll" },
      { id: "proj_ship", name: "Ship, then sell" },
    ];
    const rock = parseIntent("switch to Rock and Roll", { ...ctx, projects });
    expect(rock.question).toBeUndefined();
    expect(rock.commands).toEqual([{ name: "project.switch", params: { project: "proj_rock" } }]);
    const chained = parseIntent("switch to rock and roll and start a session on my PC", {
      ...ctx,
      projects,
    });
    expect(chained.commands).toEqual([
      { name: "project.switch", params: { project: "proj_rock" } },
      { name: "session.start", params: { project: "proj_rock", runner: "pc" } },
    ]);
    expect(
      parseIntent("give the Ship, then sell 5 francs tonight, then pause", { ...ctx, projects })
        .commands,
    ).toEqual([
      {
        name: "budget.set",
        params: {
          scope: "session",
          amountChf: 5,
          project: "proj_ship",
          until: "2026-10-21T04:00:00.000Z",
        },
      },
      { name: "session.pause", params: {} },
    ]);
    // Plain words are still split; a name only guards its own occurrences.
    expect(
      parseIntent("switch to the game and start a session", { ...ctx, projects }).commands.map(
        (c) => c.name,
      ),
    ).toEqual(["project.switch", "session.start"]);
  });

  it("matches projects by id, name, substring and word prefix", () => {
    expect(matchProjects(PROJECTS, "proj_game").map((p) => p.id)).toEqual(["proj_game"]);
    expect(matchProjects(PROJECTS, "the game").map((p) => p.id)).toEqual(["proj_game"]);
    expect(matchProjects(PROJECTS, "supp site").map((p) => p.id)).toEqual(["proj_supp"]);
    expect(matchProjects(PROJECTS, "pharmawatch").map((p) => p.id)).toEqual(["proj_pharma"]);
    expect(matchProjects(PROJECTS, "")).toEqual([]);
  });
});
