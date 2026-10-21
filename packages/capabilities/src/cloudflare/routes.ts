/**
 * Routes for the Extensions panel (S.5: "Each grant shows its scopes in the Extensions panel")
 * and the project settings screen. Mounted on any Hono-compatible app through the same minimal
 * structural interface the email routes use, so this package needs no dependency on hono; the
 * orchestrator does `createCloudflareRoutes(deps, app)`.
 *
 *   GET /cloudflare/projects/:projectId/settings   the settings (secret by reference, never a value)
 *   GET /cloudflare/projects/:projectId/token      verifyToken(): status, scopes, warnings
 *
 * Nothing here changes anything on Cloudflare.
 */
import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { ProjectRow } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import { CloudflareClient, cloudflareTokenSource } from "./client.ts";
import { cloudflareSettingsOf, scopeOf, standInBaseUrlOf } from "./settings.ts";

export interface CloudflareRouteRequest {
  param(name: string): string | undefined;
}

export interface CloudflareRouteContext {
  req: CloudflareRouteRequest;
  json(body: unknown, status?: number): Response;
}

export type CloudflareRouteHandler = (c: CloudflareRouteContext) => Promise<Response>;

/** The subset of Hono's app surface the routes need. */
export interface CloudflareRouteApp {
  get(path: string, handler: CloudflareRouteHandler): unknown;
}

export interface CloudflareRoute {
  method: "GET";
  path: string;
  handler: CloudflareRouteHandler;
}

export interface CloudflareRouteDeps {
  projects: { get(id: string): Promise<ProjectRow | undefined> };
  vault: Vault;
  clock: Clock;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

function statusOf(e: ForerunnerError): number {
  switch (e.code) {
    case "validation":
      return 400;
    case "not_found":
      return 404;
    case "provider_auth":
    case "tool_not_allowed":
      return 403;
    case "provider_rate_limit":
      return 429;
    case "unavailable":
      return 503;
    default:
      return 500;
  }
}

function fail(c: CloudflareRouteContext, e: unknown): Response {
  if (e instanceof ForerunnerError) return c.json({ error: e.toJSON() }, statusOf(e));
  return c.json({ error: { code: "internal", message: "internal error" } }, 500);
}

export function cloudflareRoutes(deps: CloudflareRouteDeps): CloudflareRoute[] {
  const settingsFor = async (c: CloudflareRouteContext) => {
    const id = c.req.param("projectId") ?? "";
    const project = await deps.projects.get(id);
    if (!project) throw new ForerunnerError("not_found", `no project ${id}`);
    const settings = cloudflareSettingsOf(project, { standInBaseUrl: standInBaseUrlOf(deps) });
    if (!settings) {
      throw new ForerunnerError("not_found", "Cloudflare is not configured for this project", {
        details: { projectId: id },
      });
    }
    return settings;
  };
  return [
    {
      method: "GET",
      path: "/cloudflare/projects/:projectId/settings",
      async handler(c) {
        try {
          const settings = await settingsFor(c);
          return c.json({ settings, scope: scopeOf(settings) });
        } catch (e) {
          return fail(c, e);
        }
      },
    },
    {
      method: "GET",
      path: "/cloudflare/projects/:projectId/token",
      async handler(c) {
        try {
          const settings = await settingsFor(c);
          const client = new CloudflareClient({
            scope: scopeOf(settings),
            token: cloudflareTokenSource({ vault: deps.vault, ref: settings.secret_ref }),
            baseUrl: deps.baseUrl ?? settings.base_url ?? standInBaseUrlOf(deps),
            fetchImpl: deps.fetchImpl,
            clock: deps.clock,
          });
          const verification = await client.verifyToken();
          return c.json({
            secret_ref: settings.secret_ref,
            scope: scopeOf(settings),
            verification,
          });
        } catch (e) {
          return fail(c, e);
        }
      },
    },
  ];
}

export function createCloudflareRoutes<A extends CloudflareRouteApp>(
  deps: CloudflareRouteDeps,
  app: A,
): A {
  for (const route of cloudflareRoutes(deps)) app.get(route.path, route.handler);
  return app;
}
