/**
 * Tokens, scopes, permissions and the rate limiter of the fake git host. Mirrors GitHub's
 * behaviour for the subset Forerunner uses: classic tokens carry OAuth scopes, fine-grained
 * and installation tokens carry per-permission read/write levels over an allowlist of repos,
 * repos outside a token's reach are 404 (not 403), and a missing permission is 403.
 */
import { randomBytes } from "node:crypto";
import type { Clock } from "@forerunner/platform";
import type { PermissionLevel, RepoPermission, TokenKind } from "./types.ts";

export interface TokenRecord {
  id: number;
  value: string;
  kind: TokenKind;
  owner: string;
  scopes: string[];
  permissions: Partial<Record<RepoPermission, PermissionLevel>>;
  /** Normalised allowlist: `owner/name`, `owner/*` or `*` (lowercase). */
  repos: string[];
  expiresAt: number | null;
  installationId: number | null;
  createdAt: string;
}

export interface RepoAccessView {
  owner: string;
  name: string;
  private: boolean;
  /** Logins (lowercase) with direct push access besides the owner. */
  collaborators: Set<string>;
}

export interface AccessSubject {
  token: TokenRecord | null;
  /** Logins (lowercase) of orgs the token owner belongs to, plus the owner itself. */
  affiliations: Set<string>;
}

export function newTokenValue(kind: TokenKind): string {
  const body = randomBytes(27)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "A");
  // Prefixes follow GitHub so redaction and secret scans treat these like the real thing.
  if (kind === "classic") return `ghp_${body}`;
  if (kind === "app_installation") return `ghs_${body}`;
  return `github_pat_${body}${randomBytes(30)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "B")}`;
}

export function normaliseRepoPattern(pattern: string, defaultOwner: string): string {
  const p = pattern.trim().toLowerCase();
  if (p === "*" || p.includes("/")) return p;
  return `${defaultOwner.toLowerCase()}/${p}`;
}

export function matchesAllowlist(repos: string[], repo: RepoAccessView): boolean {
  const full = `${repo.owner}/${repo.name}`.toLowerCase();
  const ownerWild = `${repo.owner.toLowerCase()}/*`;
  return repos.some((r) => r === "*" || r === full || r === ownerWild);
}

/** True when the subject belongs to the repo's owner (owner, org member or collaborator). */
export function isAffiliated(subject: AccessSubject, repo: RepoAccessView): boolean {
  if (!subject.token) return false;
  const login = subject.token.owner.toLowerCase();
  return subject.affiliations.has(repo.owner.toLowerCase()) || repo.collaborators.has(login);
}

/** Visibility: false means "404 Not Found", exactly like GitHub hides private repos. */
export function canSeeRepo(subject: AccessSubject, repo: RepoAccessView): boolean {
  const t = subject.token;
  if (!t) return !repo.private;
  if (t.kind === "classic") {
    if (!repo.private) return true;
    return t.scopes.includes("repo") && isAffiliated(subject, repo);
  }
  // fine-grained and installation tokens: the allowlist decides; public repos are readable
  if (
    matchesAllowlist(t.repos, repo) &&
    (t.kind === "app_installation" || isAffiliated(subject, repo))
  )
    return true;
  return !repo.private;
}

const CLASSIC_SPECIAL: Partial<Record<RepoPermission, Record<PermissionLevel, string[]>>> = {
  webhooks: {
    read: ["admin:repo_hook", "write:repo_hook", "read:repo_hook", "repo"],
    write: ["admin:repo_hook", "write:repo_hook", "repo"],
  },
  projects: { read: ["project", "read:project", "repo"], write: ["project", "repo"] },
  statuses: { read: ["repo:status", "repo"], write: ["repo:status", "repo"] },
  administration: { read: ["repo", "public_repo"], write: ["repo", "public_repo", "delete_repo"] },
};

function classicAllows(
  scopes: string[],
  repo: RepoAccessView,
  perm: RepoPermission,
  level: PermissionLevel,
): boolean {
  if (perm === "metadata") return true;
  const special = CLASSIC_SPECIAL[perm];
  if (special) {
    if (special[level].some((s) => scopes.includes(s))) return true;
    return !repo.private && level === "read" && perm !== "webhooks";
  }
  if (!repo.private && level === "read") return true;
  if (scopes.includes("repo")) return true;
  if (!repo.private && scopes.includes("public_repo")) return true;
  return false;
}

function grantedAllows(
  permissions: Partial<Record<RepoPermission, PermissionLevel>>,
  perm: RepoPermission,
  level: PermissionLevel,
): boolean {
  if (perm === "metadata") return true;
  const have = permissions[perm];
  if (!have) return false;
  return level === "read" || have === "write";
}

export type AccessDecision = "ok" | "not_found" | "forbidden" | "unauthenticated";

/** Combined visibility and permission check for one repo operation. */
export function checkRepoAccess(
  subject: AccessSubject,
  repo: RepoAccessView,
  perm: RepoPermission,
  level: PermissionLevel,
): AccessDecision {
  if (!canSeeRepo(subject, repo)) return "not_found";
  const t = subject.token;
  if (!t) {
    return !repo.private && level === "read" && (perm === "metadata" || perm === "contents")
      ? "ok"
      : "unauthenticated";
  }
  if (t.kind === "classic") {
    if (!isAffiliated(subject, repo) && (level === "write" || repo.private)) return "forbidden";
    return classicAllows(t.scopes, repo, perm, level) ? "ok" : "forbidden";
  }
  const inList = matchesAllowlist(t.repos, repo);
  if (!inList) {
    // a public repo outside the allowlist: read-only like an anonymous client
    return level === "read" && (perm === "metadata" || perm === "contents") ? "ok" : "forbidden";
  }
  if (
    t.kind === "fine_grained" &&
    !isAffiliated(subject, repo) &&
    (level === "write" || repo.private)
  )
    return "forbidden";
  return grantedAllows(t.permissions, perm, level) ? "ok" : "forbidden";
}

/** Can the subject create repositories under `owner`? */
export function canCreateRepo(
  subject: AccessSubject,
  owner: string,
  isPrivate: boolean,
): AccessDecision {
  const t = subject.token;
  if (!t) return "unauthenticated";
  if (!subject.affiliations.has(owner.toLowerCase())) return "not_found";
  if (t.kind === "classic") {
    if (t.scopes.includes("repo")) return "ok";
    if (!isPrivate && t.scopes.includes("public_repo")) return "ok";
    return "forbidden";
  }
  return t.permissions.administration === "write" ? "ok" : "forbidden";
}

export interface RateLimitState {
  limit: number;
  used: number;
  remaining: number;
  /** Unix seconds, like GitHub's X-RateLimit-Reset. */
  reset: number;
}

/** Fixed one-hour windows per key, driven by the injected clock. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; used: number }>();

  constructor(
    private readonly clock: Clock,
    readonly limit: number,
  ) {}

  private window(key: string): { start: number; used: number } {
    const now = this.clock.now();
    let w = this.windows.get(key);
    if (!w || now - w.start >= 3_600_000) {
      w = { start: now, used: 0 };
      this.windows.set(key, w);
    }
    return w;
  }

  /** Consume one request. `exceeded` is true when the request must be refused. */
  consume(key: string): RateLimitState & { exceeded: boolean } {
    const w = this.window(key);
    if (w.used >= this.limit) {
      return { ...this.describe(w), exceeded: true };
    }
    w.used += 1;
    return { ...this.describe(w), exceeded: false };
  }

  peek(key: string): RateLimitState {
    return this.describe(this.window(key));
  }

  private describe(w: { start: number; used: number }): RateLimitState {
    return {
      limit: this.limit,
      used: w.used,
      remaining: Math.max(0, this.limit - w.used),
      reset: Math.floor((w.start + 3_600_000) / 1000),
    };
  }
}
