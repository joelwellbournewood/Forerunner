import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { describeStateError } from "../../api/state-client.ts";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../../components/ui.tsx";
import { isPairingCode, normalizePairingCode } from "../pairing.ts";
import { useMobileController, useMobileState } from "../store.tsx";

/**
 * Pairing (spec R.2): the desktop shows a one-time code as a QR with the service URL. Scan
 * it (barcode plugin, when the shell has one) or type the code and the URL; the phone makes
 * its key, proves it and gets a scoped session token. Code entry always works.
 */
export function PairingScreen() {
  const controller = useMobileController();
  const navigate = useNavigate();
  const pending = useMobileState((s) => s.pendingPairing);
  const stage = useMobileState((s) => s.stage);
  const queued = useMobileState((s) => s.outboxPending);
  const [serviceUrl, setServiceUrl] = useState(controller.env.defaultStateUrl ?? "");
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(controller.env.defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    setCode(pending.code);
    if (pending.serviceUrl) setServiceUrl(pending.serviceUrl);
  }, [pending]);

  useEffect(() => {
    if (stage === "paired") navigate("/", { replace: true });
  }, [stage, navigate]);

  const submit = async () => {
    if (busy) return;
    setError(null);
    const normalized = normalizePairingCode(code);
    if (!isPairingCode(normalized)) {
      setError("Enter the pairing code shown on the desktop (8 characters).");
      return;
    }
    if (!/^https?:\/\//i.test(serviceUrl.trim())) {
      setError("Enter the state service URL (https://…) shown with the code.");
      return;
    }
    setBusy(true);
    try {
      await controller.pair({ serviceUrl, code: normalized, deviceName: deviceName || "phone" });
      navigate("/", { replace: true });
    } catch (e) {
      setError(describeStateError(e));
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    setError(null);
    const payload = await controller.scanPairing();
    if (!payload) setError("No pairing code found in the scan.");
  };

  return (
    <section aria-labelledby="m-pair-title" className="space-y-3">
      <h1 id="m-pair-title" className="text-xl font-semibold">
        Pair this phone
      </h1>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        On the desktop open Settings → Devices → Add a phone. Scan the QR code, or type the code and
        the service address it shows. This phone gets its own key; revoke it from the desktop at any
        time.
      </p>
      {queued > 0 ? (
        <p
          className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          data-testid="m-pair-queued"
        >
          {queued} queued action{queued === 1 ? "" : "s"} from before will be sent once this phone
          is paired again.
        </p>
      ) : null}
      {controller.env.scan ? (
        <Button variant="secondary" onClick={() => void scan()} data-testid="m-pair-scan">
          Scan QR code
        </Button>
      ) : (
        <p className="text-xs text-neutral-500" data-testid="m-pair-no-scanner">
          No camera scanner in this build; type the code.
        </p>
      )}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="State service URL">
          <input
            className={INPUT_CLASS}
            value={serviceUrl}
            onChange={(e) => setServiceUrl(e.target.value)}
            placeholder="https://state.example.test"
            inputMode="url"
            autoCapitalize="none"
            data-testid="m-pair-url"
          />
        </Field>
        <Field label="Pairing code" hint="8 characters, valid for ten minutes">
          <input
            className={`${INPUT_CLASS} font-mono uppercase tracking-widest`}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="ABCD2345"
            autoCapitalize="characters"
            autoComplete="one-time-code"
            data-testid="m-pair-code"
          />
        </Field>
        <Field label="Device name">
          <input
            className={INPUT_CLASS}
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            data-testid="m-pair-name"
          />
        </Field>
        <Button type="submit" variant="primary" disabled={busy} data-testid="m-pair-submit">
          {busy ? "Pairing…" : "Pair"}
        </Button>
      </form>
      {error ? <ErrorBanner message={error} testId="m-pair-error" /> : null}
    </section>
  );
}
