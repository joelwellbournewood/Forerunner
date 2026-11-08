import type { BillingSourceKind } from "@forerunner/billing";
import { ForerunnerError } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import { type CredentialWait, credentialWaitFrom } from "./credential-wait.ts";

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
    store: Pick<StateStore, "billingSource">;
    nowMs: number;
    projectId: string;
    agentId: string;
    onError?: (what: string, error: unknown) => void;
  },
): Promise<unknown> {
  const refusal = reviewRefusalOf(e);
  if (refusal?.kind !== "credential" || !(e instanceof ForerunnerError)) return e;
  const routed = (opts.provider ?? {}) as WaitingProvider;
  let wait: CredentialWait | null = null;
  try {
    wait = (await routed.waitNow?.()) ?? null;
  } catch (err) {
    opts.onError?.("the review's credential wait was not read", err);
  }
  if (!wait && refusal.sourceId) {
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
  return new ForerunnerError(e.code, e.message, {
    details: { ...(e.details ?? {}), wait: { ...wait } },
  });
}
