import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore, silenceSqliteExperimentalWarning } from "@forerunner/state";
import {
  ensureInstallWrapKey,
  INSTALL_WRAP_KEY_NAME,
  MemoryVault,
  valueEncodings,
} from "@forerunner/vault";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "../src/cli/main.ts";
import { registerVaultCli } from "../src/cli/vault.ts";
import type { RuntimeApp } from "../src/daemon/compose.ts";

silenceSqliteExperimentalWarning();

/**
 * `fr vault set <name>` (adding-a-connector.md, "Secrets"): the way to put a connector's
 * secret into this install's vault under the name its catalog entry references. The value
 * comes from stdin (piped) or a hidden terminal prompt, never from an argument; it is never
 * printed or logged; the audit row names the secret and the outcome only; a reserved name
 * (`forerunner.*`) and an invalid one are refused before anything is read or composed.
 */
const START = "2026-10-25T09:00:00.000Z";

/** A fresh value that can never be mistaken for a real credential or a fixed fixture. */
function freshValue(): string {
  return `v-${randomBytes(12).toString("hex")}`;
}

/** A terminal: raw mode toggled, keystrokes emitted as data, nothing read ahead. */
class FakeTty extends EventEmitter {
  readonly isTTY = true;
  readonly raw: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.raw.push(mode);
    return this;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
  setEncoding(): this {
    return this;
  }
}

describe("fr vault set", () => {
  const clock = new SimulatedClock(START);
  let store: StateStore;
  let humanId: string;
  let vault: MemoryVault;
  let lines: string[];
  let logs: LogRecord[];
  let stopLogs: () => void;
  let composeCalls: Record<string, unknown>[];

  beforeEach(async () => {
    store = await openStore({ url: "sqlite::memory:", clock });
    humanId = (await store.human.insert({ name: "Ada", email: "ada@example.test" })).id;
    vault = new MemoryVault();
    await ensureInstallWrapKey(vault);
    lines = [];
    logs = [];
    stopLogs = Logger.addSink((r) => logs.push(r));
    composeCalls = [];
  });
  afterEach(async () => {
    stopLogs();
    await store.close();
  });

  function program(stdin: NodeJS.ReadableStream) {
    const rt = {
      store,
      clock,
      vault,
      human: { id: humanId, name: "Ada", timezone: "UTC" },
      agent: { id: "agent-1", name: "Alice" },
      close: async () => undefined,
    } as unknown as RuntimeApp;
    const p = buildProgram({
      env: {},
      compose: async (o) => {
        composeCalls.push(o);
        return rt;
      },
      out: (l) => lines.push(l),
      stdin,
    });
    p.exitOverride();
    return p;
  }
  const fr = (stdin: NodeJS.ReadableStream, ...args: string[]) =>
    program(stdin).parseAsync(["node", "fr", ...args]);
  /** Everything a value could leak into, as one string. */
  const everything = async () => JSON.stringify([lines, logs, await store.auditLog.list()]);

  it("is registered as `fr vault set <name>`: the value from stdin or a prompt, never an argument", () => {
    const p = program(Readable.from([]));
    const vaultCmd = p.commands.find((c) => c.name() === "vault");
    expect(vaultCmd).toBeDefined();
    const set = vaultCmd?.commands.find((c) => c.name() === "set");
    expect(set).toBeDefined();
    expect(set?.registeredArguments.map((a) => a.name())).toEqual(["name"]);
    expect(set?.description()).toMatch(/stdin/);
    expect(set?.description()).toMatch(/never/);
  });

  it("stores a piped value under the name (one trailing newline dropped) with an audit row that names the secret and never the value; a second set replaces it", async () => {
    const value = freshValue();
    await fr(Readable.from([`${value}\r\n`]), "vault", "set", "slack_token");
    expect(await vault.get("slack_token")).toBe(value);
    expect(lines).toEqual(["Stored slack_token in the memory vault."]);
    expect(composeCalls).toHaveLength(1);
    expect(composeCalls[0]).toMatchObject({ startServices: false });
    const rows = await store.auditLog.list({ tool: "vault.set" } as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tool: "vault.set",
      human_id: humanId,
      input_summary: "name=slack_token",
      result_summary: "stored",
      allowed: true,
      occurred_at: clock.nowIso(),
    });
    const next = freshValue();
    await fr(Readable.from([next]), "vault", "set", "slack_token");
    expect(await vault.get("slack_token")).toBe(next);
    expect(lines[1]).toBe("Replaced slack_token in the memory vault.");
    const again = await store.auditLog.list({ tool: "vault.set" } as never);
    expect(again.map((r) => r.result_summary)).toEqual(["stored", "replaced"]);
    const text = await everything();
    for (const v of [value, next])
      for (const enc of valueEncodings(v)) expect(text).not.toContain(enc);
  });

  it("refuses the install wrapping key's reserved name and an invalid name before reading the value or composing anything", async () => {
    const input = Readable.from([`${freshValue()}\n`]);
    await expect(fr(input, "vault", "set", INSTALL_WRAP_KEY_NAME)).rejects.toMatchObject({
      code: "secret_reserved",
      details: { name: INSTALL_WRAP_KEY_NAME },
    });
    await expect(fr(Readable.from(["x"]), "vault", "set", "Bad Name")).rejects.toMatchObject({
      code: "validation",
    });
    expect(composeCalls).toEqual([]);
    expect(input.readableEnded).toBe(false);
    expect(await vault.list()).toEqual([INSTALL_WRAP_KEY_NAME]);
    expect(await store.auditLog.list({ tool: "vault.set" } as never)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("refuses an empty value and stores nothing", async () => {
    await expect(fr(Readable.from(["\n"]), "vault", "set", "slack_token")).rejects.toMatchObject({
      code: "validation",
    });
    expect(await vault.has("slack_token")).toBe(false);
    expect(await store.auditLog.list({ tool: "vault.set" } as never)).toEqual([]);
  });

  it("on a terminal the value is typed at a hidden prompt: raw mode on then off, backspace honoured, nothing echoed", async () => {
    const tty = new FakeTty();
    const written: string[] = [];
    const cli = new Command().exitOverride();
    registerVaultCli(cli, {
      open: async () => ({ vault, store, clock, human: { id: humanId } }),
      out: (l) => lines.push(l),
      input: tty as unknown as NodeJS.ReadableStream,
      output: {
        write: (s: string) => {
          written.push(s);
          return true;
        },
      },
    });
    const run = cli.parseAsync(["node", "fr", "vault", "set", "slack_token"]);
    await vi.waitFor(() => expect(written.join("")).toContain("slack_token"));
    expect(tty.raw).toEqual([true]);
    tty.emit("data", "v-ab");
    tty.emit("data", "x\u007f");
    tty.emit("data", "c\r");
    await run;
    expect(await vault.get("slack_token")).toBe("v-abc");
    expect(tty.raw).toEqual([true, false]);
    const shown = written.join("");
    expect(shown).not.toContain("v-ab");
    expect(shown).not.toContain("abc");
    expect(shown.endsWith("\n")).toBe(true);
    expect(lines).toEqual(["Stored slack_token in the memory vault."]);
  });

  it("a cancelled prompt (Ctrl-C) stores nothing and restores the terminal", async () => {
    const tty = new FakeTty();
    const cli = new Command().exitOverride();
    registerVaultCli(cli, {
      open: async () => ({ vault, store, clock, human: { id: humanId } }),
      out: (l) => lines.push(l),
      input: tty as unknown as NodeJS.ReadableStream,
      output: { write: () => true },
    });
    const run = cli.parseAsync(["node", "fr", "vault", "set", "slack_token"]);
    await vi.waitFor(() => expect(tty.raw).toEqual([true]));
    tty.emit("data", "v-a\u0003");
    await expect(run).rejects.toMatchObject({ code: "validation" });
    expect(tty.raw).toEqual([true, false]);
    expect(await vault.has("slack_token")).toBe(false);
  });
});
