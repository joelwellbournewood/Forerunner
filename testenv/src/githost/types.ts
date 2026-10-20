/**
 * Public types of the fake git host (GitHub stand-in). The REST shapes it serves are GitHub's
 * (snake_case, `id`, `node_id`, `number`, `html_url`); these types describe the admin API that
 * tests call directly and the records the host keeps about what happened.
 */
import type { Clock } from "@forerunner/platform";

export type TokenKind = "classic" | "fine_grained" | "app_installation";
export type PermissionLevel = "read" | "write";

/** Fine-grained permission names, as GitHub spells them. `metadata` is implicit on any token. */
export type RepoPermission =
  | "metadata"
  | "contents"
  | "pull_requests"
  | "issues"
  | "checks"
  | "statuses"
  | "webhooks"
  | "projects"
  | "administration";

export type WebhookEventName =
  | "ping"
  | "push"
  | "pull_request"
  | "pull_request_review"
  | "issues"
  | "issue_comment"
  | "check_run"
  | "status"
  | "release"
  | "create"
  | "delete";

export interface FakeGitHostOptions {
  /** Bare repositories live under `<rootDir>/<owner>/<name>.git`. Use a temp dir. */
  rootDir: string;
  clock?: Clock;
  /** Core API rate limit per token (and per anonymous client). Default 5000, like GitHub. */
  rateLimit?: { perHour: number };
  /** Bind address. Default 127.0.0.1 on an ephemeral port. */
  host?: string;
  port?: number;
}

export interface CreateUserInput {
  login: string;
  name?: string;
  email?: string;
}

export interface CreateOrgInput {
  login: string;
  name?: string;
  /** Logins of member users. Members see the org's private repos with a `repo`-scoped token. */
  members?: string[];
}

export type CreateTokenInput =
  | { owner: string; kind: "classic"; scopes: string[]; expiresAt?: string | null }
  | {
      owner: string;
      kind: "fine_grained";
      permissions: Partial<Record<RepoPermission, PermissionLevel>>;
      /** Repos the token may see: `name`, `owner/name`, `owner/*` or `*`. */
      repos: string[];
      expiresAt?: string | null;
    }
  | {
      owner: string;
      kind: "app_installation";
      installationId: number;
      permissions?: Partial<Record<RepoPermission, PermissionLevel>>;
      repos?: string[];
      expiresAt?: string | null;
    };

export interface IssuedToken {
  id: number;
  /** The secret value. Keep it out of logs and assertions output. */
  token: string;
  kind: TokenKind;
  owner: string;
  scopes: string[];
  permissions: Partial<Record<RepoPermission, PermissionLevel>>;
  repos: string[];
  expiresAt: string | null;
  installationId: number | null;
}

export interface CreateRepoInput {
  owner: string;
  name: string;
  private?: boolean;
  defaultBranch?: string;
  description?: string;
  /** Files for an initial commit on the default branch; keys are POSIX paths. */
  initialFiles?: Record<string, string | Uint8Array>;
}

export interface CreateAppInput {
  slug: string;
  name?: string;
  owner: string;
}

export interface CreateInstallationInput {
  appId: number;
  /** User or org login the app is installed on. */
  account: string;
  /** `"all"` or a list of repo names / full names under that account. */
  repos: string[] | "all";
  permissions: Partial<Record<RepoPermission, PermissionLevel>>;
}

export interface SeedCommitResult {
  sha: string;
  branch: string;
}

export interface WebhookDelivery {
  id: string;
  hookId: number;
  url: string;
  event: WebhookEventName;
  action: string | null;
  status: "pending" | "delivered" | "failed";
  responseStatus: number | null;
  error: string | null;
  /** The `X-Hub-Signature-256` header sent, or null when the hook has no secret. */
  signature256: string | null;
  at: string;
}

/** One event the host emitted (whether or not a hook was registered for it). */
export interface HostEvent {
  id: string;
  event: WebhookEventName;
  action: string | null;
  repo: string;
  payload: Record<string, unknown>;
  at: string;
  deliveries: WebhookDelivery[];
}

export interface RequestLogEntry {
  id: number;
  at: string;
  method: string;
  path: string;
  query: string;
  status: number;
  /** Token kind and owner login; never the token value. */
  auth: { kind: TokenKind; login: string; tokenId: number } | null;
  durationMs: number;
}
