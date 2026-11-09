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
import { isAbsolute } from "@forerunner/platform";
import type { HumanRow, JsonValue, ProjectRow } from "@forerunner/state";
import type { z } from "zod";
import { parseRepoRef } from "../loop/docs.ts";
import { MERGE_MODE_SETTING, MERGE_MODE_WORDS, mergeModeOf } from "../loop/merge-mode.ts";
import { FAST_MODE_SETTING, fastModeDescription, fastModeOf } from "../models/fast-mode.ts";
import { DEFAULT_CEILING, speedQualityOffsetOf } from "../models/ladder.ts";
import { PUSH_UNFINISHED_SETTING, pushUnfinishedOf } from "../session/push-unfinished.ts";
import { WEB_ACCESS_ROW_WORDS, WEB_ACCESS_SETTING, webAccessOf } from "../wiring/web-access.ts";
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
  /**
   * This computer names a proxy for its web traffic, which the page reader does not use yet
   * ('sites'): the "Web pages research may read" row says so, as a condition (a computer that
   * names a proxy may still reach sites directly; a page read that fails says it for certain).
   */
  proxied?: boolean;
}

/** The page reader on a computer that reaches the internet only through a proxy ('sites'). */
export const PROXY_ROW_WORDS =
  "This computer names a proxy for the internet, which Forerunner's page reader does not use yet: where the internet is reached only through it, pages cannot be read here; web search still works";

/** Whether the project's first repository is one on a git host (not a folder on this PC). */
function onHostRepository(p: ProjectRow): boolean {
  const first = p.repos[0]?.trim() ?? "";
  return !isAbsolute(first) && parseRepoRef(first) !== null;
}

/** The notification channels `settings.set notify_channel` accepts, desktop when unset. */
export const NOTIFY_CHANNEL_DEFAULT = "desktop";

const prefOf = (h: HumanRow, key: string): JsonValue | null => h.notify_prefs[key] ?? null;

/**
 * A monthly job's value (the calibration, the handover test) with its run's cap in CHF beside
 * the `budget_usd` it is stored in (later #38: Settings said "up to USD 10" and asked for the
 * budget in USD). `budget_chf` is for showing and typing only; Settings sends `budget_usd`.
 */
function withRunChf(v: JsonValue | null, defaultUsd: number, rate: number): JsonValue {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, JsonValue>) : {};
  const usd = typeof o.budget_usd === "number" ? o.budget_usd : defaultUsd;
  return { ...o, budget_chf: Math.round(usd * rate * 100) / 100 };
}

/** "CHF 8.00" for an amount in USD micro-units at the day's rate. */
function chfWords(usdMicro: number, rate: number): string {
  return `CHF ${(money(usdMicro, rate).chfMicro / 1_000_000).toFixed(2)}`;
}

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
      // The card's own risk (later #99): lowering it is medium, raising it high; the row says
      // the second in words. 0 is refused (later #43): the cap is the limit enforced in code.
      description:
        "The most all your work may spend in a month; nothing runs beyond it. It cannot be 0, and raising it needs this computer's OK",
      risk: "medium",
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
      // U-078: wait (the default) or use the other one; task runs only.
      key: "human.mid_session_limit",
      label: "When my first choice runs out mid-session",
      value: prefOf(h, "mid_session_limit") === "use_other" ? "use_other" : "wait",
      description:
        "Tasks only: wait for its reset and start by themselves, or go on at once on your other Claude credential (which may cost money). Chat, planning and reviews always use the next one",
      risk: "medium",
    }),
    human({
      // U-078 (the credential chooser): my first choice anyway (the default) or the API key.
      key: "human.code_commands",
      label: "Code tasks that need commands",
      value: prefOf(h, "code_commands") === "api_key" ? "api_key" : "first_choice",
      description:
        "Your first choice anyway (on a Claude subscription they cannot run commands, so their own tests do not run), or the API key, which runs them in the sandbox and costs money",
      risk: "medium",
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
      value: withRunChf(prefOf(h, "calibration"), 10, rate),
      // CHF, never USD (later #38): the run's cap is stored in USD as `budget_usd`.
      description: `Once a month the critic is graded on the test sets: on by default, day 1 at 06:00, up to about ${chfWords(10_000_000, rate)}, grading the light review`,
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
          // later #43: 0 is no budget (the caps hook reads 0 as none).
          description: `The most ${p.name} may spend in all. 0 means no budget: only the monthly cap limits it`,
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
          description: `One milestone, a flat task list and the light review for new tasks on ${p.name}`,
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
          value: withRunChf(p.settings.handover ?? null, 5, rate),
          description: `Once a month a fresh agent makes a set change on ${p.name} from the repository and docs alone; where it gets stuck becomes a docs task. Off until you turn it on`,
          risk: "medium",
        }),
        // Opus fast mode (spec D.20, ADR 0057): the effect and the surcharge both ways, from
        // the price table in force; changed through `settings.set` like any SETTING_SPECS key.
        project({
          key: `project.${FAST_MODE_SETTING}`,
          label: "Opus fast mode",
          value: fastModeOf(p.settings),
          description: fastModeDescription(input.pricing, rate),
          risk: "medium",
        }),
        // C-57: a repository project's status as a pull request, off unless turned on.
        // Only a project on a host repository: a linked folder on this computer opens no pull
        // request, so the switch would change nothing there (C-57 review).
        // merge-in-app: who merges accepted work, only where there is a pull request to merge.
        ...(onHostRepository(p)
          ? [
              project({
                key: `project.${MERGE_MODE_SETTING}`,
                label: "Who merges accepted work",
                value: mergeModeOf(p.settings),
                description: `${MERGE_MODE_WORDS.you} (each accepted task's pull request waits for your Merge on ${p.name}'s Overview), or ${MERGE_MODE_WORDS.after_review.toLowerCase()} (Forerunner merges it once the critic accepted it)`,
                risk: "medium",
              }),
            ]
          : []),
        ...(onHostRepository(p)
          ? [
              project({
                key: "project.status_pull_request",
                label: "Status pull request",
                value: p.settings.status_pull_request === true,
                description: `Each session's status of ${p.name} as one pull request on GitHub (off: it stays in the app, under Docs, Status)`,
                risk: "low",
              }),
            ]
          : []),
        // budget-resume: a paused task's work in progress on GitHub too, off unless turned on;
        // only where a task has a branch on the host.
        ...(onHostRepository(p)
          ? [
              project({
                key: `project.${PUSH_UNFINISHED_SETTING}`,
                label: "Push unfinished work to GitHub",
                value: pushUnfinishedOf(p.settings),
                description: `A paused task's work in progress in ${p.name}, pushed to its branch on GitHub too (off: it stays on this computer until the task is done; a push starts the repository's checks and others see it)`,
                risk: "low",
              }),
            ]
          : []),
        // 'sites' (the owner's decision of 2026-11-02): what research reads on the web, the same
        // on both credentials; the value in force, the older block list included. The agent
        // browser's own site list is separate, and the row says so in one sentence.
        project({
          key: `project.${WEB_ACCESS_SETTING}`,
          label: "Web pages research may read",
          value: webAccessOf(p.settings) as unknown as JsonValue,
          // P7-28: two short sentences (it was one paragraph with "Static hosts's research"
          // and "on both credentials"); the proxy's sentence only where it applies.
          description: `${WEB_ACCESS_ROW_WORDS}${input.proxied ? `. ${PROXY_ROW_WORDS}` : ""}`,
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
