import { type FormEvent, useEffect, useState } from "react";
import { Badge, Button, ErrorBanner, Field, INPUT_CLASS } from "../components/ui.tsx";
import { useUiState } from "../store/context.tsx";
import {
  DEFAULT_CHORD,
  formatChord,
  type HotkeyStatus,
  parseChord,
  useHotkeyBridge,
} from "./hotkey.ts";

/**
 * Settings → Global hotkey (spec O.1, ADR 0064). Shows the chord the desktop shell holds,
 * whether the OS registered it and why not, and changes it: the input is validated with the
 * shell's grammar before anything is sent, and the shell validates again before it registers.
 * Outside the desktop shell (a browser, the approvals page, the Android app) it says
 * "unavailable" and why. This is a per-install preference kept by the shell, not a daemon
 * setting, so it is not in the command registry's list below.
 */
export function HotkeySettings() {
  const bridge = useHotkeyBridge();
  const platform = useUiState((s) => s.config.platform);
  const [status, setStatus] = useState<HotkeyStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge.available) return;
    let active = true;
    const apply = (s: HotkeyStatus) => {
      if (!active) return;
      setStatus(s);
    };
    bridge.status().then(
      (s) => {
        apply(s);
        if (active) setValue(s.chord);
      },
      (e: unknown) => {
        if (active) setLoadError(e instanceof Error ? e.message : String(e));
      },
    );
    const off = bridge.onChanged(apply);
    return () => {
      active = false;
      off();
    };
  }, [bridge]);

  const parsed = parseChord(value);

  const apply = async (chord: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await bridge.set(chord);
      setStatus(next);
      setValue(next.chord);
      setSaved(`Saved: ${formatChord(next.chord, platform)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (parsed.ok) void apply(parsed.canonical);
  };

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="hotkey-settings"
    >
      <h2 className="font-semibold">Global hotkey</h2>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        Press it anywhere to bring up Forerunner and start talking to your agent (push-to-talk:
        press again to send). Without voice it opens the conversation for typing.
      </p>
      {!bridge.available ? (
        <p className="mt-2 text-sm" data-testid="hotkey-unavailable">
          <Badge tone="neutral">unavailable</Badge> {bridge.unavailableReason}
        </p>
      ) : (
        <div className="mt-2 space-y-2 text-sm">
          {loadError ? <ErrorBanner message={loadError} /> : null}
          {status ? (
            <p data-testid="hotkey-current">
              Current: <kbd className="font-mono">{formatChord(status.chord, platform)}</kbd>{" "}
              <Badge tone={status.registered ? "good" : "warn"} testId="hotkey-registered">
                {status.registered ? "active" : "not registered"}
              </Badge>
              {status.error ? (
                <span
                  className="ml-1 text-amber-800 dark:text-amber-300"
                  data-testid="hotkey-error"
                >
                  {status.error}
                </span>
              ) : null}
            </p>
          ) : null}
          <form onSubmit={submit} className="space-y-2">
            <Field
              label="New shortcut"
              hint={`For example ${DEFAULT_CHORD} (the default), Ctrl+Alt+T or F9`}
            >
              <input
                className={INPUT_CLASS}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setSaved(null);
                  setError(null);
                }}
                aria-label="Global hotkey"
                data-testid="hotkey-input"
              />
            </Field>
            {value.trim() !== "" && !parsed.ok ? (
              <output
                className="block text-xs text-red-700 dark:text-red-300"
                data-testid="hotkey-invalid"
              >
                {parsed.message}
              </output>
            ) : null}
            {parsed.ok && parsed.canonical !== status?.chord ? (
              <output
                className="block text-xs text-neutral-600 dark:text-neutral-400"
                data-testid="hotkey-preview"
              >
                Will register {formatChord(parsed.canonical, platform)}
              </output>
            ) : null}
            {error ? <ErrorBanner message={error} /> : null}
            {saved ? (
              <output className="block text-xs" data-testid="hotkey-saved">
                {saved}
              </output>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !parsed.ok}
                data-testid="hotkey-apply"
              >
                Save shortcut
              </Button>
              <Button
                variant="ghost"
                disabled={busy || (status?.chord === DEFAULT_CHORD && status.registered)}
                onClick={() => void apply(DEFAULT_CHORD)}
                data-testid="hotkey-reset"
              >
                Reset to default
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
