/**
 * Shared HTTP plumbing for the REST routes: the Hono environment, GitHub-style error bodies,
 * tolerant JSON body parsing, pagination with a `Link` header and the repo/permission guard.
 */
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type AccessSubject,
  checkRepoAccess,
  type RateLimitState,
  type TokenRecord,
} from "./auth.ts";
import type { HostStore, Json, RepoRecord } from "./store.ts";
import type { PermissionLevel, RepoPermission } from "./types.ts";

export interface AuthContext {
  token: TokenRecord | null;
  subject: AccessSubject;
  login: string | null;
  /** Decoded payload of a GitHub App JWT (`Authorization: Bearer <jwt>` on /app routes). */
  appJwt: Json | null;
}

export type HostEnv = {
  Variables: {
    auth: AuthContext;
    rate: RateLimitState | null;
  };
};

export type HostApp = Hono<HostEnv>;
export type HostContext = Context<HostEnv>;

export const DOCS_URL = "https://docs.github.com/rest";

export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly extra: Json = {},
  ) {
    super(message);
    this.name = "HttpError";
  }

  body(): Json {
    return { message: this.message, documentation_url: DOCS_URL, ...this.extra };
  }
}

export function validationFailed(
  errors: Array<{ resource: string; field: string; code: string; message?: string }>,
  message = "Validation Failed",
): HttpError {
  return new HttpError(422, message, { errors });
}

/** Parse a JSON body; an empty or invalid body is `{}` (GitHub ignores it for most routes). */
export async function readJson(c: HostContext): Promise<Json> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    throw new HttpError(400, "Problems parsing JSON");
  }
}

export function str(body: Json, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

export function requireStr(body: Json, key: string, resource: string): string {
  const v = str(body, key);
  if (v === undefined || v.length === 0) {
    throw validationFailed([{ resource, field: key, code: "missing_field" }]);
  }
  return v;
}

export function bool(body: Json, key: string): boolean | undefined {
  const v = body[key];
  return typeof v === "boolean" ? v : typeof v === "string" ? v === "true" : undefined;
}

export function num(body: Json, key: string): number | undefined {
  const v = body[key];
  return typeof v === "number"
    ? v
    : typeof v === "string" && /^\d+$/.test(v)
      ? Number(v)
      : undefined;
}

export function strList(body: Json, key: string): string[] | undefined {
  const v = body[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === "string");
}

export function intParam(c: HostContext, name: string): number {
  const raw = c.req.param(name) ?? "";
  if (!/^\d+$/.test(raw)) throw new HttpError(404, "Not Found");
  return Number(raw);
}

/** Apply `page`/`per_page` and set GitHub's `Link` header. */
export function paginate<T>(c: HostContext, items: T[]): T[] {
  const perPage = Math.min(100, Math.max(1, Number(c.req.query("per_page") ?? 30) || 30));
  const page = Math.max(1, Number(c.req.query("page") ?? 1) || 1);
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const url = new URL(c.req.url);
  const link = (p: number, rel: string) => {
    url.searchParams.set("page", String(p));
    url.searchParams.set("per_page", String(perPage));
    return `<${url.toString()}>; rel="${rel}"`;
  };
  const links: string[] = [];
  if (page < pages) links.push(link(page + 1, "next"), link(pages, "last"));
  if (page > 1) links.push(link(1, "first"), link(page - 1, "prev"));
  if (links.length > 0) c.header("Link", links.join(", "));
  return items.slice((page - 1) * perPage, page * perPage);
}

export function forbiddenMessage(token: TokenRecord | null): string {
  if (token?.kind === "app_installation") return "Resource not accessible by integration";
  return "Resource not accessible by personal access token";
}

/** Resolve `:owner/:repo` and enforce visibility (404) and permission (401/403). */
export function requireRepo(
  c: HostContext,
  store: HostStore,
  perm: RepoPermission,
  level: PermissionLevel,
): RepoRecord {
  const repo = store.repo(c.req.param("owner") ?? "", c.req.param("repo") ?? "");
  if (!repo) throw new HttpError(404, "Not Found");
  return guardRepo(c, repo, perm, level);
}

export function guardRepo(
  c: HostContext,
  repo: RepoRecord,
  perm: RepoPermission,
  level: PermissionLevel,
): RepoRecord {
  const auth = c.get("auth");
  const decision = checkRepoAccess(auth.subject, repo, perm, level);
  if (decision === "not_found") throw new HttpError(404, "Not Found");
  if (decision === "unauthenticated") throw new HttpError(401, "Requires authentication");
  if (decision === "forbidden") throw new HttpError(403, forbiddenMessage(auth.token));
  return repo;
}

export function requireLogin(c: HostContext): string {
  const auth = c.get("auth");
  if (!auth.login) throw new HttpError(401, "Requires authentication");
  return auth.login;
}

/** Path remainder after a wildcard route prefix, URL-decoded, without a leading slash. */
export function wildcardPath(c: HostContext, marker: string): string {
  const path = c.req.path;
  const idx = path.indexOf(marker);
  if (idx === -1) return "";
  return decodeURIComponent(path.slice(idx + marker.length)).replace(/^\/+/, "");
}
