import type { BillingSourceKind, StopReason } from "@forerunner/billing";
import type { StateStore } from "@forerunner/state";
import { BILLING_SWITCH_EVENT } from "./billing.ts";

/**
 * C5-left-1 (d1109-cred-screens, CE-11, ADR 0120): what a session's switches were, read from its
 * own log (`billing.switch`, one event per switched run, the first per stop the person's line)
 * and the ledger, so every screen reads data, never a sentence parsed again: the session page's
 * line under its spend and its result line (CS-6), and `SessionResult.switched`.
 */

/** The session's first switch: when, from which stopped credential, to which. */
export interface FirstSwitch {
  at: string;
  from: BillingSourceKind;
  stop: StopReason;
  to: BillingSourceKind;
  /** The credential the work went on with (the ledger's rows on it are the switch's spend). */
  toSourceId: string | null;
}

/** One task the session moved, with the USD the ledger booked to it on the credential it moved to. */
export interface SessionSwitchRow {
  taskId: string;
  from: BillingSourceKind;
  to: BillingSourceKind;
  usdMicro: number;
}

const STOPS: readonly string[] = ["limit", "refused", "share", "key_month"];
const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === "string" ? p[k] : "");

/** The session's switches, oldest first; empty for a session that never moved. */
export async function sessionSwitches(
  store: Pick<StateStore, "event" | "costLedger">,
  sessionId: string,
): Promise<{ first: FirstSwitch | null; tasks: SessionSwitchRow[] }> {
  const rows = await store.event
    .ofTypes(sessionId, [BILLING_SWITCH_EVENT], { limit: 500 })
    .catch(() => []);
  const ordered = [...rows].sort((a, b) => a.seq - b.seq);
  let first: FirstSwitch | null = null;
  const tasks: SessionSwitchRow[] = [];
  const seen = new Set<string>();
  for (const e of ordered) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    const from = str(p, "from") as BillingSourceKind;
    const to = str(p, "to") as BillingSourceKind;
    const stop = (STOPS.includes(str(p, "stop")) ? str(p, "stop") : "limit") as StopReason;
    const toSourceId = str(p, "toSourceId") || null;
    if (!from || !to) continue;
    first ??= { at: str(p, "at") || e.created_at, from, stop, to, toSourceId };
    const taskId = str(p, "taskId");
    const key = `${taskId}\u0000${toSourceId ?? ""}`;
    if (!taskId || seen.has(key)) continue;
    seen.add(key);
    const booked = toSourceId
      ? await store.costLedger
          .sum({ sessionId, taskId, billingSourceId: toSourceId })
          .catch(() => null)
      : null;
    tasks.push({ taskId, from, to, usdMicro: booked?.usd_micro ?? 0 });
  }
  return { first, tasks };
}

/** What the ledger booked on the switch's credential in this session since the switch (CHF). */
export async function switchSpend(
  store: Pick<StateStore, "costLedger">,
  sessionId: string,
  first: FirstSwitch,
): Promise<{ chfMicro: number; usdMicro: number }> {
  if (!first.toSourceId) return { chfMicro: 0, usdMicro: 0 };
  const sum = await store.costLedger
    .sum({ sessionId, billingSourceId: first.toSourceId, from: first.at })
    .catch(() => null);
  return { chfMicro: sum?.chf_micro ?? 0, usdMicro: sum?.usd_micro ?? 0 };
}
