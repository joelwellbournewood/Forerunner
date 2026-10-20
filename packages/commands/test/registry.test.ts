import { isForerunnerError } from "@forerunner/platform";
import type { ToolExecutionContext } from "@forerunner/runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  actionClassFor,
  COMMAND_NAMES,
  CommandRegistry,
  defaultRegistry,
  toolNameFor,
  toToolSpecs,
} from "../src/index.ts";
import { world } from "./helpers.ts";

const toolCtx: ToolExecutionContext = {
  runId: "r",
  sessionId: "s",
  agentId: "a",
  humanId: "h",
  allowedPaths: [],
  signal: new AbortController().signal,
};

describe("CommandRegistry", () => {
  it("ships every command of the spec list, sorted by name", () => {
    const names = defaultRegistry().names();
    expect(names).toEqual([...COMMAND_NAMES].sort());
    expect(names).toContain("budget.set");
    expect(names).toContain("capability.grant");
  });

  it("refuses a duplicate name and a name that is not dotted lower case", () => {
    const reg = defaultRegistry();
    const dup = reg.mustGet("note.add");
    expect(() => reg.register(dup)).toThrow(/already registered/);
    expect(() =>
      new CommandRegistry().register({
        name: "NoDots",
        description: "",
        params: z.object({}),
        risk: "low",
        scope: "global",
        reversible: false,
        undoStrategy: "",
        run: async () => ({ before: null, after: null, sentence: "" }),
      }),
    ).toThrow(/dotted/);
  });

  it("validates parameters with the command schema and reports the issues", () => {
    const reg = defaultRegistry();
    expect(reg.validate("budget.set", { amountChf: 20 })).toEqual({
      scope: "session",
      amountChf: 20,
    });
    try {
      reg.validate("budget.set", { scope: "session" });
      expect.unreachable();
    } catch (e) {
      expect(isForerunnerError(e, "validation")).toBe(true);
      expect((e as { details: { issues: unknown[] } }).details.issues.length).toBeGreaterThan(0);
    }
    expect(() => reg.validate("nope.cmd", {})).toThrow(/unknown command/);
  });

  it("persists the definitions into the command table and is idempotent", async () => {
    const w = await world();
    const first = await w.store.command.list();
    expect(first.length).toBe(COMMAND_NAMES.length);
    const again = await w.registry.persist(w.store);
    expect((await w.store.command.list()).length).toBe(COMMAND_NAMES.length);
    const budget = again.find((r) => r.name === "budget.set");
    expect(budget?.version).toBe(2);
    expect(budget?.risk).toBe("high");
    expect(budget?.parameters_schema).toMatchObject({ type: "object" });
    const revoke = again.find((r) => r.name === "device.revoke");
    expect(revoke?.undo_strategy.startsWith("irreversible:")).toBe(true);
    await w.store.close();
  });

  it("maps risk to an action class unless the command names one", () => {
    const reg = defaultRegistry();
    expect(actionClassFor(reg.mustGet("project.switch"))).toBe("routine_reversible");
    expect(actionClassFor(reg.mustGet("session.start"))).toBe("non_routine");
    expect(actionClassFor(reg.mustGet("capability.grant"))).toBe("capability_grant");
    expect(actionClassFor(reg.mustGet("budget.set"))).toBe("permission_change");
    expect(actionClassFor(reg.mustGet("device.revoke"))).toBe("permission_change");
  });

  it("generates one ToolSpec per command with tool-safe names", () => {
    const reg = defaultRegistry();
    const specs = toToolSpecs(reg, {
      execute: async () => ({ status: "done", sentence: "ok" }),
      ctxFor: () => {
        throw new Error("unused");
      },
    });
    expect(specs.length).toBe(COMMAND_NAMES.length);
    expect(specs.map((s) => s.name)).toContain("budget_set");
    expect(toolNameFor("email.mode.set")).toBe("email_mode_set");
    const budget = specs.find((s) => s.name === "budget_set");
    expect(budget?.risk).toBe("high");
    expect(budget?.actionClass).toBe("permission_change");
    expect(specs.find((s) => s.name === "project_switch")?.risk).toBe("low");
  });

  it("tool execution goes through the binding and reports pending and refused outcomes", async () => {
    const reg = defaultRegistry();
    const calls: string[] = [];
    const specs = toToolSpecs(reg, {
      execute: async ({ name }) => {
        calls.push(name);
        if (name === "project.switch") return { status: "done", sentence: "Switched. Undo." };
        if (name === "budget.set")
          return {
            status: "pending",
            pendingId: "p1",
            card: {
              command: "budget.set",
              what: "the session budget",
              oldValue: "CHF 5",
              newValue: "CHF 20",
              scope: "session",
              scopeLabel: "this session",
              duration: "permanent",
              impact: { risk: "medium" },
              undoHint: "Undo.",
              sentence: "",
              projectId: null,
              projectName: null,
              usesActiveProject: false,
              expiresAt: null,
              reversible: true,
            },
          };
        return { status: "refused", reason: "nope" };
      },
      ctxFor: () => ({}) as never,
    });
    const by = (n: string) => specs.find((s) => s.name === n) as (typeof specs)[number];
    expect(await by("project_switch").execute({ project: "x" }, toolCtx)).toEqual({
      content: "Switched. Undo.",
    });
    const pending = await by("budget_set").execute({ amountChf: 20 }, toolCtx);
    expect(pending.content).toMatch(/^Needs confirmation \(p1\)/);
    expect(pending.content).toContain("CHF 5 to CHF 20");
    const refused = await by("device_revoke").execute({ device: "x" }, toolCtx);
    expect(refused.isError).toBe(true);
    expect(calls).toEqual(["project.switch", "budget.set", "device.revoke"]);
  });
});
