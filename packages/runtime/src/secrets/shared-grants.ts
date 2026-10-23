import { type Clock, ForerunnerError } from "@forerunner/platform";
import type {
  HumanRequestRow,
  JsonObject,
  SecretGrantBlob,
  SecretGrantRow,
  StateStore,
} from "@forerunner/state";
import { assertSecretName, isWrappedSecret, SECRET_NAME_PATTERN } from "@forerunner/vault";
import { isYes } from "../wiring/state-ports.ts";

/** The vault's name rule, re-exported for callers that validate bodies without depending on the vault package. */
export { SECRET_NAME_PATTERN };

/**
 * Shared secrets, the store side (spec S.13, ADR 0065). One module holds the rules so the
 * state service's routes (for an install that reaches the shared state over HTTP) and the
 * runtime's direct path (ADR 0024: the daemon and the runner talk to Postgres themselves)
 * enforce the same thing:
 *
 * - a grant names agents; every human other than the owner whose agent is named gets a
 *   `human_request` of kind `approval`, risk `high` (the phone needs the biometric
 *   confirmation of ADR 0009), with a `shared_secret_grant` change card;
 * - the grant is active only once every one of them approved; one refusal cancels it;
 *   the owner revokes at any time; both ends drop the wrapped blobs and withdraw open cards;
 * - a wrapped blob is served only for an active grant, only for the agent it names and the
 *   install (device) it was wrapped for; every serve and every refusal is an audit row;
 * - no value: the owner's install wraps before anything reaches this module, and the
 *   module stores, serves and logs ciphertext, names and ids only.
 *
 * `secret_ref` mirrors an active grant (`scope: "shared"`, the named agents in `granted_to`)
 * so the existing "which secrets may this agent use" reads stay one table.
 */

export const SHARED_SECRET_CARD_KIND = "shared_secret_grant";
export const SHARED_SECRET_OPTIONS = ["approve", "deny"] as const;

export const SHARED_SECRET_AUDIT = {
  proposed: "secret.grant_proposed",
  approved: "secret.grant_approved",
  activated: "secret.grant_activated",
  refused: "secret.grant_refused",
  revoked: "secret.grant_revoked",
  served: "secret.blob_served",
  refused_serve: "secret.blob_refused",
  /** Written by the resolving install when it unwrapped a blob for a tool call. */
  resolved: "secret.shared_resolved",
} as const;

/** The store surface this module needs; the service's `RouteContext.store` and the daemon's store both have it. */
export type SharedGrantStore = Pick<
  StateStore,
  "secretGrant" | "secretRef" | "humanRequest" | "human" | "agent" | "device" | "auditLog"
>;

export interface WrapTarget {
  agentId: string;
  humanId: string;
  deviceId: string;
  deviceName: string;
  deviceKind: string;
  wrapPublicKey: string;
}

export interface ProposeSharedGrantInput {
  ownerHumanId: string;
  name: string;
  kind?: string;
  why?: string;
  agentIds: string[];
  /** One wrapped copy per (agent, install); the owner's install made them. */
  blobs: { agentId: string; deviceId: string; blob: unknown }[];
}

export interface SharedGrantOptions {
  clock: Clock;
  /** The calling install (`X-Forerunner-Install` or the daemon's device), for the audit row. */
  installId?: string | null;
}

/** What callers and devices see of a grant: never the blobs. */
export interface SharedGrantView {
  id: string;
  name: string;
  kind: string;
  why: string;
  ownerHumanId: string;
  agentIds: string[];
  requiredHumanIds: string[];
  approvedHumanIds: string[];
  requestIds: string[];
  status: SecretGrantRow["status"];
  blobCount: number;
  activatedAt: string | null;
  lastServed: string | null;
  endedAt: string | null;
  endedReason: string | null;
  createdAt: string;
  version: number;
}

export function sharedGrantView(g: SecretGrantRow): SharedGrantView {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    why: g.why,
    ownerHumanId: g.owner_human_id,
    agentIds: g.agent_ids,
    requiredHumanIds: g.required_human_ids,
    approvedHumanIds: Object.keys(g.approvals).sort(),
    requestIds: g.request_ids,
    status: g.status,
    blobCount: g.blobs.length,
    activatedAt: g.activated_at,
    lastServed: g.last_served,
    endedAt: g.ended_at,
    endedReason: g.ended_reason,
    createdAt: g.created_at,
    version: g.version,
  };
}

/**
 * Where a secret shared with these agents must be wrapped to: every non-revoked device of
 * each agent's owner that registered an install wrapping key (the PC daemon, a cloud
 * runner). Phones and web pages have no key and get nothing (spec R.7).
 */
export async function wrapTargetsFor(
  store: Pick<SharedGrantStore, "agent" | "device">,
  agentIds: string[],
): Promise<WrapTarget[]> {
  const out: WrapTarget[] = [];
  for (const agentId of agentIds) {
    const agent = await store.agent.get(agentId);
    if (!agent)
      throw new ForerunnerError("not_found", `agent ${agentId} not found`, {
        details: { agentId },
      });
    const devices = await store.device.active(agent.owner_human_id);
    for (const d of devices) {
      if (!d.wrap_public_key) continue;
      out.push({
        agentId,
        humanId: agent.owner_human_id,
        deviceId: d.id,
        deviceName: d.name,
        deviceKind: d.kind,
        wrapPublicKey: d.wrap_public_key,
      });
    }
  }
  return out;
}

function summary(parts: Record<string, unknown>): string {
  return Object.entries(parts)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : String(v)}`)
    .join(" ");
}

async function audit(
  store: Pick<SharedGrantStore, "auditLog">,
  clock: Clock,
  row: {
    tool: string;
    humanId: string | null;
    agentId?: string | null;
    input: Record<string, unknown>;
    result: string;
    allowed?: boolean;
    deniedReason?: string | null;
  },
): Promise<void> {
  await store.auditLog.append({
    tool: row.tool,
    human_id: row.humanId,
    agent_id: row.agentId ?? null,
    input_summary: summary(row.input),
    result_summary: row.result,
    allowed: row.allowed ?? true,
    denied_reason: row.deniedReason ?? null,
    occurred_at: clock.nowIso(),
  });
}

/**
 * File a grant: validates the owner, the agents, every blob's install (a non-revoked device of
 * that agent's owner with a wrapping key) and shape, and that every named agent has at least
 * one wrapped copy; then writes the row, one approval card per other human, and the audit row.
 */
export async function proposeSharedGrant(
  store: SharedGrantStore,
  input: ProposeSharedGrantInput,
  opts: SharedGrantOptions,
): Promise<{ grant: SecretGrantRow; requests: HumanRequestRow[] }> {
  const name = assertSecretName(input.name);
  const owner = await store.human.get(input.ownerHumanId);
  if (!owner) {
    throw new ForerunnerError("not_found", `human ${input.ownerHumanId} not found`, {
      details: { humanId: input.ownerHumanId },
    });
  }
  const agentIds = [...new Set(input.agentIds)];
  if (agentIds.length === 0) {
    throw new ForerunnerError("validation", "a shared secret names at least one agent");
  }
  const owners = new Map<string, string>();
  const agentNames: string[] = [];
  for (const id of agentIds) {
    const agent = await store.agent.get(id);
    if (!agent) {
      throw new ForerunnerError("not_found", `agent ${id} not found`, { details: { agentId: id } });
    }
    owners.set(id, agent.owner_human_id);
    agentNames.push(agent.name);
  }
  const blobs: SecretGrantBlob[] = [];
  const seen = new Set<string>();
  for (const b of input.blobs) {
    const agentOwner = owners.get(b.agentId);
    if (!agentOwner) {
      throw new ForerunnerError("validation", "a blob names an agent the grant does not", {
        details: { agentId: b.agentId },
      });
    }
    const device = await store.device.get(b.deviceId);
    if (!device || device.revoked || device.owner_human_id !== agentOwner) {
      throw new ForerunnerError("validation", "a blob names an install that is not the agent's", {
        details: { agentId: b.agentId, deviceId: b.deviceId },
      });
    }
    if (!device.wrap_public_key) {
      throw new ForerunnerError("validation", "that install has no wrapping key", {
        details: { deviceId: b.deviceId },
      });
    }
    if (!isWrappedSecret(b.blob)) {
      throw new ForerunnerError("validation", "a blob is not a wrapped secret", {
        details: { agentId: b.agentId, deviceId: b.deviceId },
      });
    }
    const key = `${b.agentId}:${b.deviceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blobs.push({
      agent_id: b.agentId,
      device_id: b.deviceId,
      blob: b.blob as unknown as JsonObject,
    });
  }
  for (const id of agentIds) {
    if (!blobs.some((b) => b.agent_id === id)) {
      throw new ForerunnerError("validation", "every named agent needs a wrapped copy", {
        details: { agentId: id },
      });
    }
  }
  const required = [...new Set([...owners.values()])].filter((h) => h !== owner.id).sort();
  const why = input.why?.trim() ?? "";
  const kind = input.kind?.trim() || "token";

  const grant = await store.secretGrant.propose({
    name,
    owner_human_id: owner.id,
    kind,
    why,
    agent_ids: agentIds,
    required_human_ids: required,
    blobs,
    author_human: owner.id,
  });
  const requests: HumanRequestRow[] = [];
  for (const humanId of required) {
    const theirs = agentIds.filter((id) => owners.get(id) === humanId);
    const theirNames = theirs.map((id) => agentNames[agentIds.indexOf(id)] ?? id);
    requests.push(
      await store.humanRequest.insert({
        human_id: humanId,
        kind: "approval",
        why: `${owner.name} wants to share the secret "${name}" with ${theirNames.join(", ")}${why ? `: ${why}` : ""}`,
        steps: [
          `Secret: ${name} (${kind}), owned by ${owner.name}`,
          `Readable by: ${theirNames.join(", ")}`,
          "The value stays encrypted to your install; it is never shown to you or to the service.",
          "Approve to let the named agent use it by reference, deny to cancel the grant.",
        ],
        options: [...SHARED_SECRET_OPTIONS],
        blocking: false,
        risk: "high",
        change_card: {
          kind: SHARED_SECRET_CARD_KIND,
          grantId: grant.id,
          name,
          secretKind: kind,
          ownerHumanId: owner.id,
          ownerName: owner.name,
          agentIds: theirs,
          agentNames: theirNames,
          why,
        },
        author_human: owner.id,
      }),
    );
  }
  let row = grant;
  if (requests.length > 0) {
    row = await store.secretGrant.patch(grant.id, { request_ids: requests.map((r) => r.id) });
  } else {
    await mirrorActive(store, row);
  }
  await audit(store, opts.clock, {
    tool: SHARED_SECRET_AUDIT.proposed,
    humanId: owner.id,
    input: {
      grant: grant.id,
      name,
      agents: agentIds,
      installs: blobs.map((b) => b.device_id),
      install: opts.installId,
    },
    result:
      required.length === 0
        ? "active: only the owner's agents are named"
        : `pending approval of ${required.join(", ")}`,
  });
  if (required.length === 0) {
    await audit(store, opts.clock, {
      tool: SHARED_SECRET_AUDIT.activated,
      humanId: owner.id,
      input: { grant: grant.id, name, agents: agentIds },
      result: "active",
    });
  }
  return { grant: row, requests };
}

/** The grant id a request's change card names, when the request is a shared-secret approval. */
export function sharedGrantIdOf(request: Pick<HumanRequestRow, "change_card">): string | null {
  const card = request.change_card;
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const c = card as { kind?: unknown; grantId?: unknown };
  return c.kind === SHARED_SECRET_CARD_KIND && typeof c.grantId === "string" ? c.grantId : null;
}

/**
 * Apply an answered approval card to its grant. Call it inside the transaction that answered
 * the request so the answer and the grant move together. A yes records the human's approval
 * (the grant turns active with the last one); anything else cancels the grant, drops the
 * blobs and withdraws the other humans' open cards. Returns the grant, or null when the
 * request is not a shared-secret card.
 */
export async function applySharedGrantAnswer(
  tx: SharedGrantStore,
  request: HumanRequestRow,
  by: string,
  opts: SharedGrantOptions,
): Promise<SecretGrantRow | null> {
  const grantId = sharedGrantIdOf(request);
  if (!grantId) return null;
  const grant = await tx.secretGrant.get(grantId);
  if (!grant) return null;
  if (grant.status !== "pending") return grant;
  const humanId = request.human_id ?? by;
  if (isYes(request.answer)) {
    const row = await tx.secretGrant.approve(grant.id, grant.version, humanId, request.id);
    await audit(tx, opts.clock, {
      tool: SHARED_SECRET_AUDIT.approved,
      humanId,
      input: { grant: grant.id, name: grant.name, request: request.id, install: opts.installId },
      result:
        row.status === "active"
          ? "approved; every named human approved"
          : "approved; waiting for others",
    });
    if (row.status === "active") {
      await mirrorActive(tx, row);
      await audit(tx, opts.clock, {
        tool: SHARED_SECRET_AUDIT.activated,
        humanId: row.owner_human_id,
        input: { grant: row.id, name: row.name, agents: row.agent_ids },
        result: "active",
      });
    }
    return row;
  }
  const row = await tx.secretGrant.end(
    grant.id,
    grant.version,
    "cancelled",
    `refused by ${humanId}`,
    humanId,
  );
  await withdrawOpenCards(tx, row, request.id);
  await audit(tx, opts.clock, {
    tool: SHARED_SECRET_AUDIT.refused,
    humanId,
    input: { grant: grant.id, name: grant.name, request: request.id, install: opts.installId },
    result: "cancelled; wrapped copies dropped",
    allowed: false,
    deniedReason: "refused",
  });
  return row;
}

/** The owner ends a grant: pending or active, the blobs go and the open cards are withdrawn. */
export async function revokeSharedGrant(
  store: SharedGrantStore,
  grantId: string,
  opts: SharedGrantOptions & { by: string | null; reason?: string },
): Promise<SecretGrantRow> {
  const grant = await store.secretGrant.get(grantId);
  if (!grant) {
    throw new ForerunnerError("not_found", `secret grant ${grantId} not found`, {
      details: { id: grantId },
    });
  }
  if (grant.status === "revoked" || grant.status === "cancelled") return grant;
  const row = await store.secretGrant.end(
    grant.id,
    grant.version,
    "revoked",
    opts.reason ?? "revoked by the owner",
    opts.by,
  );
  await withdrawOpenCards(store, row, null);
  await mirrorEnded(store, row);
  await audit(store, opts.clock, {
    tool: SHARED_SECRET_AUDIT.revoked,
    humanId: opts.by ?? row.owner_human_id,
    input: { grant: row.id, name: row.name, agents: row.agent_ids, install: opts.installId },
    result: "revoked; wrapped copies dropped",
  });
  return row;
}

/**
 * The one read that hands a blob out: an active grant of `name` naming `agentId`, the copy
 * wrapped for `deviceId`. Anything else is `secret_not_granted` after an audit row, with the
 * reason and never a blob.
 */
export async function serveSharedBlob(
  store: SharedGrantStore,
  req: { name: string; agentId: string; deviceId: string },
  opts: SharedGrantOptions,
): Promise<{ grant: SecretGrantRow; blob: SecretGrantBlob }> {
  const name = assertSecretName(req.name);
  const agent = await store.agent.get(req.agentId);
  const device = await store.device.get(req.deviceId);
  const refuse = async (reason: string): Promise<never> => {
    await audit(store, opts.clock, {
      tool: SHARED_SECRET_AUDIT.refused_serve,
      humanId: agent?.owner_human_id ?? null,
      agentId: req.agentId,
      input: { name, agent: req.agentId, device: req.deviceId, install: opts.installId },
      result: "refused",
      allowed: false,
      deniedReason: reason,
    });
    throw new ForerunnerError(
      "secret_not_granted",
      `secret "${name}" is not shared with this agent on this install`,
      {
        details: { name, agentId: req.agentId, deviceId: req.deviceId, reason },
      },
    );
  };
  if (!agent) return refuse("unknown agent");
  if (!device || device.revoked) return refuse("unknown or revoked install");
  if (device.owner_human_id !== agent.owner_human_id) return refuse("install is not the agent's");
  const found = await store.secretGrant.blobFor(name, req.agentId, req.deviceId);
  if (!found) return refuse("no active grant for this agent on this install");
  await store.secretGrant.markServed(found.grant.id);
  await audit(store, opts.clock, {
    tool: SHARED_SECRET_AUDIT.served,
    humanId: agent.owner_human_id,
    agentId: req.agentId,
    input: {
      grant: found.grant.id,
      name,
      owner: found.grant.owner_human_id,
      device: req.deviceId,
      install: opts.installId,
    },
    result: "wrapped copy served",
  });
  return found;
}

async function withdrawOpenCards(
  store: Pick<SharedGrantStore, "humanRequest">,
  grant: SecretGrantRow,
  except: string | null,
): Promise<void> {
  for (const id of grant.request_ids) {
    if (id === except) continue;
    const r = await store.humanRequest.get(id);
    if (r && r.status === "open") await store.humanRequest.withdraw(r.id, r.version);
  }
}

/** An active grant joins `secret_ref` as a shared reference the named agents may use. */
async function mirrorActive(
  store: Pick<SharedGrantStore, "secretRef">,
  grant: SecretGrantRow,
): Promise<void> {
  const existing = await store.secretRef.byName(grant.owner_human_id, grant.name);
  if (existing) {
    await store.secretRef.update(existing.id, existing.version, {
      scope: "shared",
      granted_to: [...new Set([...existing.granted_to, ...grant.agent_ids])],
    });
    return;
  }
  await store.secretRef.insert({
    name: grant.name,
    scope: "shared",
    owner_human_id: grant.owner_human_id,
    granted_to: [...grant.agent_ids],
    kind: grant.kind,
    created_by: grant.owner_human_id,
    author_human: grant.owner_human_id,
  });
}

async function mirrorEnded(
  store: Pick<SharedGrantStore, "secretRef" | "secretGrant">,
  grant: SecretGrantRow,
): Promise<void> {
  const existing = await store.secretRef.byName(grant.owner_human_id, grant.name);
  if (!existing) return;
  // Another active grant of the same secret keeps its agents.
  const stillActive = (await store.secretGrant.forOwner(grant.owner_human_id, "active")).filter(
    (g) => g.name === grant.name && g.id !== grant.id,
  );
  const keep = new Set(stillActive.flatMap((g) => g.agent_ids));
  const granted = existing.granted_to.filter((a) => !grant.agent_ids.includes(a) || keep.has(a));
  await store.secretRef.update(existing.id, existing.version, {
    granted_to: granted,
    // A reference this module turned shared goes back to the owner's own scope with the last grant.
    ...(existing.scope === "shared" && stillActive.length === 0 ? { scope: "human" } : {}),
  });
}
