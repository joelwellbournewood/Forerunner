/**
 * Issues, issue/PR comments and labels (the message mirror surface, and the status issue's,
 * w8-issue-host). As GitHub: issues off (`has_issues` false) answers 410 on every issue route
 * (a pull request's conversation stays on); anyone who may read the repository may open an issue
 * and comment (the read role, an organisation member with read access), with a token that may
 * write issues; the author edits their own comment, anyone with write access any comment;
 * `sort` is created, updated or comments.
 */

import type { HostApp, HostContext } from "./http.ts";
import {
  forbiddenMessage,
  guardRepo,
  HttpError,
  intParam,
  paginate,
  readJson,
  requireLogin,
  requireRepo,
  requireStr,
  str,
  strList,
  validationFailed,
} from "./http.ts";
import type { RouteContext } from "./routes-repos.ts";
import type { IssueRecord, LabelRecord, RepoRecord } from "./store.ts";
import type { PermissionLevel } from "./types.ts";

export function registerIssueRoutes(app: HostApp, ctx: RouteContext): void {
  const { store, ops } = ctx;

  const issueOf = (c: HostContext, repo: RepoRecord): IssueRecord => {
    const issue = store.issue(repo, intParam(c, "number"));
    if (!issue) throw new HttpError(404, "Not Found");
    return issue;
  };

  /** Issue endpoints on a PR number need the pull_requests permission instead (GitHub does this). */
  const issueRepo = (
    c: HostContext,
    level: PermissionLevel,
  ): { repo: RepoRecord; issue: IssueRecord } => {
    const probe = store.repo(c.req.param("owner") ?? "", c.req.param("repo") ?? "");
    const n = Number(c.req.param("number") ?? "0");
    const isPull = probe?.issues.get(n)?.pull !== null && probe?.issues.get(n) !== undefined;
    const repo = requireRepo(c, store, isPull ? "pull_requests" : "issues", level);
    return { repo, issue: issueOf(c, repo) };
  };

  const labelJson = (repo: RepoRecord, l: LabelRecord) => store.labelJson(repo, l);

  /** Issues off: 410 for the repository's issues; a pull request's number stays on. */
  const issuesOn = (repo: RepoRecord, issue?: IssueRecord | null) => {
    if (repo.hasIssues || issue?.pull) return;
    throw new HttpError(410, "Issues are disabled for this repo");
  };

  /**
   * Opening an issue or commenting on one (w8-issue-host): GitHub lets anyone who may read the
   * repository do it, with a token that may write issues (a classic token's `repo`, or
   * `public_repo` on a public repository; a fine-grained token's issues: write).
   */
  const requireParticipation = (c: HostContext, repo: RepoRecord) => {
    guardRepo(c, repo, "issues", "read");
    const token = c.get("auth").token;
    if (!token) throw new HttpError(401, "Requires authentication");
    const writes =
      token.kind === "classic"
        ? token.scopes.includes("repo") || (!repo.private && token.scopes.includes("public_repo"))
        : token.permissions.issues === "write";
    if (!writes) throw new HttpError(403, forbiddenMessage(token));
  };

  // ---- issues ------------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/issues", (c) => {
    const repo = requireRepo(c, store, "issues", "read");
    issuesOn(repo);
    const state = c.req.query("state") ?? "open";
    const labels = (c.req.query("labels") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const creator = c.req.query("creator");
    const direction = c.req.query("direction") ?? "desc";
    // GitHub's `sort`: created (the default), updated or comments; ties by number.
    const sort = c.req.query("sort") ?? "created";
    const commentsOf = (n: number) =>
      [...repo.comments.values()].filter((cm) => cm.issueNumber === n).length;
    const keyOf = (i: IssueRecord): string | number =>
      sort === "updated" ? i.updatedAt : sort === "comments" ? commentsOf(i.number) : i.createdAt;
    const issues = [...repo.issues.values()]
      .filter((i) => state === "all" || i.state === state)
      .filter((i) => labels.every((l) => i.labels.some((have) => have.toLowerCase() === l)))
      .filter((i) => !creator || i.user.toLowerCase() === creator.toLowerCase())
      .sort((a, b) => {
        const ka = keyOf(a);
        const kb = keyOf(b);
        const by = ka < kb ? -1 : ka > kb ? 1 : a.number - b.number;
        return direction === "asc" ? by : -by;
      });
    return c.json(
      paginate(
        c,
        issues.map((i) => store.issueJson(repo, i)),
      ),
    );
  });

  app.post("/repos/:owner/:repo/issues", async (c) => {
    const repo = requireRepo(c, store, "issues", "read");
    requireParticipation(c, repo);
    issuesOn(repo);
    const login = requireLogin(c);
    const body = await readJson(c);
    const title = requireStr(body, "title", "Issue");
    const labels = strList(body, "labels") ?? [];
    const issue = ops.createIssue(repo, {
      title,
      body: str(body, "body") ?? "",
      labels,
      assignees: strList(body, "assignees") ?? [],
      user: login,
    });
    return c.json(store.issueJson(repo, issue), 201);
  });

  app.get("/repos/:owner/:repo/issues/:number", (c) => {
    const { repo, issue } = issueRepo(c, "read");
    issuesOn(repo, issue);
    return c.json(store.issueJson(repo, issue));
  });

  app.patch("/repos/:owner/:repo/issues/:number", async (c) => {
    const { repo, issue } = issueRepo(c, "write");
    issuesOn(repo, issue);
    const login = requireLogin(c);
    const body = await readJson(c);
    const now = store.clock.nowIso();
    const actions: string[] = [];
    const title = str(body, "title");
    const text = str(body, "body");
    if (title !== undefined && title !== issue.title) {
      issue.title = title;
      actions.push("edited");
    }
    if (text !== undefined && text !== issue.body) {
      issue.body = text;
      if (!actions.includes("edited")) actions.push("edited");
    }
    const labels = strList(body, "labels");
    if (labels !== undefined) {
      issue.labels = ops.ensureLabels(repo, labels);
      actions.push("labeled");
    }
    const assignees = strList(body, "assignees");
    if (assignees !== undefined) issue.assignees = assignees;
    const state = str(body, "state");
    if (state === "closed" && issue.state === "open") {
      issue.state = "closed";
      issue.closedAt = now;
      issue.stateReason = str(body, "state_reason") ?? "completed";
      actions.push("closed");
    } else if (state === "open" && issue.state === "closed" && !issue.pull?.merged) {
      issue.state = "open";
      issue.closedAt = null;
      issue.stateReason = "reopened";
      actions.push("reopened");
    }
    issue.updatedAt = now;
    for (const action of actions.length > 0 ? actions : ["edited"]) {
      if (issue.pull)
        store.emit(
          repo,
          "pull_request",
          action,
          {
            number: issue.number,
            pull_request: store.pullJson(
              repo,
              issue as IssueRecord & { pull: NonNullable<IssueRecord["pull"]> },
            ),
          },
          login,
        );
      else store.emit(repo, "issues", action, { issue: store.issueJson(repo, issue) }, login);
    }
    return c.json(store.issueJson(repo, issue));
  });

  // ---- comments ------------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/issues/:number/comments", (c) => {
    const { repo, issue } = issueRepo(c, "read");
    issuesOn(repo, issue);
    // `since` as GitHub reads it: comments updated at or after the ISO-8601 instant.
    const sinceRaw = c.req.query("since");
    const since = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
    if (sinceRaw && Number.isNaN(since))
      throw validationFailed([{ resource: "IssueComment", field: "since", code: "invalid" }]);
    const comments = [...repo.comments.values()]
      .filter((cm) => cm.issueNumber === issue.number)
      .filter((cm) => !sinceRaw || Date.parse(cm.updatedAt) >= since)
      .sort((a, b) => a.id - b.id);
    return c.json(
      paginate(
        c,
        comments.map((cm) => store.commentJson(repo, cm)),
      ),
    );
  });

  app.post("/repos/:owner/:repo/issues/:number/comments", async (c) => {
    // A pull request's conversation keeps its own rule; on an issue, anyone who reads comments.
    const { repo, issue } = issueRepo(c, "read");
    if (issue.pull) issueRepo(c, "write");
    else requireParticipation(c, repo);
    issuesOn(repo, issue);
    const login = requireLogin(c);
    const body = await readJson(c);
    const text = requireStr(body, "body", "IssueComment");
    const now = store.clock.nowIso();
    const comment = {
      id: store.nextId(),
      issueNumber: issue.number,
      body: text,
      user: login,
      createdAt: now,
      updatedAt: now,
    };
    repo.comments.set(comment.id, comment);
    issue.updatedAt = now;
    store.emit(
      repo,
      "issue_comment",
      "created",
      { issue: store.issueJson(repo, issue), comment: store.commentJson(repo, comment) },
      login,
    );
    return c.json(store.commentJson(repo, comment), 201);
  });

  app.get("/repos/:owner/:repo/issues/comments", (c) => {
    const repo = requireRepo(c, store, "issues", "read");
    issuesOn(repo);
    const comments = [...repo.comments.values()].sort((a, b) => a.id - b.id);
    return c.json(
      paginate(
        c,
        comments.map((cm) => store.commentJson(repo, cm)),
      ),
    );
  });

  app.get("/repos/:owner/:repo/issues/comments/:id", (c) => {
    const repo = requireRepo(c, store, "issues", "read");
    const comment = repo.comments.get(intParam(c, "id"));
    if (!comment) throw new HttpError(404, "Not Found");
    issuesOn(repo, repo.issues.get(comment.issueNumber));
    return c.json(store.commentJson(repo, comment));
  });

  app.patch("/repos/:owner/:repo/issues/comments/:id", async (c) => {
    const repo = requireRepo(c, store, "issues", "read");
    const login = requireLogin(c);
    const comment = repo.comments.get(intParam(c, "id"));
    if (!comment) throw new HttpError(404, "Not Found");
    issuesOn(repo, repo.issues.get(comment.issueNumber));
    // The author edits their own comment; anyone with write access edits any comment (GitHub's
    // rule, which w8-status-write's tamper tests need).
    if (comment.user.toLowerCase() === login.toLowerCase()) requireParticipation(c, repo);
    else requireRepo(c, store, "issues", "write");
    const body = await readJson(c);
    comment.body = requireStr(body, "body", "IssueComment");
    comment.updatedAt = store.clock.nowIso();
    const issue = repo.issues.get(comment.issueNumber);
    if (issue) {
      store.emit(
        repo,
        "issue_comment",
        "edited",
        { issue: store.issueJson(repo, issue), comment: store.commentJson(repo, comment) },
        login,
      );
    }
    return c.json(store.commentJson(repo, comment));
  });

  app.delete("/repos/:owner/:repo/issues/comments/:id", (c) => {
    const repo = requireRepo(c, store, "issues", "write");
    const login = requireLogin(c);
    const comment = repo.comments.get(intParam(c, "id"));
    if (!comment) throw new HttpError(404, "Not Found");
    issuesOn(repo, repo.issues.get(comment.issueNumber));
    repo.comments.delete(comment.id);
    const issue = repo.issues.get(comment.issueNumber);
    if (issue) {
      store.emit(
        repo,
        "issue_comment",
        "deleted",
        { issue: store.issueJson(repo, issue), comment: store.commentJson(repo, comment) },
        login,
      );
    }
    return c.body(null, 204);
  });

  // ---- labels --------------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/labels", (c) => {
    const repo = requireRepo(c, store, "issues", "read");
    const labels = [...repo.labels.values()].sort((a, b) => a.name.localeCompare(b.name));
    return c.json(
      paginate(
        c,
        labels.map((l) => labelJson(repo, l)),
      ),
    );
  });

  app.post("/repos/:owner/:repo/labels", async (c) => {
    const repo = requireRepo(c, store, "issues", "write");
    const body = await readJson(c);
    const name = requireStr(body, "name", "Label");
    if (repo.labels.has(name.toLowerCase())) {
      throw validationFailed([{ resource: "Label", field: "name", code: "already_exists" }]);
    }
    const label: LabelRecord = {
      id: store.nextId(),
      name,
      color: (str(body, "color") ?? "ededed").replace(/^#/, ""),
      description: str(body, "description") ?? "",
      isDefault: false,
    };
    repo.labels.set(name.toLowerCase(), label);
    return c.json(labelJson(repo, label), 201);
  });

  app.get("/repos/:owner/:repo/labels/*", (c) => {
    const repo = requireRepo(c, store, "issues", "read");
    const name = decodeURIComponent(c.req.path.split("/labels/")[1] ?? "");
    const label = repo.labels.get(name.toLowerCase());
    if (!label) throw new HttpError(404, "Not Found");
    return c.json(labelJson(repo, label));
  });

  app.patch("/repos/:owner/:repo/labels/*", async (c) => {
    const repo = requireRepo(c, store, "issues", "write");
    const name = decodeURIComponent(c.req.path.split("/labels/")[1] ?? "");
    const label = repo.labels.get(name.toLowerCase());
    if (!label) throw new HttpError(404, "Not Found");
    const body = await readJson(c);
    const newName = str(body, "new_name");
    if (newName && newName.toLowerCase() !== label.name.toLowerCase()) {
      repo.labels.delete(label.name.toLowerCase());
      for (const issue of repo.issues.values()) {
        issue.labels = issue.labels.map((l) =>
          l.toLowerCase() === label.name.toLowerCase() ? newName : l,
        );
      }
      label.name = newName;
      repo.labels.set(newName.toLowerCase(), label);
    }
    const color = str(body, "color");
    if (color !== undefined) label.color = color.replace(/^#/, "");
    const description = str(body, "description");
    if (description !== undefined) label.description = description;
    return c.json(labelJson(repo, label));
  });

  app.delete("/repos/:owner/:repo/labels/*", (c) => {
    const repo = requireRepo(c, store, "issues", "write");
    const name = decodeURIComponent(c.req.path.split("/labels/")[1] ?? "");
    const label = repo.labels.get(name.toLowerCase());
    if (!label) throw new HttpError(404, "Not Found");
    repo.labels.delete(name.toLowerCase());
    for (const issue of repo.issues.values()) {
      issue.labels = issue.labels.filter((l) => l.toLowerCase() !== name.toLowerCase());
    }
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/issues/:number/labels", (c) => {
    const { repo, issue } = issueRepo(c, "read");
    issuesOn(repo, issue);
    return c.json(store.issueLabels(repo, issue));
  });

  const setLabels = async (c: HostContext, mode: "add" | "set") => {
    const { repo, issue } = issueRepo(c, "write");
    issuesOn(repo, issue);
    const login = requireLogin(c);
    const text = await c.req.text();
    let names: string[] = [];
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) names = parsed.filter((x): x is string => typeof x === "string");
      else if (parsed && typeof parsed === "object") {
        const l = (parsed as { labels?: unknown }).labels;
        if (Array.isArray(l)) names = l.filter((x): x is string => typeof x === "string");
      }
    }
    const resolved = ops.ensureLabels(repo, names);
    issue.labels =
      mode === "set" ? resolved : ops.ensureLabels(repo, [...issue.labels, ...resolved]);
    issue.updatedAt = store.clock.nowIso();
    for (const name of resolved) {
      const label = repo.labels.get(name.toLowerCase());
      store.emit(
        repo,
        "issues",
        "labeled",
        { issue: store.issueJson(repo, issue), label: label ? labelJson(repo, label) : { name } },
        login,
      );
    }
    return c.json(store.issueLabels(repo, issue));
  };
  app.post("/repos/:owner/:repo/issues/:number/labels", (c) => setLabels(c, "add"));
  app.put("/repos/:owner/:repo/issues/:number/labels", (c) => setLabels(c, "set"));

  app.delete("/repos/:owner/:repo/issues/:number/labels", (c) => {
    const { repo, issue } = issueRepo(c, "write");
    issuesOn(repo, issue);
    issue.labels = [];
    issue.updatedAt = store.clock.nowIso();
    return c.json([]);
  });

  app.delete("/repos/:owner/:repo/issues/:number/labels/*", (c) => {
    const { repo, issue } = issueRepo(c, "write");
    issuesOn(repo, issue);
    const login = requireLogin(c);
    const name = decodeURIComponent(c.req.path.split("/labels/")[1] ?? "");
    if (!issue.labels.some((l) => l.toLowerCase() === name.toLowerCase())) {
      throw new HttpError(404, "Label does not exist");
    }
    issue.labels = issue.labels.filter((l) => l.toLowerCase() !== name.toLowerCase());
    issue.updatedAt = store.clock.nowIso();
    const label = repo.labels.get(name.toLowerCase());
    store.emit(
      repo,
      "issues",
      "unlabeled",
      { issue: store.issueJson(repo, issue), label: label ? labelJson(repo, label) : { name } },
      login,
    );
    return c.json(store.issueLabels(repo, issue));
  });
}
