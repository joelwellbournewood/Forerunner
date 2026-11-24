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
import {
  PUBLIC_REPOSITORY_SENTENCE,
  STATUS_ISSUE_SETTING,
  statusIssuePolicy,
} from "../loop/status-board-words.ts";
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
  /**
   * Where each project's status is on GitHub now (w8-status-write): the status board's sentence,
   * and whether the repository is public (then Settings says who can read the issue).
   */
  statusIssue?: (project: ProjectRow) => { sentence: string | null; public: boolean | null } | null;
}

/**
 * The status issue row's words (w8-status-write, W8-write-7, -10): what the switch does, then
 * where the status is now in one sentence, and on a public repository who can read the issue.
 */
export function statusIssueRowWords(
  p: ProjectRow,
  now: { sentence: string | null; public: boolean | null } | null,
): string {
  const what = `The status of ${p.name} on GitHub: this Forerunner's own comment on the project's pinned status issue, with no costs (off: it stays in the app, under Docs, Status).`;
  const parts = [what];
  if (now?.sentence) parts.push(now.sentence);
  if (now?.public === true && statusIssuePolicy(p).on) parts.push(PUBLIC_REPOSITORY_SENTENCE);
  return parts.join(" ");
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
      // d1109-chat-depth (the owner's answer 2 of 2026-11-09): the CHF above which one chat answer
      // asks first; a stronger model always asks. Stored in CHF (`chat_ask_above`), CHF 0.10 unset.
      key: "human.chat_ask_above",
      label: "Chat asks first",
      value: (() => {
        const v = prefOf(h, "chat_ask_above");
        return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0.1;
      })(),
      description: "Below that it thinks longer when it helps, on the same model.",
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
    // d1109-cred-screens (CS-2): "When my first choice runs out mid-session" is gone; the one
    // choice is Settings -> Basics -> "Which Claude does the work" (credential_policy).
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
          // L4b-left-11 (design §5 rule 7): two decimals, as every money line.
          description: `The most one session on ${p.name} may spend (CHF ${Number(DEFAULT_SESSION_CAP_CHF).toFixed(2)} unless set)`,
          risk: "medium",
        }),
        project({
          key: "project.critic_ceiling",
          label: "Highest model",
          value: typeof p.settings.critic_ceiling === "string" ? p.settings.critic_ceiling : null,
          // A project's name is never made a possessive ("Kite notes's runs", L3-github-8).
          description: `The highest model the runs of ${p.name} may use: specialists, retries, planning and the critic (${DEFAULT_CEILING} unless set; fable only when set here)`,
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
          description: `Share of each session budget on ${p.name} kept for the critic's reviews. Shown for information: sessions keep 20% whatever is stored here`,
          risk: "medium",
        }),
        project({
          key: "project.handover",
          label: "Monthly handover test",
          value: withRunChf(p.settings.handover ?? null, 5, rate),
          description: `Once a month a fresh agent makes a set change on ${p.name} from the repository and docs alone; where it gets stuck becomes a docs task. Off until you turn it on`,
          risk: "medium",
        }),
        // d1109-starts-engine (S-5, ADR 0118): "When work is ready", off (Wait for my Start)
        // unless the person turns it on; through `settings.set start_by_itself`, a yes to turn on.
        project({
          key: "project.start_by_itself",
          label: "When work is ready",
          value: p.settings.start_by_itself === true,
          description: `Wait for my Start (the default), or Start a session by itself when work you made ready on ${p.name} can run; never in your quiet hours or while sessions are stopped`,
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
                description: `${MERGE_MODE_WORDS.you} (each accepted task's pull request waits for your Merge on the Overview of ${p.name}), or ${MERGE_MODE_WORDS.after_review.toLowerCase()} (Forerunner merges it once the critic accepted it)`,
                risk: "medium",
              }),
            ]
          : []),
        // w8-status-write (W8-write-10): the status issue's switch with where the status is now,
        // in one sentence, on every project on a host repository, a together one too (it writes
        // its own comment on the shared issue; amendment 1). It replaces the Status pull request.
        ...(onHostRepository(p)
          ? [
              project({
                key: `project.${STATUS_ISSUE_SETTING}`,
                label: "Status issue on GitHub",
                value: statusIssuePolicy(p).on,
                description: statusIssueRowWords(p, input.statusIssue?.(p) ?? null),
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
