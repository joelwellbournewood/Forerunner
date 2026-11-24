/**
 * GitHub's GraphQL endpoint for the status issue's pin (w8-issue-host, W8-host-3): POST /graphql
 * at the stand-in's own base, the URL the adapter derives with `graphqlUrlFor(baseUrl)`. GitHub
 * pins issues only through GraphQL, so this is the one way the stand-in pins. Operations are
 * dispatched on `operationName`, as the Projects stand-in for tests does
 * (packages/capabilities/test/helpers/fake-projects-graphql.ts):
 * - `StatusPinnedIssues`: `repository(owner, name) { pinnedIssues(first: 3) { totalCount nodes
 *   { issue { id number } } } }`;
 * - `StatusPinIssue`: `pinIssue(input: { issueId })` on the issue's node id; at most three per
 *   repository; pinning needs write access to the repository's issues.
 * Answers follow GitHub's GraphQL: 200 with `data`, or with `errors` typed NOT_FOUND, FORBIDDEN
 * or UNPROCESSABLE; 401 without a token. The request log records the operation and its kind.
 */

import { checkRepoAccess } from "./auth.ts";
import { type HostApp, HttpError, readJson } from "./http.ts";
import type { RouteContext } from "./routes-repos.ts";
import type { IssueRecord, Json, RepoRecord } from "./store.ts";

const PINNED_MAX = 3;

interface GqlError {
  type: string;
  message: string;
  path?: string[];
}

class GqlFailure extends Error {
  constructor(readonly error: GqlError) {
    super(error.message);
  }
}

export function registerGraphqlRoutes(app: HostApp, ctx: RouteContext): void {
  const { store } = ctx;

  /** The issue a node id names (`Issue:<id>` in base64, as `HostStore.nodeId` makes them). */
  const issueByNode = (nodeId: string): { repo: RepoRecord; issue: IssueRecord } | null => {
    const decoded = Buffer.from(nodeId, "base64").toString("utf8");
    const m = /^Issue:(\d+)$/.exec(decoded);
    if (!m) return null;
    const id = Number(m[1]);
    for (const repo of store.repos.values())
      for (const issue of repo.issues.values())
        if (issue.id === id && issue.pull === null) return { repo, issue };
    return null;
  };

  const pinnedJson = (repo: RepoRecord): Json => ({
    totalCount: repo.pinned.length,
    nodes: repo.pinned.map((n) => {
      const issue = repo.issues.get(n);
      return { issue: { id: issue ? store.nodeId("Issue", issue.id) : null, number: n } };
    }),
  });

  app.post("/graphql", async (c) => {
    const auth = c.get("auth");
    if (!auth.token) throw new HttpError(401, "This endpoint requires you to be authenticated.");
    const body = await readJson(c);
    const query = typeof body.query === "string" ? body.query : "";
    const operation = typeof body.operationName === "string" ? body.operationName : "";
    const variables = (
      body.variables && typeof body.variables === "object" ? body.variables : {}
    ) as Json;
    c.set("graphql", {
      operation: operation || "anonymous",
      kind: /^\s*mutation\b/.test(query) ? "mutation" : "query",
    });
    try {
      switch (operation) {
        case "StatusPinnedIssues": {
          const owner = String(variables.owner ?? "");
          const name = String(variables.name ?? "");
          const repo = store.repo(owner, name);
          if (!repo || checkRepoAccess(auth.subject, repo, "issues", "read") !== "ok")
            throw new GqlFailure({
              type: "NOT_FOUND",
              path: ["repository"],
              message: `Could not resolve to a Repository with the name '${owner}/${name}'.`,
            });
          return c.json({ data: { repository: { pinnedIssues: pinnedJson(repo) } } });
        }
        case "StatusPinIssue": {
          const nodeId = String(variables.issueId ?? "");
          const found = issueByNode(nodeId);
          const access = found ? checkRepoAccess(auth.subject, found.repo, "issues", "read") : null;
          if (!found || access === "not_found")
            throw new GqlFailure({
              type: "NOT_FOUND",
              path: ["pinIssue"],
              message: `Could not resolve to a node with the global id of '${nodeId}'.`,
            });
          const { repo, issue } = found;
          if (checkRepoAccess(auth.subject, repo, "issues", "write") !== "ok")
            throw new GqlFailure({
              type: "FORBIDDEN",
              path: ["pinIssue"],
              message: `${auth.login ?? "This account"} does not have the correct permissions to execute \`PinIssue\``,
            });
          if (!repo.hasIssues)
            throw new GqlFailure({
              type: "UNPROCESSABLE",
              path: ["pinIssue"],
              message: "Issues are disabled for this repository.",
            });
          if (!repo.pinned.includes(issue.number)) {
            if (repo.pinned.length >= PINNED_MAX)
              throw new GqlFailure({
                type: "UNPROCESSABLE",
                path: ["pinIssue"],
                message: `This repository already has ${PINNED_MAX} pinned issues.`,
              });
            repo.pinned.push(issue.number);
            store.emit(
              repo,
              "issues",
              "pinned",
              { issue: store.issueJson(repo, issue) },
              auth.login ?? repo.owner,
            );
          }
          return c.json({
            data: {
              pinIssue: {
                issue: { id: nodeId, number: issue.number, isPinned: true },
              },
            },
          });
        }
        default:
          throw new GqlFailure({
            type: "UNKNOWN_OPERATION",
            message: `The stand-in GitHub does not serve the operation '${operation}'.`,
          });
      }
    } catch (e) {
      if (e instanceof GqlFailure) return c.json({ data: null, errors: [e.error] });
      throw e;
    }
  });
}
