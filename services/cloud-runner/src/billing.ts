import { ForerunnerError, log } from "@forerunner/platform";
import { stateSources } from "@forerunner/runtime";
import type { StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";

/**
 * Which of the human's billing sources pays for cloud sessions (spec: "Email tasks run on the
 * cloud runner with your own billing source: your subscription if your runner is personal,
 * otherwise an API key"; S.14 "a subscription token ... on a cloud runner is used only by its
 * owner's agent"). The rules mirror `@forerunner/billing`'s `BillingRouter` for runner "cloud"
 * (that package is not a dependency of this service, see cloud-runner.md "Known issues"):
 *
 *  1. invariant: the agent belongs to the human and only that human's sources are considered;
 *  2. a disabled source is never used;
 *  3. a subscription is used on a personal runner (`FORERUNNER_RUNNER_PERSONAL=1`) or when the
 *     source itself opted in with `limits.personalRunner === true`; never on a shared runner;
 *  4. the credential must be in the runner's vault (the probe);
 *  5. preference, as the daemon's session routing: subscription, plan credits, API key, fake;
 *     ties by the source's priority, then id.
 */
export type RunnerBillingSource = Awaited<ReturnType<ReturnType<typeof stateSources>>>[number];

export interface BillingSourceProbe {
  status(source: RunnerBillingSource): Promise<{ available: boolean; reason?: string }>;
}

export interface RunnerBillingSkip {
  sourceId: string;
  kind: RunnerBillingSource["kind"];
  code: "other_human" | "disabled" | "cloud_runner" | "unavailable" | "purpose";
  reason: string;
}

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
  async status(source: RunnerBillingSource) {
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

const PREFERENCE: readonly RunnerBillingSource["kind"][] = [
  "subscription",
  "plan_credits",
  "api_key",
  "fake",
];

export interface PickRunnerBillingOptions {
  store: Pick<StateStore, "billingSource">;
  humanId: string;
  agentId: string;
  /** The agent's owner; a runner never bills one human's source for another human's agent. */
  agentOwnerHumanId: string;
  personal: boolean;
  probe: BillingSourceProbe;
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
  const all = await stateSources(opts.store as StateStore)(opts.humanId);
  const preference = PREFERENCE;
  const skipped: RunnerBillingSkip[] = [];
  const candidates: { source: RunnerBillingSource; rank: number }[] = [];
  for (const source of all) {
    const skip = (code: RunnerBillingSkip["code"], reason: string) =>
      skipped.push({ sourceId: source.id, kind: source.kind, code, reason });
    if (source.humanId !== opts.humanId) {
      skip("other_human", "belongs to another human");
      continue;
    }
    if (!source.enabled) {
      skip("disabled", "disabled");
      continue;
    }
    const rank = preference.indexOf(source.kind);
    if (rank < 0) {
      skip("purpose", `${source.kind} is not used for cloud sessions`);
      continue;
    }
    if (source.kind === "subscription" && !opts.personal && source.limits.personalRunner !== true) {
      skip("cloud_runner", "subscriptions are not used on a shared cloud runner");
      continue;
    }
    const status = await opts.probe.status(source);
    if (!status.available) {
      skip("unavailable", status.reason ?? "not available");
      continue;
    }
    candidates.push({ source, rank });
  }
  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.source.priority - b.source.priority ||
      (a.source.id < b.source.id ? -1 : a.source.id > b.source.id ? 1 : 0),
  );
  const chosen = candidates[0];
  if (!chosen) {
    throw new ForerunnerError("unavailable", "no billing source available for cloud sessions", {
      details: {
        humanId: opts.humanId,
        agentId: opts.agentId,
        personal: opts.personal,
        skipped: skipped.map((s) => ({ sourceId: s.sourceId, kind: s.kind, code: s.code })),
      },
    });
  }
  let reason = `${chosen.source.kind} "${chosen.source.label}" for cloud sessions on a ${opts.personal ? "personal" : "shared"} runner`;
  if (skipped.length > 0)
    reason += `; skipped ${skipped.map((s) => `${s.kind} ${s.sourceId}: ${s.reason}`).join(", ")}`;
  logger.info("billing source chosen", {
    sourceId: chosen.source.id,
    kind: chosen.source.kind,
    reason,
  });
  return {
    sourceId: chosen.source.id,
    kind: chosen.source.kind,
    label: chosen.source.label,
    reason,
    skipped,
  };
}
