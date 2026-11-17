import { useEffect, useState } from "react";
import { Link } from "react-router";
import {
  type CommandResultJson,
  type CredentialPolicyView,
  describeError,
  isRouteMissing,
} from "../api/client.ts";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Button, buttonClassName, ErrorBanner } from "../components/ui.tsx";
import { inAppText } from "../lib/plain-words.ts";
import { useClient } from "../store/context.tsx";

type PresetId = CredentialPolicyView["presets"][number]["id"];

/**
 * Settings -> Basics -> "Which Claude does the work" (d1109-cred-screens CS-1, ADR 0120; the
 * owner's answer 4 of 2026-11-09: "There should be a nice clean options menu"): one radio group
 * of the five presets, each with its line; the one in force selected (until the person picks,
 * the default, marked as used until they choose); the saved credentials in its order with their
 * role, state now and month; what happens next with Answer or Stop using it. A choice runs
 * `settings.set credential_policy` through `POST /commands/execute`, like every setting: one that
 * moves less money acts at once, one that moves more shows the daemon's yes first and sends
 * nothing until Change. Every sentence is the daemon's (`GET /settings/credential-policy`).
 */
export function CredentialPolicySection() {
  const client = useClient();
  const [view, setView] = useState<CredentialPolicyView | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: PresetId; result: CommandResultJson } | null>(null);
  const [saved, setSaved] = useState(false);

  const reload = async (signal?: AbortSignal) => {
    try {
      setView(await client.credentialPolicy(signal));
    } catch (e) {
      if (signal?.aborted) return;
      if (isRouteMissing(e)) setMissing(true);
      else setError(describeError(e));
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: read once per client
  useEffect(() => {
    const ctrl = new AbortController();
    void reload(ctrl.signal);
    return () => ctrl.abort();
  }, [client]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = (id: PresetId) => {
    if (!view || pending) return;
    if (view.selected === id && view.chosen === "stored") return;
    const label = view.presets.find((p) => p.id === id)?.label ?? id;
    void run(async () => {
      setSaved(false);
      const result = await client.executeCommands({
        commands: [{ name: "settings.set", params: { key: "credential_policy", value: id } }],
        wordsUsed: `Settings: Which Claude does the work to ${label}`,
        source: "ui",
      });
      if (result.status === "pending" && result.pendingId) setPending({ id, result });
      else if (result.status === "done" || result.status === "partial") {
        setSaved(true);
        await reload();
      } else setError(inAppText(result.reason ?? "Not changed."));
    });
  };

  const answer = (yes: boolean) => {
    const p = pending;
    if (!p?.result.pendingId) return;
    const pendingId = p.result.pendingId;
    void run(async () => {
      const r = await client.confirmCommand(pendingId, { answer: yes ? "tap" : "no" });
      setPending(null);
      if (yes && (r.status === "done" || r.status === "partial")) setSaved(true);
      else if (yes) setError(inAppText(r.reason ?? "Not changed."));
      await reload();
    });
  };

  const endGrant = () =>
    void run(async () => {
      setView(await client.endCredentialGrant());
    });

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="credential-policy"
    >
      <h3 className="font-semibold">Which Claude does the work</h3>
      {missing ? (
        <RouteMissing route="credentialPolicy" what="which Claude does the work" />
      ) : view === null ? (
        error ? (
          <ErrorBanner message={error} testId="credential-policy-error" />
        ) : (
          <p className="mt-1 text-sm text-neutral-500">Loading…</p>
        )
      ) : view.single ? (
        <p className="mt-1 text-sm" data-testid="credential-policy-single">
          {view.single.sentence}{" "}
          <Link
            to={view.single.link.to}
            className="text-blue-700 underline dark:text-blue-300"
            data-testid="credential-policy-single-link"
          >
            {view.single.link.label}
          </Link>
        </p>
      ) : (
        <div className="mt-1 space-y-3 text-sm">
          <p className="text-neutral-600 dark:text-neutral-400">{view.intro}</p>
          {view.selected === null && view.choiceLine ? (
            <p data-testid="credential-policy-earlier">{view.choiceLine}</p>
          ) : null}
          <fieldset className="space-y-1" disabled={busy || !!pending}>
            <legend className="sr-only">Which Claude does the work</legend>
            {view.presets.map((p) => {
              const checked = view.selected === p.id;
              return (
                <label
                  key={p.id}
                  className={`flex cursor-pointer items-start gap-2 rounded border p-2 ${
                    checked
                      ? "border-blue-500 bg-blue-50 dark:border-blue-400 dark:bg-blue-950"
                      : "border-neutral-200 dark:border-neutral-800"
                  }`}
                  data-testid={`credential-preset-${p.id}`}
                >
                  <input
                    type="radio"
                    name="credential-policy"
                    className="mt-1"
                    checked={checked}
                    onChange={() => choose(p.id)}
                    onClick={() => (checked ? choose(p.id) : undefined)}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{p.label}</span>
                    <span className="block text-neutral-600 dark:text-neutral-400">{p.line}</span>
                    {checked && view.chosen === "default" && view.choiceLine ? (
                      <span className="mt-1 block" data-testid="credential-policy-default">
                        {view.choiceLine}
                      </span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
          {pending ? (
            <div
              className="space-y-2 rounded border border-amber-300 p-2 dark:border-amber-700"
              data-testid="credential-policy-confirm"
            >
              <p data-testid="credential-policy-readback">
                {inAppText(pending.result.readback ?? "")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  onClick={() => answer(true)}
                  disabled={busy}
                  data-testid="credential-policy-change"
                >
                  Change
                </Button>
                <Button onClick={() => answer(false)} disabled={busy}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
          {saved ? (
            <output className="block" data-testid="credential-policy-saved">
              Saved. It is in{" "}
              <Link to="/changes" className="text-blue-700 underline dark:text-blue-300">
                Changes
              </Link>
              , where you can undo it.
            </output>
          ) : null}
          <ul className="space-y-1" aria-label="Your Claude credentials, in this order">
            {view.rows.map((r) => (
              <li
                key={r.kind}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded border border-neutral-200 p-2 dark:border-neutral-800"
                data-testid={`credential-row-${r.kind}`}
              >
                <span className="font-medium">{r.name}</span>
                <span data-testid="credential-row-role">{r.role}</span>
                <span
                  data-testid="credential-row-state"
                  className={r.stopped ? "text-amber-800 dark:text-amber-200" : ""}
                >
                  {r.state}
                </span>
                {r.link ? (
                  <Link
                    to={r.link.to}
                    className="text-blue-700 underline dark:text-blue-300"
                    data-testid="credential-row-link"
                  >
                    {r.link.label}
                  </Link>
                ) : null}
                <span
                  data-testid="credential-row-month"
                  className="text-neutral-600 dark:text-neutral-400"
                >
                  {r.month}
                </span>
              </li>
            ))}
          </ul>
          {view.nowLine ? (
            <p className="flex flex-wrap items-center gap-2" data-testid="credential-policy-now">
              <span>{view.nowLine}</span>
              {view.answer ? (
                <Link
                  to={view.answer.to}
                  className={buttonClassName("primary")}
                  data-testid="credential-policy-answer"
                >
                  {view.answer.label}
                </Link>
              ) : null}
              {view.grant ? (
                <Button
                  onClick={endGrant}
                  disabled={busy}
                  data-testid="credential-policy-end-grant"
                >
                  Stop using it
                </Button>
              ) : null}
            </p>
          ) : null}
          {view.grant && view.grantEndLine ? (
            <p
              className="text-xs text-neutral-600 dark:text-neutral-400"
              data-testid="credential-policy-end-grant-explain"
            >
              {view.grantEndLine}
            </p>
          ) : null}
          {view.runsOutLine ? (
            <p className="text-xs text-neutral-600 dark:text-neutral-400">{view.runsOutLine}</p>
          ) : null}
          {view.footnote ? (
            <p className="text-xs text-neutral-600 dark:text-neutral-400">{view.footnote}</p>
          ) : null}
          {error ? <ErrorBanner message={error} testId="credential-policy-error" /> : null}
        </div>
      )}
    </div>
  );
}
