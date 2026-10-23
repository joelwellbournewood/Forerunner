import { useState } from "react";
import {
  type DaemonDeviceView,
  describeError,
  isRouteMissing,
  type PairingStartView,
  type RevokeDeviceView,
} from "../api/client.ts";
import { Dialog } from "../components/Dialog.tsx";
import { QrCode } from "../components/QrCode.tsx";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Badge, Button, EmptyState, ErrorBanner, Loading } from "../components/ui.tsx";
import { formatCountdown, systemClock, type UiClock, useNow } from "../lib/clock.ts";
import { formatDateTime, relativeTime } from "../lib/time.ts";
import { useAsync } from "../lib/use-async.ts";
import { useClient } from "../store/context.tsx";

const KIND_LABELS: Record<string, string> = {
  phone: "Phone",
  web: "Web link",
  desktop: "Desktop",
};

/** "K7QX-2MPA": easier to read out and type; the phone ignores the dash. */
export function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Active devices first in the daemon's order (newest pairing first), then the revoked ones. */
export function splitDevices(devices: DaemonDeviceView[]): {
  active: DaemonDeviceView[];
  revoked: DaemonDeviceView[];
} {
  return {
    active: devices.filter((d) => !d.revoked),
    revoked: devices.filter((d) => d.revoked),
  };
}

type PairingState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "shown"; view: PairingStartView }
  | { status: "failed"; message: string; routeMissing: boolean };

function PairingPanel({
  view,
  now,
  onRestart,
  onDone,
  busy,
}: {
  view: PairingStartView;
  now: number;
  onRestart: () => void;
  onDone: () => void;
  busy: boolean;
}) {
  const expired = Date.parse(view.expiresAt) <= now;
  return (
    <div
      className="mt-3 rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="pairing-panel"
      data-expired={expired ? "true" : "false"}
    >
      {expired ? (
        <div className="space-y-2 text-sm">
          <p data-testid="pairing-expired">
            This code has expired: the service forgot it, so the phone can no longer use it.
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={onRestart}
              disabled={busy}
              data-testid="pairing-restart"
            >
              Start a new pairing
            </Button>
            <Button variant="ghost" onClick={onDone}>
              Close
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-start gap-4">
          <QrCode text={view.link} label="QR code of the pairing link" />
          <div className="min-w-0 flex-1 space-y-2 text-sm">
            <p>
              On the phone, open Forerunner and scan this code, or open the link with the camera
              app. No camera? Type the code and the service URL on the phone's pairing screen.
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-neutral-500">Code</dt>
              <dd className="font-mono text-lg tracking-widest" data-testid="pairing-code">
                {formatPairingCode(view.code)}
              </dd>
              <dt className="text-neutral-500">Service</dt>
              <dd>
                <code data-testid="pairing-service">{view.serviceUrl}</code>
              </dd>
              <dt className="text-neutral-500">Link</dt>
              <dd className="break-all">
                <code className="select-all text-xs" data-testid="pairing-link">
                  {view.link}
                </code>
              </dd>
              <dt className="text-neutral-500">Expires</dt>
              <dd>
                <span data-testid="pairing-countdown">
                  in {formatCountdown(view.expiresAt, now)}
                </span>{" "}
                <span className="text-xs text-neutral-500">
                  (at {formatDateTime(view.expiresAt)}; one use only)
                </span>
              </dd>
            </dl>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              The phone makes its own key; it shows up below once the pairing completes.
            </p>
            <Button onClick={onDone} data-testid="pairing-done">
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function RevokeDialog({
  device,
  onClose,
  onRevoked,
}: {
  device: DaemonDeviceView;
  onClose: () => void;
  onRevoked: (result: RevokeDeviceView) => void;
}) {
  const client = useClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const revoke = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onRevoked(await client.revokeDevice(device.id));
    } catch (err) {
      setMissing(isRouteMissing(err));
      setError(describeError(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`Revoke ${device.name}?`} testId="revoke-dialog">
      <div className="space-y-3 text-sm">
        <p>
          {KIND_LABELS[device.kind] ?? device.kind} · {device.platform} · paired{" "}
          {formatDateTime(device.pairedAt)}.
        </p>
        <p>
          The revocation is immediate: the device's key and session are refused from its next
          request, and anything it queued offline is not accepted. To use it again, pair it anew.
        </p>
        {missing ? (
          <RouteMissing route="revokeDevice" what="the revocation" />
        ) : error ? (
          <ErrorBanner message={error} />
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="danger"
            onClick={() => void revoke()}
            disabled={busy}
            data-testid="revoke-confirm"
          >
            {busy ? "Revoking…" : "Revoke now"}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DeviceRow({
  device,
  now,
  onRevoke,
}: {
  device: DaemonDeviceView;
  now: number;
  onRevoke?: () => void;
}) {
  return (
    <tr
      className="border-t border-neutral-100 dark:border-neutral-800"
      data-testid="device-row"
      data-device={device.id}
      data-revoked={device.revoked ? "true" : "false"}
    >
      <td className="py-1 pr-2">
        <span className="font-medium">{device.name}</span>{" "}
        {device.current ? (
          <Badge tone="info" testId="device-current">
            this device
          </Badge>
        ) : null}
      </td>
      <td className="py-1 pr-2">
        {KIND_LABELS[device.kind] ?? device.kind}
        <span className="text-xs text-neutral-500"> · {device.platform}</span>
      </td>
      <td className="py-1 pr-2" title={device.pairedAt}>
        {formatDateTime(device.pairedAt)}
      </td>
      <td className="py-1 pr-2" title={device.lastSeen ?? undefined}>
        {device.revoked
          ? `revoked ${formatDateTime(device.revokedAt)}`
          : relativeTime(device.lastSeen, now)}
      </td>
      <td className="py-1 text-right">
        {onRevoke ? (
          <Button variant="ghost" onClick={onRevoke} data-testid="device-revoke">
            Revoke
          </Button>
        ) : device.current ? (
          <span className="text-xs text-neutral-400" title="Revoke it from another device">
            the app runs here
          </span>
        ) : null}
      </td>
    </tr>
  );
}

function DeviceTable({ children }: { children: React.ReactNode }) {
  return (
    <table className="mt-1 w-full text-sm">
      <thead className="text-left text-xs text-neutral-500">
        <tr>
          <th className="py-1 pr-2">Name</th>
          <th className="py-1 pr-2">Kind</th>
          <th className="py-1 pr-2">Paired</th>
          <th className="py-1 pr-2">Last seen</th>
          <th className="py-1" />
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/**
 * Settings -> Devices (spec R.2): start a pairing (the QR of the fr:// link, the typed code
 * and its expiry), list the human's devices with this one marked, and revoke one at once.
 * Everything goes through the daemon (`GET /devices`, `POST /devices/pairing`,
 * `POST /devices/:id/revoke`), which holds the state service's admin token (ADR 0009); a
 * daemon without those routes shows the route-missing state (ADR 0037).
 */
export function DevicesSection({
  clock = systemClock,
  tickMs = 1000,
}: {
  /** Injected in tests; the countdown and "last seen" read the time through it. */
  clock?: UiClock;
  tickMs?: number;
}) {
  const client = useClient();
  const list = useAsync((signal) => client.devices(signal), [client]);
  const [pairing, setPairing] = useState<PairingState>({ status: "idle" });
  const [revoking, setRevoking] = useState<DaemonDeviceView | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const now = useNow(clock, tickMs, pairing.status === "shown");

  const start = async () => {
    setPairing({ status: "starting" });
    setNote(null);
    try {
      setPairing({ status: "shown", view: await client.startPairing({ kind: "phone" }) });
    } catch (err) {
      setPairing({
        status: "failed",
        message: describeError(err),
        routeMissing: isRouteMissing(err),
      });
    }
  };

  const closePairing = () => {
    setPairing({ status: "idle" });
    list.reload();
  };

  const { active, revoked } = splitDevices(list.data?.devices ?? []);
  const pairingAvailable = list.data?.pairingAvailable ?? true;
  const busy = pairing.status === "starting";

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="devices-section"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Devices</h2>
        {list.routeMissing ? null : (
          <div className="flex gap-2">
            <Button variant="ghost" onClick={list.reload} data-testid="devices-refresh">
              Refresh
            </Button>
            <Button
              variant="primary"
              onClick={() => void start()}
              disabled={busy || pairing.status === "shown" || !pairingAvailable}
              data-testid="pairing-start"
            >
              {busy ? "Starting…" : "Pair a phone"}
            </Button>
          </div>
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-400">
        Each phone or web session has its own key. Revoking one refuses it at once; the others keep
        working.
      </p>

      {list.data && !pairingAvailable ? (
        <p className="mt-2 text-sm text-amber-800 dark:text-amber-200" data-testid="pairing-off">
          Pairing needs the shared state service: set <code>FORERUNNER_STATE_API_URL</code> for the
          daemon and keep the service's admin token in the vault (
          <code>secret:state_api_admin</code>). The list below comes from the shared store.
        </p>
      ) : null}

      {pairing.status === "shown" ? (
        <PairingPanel
          view={pairing.view}
          now={now}
          busy={busy}
          onRestart={() => void start()}
          onDone={closePairing}
        />
      ) : null}
      {pairing.status === "failed" ? (
        <div className="mt-2" data-testid="pairing-error">
          {pairing.routeMissing ? (
            <RouteMissing route="startPairing" what="a new pairing" />
          ) : (
            <ErrorBanner message={pairing.message} onRetry={() => void start()} />
          )}
        </div>
      ) : null}

      {note ? (
        <output className="mt-2 block text-sm" data-testid="devices-note">
          {note}
        </output>
      ) : null}

      <div className="mt-3">
        {list.routeMissing ? (
          <RouteMissing route="devices" what="your paired devices" />
        ) : (
          <>
            {list.loading && !list.data ? <Loading what="devices" /> : null}
            {list.error ? <ErrorBanner message={list.error} onRetry={list.reload} /> : null}
            {list.data && active.length === 0 ? (
              <EmptyState testId="devices-empty">No device is paired yet.</EmptyState>
            ) : null}
            {active.length > 0 ? (
              <DeviceTable>
                {active.map((d) => (
                  <DeviceRow
                    key={d.id}
                    device={d}
                    now={now}
                    {...(d.current ? {} : { onRevoke: () => setRevoking(d) })}
                  />
                ))}
              </DeviceTable>
            ) : null}
            {revoked.length > 0 ? (
              <details className="mt-2 text-sm" data-testid="devices-revoked">
                <summary className="cursor-pointer text-neutral-600 dark:text-neutral-400">
                  Revoked ({revoked.length})
                </summary>
                <DeviceTable>
                  {revoked.map((d) => (
                    <DeviceRow key={d.id} device={d} now={now} />
                  ))}
                </DeviceTable>
              </details>
            ) : null}
          </>
        )}
      </div>

      {revoking ? (
        <RevokeDialog
          device={revoking}
          onClose={() => setRevoking(null)}
          onRevoked={(result) => {
            setRevoking(null);
            const tokens =
              result.tokensRevoked === null
                ? ""
                : `; ${result.tokensRevoked} session${result.tokensRevoked === 1 ? "" : "s"} ended`;
            setNote(`${result.device.name} is revoked${tokens}.`);
            // Show it among the revoked at once, then ask the daemon for the fresh list.
            list.setData((prev) =>
              prev
                ? {
                    ...prev,
                    devices: prev.devices.map((d) =>
                      d.id === result.device.id ? result.device : d,
                    ),
                  }
                : prev,
            );
            list.reload();
          }}
        />
      ) : null}
    </div>
  );
}
