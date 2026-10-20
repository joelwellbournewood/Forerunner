import {
  BillingRouter,
  type BillingSource,
  type BillingSourceProbe,
  type BillingSourceStatus,
  DEFAULT_ROUTING_POLICY,
  type ModelTier,
  type RouteSkip,
  type RoutingPolicy,
} from "@forerunner/billing";
import { ForerunnerError, log } from "@forerunner/platform";
import { stateSources } from "@forerunner/runtime";
import type { StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";

/**
 * Which of the human's billing sources pays for cloud sessions (spec: "Email tasks run on the
 * cloud runner with your own billing source: your subscription if your runner is personal,
 * otherwise an API key"; S.14 "a subscription token ... on a cloud runner is used only by its
 * owner's agent"). The decision is `BillingRouter.pick({ runner: "cloud", purpose: "session" })`
 * from `@forerunner/billing` over the human's enabled sources (`stateSources`, the daemon's
 * lister) with the runner's vault as the probe:
 *
 *  - the router's invariants: never another human's source, never a disabled one;
 *  - the cloud rule is routing policy: on a shared runner the package default
 *    (`subscriptionOnCloudRunner: "personal_runner_only"`, the source must opt in with
 *    `limits.personalRunner === true`); on a personal runner (`FORERUNNER_RUNNER_PERSONAL=1`,
 *    one person's runner) `runnerRoutingPolicy` lifts it to `"always"`, which the owner
 *    invariant still bounds;
 *  - the credential must be in the runner's vault (`VaultCredentialProbe`), and a probe that
 *    reports plan usage or month spend gets the package's plan-share and monthly-limit rules;
 *  - preference for `session` work: subscription, plan credits, API key, fake; ties by the
 *    source's priority, then id.
 *
 * On top of the router this module refuses to bill the human's sources for an agent another
 * human owns (`agentOwnerHumanId`): the runner serves one agent and that agent's owner.
 */
export type RunnerBillingSource = BillingSource;
export type { BillingSourceProbe } from "@forerunner/billing";
export type RunnerBillingSkip = RouteSkip;

export interface RunnerBillingChoice {
  sourceId: string;
  kind: RunnerBillingSource["kind"];
  label: string;
  reason: string;
  skipped: RunnerBillingSkip[];
}

/** Available when the vault holds the source's credential (fake sources need none). */
export class VaultCredentialProbe implements BillingSourceProbe {
  constructor(private readonly vault: Pick<Vault, "has">) {}
  async status(source: RunnerBillingSource): Promise<BillingSourceStatus> {
    if (source.kind === "fake") return { available: true };
    let present = false;
    try {
      present = source.credentialRef ? await this.vault.has(source.credentialRef) : false;
    } catch {
      present = false;
    }
    return present
      ? { available: true }
      : { available: false, reason: `no credential ${source.credentialRef} in the runner vault` };
  }
}

/** The ladder's working tier; the choice is made once per runner start, not per model call. */
export const DEFAULT_RUNNER_MODEL_TIER: ModelTier = "sonnet";

/**
 * The routing policy for this runner: the package default on a shared runner (a subscription
 * needs the source's `personalRunner` opt-in), subscriptions allowed on a personal runner.
 */
export function runnerRoutingPolicy(
  personal: boolean,
  base: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RoutingPolicy {
  return personal ? { ...base, subscriptionOnCloudRunner: "always" } : base;
}

export interface PickRunnerBillingOptions {
  store: Pick<StateStore, "billingSource">;
  humanId: string;
  agentId: string;
  /** The agent's owner; a runner never bills one human's source for another human's agent. */
  agentOwnerHumanId: string;
  personal: boolean;
  probe: BillingSourceProbe;
  /** The router's policy; default `runnerRoutingPolicy(personal)`. */
  policy?: RoutingPolicy;
  /** Tier for a `kindsForTier` policy; default `DEFAULT_RUNNER_MODEL_TIER`. */
  modelTier?: ModelTier;
}

export async function pickRunnerBillingSource(
  opts: PickRunnerBillingOptions,
): Promise<RunnerBillingChoice> {
  const logger = log("cloud-runner:billing");
  if (opts.agentOwnerHumanId !== opts.humanId) {
    throw new ForerunnerError(
      "validation",
      "the runner's agent belongs to another human; a billing source is only used for its owner's agent",
      { details: { humanId: opts.humanId, agentOwnerHumanId: opts.agentOwnerHumanId } },
    );
  }
  const router = new BillingRouter({
    probe: opts.probe,
    sources: stateSources(opts.store as StateStore),
    policy: opts.policy ?? runnerRoutingPolicy(opts.personal),
  });
  const decision = await router.pick({
    humanId: opts.humanId,
    agentId: opts.agentId,
    runner: "cloud",
    purpose: "session",
    modelTier: opts.modelTier ?? DEFAULT_RUNNER_MODEL_TIER,
  });
  const reason = `${decision.reason} (${opts.personal ? "personal" : "shared"} runner)`;
  logger.info("billing source chosen", {
    sourceId: decision.source.id,
    kind: decision.source.kind,
    reason,
  });
  return {
    sourceId: decision.source.id,
    kind: decision.source.kind,
    label: decision.source.label,
    reason,
    skipped: decision.skipped,
  };
}
