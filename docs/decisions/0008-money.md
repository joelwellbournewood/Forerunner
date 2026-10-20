# 0008 — Money: USD micro-units in the ledger, CHF at a daily rate, plan usage as a share

Date: 2026-10-20
Status: accepted

## Context

The spec prices model calls in USD per million tokens, the humans think and set budgets in
CHF, and subscription usage has no per-token price at all. Caps must be enforced in code
before every call, so the arithmetic has to be exact, deterministic and testable offline.
The design decision "Currency and pricing" says: budgets shown in CHF, converted at a daily
rate, raw USD kept in the ledger.

## Decision

1. **Integers only.** Every amount is an integer in micro-units: `usd_micro` (1 USD =
   1 000 000) and `chf_micro`. Prices in USD per million tokens make the cost exact:
   `usd_micro = tokens * price_per_mtok`. Floats appear only on the way out (display with two
   decimals) and on the way in (decimal inputs, exchange rates). Rounding is half-up with ties
   away from zero, applied once per conversion.
2. **Raw USD plus CHF at the day's rate, both stored.** Each ledger entry carries
   `usd_micro`, `chf_micro` and `rate_chf_per_usd`. Caps are configured in CHF, converted to
   USD when the caps are built, and compared against `usd_micro` sums; CHF totals never
   change retroactively because the rate used is stored with the entry.
3. **Rate source: ECB reference rate via Frankfurter, cached daily, with a documented
   default.** `https://api.frankfurter.app/latest?from=USD&to=CHF` (no key, no account,
   nothing host-specific). One JSON cache file under the app cache directory holds one entry
   per day. When offline the newest cached rate is used and flagged `fallback`; with no
   cache at all the default 0.80 CHF/USD is used and flagged `default`. A missing network
   never blocks recording a cost. The default is deliberately on the expensive side for a
   CHF budget holder so a cold start cannot under-count.
4. **Subscription usage is a share, shown with an estimated API-equivalent.** A subscription
   entry has `kind: "subscription"`, `plan_usage_share` (0..1 of the plan limit, from the
   provider) and `usd_micro` set to what the same tokens would have cost on the API. Caps on
   subscriptions apply to the share (`planShareCap`, default 0.95), not to the estimate; the
   estimate exists so the cost view can compare sources and so allocation reports stay in one
   unit. The UI labels such entries "plan usage, est. API-equivalent".
5. **Pricing is data with provenance.** Each price row carries `source` (`list`, `assumed`,
   `override`) and `as_of`. Humans and the weekly model watch correct prices through
   `<config>/pricing.json` without a release. Unknown models throw; no cost is ever zero by
   accident.

## Consequences

- Sums of micro-units are exact up to about 9 billion units; no decimal library is needed.
- Two people on different days see different CHF for the same USD; that is intended and
  visible through `rate_chf_per_usd`.
- A subscription's `usd_micro` is an estimate and must be labelled as such everywhere it is
  shown; it must not be summed with API spend as if it were money owed.
- Tests run without network by injecting `fetch` and a `SimulatedClock`.

## Alternatives considered

- Cents instead of micro-units: too coarse for per-token prices (0.1 USD per MTok is 0.0000001
  USD per token).
- Floats with rounding at display time: sums drift and tests become order-dependent.
- Storing CHF only: the provider bills in USD; audits and refunds need the raw figure.
- A paid FX API: needs an account and a key; the ECB reference rate is public and stable.
- Not pricing subscription usage at all: the allocation view would lose the comparison that
  tells a human when the API key would be cheaper.
