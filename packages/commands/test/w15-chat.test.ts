import { describe, expect, it } from "vitest";
import { z } from "zod";
import { settingsSet } from "../src/commands/settings.ts";
import { CommandExecutor, type ExecuteResult } from "../src/index.ts";
import { world } from "./helpers.ts";

/**
 * w15-chat (wave 15): the fix wave for live check 2 (the real model on the bench, 2026-11-09)
 * and wave 13's leftovers, in the commands: what the chat model is told and refused, the undo
 * card's words, the refusals' reasons, one Changes row for a new project, same-titled tasks and
 * the money words.
 */
function refused(r: ExecuteResult): Extract<ExecuteResult, { status: "refused" }> {
  if (r.status !== "refused")
    throw new Error(`expected refused, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}
function done(r: ExecuteResult): Extract<ExecuteResult, { status: "done" }> {
  if (r.status !== "done") throw new Error(`expected done, got ${r.status}: ${JSON.stringify(r)}`);
  return r;
}

describe("w15-chat, wave 15", () => {
  // W15-29. Live (2026-11-09, research F2): the chat model got settings_set as "Change a setting
  // by key. Keys: …" with `"value": {}`, sent "public", {allowed: "public_websites"} and "any"
  // for web_access, was refused three times with "Invalid input: expected object, received
  // string", and recorded a lesson instead.
  it("settings_set's definition gives each key's value shape; web_access's line names mode, only and never (W15-29)", () => {
    const lines = settingsSet.description.split("\n");
    expect(lines[0]).toBe(
      "Change a setting by key: a rule the app enforces, such as what research may read on the web (web_access), who merges accepted work, fast mode or quiet hours. Such a rule is a setting: change it here, never record it as a lesson instead (a lesson changes no setting). value takes the shape given for its key. A change that narrows what the app may do acts at once; one that widens it waits for the person's yes. Keys:",
    );
    expect(lines).toContain(
      '- web_access (per project): What research reads on the web: mode any (any public website, except the never list) or only (only the websites on the only list); each entry covers the site and its subdomains. Never this computer or the local network. Value: {"mode": "any" | "only", "only"?: [string], "never"?: [string]}. For example {"mode":"only","only":["developer.mozilla.org"]} or {"mode":"any","never":["facebook.com"]} or {"mode":"any"}.',
    );
    expect(lines).toContain(
      '- quiet_hours (for the person): No notifications and no non-manual session starts between start and end (local time). Value: {"start": "HH:MM", "end": "HH:MM"} | null. For example {"start":"22:00","end":"07:00"} or null.',
    );
    expect(lines).toContain(
      "- speed_quality_offset (per project): Shifts every mode's default effort one step per project: -1 speed, 0 balanced, +1 quality. Value: integer from -1 to 1.",
    );
    // Every key has its line.
    expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(21);
    // What the model's tool schema says of `value` (before: `{}`).
    const schema = z.toJSONSchema(settingsSet.params) as {
      properties: Record<string, { description?: string }>;
    };
    expect(schema.properties.value?.description).toBe(
      "The new value, in the shape the description gives for the key (an object, a list, a number, true or false, a string or null).",
    );
  });

  it("a web_access value of the wrong shape is refused naming mode, only and never (W15-29)", async () => {
    const w = await world();
    const send = async (value: unknown) =>
      refused(
        await w.executor.execute({
          name: "settings.set",
          params: { key: "web_access", value, project: "Game" },
          ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id } }),
        }),
      ).reason;
    // The three values the live model sent, in order.
    expect(await send("public")).toBe(
      'That is not a value for web pages research may read (Invalid input: expected object, received string). It takes {"mode": "any" | "only", "only"?: [string], "never"?: [string]}, for example {"mode":"only","only":["developer.mozilla.org"]}.',
    );
    expect(await send({ allowed: "public_websites" })).toBe(
      'That is not a value for web pages research may read (mode: Invalid option: expected one of "any"|"only"; Unrecognized key: "allowed"). It takes {"mode": "any" | "only", "only"?: [string], "never"?: [string]}, for example {"mode":"only","only":["developer.mozilla.org"]}.',
    );
    expect(await send("any")).toContain('"mode": "any" | "only"');
    // A site the rule cannot take keeps its own sentence (Settings shows it as it is).
    expect(await send({ mode: "only", only: ["127.0.0.1"] })).toMatch(/^"127\.0\.0\.1" is .+\.$/);
    expect(await send({ mode: "only", only: [] })).toBe(
      "Only these websites needs at least one website, or research would be stuck.",
    );
    // The shape the model reads: {mode, only} parses, and a narrowing acts at once.
    const r = done(
      await w.executor.execute({
        name: "settings.set",
        params: {
          key: "web_access",
          value: { mode: "only", only: ["developer.mozilla.org"] },
          project: "Game",
        },
        ctx: w.ctx({ actor: { kind: "agent", id: w.agent.id } }),
      }),
    );
    expect(r.sentence).toBe(
      "Set web pages research may read for Game from any public website to only developer.mozilla.org: research reads only these websites and their subdomains, on the API key and on the subscription. Undo.",
    );
  });

  it("memory.record's sentence says a lesson changes no setting (W15-29)", async () => {
    const w = await world();
    const r = done(
      await w.executor.execute({
        name: "memory.record",
        params: { text: "only read developer.mozilla.org for research" },
        ctx: w.ctx({ wordsUsed: "only read developer.mozilla.org for research" }),
      }),
    );
    expect(r.sentence).toBe(
      'Recorded a lesson in Alice\'s memory for PharmaWatch: "only read developer.mozilla.org for research". It changes no setting. Undo.',
    );
    const def = w.registry.mustGet("memory.record");
    expect(def.description).toContain(
      "A lesson changes no setting: a rule the app enforces (what research may read on the web, who merges, fast mode, quiet hours, a budget) is changed with settings_set or budget_set, never recorded here instead.",
    );
  });

  // W15-34 (live check 2, research F13): Undo on Changes for a site rule change waited for a yes
  // as a card titled "undo" ("undo: web pages research may read for Reading rules", no
  // question), raw "yes"/"no", read on Home and in the Inbox.
  it("an undo waiting for a yes asks one plain question, also when its card was made before a restart (W15-34)", async () => {
    const w = await world();
    const set = done(
      await w.executor.execute({
        name: "settings.set",
        params: {
          key: "web_access",
          value: { mode: "any", only: [], never: ["facebook.com"] },
          project: "Game",
        },
        ctx: w.ctx({ source: "ui" }),
      }),
    );
    const QUESTION =
      "Put web pages research may read for Game back to any public website? Research reads any public website except the ones listed, on the API key and on the subscription.";
    const asked = await w.executor.undo(set.changeLogId, w.ctx({ source: "ui" }));
    if (asked.status !== "pending") throw new Error(`expected pending, got ${asked.status}`);
    expect(asked.card.ask).toBe(QUESTION);
    expect(asked.readback).toBe(QUESTION);
    // The change's own name, never the command's: "undo: …" was the card's title.
    expect(asked.card.what).toBe("web pages research may read for Game");
    const row = await w.store.humanRequest.get(asked.pendingId);
    expect(row?.why).not.toMatch(/^undo:/);
    expect((row?.change_card as { ask?: string } | null)?.ask).toBe(QUESTION);
    // A daemon started again has no card in memory: the row's command says it the same way.
    const fresh = new CommandExecutor({ registry: w.registry, store: w.store, clock: w.clock });
    const again = await fresh.undo(set.changeLogId, w.ctx({ source: "ui" }));
    if (again.status !== "pending") throw new Error(`expected pending, got ${again.status}`);
    expect(again.readback).toBe(QUESTION);
    // A command without words of its own for its undo: the change it takes back, in quotes.
    const note = done(
      await w.executor.execute({
        name: "budget.set",
        params: { scope: "month", amountChf: 100 },
        ctx: w.ctx({ source: "ui" }),
        confirmation: { kind: "tap", by: { kind: "human", id: w.human.id } },
      }),
    );
    const back = await fresh.undo(note.changeLogId, w.ctx({ source: "ui" }));
    if (back.status !== "pending") throw new Error(`expected pending, got ${back.status}`);
    expect(back.card.ask).toMatch(
      /^Take back "Lowered the monthly cap from CHF 150(\.00)? to CHF 100(\.00)?"\?$/,
    );
    expect(back.card.what).not.toMatch(/^undo:/);
  });
});
