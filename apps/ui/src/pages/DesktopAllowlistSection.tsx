import { DESKTOP_ALLOWLIST_CONTROL } from "@forerunner/runtime/daemon/api-types";
import { type FormEvent, useState } from "react";
import { type DesktopAllowEntryView, describeError } from "../api/client.ts";
import { Button, ErrorBanner, Field, INPUT_CLASS, Loading } from "../components/ui.tsx";
import { useAsync } from "../lib/use-async.ts";
import { useClient, useUiState } from "../store/context.tsx";

/** How an allowlist entry reads: its application name, executable or window class. */
export function allowEntryLabel(entry: DesktopAllowEntryView): string {
  if (typeof entry === "string") return entry;
  const name = entry.app ?? entry.exe ?? entry.windowClass ?? "?";
  return entry.note ? `${name} (${entry.note})` : name;
}

/**
 * Settings → Desktop control (U-060): the applications your agent may control when desktop
 * control is on, the list the approval card points to ("add it to the desktop allowlist in
 * Settings"). An application not on it needs your yes, for one session at a time. Saving sends
 * the whole list to `PUT /desktop/allowlist/:humanId`; the daemon audits the change.
 */
export function DesktopAllowlistSection() {
  const client = useClient();
  const humanId = useUiState((s) => s.me?.id ?? null);
  const list = useAsync(
    (signal) =>
      humanId
        ? client.desktopAllowlist(humanId, signal)
        : Promise.resolve({ humanId: "", entries: [] }),
    [client, humanId],
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const entries = list.data?.entries ?? [];

  const save = async (next: DesktopAllowEntryView[], said: string) => {
    if (!humanId || busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const r = await client.setDesktopAllowlist(humanId, next);
      list.setData(() => r);
      setSaved(said);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    const app = name.trim();
    if (!app) return;
    if (entries.some((x) => allowEntryLabel(x).toLowerCase() === app.toLowerCase())) {
      setError(`${app} is already on the list.`);
      return;
    }
    setName("");
    void save(
      [...entries, app],
      `Added ${app}: your agent may control it when desktop control is on.`,
    );
  };

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="desktop-allowlist"
    >
      <h2 className="font-semibold">{DESKTOP_ALLOWLIST_CONTROL}</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        The applications your agent may use when desktop control is on (Extensions). Any other
        application needs your yes in the Inbox, for one session at a time. Name an application by
        its program (for example <code>code</code> or <code>firefox</code>) or its window class.
      </p>
      {list.loading && !list.data ? <Loading what="the desktop allowlist" /> : null}
      {list.error && !list.data ? <ErrorBanner message={list.error} onRetry={list.reload} /> : null}
      {list.data ? (
        <ul className="mt-2 space-y-1 text-sm" data-testid="desktop-allowlist-entries">
          {entries.length === 0 ? <li className="text-neutral-500">No application yet.</li> : null}
          {entries.map((entry, i) => {
            const label = allowEntryLabel(entry);
            return (
              <li
                key={typeof entry === "string" ? entry : JSON.stringify(entry)}
                className="flex items-center gap-2"
                data-testid="desktop-allowlist-entry"
              >
                <span className="font-mono text-xs">{label}</span>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void save(
                      entries.filter((_, j) => j !== i),
                      `Removed ${label}: your agent asks before it uses it.`,
                    )
                  }
                  data-testid="desktop-allowlist-remove"
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <form onSubmit={add} className="mt-2 flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <Field label="Allow an application">
            <input
              className={INPUT_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="code"
              data-testid="desktop-allowlist-name"
            />
          </Field>
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={busy || !humanId || !name.trim()}
          data-testid="desktop-allowlist-add"
        >
          Add
        </Button>
      </form>
      {saved ? (
        <output className="mt-1 block text-sm" data-testid="desktop-allowlist-saved">
          {saved}
        </output>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
    </div>
  );
}
