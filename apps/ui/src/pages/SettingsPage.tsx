import type { SettingView } from "../api/client.ts";
import { Badge, EmptyState, ErrorBanner, Loading } from "../components/ui.tsx";
import { formatDuration } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState, useUiStore } from "../store/context.tsx";
import type { ThemePreference } from "../store/store.ts";

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

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Settings (spec K.7): every setting with its scope; read-only in phase 1. */
export function SettingsPage() {
  const client = useClient();
  const store = useUiStore();
  const { theme, connection, config } = useUiState((s) => s);
  const settings = useAsync((signal) => client.settings(undefined, signal), [client]);
  const groups = groupByScope(settings.data ?? []);

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
                {connection.health.platform} · up {formatDuration(connection.health.uptimeMs)}
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

      <div>
        <div className="flex items-baseline gap-3">
          <h2 className="font-semibold">All settings</h2>
          <span className="text-xs text-neutral-500" data-testid="edit-hint">
            Read-only here for now: change a value by asking in chat (natural-language control lands
            with phase 5).
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
                    <th className="py-1">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {groups[scope].map((s) => (
                    <tr
                      key={`${s.scope}:${s.scopeId ?? ""}:${s.key}`}
                      className="border-t border-neutral-100 dark:border-neutral-800"
                      data-testid="setting-row"
                      data-scope={s.scope}
                    >
                      <td className="py-1 pr-2">
                        <Badge testId="setting-scope">
                          {s.scope}
                          {s.scopeId ? `: ${s.scopeId}` : ""}
                        </Badge>
                      </td>
                      <td className="py-1 pr-2 font-mono text-xs">{s.key}</td>
                      <td className="py-1 pr-2 font-mono text-xs">{renderValue(s.value)}</td>
                      <td className="py-1 pr-2">
                        <Badge
                          tone={
                            s.risk === "high" ? "bad" : s.risk === "medium" ? "warn" : "neutral"
                          }
                        >
                          {s.risk}
                        </Badge>
                      </td>
                      <td className="py-1 text-neutral-600 dark:text-neutral-400">
                        {s.description}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
        )}
      </div>
    </section>
  );
}
