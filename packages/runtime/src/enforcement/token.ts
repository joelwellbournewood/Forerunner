import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ForerunnerError, newId } from "@forerunner/platform";

/**
 * Capability token: the authority a run has. Issued by the runtime, verified by the hooks
 * on every tool call. The model only ever sees the token id, never the token or the key, so
 * no text in a prompt, web page or email can widen a token.
 */
export interface CapabilityClaims {
  /** Token id; this is what appears in logs and in the model context. */
  id: string;
  runId: string;
  sessionId: string;
  agentId: string;
  ownerHumanId: string;
  projectId?: string;
  taskId?: string;
  /** Tool names this run may call. "*" is never allowed in a token. */
  allowedTools: string[];
  /** Absolute roots the run may read/write under. Empty = no filesystem access. */
  allowedPaths: string[];
  /** Hostnames the run may reach; "*.example.com" allows subdomains. Empty = no network. */
  allowedDomains: string[];
  /** Secret names (without the "secret:" prefix) that may be injected into tool calls. */
  grantedSecrets: string[];
  /** Hard cap for this run in USD micro-units. */
  budgetUsdMicro: number;
  /** Spawn depth of this run (principal = 0). */
  depth: number;
  maxDepth: number;
  /** Autonomy level in force for the project (0-4). */
  autonomy: 0 | 1 | 2 | 3 | 4;
  /** True once the human approved the session plan (autonomy level 1). */
  planApproved: boolean;
  issuedAt: string;
  expiresAt: string;
}

export interface SignedToken {
  claims: CapabilityClaims;
  signature: string;
}

export class TokenIssuer {
  private readonly key: Buffer;
  private readonly revoked = new Set<string>();
  private readonly issued = new Map<string, SignedToken>();
  private readonly now: () => number;

  constructor(opts: { key?: Buffer; now?: () => number } = {}) {
    this.key = opts.key ?? randomBytes(32);
    this.now = opts.now ?? (() => Date.now());
  }

  issue(
    claims: Omit<CapabilityClaims, "id" | "issuedAt"> & { id?: string; issuedAt?: string },
  ): SignedToken {
    if (claims.allowedTools.includes("*")) {
      throw new ForerunnerError("validation", "a capability token cannot allow every tool");
    }
    if (claims.depth > claims.maxDepth) {
      throw new ForerunnerError(
        "depth_exceeded",
        `spawn depth ${claims.depth} exceeds max ${claims.maxDepth}`,
        {
          details: { depth: claims.depth, maxDepth: claims.maxDepth },
        },
      );
    }
    if (!Number.isFinite(claims.budgetUsdMicro) || claims.budgetUsdMicro < 0) {
      throw new ForerunnerError("validation", "token budget must be a non-negative number");
    }
    const full: CapabilityClaims = {
      ...claims,
      id: claims.id ?? newId(this.now()),
      issuedAt: claims.issuedAt ?? new Date(this.now()).toISOString(),
      allowedTools: [...new Set(claims.allowedTools)].sort(),
      allowedPaths: [...claims.allowedPaths],
      allowedDomains: [...claims.allowedDomains].map((d) => d.toLowerCase()),
      grantedSecrets: [...new Set(claims.grantedSecrets)],
    };
    const token = { claims: full, signature: this.sign(full) };
    this.issued.set(full.id, token);
    return token;
  }

  /** Derive a narrower token for a sub-agent. Never widens anything. */
  derive(
    parent: SignedToken,
    overrides: Partial<
      Pick<
        CapabilityClaims,
        | "allowedTools"
        | "allowedPaths"
        | "allowedDomains"
        | "grantedSecrets"
        | "budgetUsdMicro"
        | "taskId"
        | "expiresAt"
      >
    > & { runId: string },
  ): SignedToken {
    const p = this.verify(parent);
    const sub = <T>(requested: T[] | undefined, parentSet: T[]): T[] =>
      requested === undefined ? [...parentSet] : requested.filter((x) => parentSet.includes(x));
    const budget = Math.min(overrides.budgetUsdMicro ?? p.budgetUsdMicro, p.budgetUsdMicro);
    return this.issue({
      runId: overrides.runId,
      sessionId: p.sessionId,
      agentId: p.agentId,
      ownerHumanId: p.ownerHumanId,
      projectId: p.projectId,
      taskId: overrides.taskId ?? p.taskId,
      allowedTools: sub(overrides.allowedTools, p.allowedTools),
      allowedPaths: sub(overrides.allowedPaths, p.allowedPaths),
      allowedDomains: sub(overrides.allowedDomains, p.allowedDomains),
      grantedSecrets: sub(overrides.grantedSecrets, p.grantedSecrets),
      budgetUsdMicro: budget,
      depth: p.depth + 1,
      maxDepth: p.maxDepth,
      autonomy: p.autonomy,
      planApproved: p.planApproved,
      expiresAt:
        overrides.expiresAt && overrides.expiresAt < p.expiresAt
          ? overrides.expiresAt
          : p.expiresAt,
    });
  }

  verify(token: SignedToken, now: number = this.now()): CapabilityClaims {
    const expected = this.sign(token.claims);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(token.signature, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ForerunnerError("tool_not_allowed", "capability token signature invalid", {
        details: { tokenId: token.claims.id },
      });
    }
    if (this.revoked.has(token.claims.id)) {
      throw new ForerunnerError("killed", "capability token revoked", {
        details: { tokenId: token.claims.id },
      });
    }
    if (new Date(token.claims.expiresAt).getTime() <= now) {
      throw new ForerunnerError("timeout", "capability token expired", {
        details: { tokenId: token.claims.id },
      });
    }
    return token.claims;
  }

  revoke(tokenId: string): void {
    this.revoked.add(tokenId);
  }

  revokeWhere(pred: (c: CapabilityClaims) => boolean): string[] {
    const ids: string[] = [];
    for (const t of this.issued.values()) {
      if (pred(t.claims)) {
        this.revoked.add(t.claims.id);
        ids.push(t.claims.id);
      }
    }
    return ids;
  }

  isRevoked(tokenId: string): boolean {
    return this.revoked.has(tokenId);
  }

  private sign(claims: CapabilityClaims): string {
    const canonical = JSON.stringify(claims, Object.keys(claims).sort());
    return createHmac("sha256", this.key).update(canonical).digest("hex");
  }
}
