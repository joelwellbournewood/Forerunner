import { useEffect, useState } from "react";
import {
  type BillingOrderKind,
  type BillingOrderSourceView,
  type BillingOrderView,
  describeError,
  isRouteMissing,
} from "../api/client.ts";
import { RouteMissing } from "../components/RouteMissing.tsx";
import { Button, ErrorBanner } from "../components/ui.tsx";
import { formatShare } from "../lib/format.ts";
import { formatChf } from "../lib/money.ts";
import { formatDateTime } from "../lib/time.ts";
import { useClient } from "../store/context.tsx";

/** How a credential's calls are made (ADR 0098, ADR 0100). */
export function howUsed(s: Pick<BillingOrderSourceView, "via">): string {
  return s.via === "claude_code"
    ? "Through Claude Code"
    : "Straight to the API: promotional credits apply";
}

/** Whether a call could use it now, and why not, in the words the row shows. */
export function usableNow(s: BillingOrderSourceView): string {
  switch (s.blocked) {
    case null:
      return "Can be used now";
    case "allowance":
      return "Not now: this month's allowance is reached";
    case "monthly_cap":
      return "Not now: its monthly cap is reached";
    case "resting":
      return `Resting until ${formatDateTime(s.restingUntil)} after a usage limit`;
    case "no_credential":
      return s.kind === "subscription"
        ? "Not now: no subscription token is saved"
        : "Not now: no key is saved";
    case "disabled":
      return "Turned off";
    default:
      return "Not now";
  }
}

/** What it has spent this month: the subscription as a share of its allowance, a key in CHF. */
export function spentThisMonth(s: BillingOrderSourceView): string {
  if (s.kind === "subscription")
    return `${formatShare(s.planShare)} of the allowance used this month`;
  const spent = formatChf(s.monthSpent.chfMicro);
  return s.monthlyCap
    ? `${spent} this month of ${formatChf(s.monthlyCap.chfMicro)}`
    : `${spent} this month`;
}

const WORDS: Record<BillingOrderKind, string> = {
  subscription: "the Claude subscription",
  api_key: "the API key",
  plan_credits: "the plan credits",
};

/**
 * Settings -> Claude: which to use first (U-078, ADR 0100). The person's Claude credentials in
 * the order every model call uses them (tasks, Chat, project setup, reviews, the model watch),
 * each with how it is used, whether it can be used now and what it spent this month. Move up /
 * Move down posts the new order (`POST /settings/billing-order`); the daemon stores it through
 * `settings.set`, so Changes lists it with Undo.
 */
export function BillingOrderSection() {
  const client = useClient();
  const [view, setView] = useState<BillingOrderView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<"billingOrder" | "setBillingOrder" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    client.billingOrder(ctrl.signal).then(setView, (e) => {
      if (ctrl.signal.aborted) return;
      if (isRouteMissing(e)) setMissing("billingOrder");
      else setError(describeError(e));
    });
    return () => ctrl.abort();
  }, [client]);

  const move = async (index: number, delta: -1 | 1) => {
    if (!view || busy) return;
    const kinds = [...new Set(view.sources.map((s) => s.kind))];
    const from = kinds.indexOf(view.sources[index]?.kind as BillingOrderKind);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= kinds.length) return;
    const next = [...kinds];
    [next[from], next[to]] = [next[to] as BillingOrderKind, next[from] as BillingOrderKind];
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const updated = await client.setBillingOrder(next);
      setView(updated);
      setSaved(
        `Saved: ${next.map((k) => WORDS[k]).join(", then ")}. It is in Changes, where you can undo it.`,
      );
    } catch (e) {
      if (isRouteMissing(e)) setMissing("setBillingOrder");
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded border border-neutral-200 p-3 dark:border-neutral-800"
      data-testid="billing-order-section"
    >
      <h2 className="font-semibold">Claude: which to use first</h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        Forerunner uses your Claude credentials in this order for everything: tasks, Chat, project
        setup and reviews. When one cannot be used, the next one is. A subscription always runs
        through Claude Code; an API key always goes straight to the API, where promotional credits
        apply.
      </p>
      {missing === "billingOrder" ? (
        <RouteMissing route="billingOrder" what="the order of your Claude credentials" />
      ) : view ? (
        <div className="mt-2 space-y-2">
          {!view.chosen && view.sources.length > 1 ? (
            <p className="text-sm" data-testid="billing-order-default">
              You have not chosen an order yet: tasks use the subscription first, and Chat, project
              setup and reviews use the API key first. Moving one sets this order for everything.
            </p>
          ) : null}
          {view.sources.length === 0 ? (
            <p className="text-sm" data-testid="billing-order-empty">
              No Claude credential is saved yet. Add your subscription token or an API key under
              Accounts and keys.
            </p>
          ) : (
            <ol className="space-y-2" aria-label="Claude credentials, first used first">
              {view.sources.map((s, i) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800"
                  data-testid={`billing-order-row-${s.kind}`}
                >
                  <span className="font-medium">
                    {i + 1}. {s.name}
                  </span>
                  <span data-testid="billing-order-how">{howUsed(s)}</span>
                  <span
                    data-testid="billing-order-status"
                    className={s.usable ? "" : "text-amber-800 dark:text-amber-200"}
                  >
                    {usableNow(s)}
                  </span>
                  <span data-testid="billing-order-spent">{spentThisMonth(s)}</span>
                  <span className="ml-auto flex gap-1">
                    <Button
                      aria-label={`Move ${s.name} up`}
                      disabled={busy || i === 0}
                      onClick={() => void move(i, -1)}
                    >
                      Move up
                    </Button>
                    <Button
                      aria-label={`Move ${s.name} down`}
                      disabled={busy || i === view.sources.length - 1}
                      onClick={() => void move(i, 1)}
                    >
                      Move down
                    </Button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {missing === "setBillingOrder" ? (
            <RouteMissing route="setBillingOrder" what="saving the order" />
          ) : error ? (
            <ErrorBanner message={error} testId="billing-order-error" />
          ) : null}
          {saved ? (
            <output className="block text-sm" data-testid="billing-order-saved">
              {saved}
            </output>
          ) : null}
        </div>
      ) : error ? (
        <ErrorBanner message={error} testId="billing-order-error" />
      ) : (
        <p className="mt-2 text-sm text-neutral-500">Loading…</p>
      )}
    </div>
  );
}
