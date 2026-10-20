import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import { Logger, type LogRecord } from "@forerunner/platform";
import { join } from "@forerunner/platform/paths";
import type { KeyringEntryFactory, KeyringEntryLike } from "../src/keyring.ts";

/** A fresh value that can never be mistaken for a real credential or a fixed fixture. */
export function freshValue(prefix = "v-"): string {
  return `${prefix}${randomBytes(12).toString("hex")}`;
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "fr-vault-"));
  return { dir, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Fast KDF for tests; production uses DEFAULT_SCRYPT. */
export const FAST_SCRYPT = { N: 1024, r: 8, p: 1 };

/**
 * In-memory stand-in for the OS keyring: same contract as @napi-rs/keyring's AsyncEntry.
 * `maxLength` simulates the Windows Credential Manager blob cap; `failing` a store that is
 * locked or absent; `hang` an operation that never completes unless aborted.
 */
export class FakeKeyringStore {
  readonly data = new Map<string, string>();
  readonly log: string[] = [];
  failing = false;
  hang = false;
  maxLength: number | null = null;

  readonly factory: KeyringEntryFactory = (service, account) => {
    const key = `${service}\u0000${account}`;
    const guard = (op: string, signal?: AbortSignal | null): Promise<void> => {
      this.log.push(`${op} ${account}`);
      if (this.failing) {
        return Promise.reject(new Error("Couldn't access platform storage: AccessDenied"));
      }
      if (this.hang) {
        return new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      return Promise.resolve();
    };
    const entry: KeyringEntryLike = {
      setPassword: async (password, signal) => {
        await guard("set", signal);
        if (this.maxLength !== null && password.length > this.maxLength) {
          throw new Error("Invalid parameter: blob too long");
        }
        this.data.set(key, password);
      },
      getPassword: async (signal) => {
        await guard("get", signal);
        return this.data.get(key) ?? null;
      },
      deleteCredential: async (signal) => {
        await guard("delete", signal);
        return this.data.delete(key);
      },
    };
    return entry;
  };

  accounts(service: string): string[] {
    return [...this.data.keys()]
      .filter((k) => k.startsWith(`${service}\u0000`))
      .map((k) => k.slice(service.length + 1))
      .sort();
  }
}

/**
 * Capture everything a test could leak through: Logger sinks and the console. Returns the
 * collected text so a test can assert a value never appears in it.
 */
export function captureOutput(): { text: () => string; restore: () => void } {
  const records: LogRecord[] = [];
  const consoleLines: string[] = [];
  const previousLevel = "info";
  Logger.setSinks([(r) => records.push(r)]);
  Logger.setLevel("debug");
  const original = { log: console.log, warn: console.warn, error: console.error };
  const grab =
    (name: "log" | "warn" | "error") =>
    (...args: unknown[]) => {
      consoleLines.push(`${name}: ${args.map((a) => stringify(a)).join(" ")}`);
    };
  console.log = grab("log");
  console.warn = grab("warn");
  console.error = grab("error");
  return {
    text: () => [...records.map((r) => JSON.stringify(r)), ...consoleLines].join("\n"),
    restore: () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
      Logger.setSinks([]);
      Logger.setLevel(previousLevel);
    },
  };
}

export function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) {
    return `${v.name}: ${v.message} ${JSON.stringify((v as { details?: unknown }).details ?? {})} ${
      v.cause instanceof Error ? v.cause.message : ""
    }`;
  }
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Run `fn`, return the thrown error (or fail). Used to inspect error text for leaks. */
export async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the operation to throw");
}
