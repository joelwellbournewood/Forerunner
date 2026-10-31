/**
 * `GET /settings` (spec K.7, Q.1; U-060): every setting a person can change, with a plain
 * label, the value in force, its scope and risk. Each row is changed by the command chat and
 * voice use (`settings.set`, `budget.set`, `autonomy.set`), so the settings screen shows the
 * same change card and writes the same change log row; none is reachable by chat alone.
 */
import {
  chfMicro,
  chfToUsdMicro,
  DEFAULT_MONTHLY_CAP_CHF,
  DEFAULT_SESSION_CAP_CHF,
  type PricingTable,
} from "@forerunner/billing";
import type { HumanRow, JsonValue, ProjectRow } from "@forerunner/state";
import type { z } from "zod";
import { FAST_MODE_SETTING, fastModeDescription, fastModeOf } from "../models/fast-mode.ts";
import { DEFAULT_CEILING, speedQualityOffsetOf } from "../models/ladder.ts";
import type { Money, SettingView } from "./api-types.ts";
import { money } from "./views.ts";

type Row = z.infer<typeof SettingView>;

export interface SettingsViewInput {
  human: HumanRow;
  projects: ProjectRow[];
  /** CHF per USD at the day's rate. */
  chfPerUsd: number;
  providerName: string | null;
  registryDir: string;
  pricing: PricingTable;
}

/** The notification channels `settings.set notify_channel` accepts, desktop when unset. */
export const NOTIFY_CHANNEL_DEFAULT = "desktop";

const prefOf = (h: HumanRow, key: string): JsonValue | null => h.notify_prefs[key] ?? null;

/**
 * A cap as its change card named it: the CHF figure `budget.set` stored beside the USD amount
 * when there is one, else the USD amount at today's rate; unset (0), the default in CHF.
 */
function capMoney(usd: unknown, chf: unknown, defaultChf: number, rate: number): Money {
  if (typeof usd === "number" && usd > 0) {
    return typeof chf === "number" ? { usdMicro: usd, chfMicro: chf } : money(usd, rate);
  }
  const fallback = chfMicro(defaultChf);
  return { usdMicro: chfToUsdMicro(fallback, rate), chfMicro: fallback };
}

export function settingsView(input: SettingsViewInput): Row[] {
  const h = input.human;
  const rate = input.chfPerUsd;
  const human = (row: Omit<Row, "scope" | "scopeId">): Row => ({
    ...row,
    scope: "human",
    scopeId: h.id,
  });
  return [
    human({
      key: "human.default_autonomy",
      label: "Default autonomy for new projects",
      value: h.default_autonomy,
      description: "Autonomy level for new projects (0 advisor to 4 autopilot)",
      risk: "medium",
    }),
    human({
      key: "human.monthly_cap",
      label: "Monthly spending cap",
      // The cap in force: the default ceiling (CHF 150) when none was set.
      value: capMoney(
        h.monthly_cap_usd_micro,
        prefOf(h, "monthly_cap_chf_micro"),
        DEFAULT_MONTHLY_CAP_CHF,
        rate,
      ),
      description: "Hard monthly spend cap",
      risk: "high",
    }),
    human({
      key: "human.timezone",
      label: "Time zone",
      value: h.timezone,
      description: "Time zone for schedules and quiet hours",
      risk: "low",
    }),
    human({
      key: "human.language",
      label: "Language",
      value: h.locale || "en",
      // Stored (`settings.set language`), but nothing reads it yet: information only.
      description:
        "The app and your agent work in English in this version; the stored choice changes nothing yet",
      risk: "low",
    }),
    human({
      key: "human.quiet_hours",
      label: "Quiet hours",
      value: prefOf(h, "quiet_hours"),
      description:
        "No notifications and no sessions that start on their own between these times (your local time); off when unset",
      risk: "low",
    }),
    human({
      key: "human.notify_channel",
      label: "Where notifications go",
      value: prefOf(h, "notify_channel") ?? NOTIFY_CHANNEL_DEFAULT,
      description: "The channel your notifications use first (desktop when unset)",
      risk: "low",
    }),
    human({
      key: "human.voice_alerts",
      label: "Read urgent notifications aloud",
      value: prefOf(h, "voice_alerts") === true,
      description:
        "Speak urgent notifications through the voice provider while the app is open, outside quiet hours",
      risk: "low",
    }),
    human({
      key: "human.calibration",
      label: "Monthly critic calibration",
      value: prefOf(h, "calibration"),
      description:
        "Monthly critic calibration over the golden eval sets: enabled, day, time, budget_usd, tier (defaults: on, day 1, 06:00, USD 10, tier 1)",
      risk: "medium",
    }),
    human({
      key: "human.model_watch",
      label: "Model watch evaluations",
      value: prefOf(h, "model_watch") ?? { run_evals: false, allow_process_sandbox: false },
      description:
        "Whether the weekly model watch runs its paid eval sets without asking, and whether eval commands may run without a container",
      risk: "medium",
    }),
    {
      key: "runtime.provider",
      label: "Model provider",
      scope: "global",
      scopeId: null,
      value: input.providerName ?? "none",
      description: "Model provider in use",
      risk: "low",
    },
    {
      key: "runtime.registry",
      label: "Specialist registry",
      scope: "global",
      scopeId: null,
      value: input.registryDir,
      description: "Specialist registry directory",
      risk: "low",
    },
    ...input.projects.flatMap((p): Row[] => {
      const project = (row: Omit<Row, "scope" | "scopeId">): Row => ({
        ...row,
        scope: "project",
        scopeId: p.id,
      });
      return [
        project({
          key: "project.autonomy",
          label: "Autonomy",
          value: p.autonomy_level,
          description: `Autonomy for ${p.name}`,
          risk: "medium",
        }),
        project({
          key: "project.budget",
          label: "Project budget",
          value: money(p.budget_usd_micro, rate),
          description: `Budget for ${p.name}`,
          risk: "medium",
        }),
        project({
          key: "project.session_cap",
          label: "Budget per session",
          value: capMoney(
            p.settings.session_cap_usd_micro,
            p.settings.session_cap_chf_micro,
            DEFAULT_SESSION_CAP_CHF,
            rate,
          ),
          description: `The most one session on ${p.name} may spend (CHF ${DEFAULT_SESSION_CAP_CHF} unless set)`,
          risk: "medium",
        }),
        project({
          key: "project.critic_ceiling",
          label: "Highest model",
          value: typeof p.settings.critic_ceiling === "string" ? p.settings.critic_ceiling : null,
          description: `The highest model ${p.name}'s runs may use: specialists, retries, planning and the critic (${DEFAULT_CEILING} unless set; fable only when set here)`,
          risk: "medium",
        }),
        project({
          key: "project.small_project_mode",
          label: "Small-project mode",
          value: p.small_project_mode === true,
          description: `One milestone, a flat task list and critic tier 0 for new tasks on ${p.name}`,
          risk: "low",
        }),
        project({
          key: "project.session_reserve_share",
          label: "Review reserve",
          value:
            typeof p.settings.session_reserve_share === "number"
              ? p.settings.session_reserve_share
              : null,
          // Stored by `settings.set`, but sessions keep their fixed 20% today: information only.
          description: `Share of each session budget on ${p.name} kept for review and fixes. Shown for information: sessions keep 20% whatever is stored here`,
          risk: "medium",
        }),
        project({
          key: "project.handover",
          label: "Monthly handover test",
          value: p.settings.handover ?? null,
          description: `Monthly handover test on ${p.name}: enabled, day, time, budget_usd, seed (off until enabled)`,
          risk: "medium",
        }),
        // Opus fast mode (spec D.20, ADR 0057): the effect and the surcharge both ways, from
        // the price table in force; changed through `settings.set` like any SETTING_SPECS key.
        project({
          key: `project.${FAST_MODE_SETTING}`,
          label: "Opus fast mode",
          value: fastModeOf(p.settings),
          description: fastModeDescription(input.pricing),
          risk: "medium",
        }),
        // The slider (spec D.16): -1 speed, 0 balanced, +1 quality, as every mode reads it.
        project({
          key: "project.speed_quality_offset",
          label: "Speed or quality",
          value: speedQualityOffsetOf(p.settings),
          description: `Speed versus quality for ${p.name}: every mode's effort one step down or up`,
          risk: "low",
        }),
      ];
    }),
  ];
}
