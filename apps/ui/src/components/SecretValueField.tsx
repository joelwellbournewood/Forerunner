import { STORABLE_SECRETS, type StorableSecretName } from "@forerunner/runtime/daemon/api-types";
import { useEffect, useState } from "react";
import { describeError, isRouteMissing } from "../api/client.ts";
import { useClient } from "../store/context.tsx";
import { RouteMissing } from "./RouteMissing.tsx";
import { Button, ErrorBanner, INPUT_CLASS } from "./ui.tsx";

/** The cloud voice key a `voice-*` extension row reads, when it reads one (U-054). */
export function voiceKeyNameOf(secrets: readonly string[]): StorableSecretName | null {
  for (const s of secrets) {
    if (s in STORABLE_SECRETS && STORABLE_SECRETS[s as StorableSecretName].kind === "api_key")
      return s as StorableSecretName;
  }
  return null;
}

/**
 * One secret the person types in the app (U-054): the agent mailbox's password on the Email
 * page, a cloud voice key on its Extensions row. 1.0.4 asked for `fr vault set`, which the
 * installed app does not have. The value goes once to the daemon (`POST /secrets/store`), into
 * this computer's credential store under `name`; the field is emptied and nothing shows it
 * again. The line says whether one is saved (`GET /secrets/store` answers names only).
 */
export function SecretValueField({
  name,
  label,
  testId,
  onStored,
}: {
  /** An allowlisted name (`STORABLE_SECRETS`, or a mailbox password `<agent>_imap_password`). */
  name: string;
  label: string;
  testId: string;
  /** Called with the reference (`secret:<name>`) a setting uses for it, once it is stored. */
  onStored?: (ref: string) => void;
}) {
  const client = useClient();
  const [value, setValue] = useState("");
  const [stored, setStored] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    client.storedSecrets(name, ctrl.signal).then(
      (v) => setStored(v.secrets.find((s) => s.name === name)?.stored ?? false),
      (e) => {
        if (!ctrl.signal.aborted && isRouteMissing(e)) setMissing(true);
      },
    );
    return () => ctrl.abort();
  }, [client, name]);

  const save = async () => {
    const v = value;
    if (!v.trim() || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    setValue("");
    try {
      const r = await client.storeSecret(name, v);
      setStored(true);
      setSaved(true);
      onStored?.(r.ref);
    } catch (e) {
      setMissing(isRouteMissing(e));
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (missing)
    return <RouteMissing route="storeSecret" what={`saving the ${label.toLowerCase()}`} />;
  return (
    <div className="space-y-1" data-testid={testId}>
      <div className="flex flex-wrap gap-1">
        <input
          className={`${INPUT_CLASS} min-w-0 flex-1`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          placeholder={stored ? "Saved. Type a new one to replace it" : label}
          aria-label={label}
          data-testid={`${testId}-input`}
        />
        <Button
          onClick={() => void save()}
          disabled={busy || !value.trim()}
          data-testid={`${testId}-save`}
        >
          {busy ? "Saving…" : stored ? "Replace" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-neutral-600 dark:text-neutral-400" data-testid={`${testId}-state`}>
        {saved
          ? `Saved in this computer's credential store as ${name}.`
          : stored
            ? `A value is saved as ${name}.`
            : stored === false
              ? `Nothing saved yet. It is kept in this computer's credential store as ${name}, never in the settings.`
              : ""}
      </p>
      {error ? <ErrorBanner message={error} testId={`${testId}-error`} /> : null}
    </div>
  );
}
