import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "@forerunner/platform";
import type { NewAuditLog } from "@forerunner/state";
import { afterAll, describe, expect, it } from "vitest";
import {
  droppedToolAudit,
  specialistSpecFrom,
  TOOL_UNMAPPED_AUDIT,
} from "../src/daemon/compose.ts";
import { fileTools } from "../src/daemon/tools.ts";
import { loadRegistry } from "../src/registry/loader.ts";
import {
  CLAUDE_CODE_TOOL_EQUIVALENTS,
  type DroppedTool,
  loopToolsFor,
} from "../src/registry/tools.ts";
import { KNOWN_CLAUDE_CODE_TOOLS } from "../src/registry/types.ts";
import { RUN_COMMAND_TOOL } from "../src/session/executor.ts";

/**
 * The registry names Claude Code tools; the loop driver maps them to its built-ins and nothing
 * else (ADR 0043). Table-driven over the mapping, then the composition root's spec function on
 * a real registry copy whose coder names an unknown `cc:Foo`, and the audit row it leaves.
 */
const BUILT_INS = fileTools().names(); // list_dir, read_file, run_command, write_file
const REGISTRY = join(process.cwd(), "evals", "registry");
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const WIDGET_FM = (tools: string[], requiresSandbox: boolean) => `name: widget
version: "1.0.0"
description: Builds widgets for the tool mapping tests.
default_tier: sonnet
default_effort: medium
max_effort: high
allowed_tools:
${tools.map((t) => `  - ${t}`).join("\n")}
allowed_domains: []
max_budget_usd: 1.0
max_turns: 10
timeout_minutes: 5
risk_tier_floor: 1
eval_set: evals/widget
status: active
requires_sandbox: ${requiresSandbox}
output_contract: A widget and a report naming each acceptance criterion with evidence.
`;

/** A copy of the repository registry plus a `widget` specialist; `cc:Foo` is accepted by the loader for the test. */
function registryWith(tools: string[], requiresSandbox = true) {
  const dir = mkdtempSync(join(os.tmpdir(), "fr-cc-tools-"));
  temps.push(dir);
  cpSync(REGISTRY, dir, { recursive: true });
  const file = join(dir, "specialists", "widget", "specialist.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    `---\n${WIDGET_FM(tools, requiresSandbox)}---\n\n# Widget\n\nBuild it.\n`,
    "utf8",
  );
  return loadRegistry(dir, {
    toolNames: [...BUILT_INS, "ext:fake:fetch_page"],
    claudeCodeTools: [...KNOWN_CLAUDE_CODE_TOOLS, "Foo"],
  });
}

describe("loopToolsFor: the loop driver's equivalents of the registry's Claude Code tools", () => {
  it.each(Object.entries(CLAUDE_CODE_TOOL_EQUIVALENTS))(
    "cc:%s yields %s and nothing else",
    (cc, builtIn) => {
      const m = loopToolsFor([`cc:${cc}`], { available: BUILT_INS });
      expect(m).toEqual({ tools: [builtIn], dropped: [] });
      expect(BUILT_INS).toContain(builtIn);
    },
  );

  it("maps every known Claude Code tool or lists it as one with no loop equivalent", () => {
    const without = KNOWN_CLAUDE_CODE_TOOLS.filter(
      (t) => !Object.hasOwn(CLAUDE_CODE_TOOL_EQUIVALENTS, t),
    );
    expect(without).toEqual(["WebFetch", "WebSearch", "Task", "TodoWrite"]);
    for (const t of without) {
      expect(loopToolsFor([`cc:${t}`], { available: BUILT_INS })).toEqual({
        tools: [],
        dropped: [expect.objectContaining({ tool: `cc:${t}`, reason: "unmapped" })],
      });
    }
  });

  it("the read tools never yield a write tool and cc:Bash yields run_command only", () => {
    expect(
      loopToolsFor(["cc:Read", "cc:Glob", "cc:Grep", "cc:LS"], { available: BUILT_INS }),
    ).toEqual({
      tools: ["read_file", "list_dir"],
      dropped: [],
    });
    expect(loopToolsFor(["cc:Bash"], { available: BUILT_INS }).tools).toEqual([RUN_COMMAND_TOOL]);
    expect(CLAUDE_CODE_TOOL_EQUIVALENTS.Bash).toBe(RUN_COMMAND_TOOL);
  });

  it("drops an unknown cc:Foo with its reason, never silently", () => {
    const m = loopToolsFor(["cc:Read", "cc:Foo"], { available: BUILT_INS });
    expect(m.tools).toEqual(["read_file"]);
    expect(m.dropped).toEqual([
      {
        tool: "cc:Foo",
        reason: "unmapped",
        message: expect.stringContaining("cc:Foo has no equivalent on the loop driver"),
      },
    ]);
  });

  it("a name that is only an Object prototype member is unmapped, not a lookup through the prototype chain", () => {
    // Only the table's own entries map; `cc:constructor` must not resolve to Object's
    // constructor and leak its source text into the reason.
    for (const name of [
      "cc:constructor",
      "cc:__proto__",
      "cc:toString",
      "cc:hasOwnProperty",
      "cc:valueOf",
      "cc:",
    ]) {
      const m = loopToolsFor([name], { available: BUILT_INS });
      expect(m.tools).toEqual([]);
      expect(m.dropped).toEqual([
        {
          tool: name,
          reason: "unmapped",
          message: `${name} has no equivalent on the loop driver; it is offered on the Agent SDK driver only`,
        },
      ]);
      expect(m.dropped[0]?.message).not.toContain("native code");
    }
  });

  it("refuses run_command when commands are not allowed, however the entry spelled it", () => {
    for (const name of ["cc:Bash", RUN_COMMAND_TOOL]) {
      const m = loopToolsFor(["cc:Read", name], { available: BUILT_INS, commands: false });
      expect(m.tools).toEqual(["read_file"]);
      expect(m.dropped).toEqual([
        expect.objectContaining({ tool: name, reason: "commands_not_allowed" }),
      ]);
    }
    expect(
      loopToolsFor([RUN_COMMAND_TOOL], { available: BUILT_INS, commands: true }).tools,
    ).toEqual([RUN_COMMAND_TOOL]);
  });

  it("passes Forerunner names through only while they are registered (a bridged tool after a disable is dropped)", () => {
    const bridged = "ext:fake:fetch_page";
    expect(loopToolsFor([bridged, "cc:Read"], { available: [...BUILT_INS, bridged] })).toEqual({
      tools: [bridged, "read_file"],
      dropped: [],
    });
    const gone = loopToolsFor([bridged, "cc:Read"], { available: BUILT_INS });
    expect(gone.tools).toEqual(["read_file"]);
    expect(gone.dropped).toEqual([
      {
        tool: bridged,
        reason: "unavailable",
        message: `${bridged} is not registered in this runtime`,
      },
    ]);
    // a cc: name whose equivalent this runtime lacks names both in the message
    expect(loopToolsFor(["cc:Read"], { available: ["write_file"] }).dropped).toEqual([
      {
        tool: "cc:Read",
        reason: "unavailable",
        message: "cc:Read maps to read_file, which is not registered in this runtime",
      },
    ]);
  });

  it("keeps the registry's order and collapses duplicates", () => {
    const m = loopToolsFor(["cc:Edit", "cc:Write", "cc:Read", "cc:Grep", "cc:Glob", "read_file"], {
      available: BUILT_INS,
    });
    expect(m.tools).toEqual(["write_file", "read_file", "list_dir"]);
    expect(m.dropped).toEqual([]);
  });
});

describe("specialistSpecFrom: each driver maps the registry's names its own way", () => {
  it("on the loop driver the spec carries the built-ins, cc:Foo is dropped and reported, the registry stays as written", () => {
    const registry = registryWith(["cc:Read", "cc:Foo", "cc:Bash"]);
    const drops: [string, DroppedTool][] = [];
    const specs = specialistSpecFrom(registry, {
      driver: "loop",
      tools: () => BUILT_INS,
      onDropped: (s, d) => drops.push([s, d]),
    });
    expect(specs("widget")?.allowedTools).toEqual(["read_file", RUN_COMMAND_TOOL]);
    expect(drops).toEqual([
      ["widget", expect.objectContaining({ tool: "cc:Foo", reason: "unmapped" })],
    ]);
    expect(registry.specialist("widget").allowed_tools).toEqual(["cc:Read", "cc:Foo", "cc:Bash"]);
    // the repository coder: every name mapped, nothing dropped
    expect(specs("coder")?.allowedTools).toEqual([
      "read_file",
      "write_file",
      RUN_COMMAND_TOOL,
      "list_dir",
    ]);
    expect(drops).toHaveLength(1);
  });

  it("on the SDK driver the cc: names stay as the registry wrote them; the driver is always named", () => {
    const registry = registryWith(["cc:Read", "cc:Foo"]);
    const drops: string[] = [];
    const sdk = specialistSpecFrom(registry, {
      driver: "sdk",
      tools: () => BUILT_INS,
      onDropped: (_s, d) => drops.push(d.tool),
    });
    expect(sdk("widget")?.allowedTools).toEqual(["cc:Read", "cc:Foo"]);
    expect(drops).toEqual([]);
    // No silent default: a caller that names no driver is a type error, so a loop-driver
    // executor can never be handed the SDK form by omission (the cloud runner takes
    // `rt.specialists` from the composed runtime).
    // @ts-expect-error the options are required
    expect(() => specialistSpecFrom(registry)).toThrow(/driver/);
  });

  it("cc:Bash yields run_command only for an entry that requires a sandbox unless the caller's policy allows commands", () => {
    const registry = registryWith(["cc:Bash", "cc:Read"], false);
    const drops: DroppedTool[] = [];
    const byEntry = specialistSpecFrom(registry, {
      driver: "loop",
      tools: () => BUILT_INS,
      onDropped: (_s, d) => drops.push(d),
    });
    expect(byEntry("widget")?.allowedTools).toEqual(["read_file"]);
    expect(drops).toEqual([
      expect.objectContaining({ tool: "cc:Bash", reason: "commands_not_allowed" }),
    ]);
    const sandboxed = specialistSpecFrom(registry, {
      driver: "loop",
      tools: () => BUILT_INS,
      commands: () => true,
    });
    expect(sandboxed("widget")?.allowedTools).toEqual([RUN_COMMAND_TOOL, "read_file"]);
  });

  it("the spec never names a tool the registry did not grant", () => {
    const registry = registryWith(["cc:Read"]);
    const spec = specialistSpecFrom(registry, { driver: "loop", tools: () => BUILT_INS })("widget");
    expect(spec?.allowedTools).toEqual(["read_file"]);
    expect(spec?.allowedTools).not.toContain("write_file");
    expect(spec?.allowedTools).not.toContain(RUN_COMMAND_TOOL);
  });
});

describe("droppedToolAudit: one audit row per specialist and tool", () => {
  const drop: DroppedTool = {
    tool: "cc:Foo",
    reason: "unmapped",
    message: "cc:Foo has no equivalent on the loop driver",
  };

  it("writes the row naming the specialist and the tool, once, and flush waits for it", async () => {
    const rows: NewAuditLog[] = [];
    const warnings: string[] = [];
    const audit = droppedToolAudit({
      audit: {
        append: async (row) => {
          rows.push(row);
          return row;
        },
      },
      agentId: "agent-1",
      humanId: "human-1",
      warn: (m) => warnings.push(m),
    });
    audit.onDropped("coder", drop);
    audit.onDropped("coder", drop);
    audit.onDropped("coder", { ...drop, tool: "cc:Bar" });
    await audit.flush();
    expect(rows).toEqual([
      {
        agent_id: "agent-1",
        human_id: "human-1",
        tool: TOOL_UNMAPPED_AUDIT,
        input_summary: "coder: cc:Foo",
        result_summary: "dropped (unmapped)",
        allowed: false,
        denied_reason: "tool_not_allowed: cc:Foo has no equivalent on the loop driver",
      },
      expect.objectContaining({ input_summary: "coder: cc:Bar" }),
    ]);
    expect(TOOL_UNMAPPED_AUDIT).toBe("registry.tool_unmapped");
    expect(warnings).toEqual([
      "specialist tool not offered on the loop driver",
      "specialist tool not offered on the loop driver",
    ]);
  });

  it("a failing append is a warning, never a thrown lookup", async () => {
    const warnings: Record<string, unknown>[] = [];
    const audit = droppedToolAudit({
      audit: {
        append: async () => {
          throw new Error("disk full");
        },
      },
      agentId: "a",
      humanId: "h",
      warn: (_m, c) => warnings.push(c),
    });
    expect(() => audit.onDropped("coder", drop)).not.toThrow();
    await expect(audit.flush()).resolves.toBeUndefined();
    expect(warnings).toEqual([
      expect.objectContaining({ specialist: "coder", tool: "cc:Foo", reason: "unmapped" }),
      expect.objectContaining({ specialist: "coder", tool: "cc:Foo", error: "disk full" }),
    ]);
  });
});
