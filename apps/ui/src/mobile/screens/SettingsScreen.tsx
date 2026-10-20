import { useState } from "react";
import { describeStateError } from "../../api/state-client.ts";
import { Badge, Button, ErrorBanner, Field, INPUT_CLASS } from "../../components/ui.tsx";
import { formatDateTime } from "../../lib/time.ts";
import { syncLabel } from "../MobileApp.tsx";
import { useMobileController, useMobileState } from "../store.tsx";

/**
 * Settings (spec R.2, R.6, R.7): device name, this device's id (for Settings → Devices on
 * the desktop), the paired human and service, sync status (live / polling / offline plus
 * queued actions), push mode (the polling stand-in until FCM is configured), quiet hours,
 * where the key and token live, and "Forget this device". Revocation itself is done from the
 * desktop (the service accepts revocations from admins only), which this screen says.
 */
export function SettingsScreen() {
  const controller = useMobileController();
  const state = useMobileState((s) => s);
  const [name, setName] = useState(state.session?.deviceName ?? "");
  const [quietFrom, setQuietFrom] = useState(state.quietHours.from ?? "");
  const [quietTo, setQuietTo] = useState(state.quietHours.to ?? "");
  const [confirmForget, setConfirmForget] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = state.session;

  const forget = async () => {
    setError(null);
    try {
      await controller.forgetDevice();
    } catch (e) {
      setError(describeStateError(e));
    }
  };

  return (
    <section aria-labelledby="m-settings-title" className="space-y-4">
      <h1 id="m-settings-title" className="text-xl font-semibold">
        Settings
      </h1>

      <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h2 className="font-semibold">Sync</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-neutral-500">Status</dt>
          <dd>
            <Badge
              tone={
                state.syncMode === "live" ? "good" : state.syncMode === "offline" ? "bad" : "warn"
              }
              testId="m-sync-status"
            >
              {syncLabel(state.syncMode, state.outboxPending)}
            </Badge>
          </dd>
          <dt className="text-neutral-500">Last heartbeat</dt>
          <dd data-testid="m-heartbeat">{formatDateTime(state.lastHeartbeatAt)}</dd>
          <dt className="text-neutral-500">Queued offline</dt>
          <dd data-testid="m-outbox">{state.outboxPending}</dd>
          <dt className="text-neutral-500">Push</dt>
          <dd data-testid="m-push-mode">
            {state.push ? `${state.push.mode} — ${state.push.detail}` : "unknown"}
          </dd>
        </dl>
        <div className="mt-3 flex gap-2">
          <Button
            variant="secondary"
            onClick={() => void controller.refresh()}
            data-testid="m-refresh"
          >
            Sync now
          </Button>
          <Button
            variant="ghost"
            onClick={() => void controller.flushOutbox()}
            disabled={state.outboxPending === 0}
          >
            Send queued
          </Button>
        </div>
      </div>

      <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h2 className="font-semibold">This device</h2>
        {session ? (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-neutral-500">Paired as</dt>
            <dd data-testid="m-human">{session.humanName ?? session.humanId}</dd>
            <dt className="text-neutral-500">Device id</dt>
            <dd className="break-all font-mono text-xs" data-testid="m-device-id">
              {session.deviceId}
            </dd>
            <dt className="text-neutral-500">Service</dt>
            <dd className="break-all" data-testid="m-service-url">
              {session.baseUrl}
            </dd>
            <dt className="text-neutral-500">Scopes</dt>
            <dd data-testid="m-scopes">{session.scopes.join(", ")}</dd>
            <dt className="text-neutral-500">Token expires</dt>
            <dd>{formatDateTime(session.expiresAt)}</dd>
            <dt className="text-neutral-500">Key and token</dt>
            <dd data-testid="m-secure-store">
              {state.secureStoreKind === "shell"
                ? "Android Keystore-wrapped store"
                : `${state.secureStoreKind} storage (insecure fallback outside the Android shell)`}
            </dd>
            <dt className="text-neutral-500">Biometrics</dt>
            <dd data-testid="m-biometric">
              {state.inShell
                ? state.biometricAvailable
                  ? "available"
                  : "not enrolled on this phone"
                : "simulated prompt (outside the Android shell)"}
            </dd>
            <dt className="text-neutral-500">Shell</dt>
            <dd>{state.inShell ? `Android ${state.shellVersion ?? ""}`.trim() : "web"}</dd>
          </dl>
        ) : null}
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            controller.setDeviceName(name);
          }}
        >
          <Field label="Device name">
            <input
              className={INPUT_CLASS}
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="m-device-name"
            />
          </Field>
          <Button type="submit" data-testid="m-device-name-save">
            Save
          </Button>
        </form>
        <p className="mt-3 text-xs text-neutral-500">
          Lost or sold this phone? Revoke it on the desktop under Settings → Devices; the next
          request from it is refused. Forgetting it here deletes the key and the token on the phone
          only.
        </p>
        {confirmForget ? (
          <div className="mt-2 flex gap-2">
            <Button variant="danger" onClick={() => void forget()} data-testid="m-forget-confirm">
              Yes, forget this device
            </Button>
            <Button variant="secondary" onClick={() => setConfirmForget(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <Button
            variant="danger"
            className="mt-2"
            onClick={() => setConfirmForget(true)}
            data-testid="m-forget"
          >
            Forget this device
          </Button>
        )}
      </div>

      <div className="rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h2 className="font-semibold">Quiet hours</h2>
        <p className="text-xs text-neutral-500">No notices between these local times.</p>
        <form
          className="mt-2 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            controller.setQuietHours({ from: quietFrom || null, to: quietTo || null });
          }}
        >
          <Field label="From (HH:MM)">
            <input
              className={INPUT_CLASS}
              value={quietFrom}
              onChange={(e) => setQuietFrom(e.target.value)}
              placeholder="22:00"
              data-testid="m-quiet-from"
            />
          </Field>
          <Field label="To (HH:MM)">
            <input
              className={INPUT_CLASS}
              value={quietTo}
              onChange={(e) => setQuietTo(e.target.value)}
              placeholder="07:00"
              data-testid="m-quiet-to"
            />
          </Field>
          <Button type="submit" data-testid="m-quiet-save">
            Save
          </Button>
        </form>
      </div>

      {error ? <ErrorBanner message={error} /> : null}
    </section>
  );
}
