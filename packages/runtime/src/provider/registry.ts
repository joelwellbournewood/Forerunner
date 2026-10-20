import { ForerunnerError } from "@forerunner/platform";
import type { ModelProvider } from "./types.ts";

/** Providers by name; "anthropic" and "fake" are built in, others plug in (adding-a-provider.md). */
export class ProviderRegistry {
  private providers = new Map<string, ModelProvider>();

  register(p: ModelProvider): this {
    this.providers.set(p.name, p);
    return this;
  }

  get(name: string): ModelProvider {
    const p = this.providers.get(name);
    if (!p) throw new ForerunnerError("not_found", `model provider not registered: ${name}`);
    return p;
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  names(): string[] {
    return [...this.providers.keys()];
  }
}
