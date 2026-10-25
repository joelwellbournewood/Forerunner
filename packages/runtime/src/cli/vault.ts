import { ForerunnerError } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import {
  assertSecretName,
  assertSecretValue,
  MAX_SECRET_VALUE_LENGTH,
  type Vault,
} from "@forerunner/vault";
import type { Command } from "commander";

/**
 * `fr vault set <name>`: a secret into this install's vault under the name a connector's
 * catalog entry references (`secret:<name>`), for every name `fr setup` does not store.
 * The value comes from stdin when it is piped, or from a hidden terminal prompt, never from
 * an argument (shell history, process list); no output line, log line or audit row carries
 * it. The name goes through `assertSecretName`, so a reserved `forerunner.*` name (the
 * install wrapping key) and an invalid one are refused before anything is read or composed.
 * One `vault.set` audit row per store: the name and whether it replaced a value.
 */
export interface VaultCliRuntime {
  vault: Pick<Vault, "backend" | "has" | "set">;
  store: Pick<StateStore, "auditLog">;
  clock: { nowIso(): string };
  human: { id: string };
}

/** What the value is read from: `process.stdin`, or a test's stream or fake terminal. */
export interface SecretInput {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  setEncoding?(encoding: BufferEncoding): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: "data" | "end" | "error", listener: (...args: unknown[]) => void): unknown;
  off(event: "data" | "end" | "error", listener: (...args: unknown[]) => void): unknown;
}

export interface VaultCliDeps {
  /** The composed runtime without its services: the vault the daemon opens, the store, the clock. */
  open: () => Promise<VaultCliRuntime>;
  out: (line: string) => void;
  /** Where the value comes from; the process's stdin by default. */
  input?: SecretInput;
  /** Where the hidden prompt is written (a terminal only); the process's stdout by default. */
  output?: { write(chunk: string): unknown };
}

/** The audit row's tool name. */
export const VAULT_SET_AUDIT = "vault.set";

/** Bound on what is read before the value check runs (UTF-8 bytes of the longest legal value). */
const MAX_READ_BYTES = MAX_SECRET_VALUE_LENGTH * 4 + 2;

/** One trailing line end dropped: a piped `echo` or a pasted line ends with one. */
function stripLineEnd(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n") || text.endsWith("\r")) return text.slice(0, -1);
  return text;
}

/**
 * Read the whole of a piped stdin (bounded) with one trailing line end dropped, or, on a
 * terminal, the keystrokes up to Enter with raw mode on so nothing is echoed; backspace
 * removes a character, Ctrl-C refuses with `validation` and nothing is stored. The prompt
 * names the secret, never shows a character of the value, and ends the line afterwards.
 */
export function readSecretValue(
  input: SecretInput,
  output: { write(chunk: string): unknown },
  prompt: string,
): Promise<string> {
  if (!input.isTTY) {
    return new Promise<string>((resolve, reject) => {
      const chunks: string[] = [];
      let size = 0;
      const done = () => {
        input.off("data", onData);
        input.off("end", onEnd);
        input.off("error", onError);
      };
      const onData = (chunk: unknown) => {
        const text =
          typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
        size += Buffer.byteLength(text, "utf8");
        if (size > MAX_READ_BYTES) {
          done();
          input.pause?.();
          reject(new ForerunnerError("validation", "secret value is too large"));
          return;
        }
        chunks.push(text);
      };
      const onEnd = () => {
        done();
        resolve(stripLineEnd(chunks.join("")));
      };
      const onError = (e: unknown) => {
        done();
        reject(e);
      };
      input.setEncoding?.("utf8");
      input.on("data", onData);
      input.on("end", onEnd);
      input.on("error", onError);
      input.resume?.();
    });
  }
  return new Promise<string>((resolve, reject) => {
    let typed = "";
    const finish = (settle: () => void) => {
      input.off("data", onData);
      input.off("error", onError);
      input.setRawMode?.(false);
      input.pause?.();
      output.write("\n");
      settle();
    };
    const onData = (chunk: unknown) => {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          finish(() => resolve(typed));
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          finish(() => reject(new ForerunnerError("validation", "cancelled; nothing was stored")));
          return;
        }
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    const onError = (e: unknown) => finish(() => reject(e));
    output.write(prompt);
    input.setEncoding?.("utf8");
    input.setRawMode?.(true);
    input.on("data", onData);
    input.on("error", onError);
    input.resume?.();
  });
}

export function registerVaultCli(program: Command, deps: VaultCliDeps): void {
  const vault = program
    .command("vault")
    .description("Secrets in this install's vault, by name (values are never printed)");

  vault
    .command("set")
    .description(
      "Store a secret under <name> (the name a connector references as secret:<name>): the value is read from stdin when piped, else typed at a hidden prompt; never from an argument",
    )
    .argument("<name>", "the secret's name, e.g. slack_token")
    .action(async (rawName: string) => {
      // Refused before anything is read or composed: an invalid name, and the reserved
      // `forerunner.*` names (the install wrapping key is one).
      const name = assertSecretName(rawName);
      const rt = await deps.open();
      const value = assertSecretValue(
        await readSecretValue(
          deps.input ?? process.stdin,
          deps.output ?? process.stdout,
          `Value for ${name} (not shown; Enter to finish, Ctrl-C to cancel): `,
        ),
      );
      const replaced = await rt.vault.has(name);
      await rt.vault.set(name, value);
      await rt.store.auditLog.append({
        tool: VAULT_SET_AUDIT,
        human_id: rt.human.id,
        input_summary: `name=${name}`,
        result_summary: replaced ? "replaced" : "stored",
        allowed: true,
        occurred_at: rt.clock.nowIso(),
      });
      deps.out(`${replaced ? "Replaced" : "Stored"} ${name} in the ${rt.vault.backend} vault.`);
    });
}
