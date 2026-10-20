/**
 * GitHub App stand-in (installations and installation access tokens), rate limit and meta.
 */
import { newTokenValue, normaliseRepoPattern, type TokenRecord } from "./auth.ts";
import type { HostApp } from "./http.ts";
import { HttpError, intParam, readJson, strList } from "./http.ts";
import type { RouteContext } from "./routes-repos.ts";
import type { InstallationRecord, Json } from "./store.ts";
import type { PermissionLevel, RepoPermission } from "./types.ts";

export const INSTALLATION_TOKEN_TTL_MS = 60 * 60 * 1000;

function permissionsOf(raw: unknown): Partial<Record<RepoPermission, PermissionLevel>> {
  const out: Partial<Record<RepoPermission, PermissionLevel>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Json)) {
    if (v === "read" || v === "write") out[k as RepoPermission] = v;
  }
  return out;
}

export function registerAppRoutes(
  app: HostApp,
  ctx: RouteContext & {
    issueInstallationToken: (
      inst: InstallationRecord,
      narrow: { repos?: string[]; permissions?: Partial<Record<RepoPermission, PermissionLevel>> },
    ) => TokenRecord;
  },
): void {
  const { store } = ctx;

  const requireAppJwt = (jwt: Json | null, appId: number): void => {
    if (!jwt) throw new HttpError(401, "A JSON web token could not be decoded");
    const iss = String(jwt.iss ?? "");
    const appRec = store.apps.get(appId);
    if (!appRec || (iss !== String(appRec.id) && iss !== appRec.slug)) {
      throw new HttpError(401, "Bad credentials");
    }
    const exp = typeof jwt.exp === "number" ? jwt.exp : null;
    if (exp !== null && exp * 1000 < store.clock.now()) {
      throw new HttpError(
        401,
        "'Expiration time' claim ('exp') must be a numeric value representing the future time",
      );
    }
  };

  const installationJson = (inst: InstallationRecord): Json => {
    const appRec = store.apps.get(inst.appId);
    return {
      id: inst.id,
      node_id: store.nodeId("Installation", inst.id),
      app_id: inst.appId,
      app_slug: appRec?.slug ?? "app",
      account: store.userJsonByLogin(inst.account),
      repository_selection: inst.repos === "all" ? "all" : "selected",
      access_tokens_url: `${store.baseUrl}/app/installations/${inst.id}/access_tokens`,
      repositories_url: `${store.baseUrl}/installation/repositories`,
      html_url: `${store.baseUrl}/settings/installations/${inst.id}`,
      target_type: store.user(inst.account)?.type ?? "User",
      permissions: inst.permissions,
      events: [],
    };
  };

  app.get("/app", (c) => {
    const jwt = c.get("auth").appJwt;
    if (!jwt) throw new HttpError(401, "A JSON web token could not be decoded");
    const appRec = [...store.apps.values()].find(
      (a) => String(a.id) === String(jwt.iss) || a.slug === jwt.iss,
    );
    if (!appRec) throw new HttpError(401, "Bad credentials");
    return c.json({
      id: appRec.id,
      slug: appRec.slug,
      node_id: store.nodeId("App", appRec.id),
      owner: store.userJsonByLogin(appRec.owner),
      name: appRec.name,
      html_url: `${store.baseUrl}/apps/${appRec.slug}`,
      permissions: {},
      events: [],
    });
  });

  app.get("/app/installations", (c) => {
    const jwt = c.get("auth").appJwt;
    if (!jwt) throw new HttpError(401, "A JSON web token could not be decoded");
    const list = [...store.installations.values()].filter((inst) => {
      const appRec = store.apps.get(inst.appId);
      return appRec && (String(appRec.id) === String(jwt.iss) || appRec.slug === jwt.iss);
    });
    return c.json(list.map(installationJson));
  });

  app.get("/app/installations/:id", (c) => {
    const inst = store.installations.get(intParam(c, "id"));
    if (!inst) throw new HttpError(404, "Not Found");
    requireAppJwt(c.get("auth").appJwt, inst.appId);
    return c.json(installationJson(inst));
  });

  app.post("/app/installations/:id/access_tokens", async (c) => {
    const inst = store.installations.get(intParam(c, "id"));
    if (!inst) throw new HttpError(404, "Not Found");
    requireAppJwt(c.get("auth").appJwt, inst.appId);
    const body = await readJson(c);
    const repos = strList(body, "repositories");
    const permissions =
      body.permissions !== undefined ? permissionsOf(body.permissions) : undefined;
    if (permissions) {
      for (const [k, v] of Object.entries(permissions)) {
        const have = inst.permissions[k as RepoPermission];
        if (!have || (v === "write" && have !== "write")) {
          throw new HttpError(
            422,
            `The permissions requested are not granted to this installation.`,
          );
        }
      }
    }
    if (repos) {
      const allowed =
        inst.repos === "all" ? null : inst.repos.map((r) => normaliseRepoPattern(r, inst.account));
      for (const r of repos) {
        const full = normaliseRepoPattern(r, inst.account);
        if (allowed && !allowed.includes(full)) {
          throw new HttpError(
            422,
            "There is at least one repository that does not exist or is not accessible to the parent installation.",
          );
        }
      }
    }
    const token = ctx.issueInstallationToken(inst, { repos, permissions });
    const visible = [...store.repos.values()].filter((r) =>
      token.repos.some(
        (p) =>
          p === "*" ||
          p === `${r.owner}/${r.name}`.toLowerCase() ||
          p === `${r.owner.toLowerCase()}/*`,
      ),
    );
    return c.json(
      {
        token: token.value,
        expires_at: token.expiresAt ? new Date(token.expiresAt).toISOString() : null,
        permissions: token.permissions,
        repository_selection: inst.repos === "all" && !repos ? "all" : "selected",
        repositories: visible.map((r) => store.repoJson(r, store.subjectFor(token))),
      },
      201,
    );
  });

  app.get("/rate_limit", (c) => {
    const rate = c.get("rate");
    const core = rate ?? { limit: 0, used: 0, remaining: 0, reset: 0 };
    const block = {
      limit: core.limit,
      used: core.used,
      remaining: core.remaining,
      reset: core.reset,
    };
    return c.json({
      resources: { core: block, search: block, graphql: block, integration_manifest: block },
      rate: block,
    });
  });

  app.get("/meta", (c) =>
    c.json({
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: ["127.0.0.1/32"],
      web: ["127.0.0.1/32"],
      api: ["127.0.0.1/32"],
      git: ["127.0.0.1/32"],
      fake_git_host: true,
    }),
  );

  app.get("/zen", (c) => c.text("Keep it logically awesome."));
}

export { newTokenValue };
