import type { BillingSourceKind } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import { askShown, type CredentialWait, credentialWaitFrom } from "./credential-wait.ts";

/**
 * A task review that a limit or a credential refused before the critic gave a verdict (the
 * leftovers of wave 7; ADR 0112 point 5, ADR 0100 point 9): no review of the work happened, so
 * it is no verdict and no failed try. The critic (`@forerunner/critic`, `refusedReviewError`)
 * throws a `ForerunnerError` whose `details.review` is `REVIEW_REFUSED`, keeping the refusal's
 * code (`budget_exceeded`, `provider_usage_limit`, `provider_auth`, `unavailable`) and its
 * details; the session pauses the task at that limit, or lets it wait for the credential.
 */
export const REVIEW_REFUSED = "refused";

/** The error codes of a credential that could not serve a call (ADR 0100). */
export const CREDENTIAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "provider_usage_limit",
  "provider_auth",
  "unavailable",
]);

export type ReviewRefusal =
  | {
      kind: "budget";
      /** The refusal's level (`run`, `session`, `task`, `project`, `month`, `plan`). */
      level: string | null;
      capUsdMicro: number | null;
      /** What the review's run spent before it was refused. */
      spentUsdMicro: number;
      message: string;
      /**
       * d1116-budget-all: the refused call's worst case as the precheck counted it, or null (an
       * outer cap's refusal, or a refusal of before); the card's `needs_usd_micro` reads it.
       */
      estimateUsdMicro?: number | null;
    }
  | {
      kind: "credential";
      code: string;
      message: string;
      sourceId: string | null;
      resetAt: string | null;
      /** What the review waits for, as the critic's port worked it out (`withReviewWait`). */
      wait: CredentialWait | null;
    };

/** The refusal a task review threw, or null for any other error. */
export function reviewRefusalOf(e: unknown): ReviewRefusal | null {
  if (!(e instanceof ForerunnerError)) return null;
  const d = (e.details ?? {}) as Record<string, unknown>;
  if (d.review !== REVIEW_REFUSED) return null;
  const str = (k: string) => (typeof d[k] === "string" ? (d[k] as string) : null);
  if (e.code === "budget_exceeded")
    return {
      kind: "budget",
      level: str("level"),
      capUsdMicro: typeof d.capUsdMicro === "number" ? d.capUsdMicro : null,
      spentUsdMicro: typeof d.spentUsdMicro === "number" ? d.spentUsdMicro : 0,
      estimateUsdMicro: typeof d.estimateUsdMicro === "number" ? d.estimateUsdMicro : null,
      message: e.message,
    };
  if (CREDENTIAL_REFUSAL_CODES.has(e.code))
    return {
      kind: "credential",
      code: e.code,
      message: e.message,
      sourceId: str("sourceId"),
      resetAt: str("resetAt"),
      wait: credentialWaitFrom(d.wait),
    };
  return null;
}

/** What the critic's provider can say of a credential wait: the routed provider's. */
interface WaitingProvider {
  waitNow?(model?: string): Promise<CredentialWait | null>;
  noteWait?(sourceId: string, projectId: string, agentId: string): Promise<void>;
  peek?(model?: string): Promise<{ kind: string } | null>;
}

/**
 * w8-l4-leftovers (L4i-left-59): a review the hooks refused at the plan level, the share of the
 * subscription Forerunner may use (`budget_exceeded` with level `plan`). The share is a run-out
 * of that credential under the person's policy (the owner's D5), as it is for a run
 * (L4-creds-1), never a budget pause: before, the task paused with a budget card ("its review
 * waits for room in your Claude subscription's share") that waited for the 1st whatever the
 * person chose.
 */
export function isShareRefusal(e: unknown): boolean {
  const refusal = reviewRefusalOf(e);
  return refusal?.kind === "budget" && refusal.level === "plan";
}

/**
 * Whether a review the share refused goes on now with another credential: the person's policy
 * lets one take over ("then the API key", or a standing yes), so a call of the critic's purpose
 * would not wait and would not be made on the subscription. The review is then made once more
 * there; false under 'wait' and 'ask' (the wait `withReviewWait` keeps), and for any other error.
 */
export async function shareGoesOn(e: unknown, provider: unknown): Promise<boolean> {
  if (!isShareRefusal(e)) return false;
  const routed = (provider ?? {}) as WaitingProvider;
  if (!routed.waitNow || !routed.peek) return false;
  try {
    if (await routed.waitNow()) return false;
    const next = await routed.peek();
    return !!next && next.kind !== "subscription";
  } catch {
    return false;
  }
}

/**
 * A task review a credential refused (ADR 0100 point 9): what it waits for, worked out where the
 * review's own routing is known, and kept on the source for the task's project, so the
 * project's session starts by itself once the credential serves again (the task runs again
 * then and the critic reviews it). The routed provider says what a call of the critic's purpose
 * would wait for now (`waitNow`); else the refused call's own source, read from the store (its
 * refusal mark, or its rest). Returns the error to throw: the refusal with `details.wait`, or the
 * error as it was when nothing is known to wait for.
 */
export async function withReviewWait(
  e: unknown,
  opts: {
    provider: unknown;
    store: Pick<StateStore, "billingSource"> & Partial<Pick<StateStore, "humanRequest">>;
    nowMs: number;
    projectId: string;
    agentId: string;
    onError?: (what: string, error: unknown) => void;
  },
): Promise<unknown> {
  const refusal = reviewRefusalOf(e);
  // L4i-left-59: the share's refusal waits as the credential's stop when the policy holds the
  // work ('wait', or 'ask' with its one card); without such a wait it stays the refusal it was.
  const share = isShareRefusal(e);
  if ((refusal?.kind !== "credential" && !share) || !(e instanceof ForerunnerError)) return e;
  const routed = (opts.provider ?? {}) as WaitingProvider;
  let wait: CredentialWait | null = null;
  try {
    wait = (await routed.waitNow?.()) ?? null;
  } catch (err) {
    opts.onError?.("the review's credential wait was not read", err);
  }
  if (share && !wait) return e;
  if (!wait && refusal?.kind === "credential" && refusal.sourceId) {
    const row = await opts.store.billingSource.get(refusal.sourceId).catch(() => undefined);
    if (row) {
      const limits = (row.limits ?? {}) as { restingUntil?: unknown; refusedAt?: unknown };
      const refused = refusal.code === "provider_auth" || typeof limits.refusedAt === "string";
      const resting =
        typeof limits.restingUntil === "string" && Date.parse(limits.restingUntil) > opts.nowMs
          ? limits.restingUntil
          : null;
      wait = refused
        ? { reason: "refused", sourceId: row.id, kind: row.kind as BillingSourceKind, until: null }
        : {
            reason: "limit",
            sourceId: row.id,
            kind: row.kind as BillingSourceKind,
            until: resting ?? refusal.resetAt,
          };
    }
  }
  if (!wait) return e;
  try {
    await routed.noteWait?.(wait.sourceId, opts.projectId, opts.agentId);
  } catch (err) {
    opts.onError?.("the review's credential wait was not kept", err);
  }
  // The 'ask' form only while the stop's one card is open (d1109-cred-engine fix-up).
  const shown = await askShown(opts.store, wait).catch(() => wait as CredentialWait);
  return new ForerunnerError(share ? "provider_usage_limit" : e.code, e.message, {
    details: {
      ...(e.details ?? {}),
      ...(share ? { sourceId: wait.sourceId, ...(wait.until ? { resetAt: wait.until } : {}) } : {}),
      wait: { ...shown },
    },
  });
}
