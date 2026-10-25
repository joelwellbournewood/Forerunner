import { assertSecretValue, assertStorableSecretName, type Vault } from "./types.ts";

/** In-process vault for tests and for `FORERUNNER_VAULT_BACKEND=memory`. Nothing persists. */
export class MemoryVault implements Vault {
  readonly backend = "memory" as const;
  private readonly entries = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [name, value] of Object.entries(initial)) {
      this.entries.set(assertStorableSecretName(name), assertSecretValue(value));
    }
  }

  async set(name: string, value: string): Promise<void> {
    this.entries.set(assertStorableSecretName(name), assertSecretValue(value));
  }

  async get(name: string): Promise<string | null> {
    return this.entries.get(assertStorableSecretName(name)) ?? null;
  }

  async delete(name: string): Promise<boolean> {
    return this.entries.delete(assertStorableSecretName(name));
  }

  async list(): Promise<string[]> {
    return [...this.entries.keys()].sort();
  }

  async has(name: string): Promise<boolean> {
    return this.entries.has(assertStorableSecretName(name));
  }

  /** Forget everything (tests). */
  clear(): void {
    this.entries.clear();
  }
}
