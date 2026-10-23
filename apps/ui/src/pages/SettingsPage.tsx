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
import { useClient, useUiState, useUiStore } from "../store/context.tsx";
import type { ThemePreference } from "../store/store.ts";
import { SourcesSection } from "./SourcesSection.tsx";

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
  "shared_with",
  "quiet_hours",
  "notify_channel",
  "default_autonomy",
  "language",
  "calibration",
  "handover",
] as const;

export interface SettingCommand {
  name: "autonomy.set" | "budget.set" | "settings.set";
  /** Parameters for the typed value, or null when the value is not valid for this setting. */
  params: (value: string) => Record<string, unknown> | null;
  inputType: "number" | "text";
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

function SettingChangeDialog({
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
  const installId = useUiState((s) => s.config.installId);
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
        wordsUsed: `Settings: ${setting.key} to ${value}`,
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
    // (the desktop app is one, ADR 0030): the daemon checks the device, not this screen.
    void run(() =>
      result.decision === "needs_device"
        ? client.confirmCommand(pendingId, { answer: "device", deviceId: installId ?? "desktop" })
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
            <Field
              label={`New value${command.unit ? ` (${command.unit})` : ""}`}
              hint={`Current: ${renderValue(setting.value)}`}
            >
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
            </Field>
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

/** Settings (spec K.7, Q.1): every setting with its scope; changes run through the command registry. */
export function SettingsPage() {
  const client = useClient();
  const store = useUiStore();
  const { theme, connection, config } = useUiState((s) => s);
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
        </dl>
      </div>

      <SourcesSection />

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
                          {isMoney(s.value) ? <Money value={s.value} /> : renderValue(s.value)}
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
