import { z } from "zod";

/**
 * d1109-cred-screens CS-1 (ADR 0120 amended 2026-11-16): Settings -> Basics -> "Which Claude does
 * the work", the one options menu of the person's credential policy, in the daemon's words
 * (`credential-policy-view.ts`). `credential-policy-routes.ts` serves it.
 */
export const CredentialPolicyPresetId = z.enum([
  "subscription_then_wait",
  "subscription_then_ask",
  "subscription_then_key",
  "key_then_subscription",
  "key_only",
]);
export type CredentialPolicyPresetId = z.infer<typeof CredentialPolicyPresetId>;

const LinkView = z.object({ label: z.string(), to: z.string() });

export const CredentialPolicyPresetView = z.object({
  id: CredentialPolicyPresetId,
  /** "Subscription first, then wait": the label shows the order. */
  label: z.string(),
  /** What it does when the first credential runs out, one line. */
  line: z.string(),
  /** It moves work onto money by itself (a change to it asks the person's yes first). */
  movesMoney: z.boolean(),
});
export type CredentialPolicyPresetView = z.infer<typeof CredentialPolicyPresetView>;

export const CredentialPolicyRowView = z.object({
  kind: z.enum(["subscription", "api_key", "plan_credits"]),
  /** "Claude subscription", "API key". */
  name: z.string(),
  /** Its role under the preset: "Does the work", "Takes over when your subscription runs out". */
  role: z.string(),
  /** Its state now: "Works now", "At its limit until 15:40", "Refused: save a new key". */
  state: z.string(),
  /** Whether the state is a stop (shown in amber). */
  stopped: z.boolean(),
  /** Where its state is fixed (the setup assistant, the allowance); null when nothing to do. */
  link: LinkView.nullable(),
  /** This month: "34% of this month's allowance used", "CHF 2.10 this month". */
  month: z.string(),
});
export type CredentialPolicyRowView = z.infer<typeof CredentialPolicyRowView>;

export const CredentialPolicyView = z.object({
  intro: z.string(),
  presets: z.array(CredentialPolicyPresetView),
  /** The preset in force (stored, derived from earlier settings, or the default); null for an earlier choice no preset matches. */
  selected: CredentialPolicyPresetId.nullable(),
  /** `stored`: the person picked it; `derived`: read from earlier settings; `default`: not chosen yet. */
  chosen: z.enum(["stored", "derived", "default"]),
  /** "Used until you choose: ..." (default) or "Your earlier choice: ..."; null otherwise. */
  choiceLine: z.string().nullable(),
  /** The saved credentials in the preset's order. */
  rows: z.array(CredentialPolicyRowView),
  /** What happens next, computed now; null with one credential saved. */
  nowLine: z.string().nullable(),
  /** The now line's Answer (opens the open ask card); null when no card is open. */
  answer: LinkView.nullable(),
  /** A yes stands (the now line names it): "Stop using it" ends it (POST .../grant/end). */
  grant: z.boolean(),
  /**
   * What "Stop using it" does, beside it (design §3: every action has its one-line
   * consequence): "Stop using it: what already runs on your API key finishes; new work waits
   * for your subscription."; null when no yes stands.
   */
  grantEndLine: z.string().nullable(),
  /** "Runs out means: ..."; null with one credential saved. */
  runsOutLine: z.string().nullable(),
  /** The subscription-first presets' footnote; null otherwise. */
  footnote: z.string().nullable(),
  /** One credential (or none) saved: the presets fold into this sentence and its link. */
  single: z.object({ sentence: z.string(), link: LinkView }).nullable(),
});
export type CredentialPolicyView = z.infer<typeof CredentialPolicyView>;

export const CREDENTIAL_POLICY_ROUTES = {
  credentialPolicy:
    "GET /settings/credential-policy (CredentialPolicyView: d1109-cred-screens CS-1, Settings' 'Which Claude does the work': the five presets with their lines, the one in force (stored, derived from the earlier order, or the default shown as used until the person picks), each saved credential's role, state now and month, what happens next with Answer or Stop using it, what 'runs out' means; with one credential saved the presets fold into one sentence; a choice goes through POST /commands/execute settings.set credential_policy)",
  endCredentialGrant:
    "POST /settings/credential-policy/grant/end (CredentialPolicyView: ends the person's standing yes to their other Claude credential (the engine's endGrant, one billing.grant_end audit row); the next pick waits for the stop's end; nothing changes when no yes stands)",
} as const;
