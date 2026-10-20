/**
 * Durable model settings the weekly model watch may change after a human says yes (spec D):
 *
 *   <config>/models.json   ladder overrides (tier -> provider -> model id) and effort overrides
 *                          per mode, with a history of adopted changes;
 *   <config>/pricing.json  the pricing overrides the billing package already reads
 *                          (loadPricing / mergePricing).
 *
 * Nothing in the runtime reads these files directly; the orchestrator loads them at start and
 * applies them with applyModelSettings(). The watch writes them only inside adopt(), after an
 * approval. Writes are atomic (temp file + rename) and the documents are validated on read, so
 * a hand-edited typo fails loudly instead of changing a model by accident.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  PRICING_FILE_NAME,
  type PricingOverrides,
  parsePricingOverrides,
  pricingOverridesPath,
} from "@forerunner/billing";
import { appDirs, dirname, ForerunnerError, join } from "@forerunner/platform";
import { z } from "zod";
import type { EffortLevel, ModelTier } from "../provider/types.ts";
import {
  DEFAULT_LADDER,
  type LadderRung,
  MODE_DEFAULTS,
  type Mode,
  type ModeDefault,
} from "./ladder.ts";

export const MODEL_SETTINGS_FILE_NAME = "models.json";

export const TIER_VALUES = [
  "haiku",
  "sonnet",
  "opus",
  "fable",
] as const satisfies readonly ModelTier[];
export const EFFORT_VALUES = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly EffortLevel[];
export const MODE_VALUES = [
  "voice_chat",
  "text_chat",
  "routing",
  "planning",
  "coder",
  "researcher",
  "critic_t1",
  "critic_t23",
] as const satisfies readonly Mode[];

export const ModelSettingsChangeSchema = z
  .object({
    at: z.string(),
    report_id: z.string(),
    by: z.string().nullable(),
    changes: z.array(z.string()),
  })
  .strict();
export type ModelSettingsChange = z.infer<typeof ModelSettingsChangeSchema>;

export const ModelSettingsSchema = z
  .object({
    version: z.literal(1),
    updated_at: z.string(),
    /** tier -> provider name -> model id. Only the rungs that differ from the built-in ladder. */
    ladder: z.partialRecord(z.enum(TIER_VALUES), z.record(z.string().min(1), z.string().min(1))),
    /** mode -> effort. Only the modes that differ from the built-in table. */
    efforts: z.partialRecord(z.enum(MODE_VALUES), z.enum(EFFORT_VALUES)),
    history: z.array(ModelSettingsChangeSchema),
  })
  .strict();
export type ModelSettings = z.infer<typeof ModelSettingsSchema>;

export function emptyModelSettings(nowIso: string): ModelSettings {
  return { version: 1, updated_at: nowIso, ladder: {}, efforts: {}, history: [] };
}

/** Validate a models.json text. Throws ForerunnerError("validation") naming the file. */
export function parseModelSettings(text: string, file = MODEL_SETTINGS_FILE_NAME): ModelSettings {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new ForerunnerError("validation", `model settings are not valid JSON: ${file}`, {
      details: { file },
      cause: e,
    });
  }
  const parsed = ModelSettingsSchema.safeParse(json);
  if (!parsed.success) {
    throw new ForerunnerError("validation", `model settings are malformed: ${file}`, {
      details: {
        file,
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    });
  }
  return parsed.data;
}

export interface EffectiveModelConfig {
  ladder: LadderRung[];
  modeDefaults: Record<Mode, ModeDefault>;
}

/** The built-in ladder and effort table with the adopted overrides applied. Inputs are not mutated. */
export function applyModelSettings(
  settings: ModelSettings,
  base: EffectiveModelConfig,
): EffectiveModelConfig {
  const ladder = base.ladder.map((rung) => {
    const over = settings.ladder[rung.tier];
    return { tier: rung.tier, models: { ...rung.models, ...(over ?? {}) } };
  });
  const modeDefaults = { ...base.modeDefaults } as Record<Mode, ModeDefault>;
  for (const mode of MODE_VALUES) {
    const effort = settings.efforts[mode];
    if (effort) modeDefaults[mode] = { ...base.modeDefaults[mode], effort };
  }
  return { ladder, modeDefaults };
}

/** The built-in ladder and effort table (spec D), copied so callers can never mutate the originals. */
export function builtinModelConfig(): EffectiveModelConfig {
  return {
    ladder: DEFAULT_LADDER.map((r) => ({ tier: r.tier, models: { ...r.models } })),
    modeDefaults: { ...MODE_DEFAULTS },
  };
}

export interface ModelSettingsStore {
  readPricingOverrides(): Promise<PricingOverrides>;
  writePricingOverrides(overrides: PricingOverrides): Promise<void>;
  readModelSettings(): Promise<ModelSettings>;
  writeModelSettings(settings: ModelSettings): Promise<void>;
  /** Where the documents live, for reports and audit rows. */
  describe(): { pricing: string; models: string };
}

/** In-memory store for tests and dry runs. */
export class MemoryModelSettingsStore implements ModelSettingsStore {
  pricing: PricingOverrides = {};
  settings: ModelSettings | null = null;
  readonly writes: { pricing: number; models: number } = { pricing: 0, models: 0 };

  constructor(private readonly nowIso: () => string) {}

  async readPricingOverrides(): Promise<PricingOverrides> {
    return structuredClone(this.pricing);
  }
  async writePricingOverrides(overrides: PricingOverrides): Promise<void> {
    this.pricing = structuredClone(overrides);
    this.writes.pricing += 1;
  }
  async readModelSettings(): Promise<ModelSettings> {
    return structuredClone(this.settings ?? emptyModelSettings(this.nowIso()));
  }
  async writeModelSettings(settings: ModelSettings): Promise<void> {
    this.settings = ModelSettingsSchema.parse(settings);
    this.writes.models += 1;
  }
  describe(): { pricing: string; models: string } {
    return { pricing: `memory:${PRICING_FILE_NAME}`, models: `memory:${MODEL_SETTINGS_FILE_NAME}` };
  }
}

export interface FileModelSettingsStoreOptions {
  /** Directory of both files. Default: appDirs(env).config. */
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  nowIso: () => string;
}

/** The production store: <config>/pricing.json and <config>/models.json, written atomically. */
export class FileModelSettingsStore implements ModelSettingsStore {
  readonly pricingPath: string;
  readonly modelsPath: string;
  private readonly nowIso: () => string;

  constructor(opts: FileModelSettingsStoreOptions) {
    const dir = opts.configDir ?? appDirs({ env: opts.env }).config;
    this.pricingPath = opts.configDir
      ? join(dir, PRICING_FILE_NAME)
      : pricingOverridesPath(opts.env);
    this.modelsPath = join(dir, MODEL_SETTINGS_FILE_NAME);
    this.nowIso = opts.nowIso;
  }

  async readPricingOverrides(): Promise<PricingOverrides> {
    const text = await readOptional(this.pricingPath);
    return text === null ? {} : parsePricingOverrides(text, this.pricingPath);
  }

  async writePricingOverrides(overrides: PricingOverrides): Promise<void> {
    // Round-trip through the parser so a malformed document is never written.
    const text = `${JSON.stringify(overrides, null, 2)}\n`;
    parsePricingOverrides(text, this.pricingPath);
    await writeAtomic(this.pricingPath, text);
  }

  async readModelSettings(): Promise<ModelSettings> {
    const text = await readOptional(this.modelsPath);
    return text === null
      ? emptyModelSettings(this.nowIso())
      : parseModelSettings(text, this.modelsPath);
  }

  async writeModelSettings(settings: ModelSettings): Promise<void> {
    const text = `${JSON.stringify(ModelSettingsSchema.parse(settings), null, 2)}\n`;
    await writeAtomic(this.modelsPath, text);
  }

  describe(): { pricing: string; models: string } {
    return { pricing: this.pricingPath, models: this.modelsPath };
  }
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ForerunnerError("validation", `cannot read ${file}`, { details: { file }, cause: e });
  }
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}
