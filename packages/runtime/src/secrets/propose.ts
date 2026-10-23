import { ForerunnerError } from "@forerunner/platform";
import { assertSecretName, type Vault, wrapSecret } from "@forerunner/vault";
import type { SharedSecretService } from "./resolver.ts";
import type { SharedGrantView } from "./shared-grants.ts";

/**
 * The owner's side of a shared secret (spec S.13, ADR 0065): read the value from this
 * install's own vault, wrap it to every install of every named agent (the targets the
 * service lists: non-revoked devices of the agent's owner with a wrapping key) and file the
 * grant. The value leaves this function only inside the wrapped blobs; the proposal body,
 * the grant row, the approval cards and every audit row carry names and ids.
 */
export interface ProposeSharedSecretOptions {
  vault: Vault;
  service: SharedSecretService;
  ownerHumanId: string;
  name: string;
  agentIds: string[];
  why?: string;
  kind?: string;
}

export interface ProposedSharedSecret {
  grant: SharedGrantView;
  requestIds: string[];
  /** Which installs received a wrapped copy, per agent. */
  targets: { agentId: string; deviceId: string; deviceName: string }[];
}

export async function proposeSharedSecret(
  opts: ProposeSharedSecretOptions,
): Promise<ProposedSharedSecret> {
  const name = assertSecretName(opts.name);
  const agentIds = [...new Set(opts.agentIds)];
  if (agentIds.length === 0) {
    throw new ForerunnerError("validation", "a shared secret names at least one agent");
  }
  const targets = await opts.service.wrapTargets(agentIds);
  for (const agentId of agentIds) {
    if (!targets.some((t) => t.agentId === agentId)) {
      throw new ForerunnerError(
        "validation",
        `agent ${agentId} has no install with a wrapping key; start its daemon or runner first`,
        { details: { agentId } },
      );
    }
  }
  const value = await opts.vault.get(name);
  if (value === null) {
    throw new ForerunnerError("not_found", `secret "${name}" is not in the vault`, {
      details: { name },
    });
  }
  const blobs = targets.map((t) => ({
    agentId: t.agentId,
    deviceId: t.deviceId,
    blob: wrapSecret(value, t.wrapPublicKey, {
      name,
      ownerHumanId: opts.ownerHumanId,
      agentId: t.agentId,
      deviceId: t.deviceId,
    }),
  }));
  const { grant, requestIds } = await opts.service.propose({
    ownerHumanId: opts.ownerHumanId,
    name,
    agentIds,
    blobs,
    ...(opts.why !== undefined ? { why: opts.why } : {}),
    ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
  });
  return {
    grant,
    requestIds,
    targets: targets.map((t) => ({
      agentId: t.agentId,
      deviceId: t.deviceId,
      deviceName: t.deviceName,
    })),
  };
}
