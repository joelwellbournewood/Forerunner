import { useState } from "react";
import type { ModelSettingsView, SettingView } from "../api/client.ts";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Badge, ErrorBanner, Loading } from "../components/ui.tsx";
import { useAsync } from "../lib/use-async.ts";
import { useClient } from "../store/context.tsx";
import { SettingChangeDialog, type SettingCommand } from "./SettingsPage.tsx";

/**
 * Settings → Models (spec D.4, ADR 0072): per agent mode and per specialist the model, effort,
 * max tokens, speed mode and timeout in force, each with the default it falls back to (the
 * effort table or the specialist's registry file). Temperature has a column only when the
 * provider in use says it accepts one. A change runs `model.settings.set` through the same
 * dialog, change card and change log as every other setting.
 */

export type RunSettings = ModelSettingsView["specialists"][number]["settings"];
export type SettingValue = RunSettings["tier"];
export type ModelSettingField =
  | "tier"
  | "effort"
  | "max_tokens"
  | "speed_mode"
  | "timeout_minutes"
  | "temperature";

interface Column {
  field: ModelSettingField;
  key: "tier" | "effort" | "maxTokens" | "speedMode" | "timeoutMinutes" | "temperature";
  label: string;
}

export const MODEL_SETTING_COLUMNS: readonly Column[] = [
  { field: "tier", key: "tier", label: "Model" },
  { field: "effort", key: "effort", label: "Effort" },
  { field: "max_tokens", key: "maxTokens", label: "Max tokens" },
  { field: "speed_mode", key: "speedMode", label: "Speed mode" },
  { field: "timeout_minutes", key: "timeoutMinutes", label: "Timeout (min)" },
  { field: "temperature", key: "temperature", label: "Temperature" },
];

/** The columns this provider gets: temperature only where it is accepted (spec D.4). */
export function columnsFor(view: Pick<ModelSettingsView, "provider">): readonly Column[] {
  return MODEL_SETTING_COLUMNS.filter(
    (c) => c.field !== "temperature" || view.provider.acceptsTemperature,
  );
}

const OPTIONS: Partial<Record<ModelSettingField, readonly string[]>> = {
  tier: ["haiku", "sonnet", "opus", "fable"],
  effort: ["low", "medium", "high", "xhigh", "max"],
  speed_mode: ["standard", "fast"],
};

const NUMBER_RULES: Partial<
  Record<ModelSettingField, { min: number; max: number; integer: boolean }>
> = {
  max_tokens: { min: 1, max: 128_000, integer: true },
  timeout_minutes: { min: 1, max: 1440, integer: true },
  temperature: { min: 0, max: 1, integer: false },
};

const MODE_LABELS: Record<string, string> = {
  planning: "planning",
  text_chat: "chat",
  critic_t1: "review tier 1",
  critic_t23: "review tiers 2 and 3",
};

const SOURCE_LABELS: Record<SettingValue["defaultSource"], string> = {
  table: "effort table",
  specialist: "registry file",
};

export interface ModelSettingTarget {
  agent: string;
  mode?: string;
  specialist?: string;
  /** "Alice · planning" or "coder": for the dialog title and description. */
  subject: string;
}

const show = (v: string | number | null) => (v === null ? "none" : String(v));

/**
 * The dialog input for one field of one target: `model.settings.set` with the target, the field
 * and the typed value; "default" removes the override (value null).
 */
export function modelSettingCommand(
  target: ModelSettingTarget,
  field: ModelSettingField,
  current: SettingValue,
): { setting: SettingView; command: SettingCommand } {
  const where = {
    agent: target.agent,
    ...(target.mode !== undefined ? { mode: target.mode } : {}),
    ...(target.specialist !== undefined ? { specialist: target.specialist } : {}),
  };
  const options = OPTIONS[field];
  const rule = NUMBER_RULES[field];
  const defaultLabel = `default (${show(current.default)}, ${SOURCE_LABELS[current.defaultSource]})`;
  const command: SettingCommand = {
    name: "model.settings.set",
    inputType: "text",
    ...(options
      ? {
          options: [
            { value: "default", label: defaultLabel },
            ...options.map((o) => ({ value: o, label: o })),
          ],
        }
      : {}),
    initial: () =>
      current.source === "agent" && current.value !== null ? String(current.value) : "default",
    params: (raw) => {
      const v = raw.trim();
      if (v === "") return null;
      if (v === "default") return { ...where, field, value: null };
      if (options) return options.includes(v) ? { ...where, field, value: v } : null;
      if (rule) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < rule.min || n > rule.max) return null;
        if (rule.integer && !Number.isInteger(n)) return null;
        return { ...where, field, value: n };
      }
      return null;
    },
  };
  const label = MODEL_SETTING_COLUMNS.find((c) => c.field === field)?.label ?? field;
  const setting: SettingView = {
    key: `${target.specialist ? `specialist.${target.specialist}` : `agent.${target.mode}`}.${field}`,
    scope: "agent",
    scopeId: target.agent,
    value: current.value,
    description: `${label} for ${target.subject}; ${defaultLabel}${
      rule ? `; a number from ${rule.min} to ${rule.max}, or "default"` : ""
    }`,
    risk: field === "tier" || field === "effort" || field === "speed_mode" ? "medium" : "low",
  };
  return { setting, command };
}

function ValueCell({
  value,
  extra,
  onEdit,
  testId,
}: {
  value: SettingValue;
  extra?: string | null;
  onEdit: (() => void) | null;
  testId: string;
}) {
  const own = value.source === "agent";
  const body = (
    <>
      <span className="font-mono text-xs">{show(value.value)}</span>
      {extra ? <span className="text-xs text-neutral-500"> {extra}</span> : null}{" "}
      {own ? (
        <Badge
          tone="info"
          title={`default ${show(value.default)} from the ${SOURCE_LABELS[value.defaultSource]}`}
        >
          set
        </Badge>
      ) : (
        <span className="text-xs text-neutral-500" data-testid="model-setting-default">
          {value.source === "specialist" ? "registry file" : "effort table"}
        </span>
      )}
    </>
  );
  return (
    <td className="py-1 pr-2" data-testid={testId} data-source={value.source}>
      {onEdit ? (
        <button
          type="button"
          className="text-left hover:underline"
          onClick={onEdit}
          data-testid="model-setting-change"
        >
          {body}
        </button>
      ) : (
        body
      )}
    </td>
  );
}

interface Row {
  kind: "agent" | "specialist";
  label: string;
  note: string | null;
  settings: RunSettings;
  target: ModelSettingTarget | null;
  mode: string;
  name: string;
}

export function rowsOf(view: ModelSettingsView): Row[] {
  const rows: Row[] = [];
  for (const a of view.agents)
    for (const m of a.modes)
      rows.push({
        kind: "agent",
        label: `${a.name} · ${MODE_LABELS[m.mode] ?? m.mode}`,
        note: a.note,
        settings: m,
        name: a.name,
        mode: m.mode,
        target: a.editable
          ? { agent: a.id, mode: m.mode, subject: `${a.name} · ${MODE_LABELS[m.mode] ?? m.mode}` }
          : null,
      });
  for (const s of view.specialists)
    rows.push({
      kind: "specialist",
      label: s.name,
      note: null,
      settings: s.settings,
      name: s.name,
      mode: s.settings.mode,
      target: {
        agent: s.overridesAgentId,
        specialist: s.name,
        subject: `the ${s.name} specialist`,
      },
    });
  return rows;
}

export function ModelSettingsSection() {
  const client = useClient();
  const view = useAsync((signal) => client.modelSettings(signal), [client]);
  const [editing, setEditing] = useState<{
    setting: SettingView;
    command: SettingCommand;
  } | null>(null);
  const data = view.data;
  const columns = data ? columnsFor(data) : [];

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="model-settings"
    >
      <h2 className="font-semibold">Models per agent and specialist</h2>
      {view.routeMissing ? (
        <RouteMissing route="modelSettings" what="the model settings per agent and specialist" />
      ) : null}
      {view.loading && !data ? <Loading what="model settings" /> : null}
      {view.error && !view.routeMissing ? (
        <ErrorBanner message={view.error} onRetry={view.reload} />
      ) : null}
      {data ? (
        <>
          <p
            className="mt-1 text-xs text-neutral-600 dark:text-neutral-400"
            data-testid="model-provider"
          >
            Provider {data.provider.name ?? "none"} ·{" "}
            {data.provider.acceptsTemperature
              ? "accepts a temperature"
              : "takes no temperature (none is sent, none is shown)"}{" "}
            · fast mode {data.provider.fastMode ? "available" : "not available"}. Defaults come from
            the effort table or the specialist's registry file; a fast speed mode applies only where
            the project allows fast mode.
          </p>
          {data.configError ? (
            <ErrorBanner
              message={`The agent's model settings are malformed and ignored: ${data.configError}`}
            />
          ) : null}
          <table className="mt-2 w-full text-sm">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-1 pr-2">Agent or specialist</th>
                {columns.map((c) => (
                  <th
                    key={c.field}
                    className="py-1 pr-2"
                    data-testid={`model-settings-col-${c.field}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowsOf(data).map((r) => (
                <tr
                  key={`${r.kind}:${r.label}`}
                  className="border-t border-neutral-100 dark:border-neutral-800"
                  data-testid="model-settings-row"
                  data-kind={r.kind}
                  data-name={r.name}
                  data-mode={r.mode}
                >
                  <td className="py-1 pr-2">
                    {r.label}
                    {r.note ? (
                      <span
                        className="block text-xs text-neutral-500"
                        data-testid="model-settings-note"
                      >
                        {r.note}
                      </span>
                    ) : null}
                  </td>
                  {columns.map((c) => {
                    const value = r.settings[c.key];
                    if (!value) return <td key={c.field} />;
                    const target = r.target;
                    return (
                      <ValueCell
                        key={c.field}
                        testId={`model-setting-${c.field}`}
                        value={value}
                        extra={
                          c.field === "tier" && r.settings.model ? `(${r.settings.model})` : null
                        }
                        onEdit={
                          target
                            ? () => setEditing(modelSettingCommand(target, c.field, value))
                            : null
                        }
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      {editing ? (
        <SettingChangeDialog
          setting={editing.setting}
          command={editing.command}
          onClose={() => setEditing(null)}
          onChanged={view.reload}
        />
      ) : null}
    </div>
  );
}
