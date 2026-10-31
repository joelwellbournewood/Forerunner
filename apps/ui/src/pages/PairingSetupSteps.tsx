import type { PairingSetupView } from "@forerunner/runtime/daemon/api-types";
import { ExternalLink } from "../components/ExternalLink.tsx";
import { SecretValueField } from "../components/SecretValueField.tsx";

/** The name the app's secret box may store the admin token under (U-054's allowlist). */
const STORABLE_ADMIN_SECRET = "state_api_admin";

/**
 * Settings -> Devices while a phone cannot be paired yet (U-055): what to set up first, in
 * plain steps. 1.0.4 named two environment variables and a vault reference with no word on
 * what they are. Pairing goes through Forerunner's shared state service, a server of the
 * person's own that the phone and this PC both reach; the app cannot run it for them. The steps
 * show only what is still missing, and the admin token is pasted right here.
 */
export function PairingSetupSteps({
  setup,
  onSaved,
}: {
  /** What the daemon says is missing; absent from an older daemon (the general steps show). */
  setup: PairingSetupView | undefined;
  onSaved: () => void;
}) {
  const serviceUrl = setup?.serviceUrl ?? null;
  const secretName = setup?.adminSecretName ?? STORABLE_ADMIN_SECRET;
  return (
    <div
      className="mt-2 space-y-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
      data-testid="pairing-off"
    >
      <p>
        To pair a phone, Forerunner needs its <strong>shared state service</strong> first: a small
        server of yours that this PC and your phone both reach over the internet. It is not part of
        the app. Until it is set up, the list below shows this PC's own record.
      </p>
      <ol className="list-decimal space-y-2 pl-5">
        {serviceUrl === null ? (
          <>
            <li data-testid="pairing-step-service">
              Run the state service on a server you control (a small cloud server, or a computer at
              home reachable over HTTPS). When you start it, you choose its{" "}
              <strong>admin token</strong>: a long random password that only Forerunner on your PCs
              knows.
            </li>
            <li data-testid="pairing-step-address">
              Tell this PC the service's address. Forerunner reads it from a setting of your user
              account called an environment variable: add one named{" "}
              <code>FORERUNNER_STATE_API_URL</code> whose value is the address, for example{" "}
              <code>https://state.example.org</code>. On Windows: open Start, type "environment
              variables", choose "Edit environment variables for your account", then New. Then quit
              Forerunner from the tray icon and open it again.
            </li>
          </>
        ) : (
          <li data-testid="pairing-step-address-done">
            ✓ This PC uses the state service at <code>{serviceUrl}</code>.
          </li>
        )}
        {setup?.adminSecretStored ? (
          <li>✓ The service's admin token is saved on this PC.</li>
        ) : (
          <li data-testid="pairing-step-token">
            Paste the service's admin token here. It stays in this computer's credential store and
            never leaves this PC except to the service.
            {secretName === STORABLE_ADMIN_SECRET ? (
              <div className="mt-1 max-w-md">
                <SecretValueField
                  name={STORABLE_ADMIN_SECRET}
                  label="State service admin token"
                  testId="pairing-admin-token"
                  onStored={onSaved}
                />
              </div>
            ) : (
              <p className="mt-1">
                This PC is set to read it under the name <code>{secretName}</code> (the
                FORERUNNER_STATE_API_ADMIN_TOKEN_REF variable says so), which the app cannot store;
                remove that variable to use the box here, or store it from a source checkout with{" "}
                <code>fr vault set {secretName}</code>.
              </p>
            )}
          </li>
        )}
      </ol>
      {setup?.guideUrl ? (
        <p>
          <ExternalLink href={setup.guideUrl} testId="pairing-guide-link">
            The setup guide: what to set up first
          </ExternalLink>
        </p>
      ) : (
        <p>The setup guide that comes with each release explains it under "Pairing the phone".</p>
      )}
    </div>
  );
}
