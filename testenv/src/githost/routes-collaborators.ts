/**
 * A login's permission on a repository (w8-issue-host, W8-host-8): GitHub's
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission`. It answers the legacy
 * `permission` (admin, write, read or none: maintain reads as write, triage as read) and the
 * `role_name` (admin, maintain, write, triage, read, or none), worked out as GitHub does from the
 * owner, the collaborator role and the owning organisation's base permission (`HostStore.roleOf`).
 * GitHub's documentation lists 404 as its only refusal: the caller needs push access to read
 * anyone's permission, and a login that is not a user is not found. Forerunner reads it as the
 * one source of write access (D-W8-37); association is only a first filter.
 */

import { checkRepoAccess } from "./auth.ts";
import { type HostApp, HttpError, requireRepo } from "./http.ts";
import type { RouteContext } from "./routes-repos.ts";
import type { CollaboratorRole } from "./types.ts";

/** The legacy base role of a role (GitHub's `permission` field). */
function legacyPermission(role: CollaboratorRole): "admin" | "write" | "read" | "none" {
  if (role === "admin") return "admin";
  if (role === "maintain" || role === "write") return "write";
  if (role === "triage" || role === "read") return "read";
  return "none";
}

export function registerCollaboratorRoutes(app: HostApp, ctx: RouteContext): void {
  const { store } = ctx;

  app.get("/repos/:owner/:repo/collaborators/:login/permission", (c) => {
    const repo = requireRepo(c, store, "metadata", "read");
    // Only someone who may push reads another's permission; GitHub answers a reader 404.
    if (checkRepoAccess(c.get("auth").subject, repo, "contents", "write") !== "ok")
      throw new HttpError(404, "Not Found");
    const login = c.req.param("login") ?? "";
    const role = store.roleOf(repo, login);
    const user = store.user(login);
    if (role === null || !user) throw new HttpError(404, `${login} is not a user`);
    const permission = legacyPermission(role);
    return c.json({
      permission,
      role_name: role,
      user: {
        ...store.userJson(user),
        permissions: {
          admin: role === "admin",
          maintain: role === "admin" || role === "maintain",
          push: permission === "admin" || permission === "write",
          triage: role !== "read" && role !== "none",
          pull: role !== "none",
        },
        role_name: role,
      },
    });
  });
}
