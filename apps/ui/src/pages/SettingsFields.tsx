import type { SettingView } from "../api/client.ts";
import { Field, INPUT_CLASS } from "../components/ui.tsx";

/**
 * Settings as a person reads and changes them (U-060): a plain label for every key, a value in
 * words instead of JSON, and a proper control per setting (time fields for quiet hours, a list
 * for the notification channel, check boxes for the model watch, labelled fields for the
 * monthly calibration and the handover test). Every control still sends the command chat and
 * voice use (`settings.set`, `budget.set`, `autonomy.set`); `SettingsPage` runs it through the
 * same change card and change log.
 */

/** One input of a structured setting. The dialog keeps the values as JSON of name -> text. */
export interface FieldSpec {
  name: string;
  label: string;
  kind: "checkbox" | "time" | "number" | "select" | "text" | "lines";
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}

export type FieldValues = Record<string, string>;

export function readFields(raw: string): FieldValues {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as FieldValues) : {};
  } catch {
    return {};
  }
}

/** The plain name of a setting key when the daemon sends none (an older daemon). */
export const SETTING_LABELS: Record<string, string> = {
  default_autonomy: "Default autonomy for new projects",
  monthly_cap: "Monthly spending cap",
  timezone: "Time zone",
  language: "Language",
  quiet_hours: "Quiet hours",
  notify_channel: "Where notifications go",
  voice_alerts: "Read urgent notifications aloud",
  calibration: "Monthly critic calibration",
  model_watch: "Model watch evaluations",
  provider: "Model provider",
  registry: "Specialist registry",
  autonomy: "Autonomy",
  budget: "Project budget",
  session_cap: "Budget per session",
  critic_ceiling: "Highest model",
  small_project_mode: "Small-project mode",
  session_reserve_share: "Review reserve",
  handover: "Monthly handover test",
  fast_mode: "Opus fast mode",
  speed_quality_offset: "Speed or quality",
};

export function leafOf(key: string): string {
  return key.includes(".") ? (key.split(".").pop() ?? key) : key;
}

/** "Quiet hours": the daemon's label, else the table's, else the key itself. */
export function settingLabel(s: Pick<SettingView, "key" | "label">): string {
  return s.label ?? SETTING_LABELS[leafOf(s.key)] ?? s.key;
}

export const AUTONOMY_OPTIONS = [
  { value: "0", label: "0 Advisor: suggests, you do" },
  { value: "1", label: "1 Assisted: asks before most actions" },
  { value: "2", label: "2 Standard" },
  { value: "3", label: "3 Trusted: asks only for risky actions" },
  { value: "4", label: "4 Autopilot" },
] as const;

export const ON_OFF = [
  { value: "true", label: "On" },
  { value: "false", label: "Off" },
] as const;

export const NOTIFY_CHANNELS = [
  { value: "desktop", label: "This computer (desktop notifications)" },
  { value: "email", label: "Email" },
  { value: "telegram", label: "Telegram" },
  { value: "signal", label: "Signal" },
  { value: "push", label: "The phone app (push)" },
] as const;

export const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
] as const;

export const MODEL_TIERS = [
  { value: "haiku", label: "haiku" },
  { value: "sonnet", label: "sonnet" },
  { value: "opus", label: "opus (the default)" },
  { value: "fable", label: "fable (the top model; costs the most)" },
] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown, fallback: string) =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : fallback;
const int = (v: string | undefined, min: number, max: number): number | null => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};
const lines = (v: string | undefined) =>
  (v ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

/** How a setting's value reads on the screen: words, never JSON. */
export function describeSetting(s: Pick<SettingView, "key" | "value">): string | null {
  const leaf = leafOf(s.key);
  const v = s.value;
  const option = (list: readonly { value: string; label: string }[]) =>
    list.find((o) => o.value === String(v))?.label ?? String(v);
  switch (leaf) {
    case "quiet_hours": {
      const q = obj(v);
      return typeof q.start === "string" && typeof q.end === "string"
        ? `from ${q.start} to ${q.end}`
        : "off";
    }
    case "voice_alerts":
    case "small_project_mode":
    case "fast_mode":
      return v === true ? "on" : "off";
    case "notify_channel":
      return option(NOTIFY_CHANNELS);
    case "language":
      return option(LANGUAGES);
    case "default_autonomy":
    case "autonomy":
      return option(AUTONOMY_OPTIONS);
    case "critic_ceiling":
      return typeof v === "string" ? v : "opus (the default)";
    case "session_reserve_share":
      return typeof v === "number" ? `${Math.round(v * 100)}% of each session` : "20% (default)";
    case "model_watch": {
      const m = obj(v);
      return `${m.run_evals === true ? "runs the paid evaluations without asking" : "asks before any paid evaluation"}; ${
        m.allow_process_sandbox === true
          ? "evaluations may run without a container"
          : "evaluations need a container"
      }`;
    }
    case "calibration": {
      const c = obj(v);
      if (c.enabled === false) return "off";
      return `on, day ${str(c.day, "1")} at ${str(c.time, "06:00")}, up to USD ${str(c.budget_usd, "10")}, review tier ${str(c.tier, "1")}`;
    }
    case "handover": {
      const h = obj(v);
      if (h.enabled !== true) return "off";
      const seed = obj(h.seed);
      return `on, day ${str(h.day, "1")} at ${str(h.time, "07:00")}${
        typeof seed.title === "string" ? `, change: ${seed.title}` : ""
      }`;
    }
    default:
      return null;
  }
}

/** The command and control behind a structured or listed setting; null for the rest. */
export interface StructuredCommand {
  name: "settings.set" | "budget.set" | "autonomy.set";
  inputType: "number" | "text" | "fields";
  options?: readonly { value: string; label: string }[];
  fields?: readonly FieldSpec[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  initial: (current: unknown) => string;
  params: (value: string) => Record<string, unknown> | null;
  display?: (value: string) => string;
}

const select = (
  key: string,
  options: readonly { value: string; label: string }[],
  parse: (v: string) => unknown,
  initial: (current: unknown) => string,
  projectParam: Record<string, string>,
): StructuredCommand => ({
  name: "settings.set",
  inputType: "text",
  options,
  initial,
  params: (v) =>
    options.some((o) => o.value === v) ? { key, value: parse(v), ...projectParam } : null,
  display: (v) => options.find((o) => o.value === v)?.label ?? v,
});

const fields = (
  specs: readonly FieldSpec[],
  initial: (current: unknown) => FieldValues,
  build: (values: FieldValues) => Record<string, unknown> | null,
  display: (values: FieldValues) => string,
): StructuredCommand => ({
  name: "settings.set",
  inputType: "fields",
  fields: specs,
  initial: (current) => JSON.stringify(initial(current)),
  params: (raw) => build(readFields(raw)),
  display: (raw) => display(readFields(raw)),
});

const MONTH_FIELDS: readonly FieldSpec[] = [
  { name: "day", label: "Day of the month", kind: "number", min: 1, max: 31, step: 1 },
  { name: "time", label: "Time (your local time)", kind: "time" },
  {
    name: "budget_usd",
    label: "Budget for the run (USD)",
    kind: "number",
    min: 1,
    max: 1000,
    step: 1,
    hint: "The run stops at this amount; it counts against your caps.",
  },
];

/** The command and control for the settings that need more than a number or free text. */
export function structuredCommand(s: SettingView): StructuredCommand | null {
  const leaf = leafOf(s.key);
  const projectParam: Record<string, string> =
    s.scope === "project" && s.scopeId ? { project: s.scopeId } : {};
  const asBool = (v: string) => v === "true";
  const boolInitial = (current: unknown) => (current === true ? "true" : "false");
  switch (leaf) {
    case "quiet_hours":
      return fields(
        [
          { name: "on", label: "Quiet hours on", kind: "checkbox" },
          { name: "start", label: "From", kind: "time" },
          { name: "end", label: "Until", kind: "time" },
        ],
        (current) => {
          const q = obj(current);
          return {
            on: typeof q.start === "string" ? "true" : "false",
            start: str(q.start, "22:00"),
            end: str(q.end, "07:00"),
          };
        },
        (v) => {
          if (v.on !== "true") return { key: "quiet_hours", value: null };
          if (!HHMM.test(v.start ?? "") || !HHMM.test(v.end ?? "")) return null;
          return { key: "quiet_hours", value: { start: v.start, end: v.end } };
        },
        (v) => (v.on === "true" ? `from ${v.start} to ${v.end}` : "off"),
      );
    case "notify_channel":
      return select(
        leaf,
        NOTIFY_CHANNELS,
        (v) => v,
        (c) => str(c, "desktop"),
        {},
      );
    case "voice_alerts":
      return select(leaf, ON_OFF, asBool, boolInitial, {});
    case "small_project_mode":
    case "fast_mode":
      return select(leaf, ON_OFF, asBool, boolInitial, projectParam);
    case "critic_ceiling":
      return select(
        leaf,
        MODEL_TIERS,
        (v) => v,
        (c) => str(c, "opus"),
        projectParam,
      );
    case "default_autonomy":
      return select(leaf, AUTONOMY_OPTIONS, Number, (c) => str(c, "2"), {});
    case "session_cap":
      return {
        name: "budget.set",
        inputType: "number",
        min: 0,
        step: 0.5,
        unit: "CHF",
        initial: (c) => {
          const m = obj(c);
          return typeof m.chfMicro === "number" ? String(m.chfMicro / 1_000_000) : "";
        },
        params: (v) => {
          const amountChf = Number(v);
          return Number.isFinite(amountChf) && amountChf > 0
            ? { scope: "session", amountChf, ...projectParam }
            : null;
        },
      };
    case "model_watch":
      return fields(
        [
          {
            name: "run_evals",
            label: "Run the paid evaluations every week without asking",
            kind: "checkbox",
            hint: "Off: the weekly check compares models and prices only and asks before any paid evaluation.",
          },
          {
            name: "allow_process_sandbox",
            label: "Let evaluation commands run without a container (weaker isolation)",
            kind: "checkbox",
            hint: "Only matters when no container engine is installed. Turning it on needs this PC's confirmation.",
          },
        ],
        (current) => {
          const m = obj(current);
          return {
            run_evals: m.run_evals === true ? "true" : "false",
            allow_process_sandbox: m.allow_process_sandbox === true ? "true" : "false",
          };
        },
        (v) => ({
          key: "model_watch",
          value: {
            run_evals: v.run_evals === "true",
            allow_process_sandbox: v.allow_process_sandbox === "true",
          },
        }),
        (v) =>
          `run evaluations without asking: ${v.run_evals === "true" ? "yes" : "no"}; without a container: ${
            v.allow_process_sandbox === "true" ? "yes" : "no"
          }`,
      );
    case "calibration":
      return fields(
        [
          { name: "enabled", label: "Grade the critic every month", kind: "checkbox" },
          ...MONTH_FIELDS,
          {
            name: "tier",
            label: "Review tier graded",
            kind: "select",
            options: [
              { value: "1", label: "1" },
              { value: "2", label: "2" },
              { value: "3", label: "3" },
            ],
          },
        ],
        (current) => {
          const c = obj(current);
          return {
            enabled: c.enabled === false ? "false" : "true",
            day: str(c.day, "1"),
            time: str(c.time, "06:00"),
            budget_usd: str(c.budget_usd, "10"),
            tier: str(c.tier, "1"),
          };
        },
        (v) => {
          const day = int(v.day, 1, 31);
          const tier = int(v.tier, 1, 3);
          const budget = Number(v.budget_usd);
          if (day === null || tier === null || !HHMM.test(v.time ?? "")) return null;
          if (!Number.isFinite(budget) || budget <= 0 || budget > 1000) return null;
          return {
            key: "calibration",
            value: { enabled: v.enabled === "true", day, time: v.time, budget_usd: budget, tier },
          };
        },
        (v) => (v.enabled === "true" ? `on, day ${v.day} at ${v.time}` : "off"),
      );
    case "handover":
      return fields(
        [
          { name: "enabled", label: "Run the handover test every month", kind: "checkbox" },
          ...MONTH_FIELDS,
          {
            name: "title",
            label: "The change a fresh agent makes (title)",
            kind: "text",
            hint: "Leave empty to keep the change already set.",
          },
          { name: "outcome", label: "What done looks like", kind: "text" },
          { name: "criteria", label: "Acceptance criteria (one per line)", kind: "lines" },
          { name: "files", label: "Files it may touch (one per line)", kind: "lines" },
          {
            name: "riskTier",
            label: "Review tier",
            kind: "select",
            options: ["0", "1", "2", "3"].map((t) => ({ value: t, label: t })),
          },
        ],
        (current) => {
          const h = obj(current);
          const seed = obj(h.seed);
          return {
            enabled: h.enabled === true ? "true" : "false",
            day: str(h.day, "1"),
            time: str(h.time, "07:00"),
            budget_usd: str(h.budget_usd, "5"),
            title: str(seed.title, ""),
            outcome: str(seed.outcome, ""),
            criteria: Array.isArray(seed.acceptanceCriteria)
              ? seed.acceptanceCriteria.join("\n")
              : "",
            files: Array.isArray(seed.files) ? seed.files.join("\n") : "",
            riskTier: str(seed.riskTier, "1"),
          };
        },
        (v) => {
          const day = int(v.day, 1, 31);
          const budget = Number(v.budget_usd);
          if (day === null || !HHMM.test(v.time ?? "")) return null;
          if (!Number.isFinite(budget) || budget <= 0 || budget > 1000) return null;
          const value: Record<string, unknown> = {
            enabled: v.enabled === "true",
            day,
            time: v.time,
            budget_usd: budget,
          };
          const title = (v.title ?? "").trim();
          if (title) {
            const criteria = lines(v.criteria);
            const files = lines(v.files);
            const riskTier = int(v.riskTier, 0, 3);
            if (!(v.outcome ?? "").trim() || criteria.length === 0 || files.length === 0)
              return null;
            if (riskTier === null) return null;
            value.seed = {
              title,
              outcome: (v.outcome ?? "").trim(),
              acceptanceCriteria: criteria,
              riskTier,
              files,
            };
          }
          return { key: "handover", value, ...projectParam };
        },
        (v) => (v.enabled === "true" ? `on, day ${v.day} at ${v.time}` : "off"),
      );
    default:
      return null;
  }
}

/** The inputs of a structured setting: labelled check boxes, times, numbers and lists. */
export function FieldsInput({
  specs,
  value,
  onChange,
}: {
  specs: readonly FieldSpec[];
  value: string;
  onChange: (value: string) => void;
}) {
  const values = readFields(value);
  const set = (name: string, v: string) => onChange(JSON.stringify({ ...values, [name]: v }));
  return (
    <div className="space-y-2" data-testid="setting-fields">
      {specs.map((f) => {
        const id = `setting-field-${f.name}`;
        if (f.kind === "checkbox") {
          return (
            <div key={f.name}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={values[f.name] === "true"}
                  onChange={(e) => set(f.name, e.target.checked ? "true" : "false")}
                  data-testid={id}
                />
                <span>{f.label}</span>
              </label>
              {f.hint ? <p className="ml-6 text-xs text-neutral-500">{f.hint}</p> : null}
            </div>
          );
        }
        return (
          <Field key={f.name} label={f.label} {...(f.hint ? { hint: f.hint } : {})}>
            {f.kind === "select" ? (
              <select
                className={INPUT_CLASS}
                value={values[f.name] ?? ""}
                onChange={(e) => set(f.name, e.target.value)}
                data-testid={id}
              >
                {(f.options ?? []).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.kind === "lines" ? (
              <textarea
                className={`${INPUT_CLASS} min-h-16`}
                value={values[f.name] ?? ""}
                onChange={(e) => set(f.name, e.target.value)}
                data-testid={id}
              />
            ) : (
              <input
                className={INPUT_CLASS}
                type={f.kind}
                min={f.min}
                max={f.max}
                step={f.step}
                value={values[f.name] ?? ""}
                onChange={(e) => set(f.name, e.target.value)}
                data-testid={id}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}
