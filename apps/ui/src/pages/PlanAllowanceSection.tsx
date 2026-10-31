import { type FormEvent, useEffect, useState } from "react";
import { describeError, isRouteMissing, type PlanAllowanceView } from "../api/client.ts";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Button, ErrorBanner, Field, INPUT_CLASS } from "../components/ui.tsx";
import { formatAmount } from "../lib/money.ts";
import { useClient } from "../store/context.tsx";

const chf = (n: number) => `CHF ${formatAmount(Math.round(n * 1_000_000))}`;

/**
 * Settings -> Claude subscription allowance (U-052). Claude does not report how much of a plan
 * Forerunner used, so the daemon estimates it against this monthly amount and stops
 * subscription work near it (ADR 0044). 1.0.4 fixed it at the USD 50 default in the installed
 * app. The person enters CHF a month; the daemon converts at its rate of the day and stores USD
 * (`POST /settings/plan-allowance`), in force from the next task.
 */
export function PlanAllowanceSection() {
  const client = useClient();
  const [view, setView] = useState<PlanAllowanceView | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<"planAllowance" | "setPlanAllowance" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    client.planAllowance(ctrl.signal).then(
      (v) => {
        setView(v);
        setDraft(String(v.chfMonthly));
      },
      (e) => {
        if (ctrl.signal.aborted) return;
        if (isRouteMissing(e)) setMissing("planAllowance");
        else setError(describeError(e));
      },
    );
    return () => ctrl.abort();
  }, [client]);

  const amount = Number(draft.replace(/['\s]/g, "").replace(",", "."));
  const valid = draft.trim() !== "" && Number.isFinite(amount) && amount > 0;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!valid || busy || view?.overridden) return;
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const next = await client.setPlanAllowance(amount);
      setView(next);
      setDraft(String(next.chfMonthly));
      setSaved(
        `Saved. Subscription work stops at ${Math.round(next.stopShare * 100)}% of ${chf(next.chfMonthly)} a month, from the next task on.`,
      );
    } catch (err) {
      if (isRouteMissing(err)) setMissing("setPlanAllowance");
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="plan-allowance-section"
    >
      <h2 className="font-semibold">Claude subscription allowance</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Claude does not tell Forerunner how much of your plan it has used, so Forerunner estimates
        it: what its work would cost at API prices, against this amount a month. Subscription work
        stops near it; an API key takes over when one is saved. Enter what your plan covers: the
        default (USD 50) is set low on purpose, and a Max plan covers much more.
      </p>
      {missing === "planAllowance" ? (
        <RouteMissing route="planAllowance" what="the subscription allowance" />
      ) : view ? (
        <form onSubmit={(e) => void save(e)} className="mt-2 space-y-2">
          {!view.subscription ? (
            <p className="text-sm" data-testid="plan-allowance-no-subscription">
              No Claude subscription is connected. This applies once you add its token under
              Accounts and keys.
            </p>
          ) : null}
          <p className="text-sm" data-testid="plan-allowance-current">
            Now: {chf(view.chfMonthly)} a month
            {view.origin === "default" ? " (the default)" : ""}, stored as USD{" "}
            {formatAmount(Math.round(view.usdMonthly * 1_000_000))} at today's rate.
          </p>
          {view.overridden ? (
            <p
              className="text-sm text-amber-800 dark:text-amber-200"
              data-testid="plan-allowance-overridden"
            >
              The environment variable FORERUNNER_PLAN_USD_MONTHLY sets it on this computer. Remove
              that variable and restart Forerunner to set it here.
            </p>
          ) : null}
          <Field label="CHF per month" hint="API-equivalent usage your plan covers each month.">
            <input
              className={INPUT_CLASS}
              inputMode="decimal"
              value={draft}
              disabled={view.overridden}
              onChange={(e) => {
                setDraft(e.target.value);
                setSaved(null);
              }}
              data-testid="plan-allowance-input"
            />
          </Field>
          {missing === "setPlanAllowance" ? (
            <RouteMissing route="setPlanAllowance" what="saving the subscription allowance" />
          ) : error ? (
            <ErrorBanner message={error} testId="plan-allowance-error" />
          ) : null}
          {saved ? (
            <output className="block text-sm" data-testid="plan-allowance-saved">
              {saved}
            </output>
          ) : null}
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !valid || view.overridden}
            data-testid="plan-allowance-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </form>
      ) : error ? (
        <ErrorBanner message={error} testId="plan-allowance-error" />
      ) : (
        <p className="mt-2 text-sm text-neutral-500">Loading…</p>
      )}
    </div>
  );
}
