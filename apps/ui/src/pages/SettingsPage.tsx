import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { type CommandResultJson, describeError, type SettingView } from "../api/client.ts";
import { CommandResult } from "../components/ChangeCardDialog.tsx";
import { Dialog } from "../components/Dialog.tsx";
import {
  Badge,
  Button,
  EmptyState,
  ErrorBanner,
  Field,
  INPUT_CLASS,
  Loading,
  Money,
} from "../components/ui.tsx";
import { formatAmount, type MoneyLike } from "../lib/money.ts";
import { formatDuration } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { HotkeySettings } from "../shell/HotkeySettings.tsx";
import { useClient, useUiState, useUiStore } from "../store/context.tsx";
import type { ThemePreference } from "../store/store.ts";
import { DevicesSection } from "./DevicesSection.tsx";
import { ModelSettingsSection } from "./ModelSettingsSection.tsx";
import { SourcesSection } from "./SourcesSection.tsx";
import { VoiceSettingsCard } from "./VoiceSettingsCard.tsx";

type Scope = SettingView["scope"];
const SCOPES: readonly Scope[] = ["global", "human", "agent", "project"];
const SCOPE_LABELS: Record<Scope, string> = {
  global: "Global",
  human: "Per human",
  agent: "Per agent",
  project: "Per project",
};

export function groupByScope(settings: SettingView[]): Record<Scope, SettingView[]> {
  const groups: Record<Scope, SettingView[]> = { global: [], human: [], agent: [], project: [] };
  for (const s of settings) groups[s.scope].push(s);
  return groups;
}

export function isMoney(value: unknown): value is MoneyLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as MoneyLike).usdMicro === "number" &&
    typeof (value as MoneyLike).chfMicro === "number"
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (isMoney(value)) return `CHF ${formatAmount(value.chfMicro)}`;
  return JSON.stringify(value);
}

/** Keys `settings.set` accepts (mirror of `SETTING_SPECS` in `@forerunner/commands`). */
export const SETTING_KEYS = [
  "speed_quality_offset",
  "critic_ceiling",
  "session_reserve_share",
  "small_project_mode",
  "fast_mode",
  "shared_with",
  "quiet_hours",
  "notify_channel",
  "voice_alerts",
  "default_autonomy",
  "language",
  "calibration",
  "handover",
] as const;

/**
 * The speed-versus-quality slider's three positions (spec D.16): the value `settings.set`
 * writes to the project's `speed_quality_offset`, its name and what it does. The runtime reads
 * the value per run, chat or voice turn and planning session; the daemon's change card and
 * change log sentence say the same in words.
 */
export const SPEED_QUALITY_POSITIONS = [
  { value: -1, label: "speed", effect: "every mode's effort one step lower: faster and cheaper" },
  { value: 0, label: "balanced", effect: "every mode at its default effort" },
  {
    value: 1,
    label: "quality",
    effect: "every mode's effort one step higher: slower, more thorough",
  },
] as const;
export type SpeedQualityPosition = (typeof SPEED_QUALITY_POSITIONS)[number];

/** The position of a slider value; anything but -1 or +1 (unset included) is balanced, as the runtime reads it. */
export function speedQualityPosition(value: unknown): SpeedQualityPosition {
  const v = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return (
    SPEED_QUALITY_POSITIONS.find((p) => p.value === v && p.value !== 0) ??
    SPEED_QUALITY_POSITIONS[1]
  );
}

/** "quality (+1)": the position's name with the value it writes. */
export function speedQualityLabel(value: unknown): string {
  const p = speedQualityPosition(value);
  return `${p.label} (${p.value > 0 ? "+" : ""}${p.value})`;
}

const isSlider = (key: string) =>
  (key.includes(".") ? key.split(".").pop() : key) === "speed_quality_offset";

export interface SettingCommand {
  name: "autonomy.set" | "budget.set" | "settings.set" | "model.settings.set";
  /** Parameters for the typed value, or null when the value is not valid for this setting. */
  params: (value: string) => Record<string, unknown> | null;
  /** `slider`: a range over `positions` (the speed-versus-quality slider), not a typed value. */
  inputType: "number" | "text" | "slider";
  /** The named stops of a slider, lowest first. */
  positions?: readonly SpeedQualityPosition[];
  /** How the chosen value reads in words (the change log's words used); the raw value otherwise. */
  display?: (value: string) => string;
  /** A fixed set of values: the dialog shows a select instead of a free input. */
  options?: readonly { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** The current value as the input shows it. */
  initial: (current: unknown) => string;
}

const asInt = (value: string): number | null => {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
};
const asChf = (value: string): number | null => {
  const n = Number(value.replace(/'/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const parseLoose = (value: string): unknown => {
  const t = value.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  // Object settings (the monthly jobs' `calibration` and `handover`) are edited as the JSON
  // `initialPlain` shows; text that does not parse stays text and the schema answers.
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return t;
    }
  }
  return t;
};
const initialPlain = (current: unknown) =>
  isMoney(current)
    ? formatAmount(current.chfMicro).replace(/'/g, "")
    : current === null || current === undefined
      ? ""
      : typeof current === "string"
        ? current
        : JSON.stringify(current);

/**
 * The command behind a setting row (spec Q.1: nothing is UI-only). Autonomy and budgets have
 * their own commands; the keys of `SETTING_SPECS` go through `settings.set`; anything else is
 * read-only here (and in chat).
 */
export function commandForSetting(s: SettingView): SettingCommand | null {
  const key = s.key;
  const leaf = key.includes(".") ? (key.split(".").pop() ?? key) : key;
  const projectParam = s.scope === "project" && s.scopeId ? { project: s.scopeId } : {};
  if (key === "project.autonomy" || key === "autonomy.level") {
    return {
      name: "autonomy.set",
      inputType: "number",
      min: 0,
      max: 4,
      step: 1,
      initial: initialPlain,
      params: (v) => {
        const level = asInt(v);
        return level === null || level < 0 || level > 4 ? null : { level, ...projectParam };
      },
    };
  }
  if (key === "project.budget") {
    return {
      name: "budget.set",
      inputType: "number",
      min: 0,
      step: 0.5,
      unit: "CHF",
      initial: initialPlain,
      params: (v) => {
        const amountChf = asChf(v);
        return amountChf === null ? null : { scope: "project", amountChf, ...projectParam };
      },
    };
  }
  if (key === "human.monthly_cap" || key === "budget.monthly_cap_chf") {
    return {
      name: "budget.set",
      inputType: "number",
      min: 0,
      step: 1,
      unit: "CHF",
      initial: initialPlain,
      params: (v) => {
        const amountChf = asChf(v);
        return amountChf === null ? null : { scope: "month", amountChf };
      },
    };
  }
  if (leaf === "speed_quality_offset") {
    // The slider (spec D.16): three stops, -1 speed, 0 balanced, +1 quality.
    return {
      name: "settings.set",
      inputType: "slider",
      min: -1,
      max: 1,
      step: 1,
      positions: SPEED_QUALITY_POSITIONS,
      initial: (current) => String(speedQualityPosition(current).value),
      display: speedQualityLabel,
      params: (v) => {
        const value = asInt(v);
        return value === null || value < -1 || value > 1
          ? null
          : { key: leaf, value, ...projectParam };
      },
    };
  }
  if ((SETTING_KEYS as readonly string[]).includes(leaf)) {
    return {
      name: "settings.set",
      inputType: leaf === "default_autonomy" ? "number" : "text",
      ...(leaf === "default_autonomy" ? { min: 0, max: 4, step: 1 } : {}),
      initial: initialPlain,
      params: (v) =>
        v.trim() === "" ? null : { key: leaf, value: parseLoose(v), ...projectParam },
    };
  }
  return null;
}

/**
 * A setting with named stops (the speed-versus-quality slider, spec D.16): a range input over
 * the stops, the stop names under it (each one picks its stop), and what the chosen stop does.
 */
function SliderInput({
  command,
  current,
  value,
  onChange,
}: {
  command: SettingCommand;
  current: unknown;
  value: string;
  onChange: (value: string) => void;
}) {
  const positions = command.positions ?? [];
  const chosen = speedQualityPosition(value);
  return (
    <div className="space-y-1" data-testid="setting-slider">
      <Field label="Speed or quality" hint={`Current: ${speedQualityLabel(current)}`}>
        <input
          className="w-full accent-blue-600"
          type="range"
          min={command.min}
          max={command.max}
          step={command.step}
          value={value}
          aria-valuetext={chosen.label}
          onChange={(e) => onChange(e.target.value)}
          data-testid="setting-value"
        />
      </Field>
      <div className="flex justify-between text-xs" data-testid="slider-stops">
        {positions.map((p) => (
          <button
            key={p.value}
            type="button"
            className={
              p.value === chosen.value
                ? "font-semibold text-blue-700 dark:text-blue-300"
                : "text-neutral-500 hover:underline"
            }
            aria-pressed={p.value === chosen.value}
            onClick={() => onChange(String(p.value))}
            data-testid={`slider-stop-${p.label}`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <output className="block text-xs" data-testid="slider-effect">
        {chosen.label}: {chosen.effect}, from the next run, chat or voice turn and planning session.
      </output>
    </div>
  );
}

/** The change dialog every settings row uses (also the model settings section, spec D.4). */
export function SettingChangeDialog({
  setting,
  command,
  onClose,
  onChanged,
}: {
  setting: SettingView;
  command: SettingCommand;
  onClose: () => void;
  onChanged: () => void;
}) {
  const client = useClient();
  // This PC's own device row as the daemon names it on `/me` (ADR 0030): the paired device a
  // high-risk change is confirmed on. The shell's install id is not a device the daemon knows.
  const desktopDeviceId = useUiState((s) => s.me?.desktopDeviceId ?? null);
  const [value, setValue] = useState(() => command.initial(setting.value));
  const [result, setResult] = useState<CommandResultJson | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoNote, setUndoNote] = useState<string | null>(null);
  const params = command.params(value);

  const run = async (action: () => Promise<CommandResultJson>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await action());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!params) return;
    void run(() =>
      client.executeCommands({
        commands: [{ name: command.name, params }],
        wordsUsed: `Settings: ${setting.key} to ${command.display ? command.display(value) : value}`,
        // The change log names the channel: this screen is `ui`, chat and voice are theirs.
        source: "ui",
        ...(setting.scope === "project" && setting.scopeId ? { projectId: setting.scopeId } : {}),
      }),
    );
  };

  const confirm = (answer: "yes" | "no") => {
    if (result?.status !== "pending" || !result.pendingId) return;
    const pendingId = result.pendingId;
    if (answer === "no") {
      void run(() => client.confirmCommand(pendingId, { answer: "no" }));
      return;
    }
    // A tap in the app answers a medium-risk card; a high-risk card needs this paired device
    // (the desktop app is one, ADR 0030): the daemon checks the device row, not this screen.
    // Without an id (`/me` not loaded yet, or it failed) the device answer goes without one
    // and the daemon-token route answers with its own desktop row; a daemon that has no row
    // (its `/me` names none) refuses that, and the dialog shows the refusal.
    void run(() =>
      result.decision === "needs_device"
        ? client.confirmCommand(pendingId, {
            answer: "device",
            ...(desktopDeviceId ? { deviceId: desktopDeviceId } : {}),
          })
        : client.confirmCommand(pendingId, { answer: "tap" }),
    );
  };

  const finish = () => {
    onChanged();
    onClose();
  };

  return (
    <Dialog open onClose={finish} title={`Change ${setting.key}`} testId="setting-dialog">
      <div className="space-y-3 text-sm">
        <p className="text-xs text-neutral-600 dark:text-neutral-400">
          {setting.description}. Scope: {setting.scope}
          {setting.scopeId ? ` ${setting.scopeId}` : ""}. Runs the <code>{command.name}</code>{" "}
          command, the same one chat and voice use, and writes the same change log entry.
        </p>
        {result === null ? (
          <form onSubmit={submit} className="space-y-2">
            {command.inputType === "slider" ? (
              <SliderInput
                command={command}
                current={setting.value}
                value={value}
                onChange={setValue}
              />
            ) : (
              <Field
                label={`New value${command.unit ? ` (${command.unit})` : ""}`}
                hint={`Current: ${renderValue(setting.value)}`}
              >
                {command.options ? (
                  <select
                    className={INPUT_CLASS}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    data-testid="setting-value"
                  >
                    {command.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={INPUT_CLASS}
                    type={command.inputType}
                    min={command.min}
                    max={command.max}
                    step={command.step}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    data-testid="setting-value"
                  />
                )}
              </Field>
            )}
            {error ? <ErrorBanner message={error} /> : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !params}
                data-testid="setting-apply"
              >
                Preview and apply
              </Button>
              <Button variant="ghost" onClick={finish}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <CommandResult
              result={result}
              busy={busy}
              onConfirm={confirm}
              onUndo={(changeLogId) => {
                void (async () => {
                  setBusy(true);
                  try {
                    const r = await client.undoChange(changeLogId);
                    setUndoNote(
                      r.status === "done"
                        ? (r.sentence ?? "Undone.")
                        : `Undo ${r.status}: ${r.reason ?? ""}`,
                    );
                  } catch (err) {
                    setError(describeError(err));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
              onDismiss={finish}
            />
            {undoNote ? (
              <output className="block text-sm" data-testid="setting-undone">
                {undoNote}
              </output>
            ) : null}
            {error ? <ErrorBanner message={error} /> : null}
            {result.status === "done" || result.status === "partial" ? (
              <p className="text-xs text-neutral-500">
                Logged in{" "}
                <Link to="/changes" className="text-blue-700 hover:underline dark:text-blue-300">
                  Changes
                </Link>
                .
              </p>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** The per-project Opus fast mode rows (spec D.20, ADR 0057) the daemon lists as `project.fast_mode`. */
export const FAST_MODE_KEY = "project.fast_mode";

export function fastModeRows(settings: SettingView[]): SettingView[] {
  return settings.filter((s) => s.key === FAST_MODE_KEY && s.scope === "project" && s.scopeId);
}

/**
 * The command that flips a project's fast mode: `settings.set` with the other value prefilled,
 * so the dialog's change card (the daemon's, with the effect and the surcharge for that
 * direction) is one click away. The UI computes no price: the daemon's texts carry it.
 */
export function fastModeToggle(s: SettingView): SettingCommand | null {
  const command = commandForSetting(s);
  if (!command) return null;
  return { ...command, initial: (current) => (current === true ? "false" : "true") };
}

/**
 * Opus fast mode (spec D.20): what the flag does and costs, both ways, in the daemon's words
 * (the row's description, priced from the table in force), and per project its state with a
 * button that runs the same `settings.set` command chat and voice use.
 */
function FastModeCard({
  rows,
  onToggle,
}: {
  rows: SettingView[];
  onToggle: (setting: SettingView, command: SettingCommand) => void;
}) {
  const projects = useUiState((s) => s.projects);
  if (rows.length === 0) return null;
  const description = rows[0]?.description ?? "";
  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="fast-mode-card"
    >
      <h2 className="font-semibold">Opus fast mode</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        For urgent work. Off by default. Only API-key runs go fast; a subscription ignores the flag
        (API only) and every ignored run is noted in the audit log.
      </p>
      <p className="mt-1 text-sm" data-testid="fast-mode-effect">
        {description}
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {rows.map((s) => {
          const on = s.value === true;
          const name = projects.find((p) => p.id === s.scopeId)?.name ?? s.scopeId;
          const command = fastModeToggle(s);
          return (
            <li
              key={s.scopeId}
              className="flex flex-wrap items-center gap-2"
              data-testid="fast-mode-row"
              data-project={s.scopeId ?? ""}
            >
              <span className="font-medium">{name}</span>
              <Badge tone={on ? "warn" : "neutral"} testId="fast-mode-state">
                {on ? "on: Opus runs at the fast-mode rate" : "off: standard speed and rate"}
              </Badge>
              {command ? (
                <Button
                  variant="ghost"
                  onClick={() => onToggle(s, command)}
                  data-testid="fast-mode-toggle"
                >
                  {on ? "Turn off" : "Turn on"}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Settings (spec K.7, Q.1, R.2): every setting with its scope (changes run through the command
 * registry), the paired devices, the sources and the capabilities.
 */
export function SettingsPage() {
  const client = useClient();
  const store = useUiStore();
  const { theme, connection, config, me } = useUiState((s) => s);
  const settings = useAsync((signal) => client.settings(undefined, signal), [client]);
  const groups = groupByScope(settings.data ?? []);
  const [editing, setEditing] = useState<{ setting: SettingView; command: SettingCommand } | null>(
    null,
  );

  return (
    <section aria-labelledby="settings-title" className="space-y-5">
      <h1 id="settings-title" className="text-xl font-semibold">
        Settings
      </h1>

      <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h2 className="font-semibold">Appearance</h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span>Dark mode</span>
          <select
            aria-label="Theme"
            data-testid="theme-select"
            value={theme}
            onChange={(e) =>
              store.dispatch({ type: "theme", theme: e.target.value as ThemePreference })
            }
            className="rounded border border-neutral-300 bg-white px-2 py-1 dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="system">Follow the system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <Badge>scope: this device</Badge>
        </div>
      </div>

      <HotkeySettings />

      <div
        className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
        data-testid="daemon-status"
      >
        <h2 className="font-semibold">Daemon connection</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-500">Status</dt>
          <dd>
            <Badge
              tone={
                connection.status === "connected"
                  ? "good"
                  : connection.status === "connecting"
                    ? "warn"
                    : "bad"
              }
            >
              {connection.status}
            </Badge>{" "}
            {connection.error ? (
              <span className="text-red-700 dark:text-red-300">{connection.error}</span>
            ) : null}
          </dd>
          <dt className="text-neutral-500">URL</dt>
          <dd>
            <code>{config.baseUrl}</code> <Badge>from {config.source}</Badge>
          </dd>
          <dt className="text-neutral-500">Token</dt>
          <dd>{config.token ? "present (never shown)" : "none"}</dd>
          <dt className="text-neutral-500">Realtime</dt>
          <dd>{connection.streamMode}</dd>
          {connection.health ? (
            <>
              <dt className="text-neutral-500">Daemon</dt>
              <dd>
                v{connection.health.version} · {connection.health.profile} ·{" "}
                {connection.health.platform} · up {formatDuration(connection.health.uptimeMs)} ·{" "}
                <Link to="/updates" className="text-blue-700 hover:underline dark:text-blue-300">
                  updates
                </Link>
              </dd>
              <dt className="text-neutral-500">State</dt>
              <dd>
                <code>{connection.health.stateUrl}</code>
              </dd>
              <dt className="text-neutral-500">Vault</dt>
              <dd>{connection.health.vaultBackend}</dd>
              <dt className="text-neutral-500">Sessions</dt>
              <dd>
                {connection.health.activeSessions} active
                {connection.health.killActive ? " · kill switch active" : ""}
              </dd>
              <dt className="text-neutral-500">Sandbox</dt>
              <dd data-testid="sandbox-health">
                <Badge tone={connection.health.sandbox.available ? "good" : "warn"}>
                  {connection.health.sandbox.kind}
                  {connection.health.sandbox.available
                    ? ` via ${connection.health.sandbox.engine}`
                    : " stand-in"}
                </Badge>{" "}
                {connection.health.sandbox.reason}
              </dd>
              <dt className="text-neutral-500">Extensions</dt>
              <dd data-testid="extensions-health">
                {connection.health.extensions.enabled} enabled
                {connection.health.extensions.pending > 0
                  ? ` · ${connection.health.extensions.pending} waiting for your approval`
                  : ""}{" "}
                <Link to="/extensions" className="text-blue-700 hover:underline dark:text-blue-300">
                  open
                </Link>
              </dd>
            </>
          ) : null}
          {config.platform ? (
            <>
              <dt className="text-neutral-500">Shell</dt>
              <dd>
                {config.platform}
                {config.shellVersion ? ` · ${config.shellVersion}` : ""}
              </dd>
            </>
          ) : null}
          {me ? (
            <>
              <dt className="text-neutral-500">This PC</dt>
              <dd data-testid="desktop-device">
                {me.desktopDeviceId ? (
                  <>
                    paired device <code>{me.desktopDeviceId}</code>: confirms high-risk changes here
                  </>
                ) : (
                  "no device row registered by the daemon: high-risk changes cannot be confirmed on this PC (confirm on the phone with biometric)"
                )}
              </dd>
            </>
          ) : null}
        </dl>
      </div>

      <DevicesSection />

      <SourcesSection />

      <FastModeCard
        rows={fastModeRows(settings.data ?? [])}
        onToggle={(setting, command) => setEditing({ setting, command })}
      />
      <ModelSettingsSection />

      <VoiceSettingsCard />

      <div
        className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
        data-testid="capabilities-section"
      >
        <h2 className="font-semibold">Capabilities</h2>
        <ul className="mt-2 space-y-1 text-sm">
          <li>
            <Link
              to="/settings/capabilities/email"
              className="font-medium text-blue-700 hover:underline dark:text-blue-300"
              data-testid="capability-email"
            >
              Email
            </Link>
            <span className="text-neutral-600 dark:text-neutral-400">
              {" "}
              — a mailbox and a sending mode per agent, the limits that stay on, pause, the command
              audit.
            </span>
          </li>
          <li className="text-neutral-600 dark:text-neutral-400">
            The browser and desktop control are switched on in{" "}
            <Link to="/extensions" className="text-blue-700 hover:underline dark:text-blue-300">
              Extensions
            </Link>
            .
          </li>
        </ul>
      </div>

      <div>
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="font-semibold">All settings</h2>
          <span className="text-xs text-neutral-500" data-testid="edit-hint">
            Change a value here or by asking in chat or voice: every route runs the same command,
            shows the same change card and writes the same entry in{" "}
            <Link to="/changes" className="text-blue-700 hover:underline dark:text-blue-300">
              Changes
            </Link>
            .
          </span>
        </div>
        {settings.loading && !settings.data ? <Loading what="settings" /> : null}
        {settings.error ? <ErrorBanner message={settings.error} onRetry={settings.reload} /> : null}
        {settings.data && settings.data.length === 0 ? (
          <EmptyState>The daemon reports no settings.</EmptyState>
        ) : null}
        {SCOPES.map((scope) =>
          groups[scope].length === 0 ? null : (
            <div key={scope} className="mt-3" data-testid={`scope-group-${scope}`}>
              <h3 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">
                {SCOPE_LABELS[scope]}
              </h3>
              <table className="mt-1 w-full text-sm">
                <thead className="text-left text-xs text-neutral-500">
                  <tr>
                    <th className="py-1 pr-2">Scope</th>
                    <th className="py-1 pr-2">Key</th>
                    <th className="py-1 pr-2">Value</th>
                    <th className="py-1 pr-2">Risk</th>
                    <th className="py-1 pr-2">Description</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {groups[scope].map((s) => {
                    const command = commandForSetting(s);
                    return (
                      <tr
                        key={`${s.scope}:${s.scopeId ?? ""}:${s.key}`}
                        className="border-t border-neutral-100 dark:border-neutral-800"
                        data-testid="setting-row"
                        data-scope={s.scope}
                        data-key={s.key}
                      >
                        <td className="py-1 pr-2">
                          <Badge testId="setting-scope">
                            {s.scope}
                            {s.scopeId ? `: ${s.scopeId}` : ""}
                          </Badge>
                        </td>
                        <td className="py-1 pr-2 font-mono text-xs">{s.key}</td>
                        <td
                          className="py-1 pr-2 font-mono text-xs"
                          data-testid="setting-value-cell"
                        >
                          {isMoney(s.value) ? (
                            <Money value={s.value} />
                          ) : isSlider(s.key) ? (
                            speedQualityLabel(s.value)
                          ) : (
                            renderValue(s.value)
                          )}
                        </td>
                        <td className="py-1 pr-2">
                          <Badge
                            tone={
                              s.risk === "high" ? "bad" : s.risk === "medium" ? "warn" : "neutral"
                            }
                          >
                            {s.risk}
                          </Badge>
                        </td>
                        <td className="py-1 pr-2 text-neutral-600 dark:text-neutral-400">
                          {s.description}
                        </td>
                        <td className="py-1 text-right">
                          {command ? (
                            <Button
                              variant="ghost"
                              onClick={() => setEditing({ setting: s, command })}
                              data-testid="setting-change"
                            >
                              Change
                            </Button>
                          ) : (
                            <span
                              className="text-xs text-neutral-400"
                              title="No command changes this value"
                            >
                              read-only
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ),
        )}
      </div>
      {editing ? (
        <SettingChangeDialog
          setting={editing.setting}
          command={editing.command}
          onClose={() => setEditing(null)}
          onChanged={settings.reload}
        />
      ) : null}
    </section>
  );
}
