/**
 * The ladder and effort table in force for this process (spec D, ADR 0039): the built-in
 * tables with `<config>/models.json` applied at compose, replaced in place when the model
 * watch's `onAdopted` hands over the tables a human just adopted, so the next session picks
 * the adopted rung and effort without a restart. Consumers (`LoopTaskExecutor`,
 * `ConversationAgent`, the pricing closures in `compose.ts`) read through `get()` at every
 * run start, never once.
 *
 * A malformed settings document never changes a model by accident: it is ignored with one
 * `audit_log` row (`model_settings.read`, allowed=false, the file name and the parser's
 * message, never the document's content) and the built-in tables are used until the file is
 * fixed or the model watch rewrites it.
 */
import { type Clock, errorMessage, log } from "@forerunner/platform";
import type { AuditLogRepo } from "@forerunner/state";
import {
  applyModelSettings,
  builtinModelConfig,
  type EffectiveModelConfig,
  type ModelSettingsStore,
} from "../models/settings.ts";

/** Audit row of a settings document that could not be read (allowed=false) or was applied. */
export const MODEL_SETTINGS_READ_TOOL = "model_settings.read";

export class EffectiveModelConfigHolder {
  private current: EffectiveModelConfig;
  /** Where the tables came from: the settings file, the built-ins, or an adoption at runtime. */
  source: "settings" | "builtin" | "adopted";

  constructor(initial: EffectiveModelConfig, source: "settings" | "builtin") {
    this.current = initial;
    this.source = source;
  }

  get(): EffectiveModelConfig {
    return this.current;
  }

  /** Replace the tables in force (the model watch's `onAdopted`). */
  adopt(config: EffectiveModelConfig): void {
    this.current = {
      ladder: config.ladder.map((r) => ({ tier: r.tier, models: { ...r.models } })),
      modeDefaults: { ...config.modeDefaults },
    };
    this.source = "adopted";
  }
}

export interface ReadModelConfigDeps {
  settings: ModelSettingsStore;
  audit: Pick<AuditLogRepo, "append">;
  clock: Clock;
  humanId: string;
}

/**
 * Read `<config>/models.json` and apply it to the built-in tables. A document that does not
 * parse is ignored with an audit row and a warning; the built-ins are returned.
 */
export async function readEffectiveModelConfig(
  deps: ReadModelConfigDeps,
): Promise<EffectiveModelConfigHolder> {
  const file = deps.settings.describe().models;
  try {
    const settings = await deps.settings.readModelSettings();
    const config = applyModelSettings(settings, builtinModelConfig());
    const overrides = Object.keys(settings.ladder).length + Object.keys(settings.efforts).length;
    if (overrides > 0) {
      await deps.audit.append({
        tool: MODEL_SETTINGS_READ_TOOL,
        allowed: true,
        human_id: deps.humanId,
        input_summary: file,
        result_summary: `${overrides} adopted override(s) applied to the built-in ladder and effort table`,
        occurred_at: deps.clock.nowIso(),
      });
    }
    return new EffectiveModelConfigHolder(config, "settings");
  } catch (e) {
    const message = errorMessage(e);
    log("compose").warn("model settings ignored; built-in ladder and effort table in use", {
      file,
      error: message,
    });
    await deps.audit.append({
      tool: MODEL_SETTINGS_READ_TOOL,
      allowed: false,
      human_id: deps.humanId,
      input_summary: file,
      result_summary: "built-in ladder and effort table in use",
      denied_reason: `validation: ${message}`,
      occurred_at: deps.clock.nowIso(),
    });
    return new EffectiveModelConfigHolder(builtinModelConfig(), "builtin");
  }
}
