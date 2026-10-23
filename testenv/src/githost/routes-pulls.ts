/**
 * Pull requests: list, open, read (with mergeability), edit, merge, files, commits, reviews
 * and "update branch".
 */
import type { MergeMethod } from "./git.ts";
import type { HostApp, HostContext } from "./http.ts";
import {
  bool,
  HttpError,
  intParam,
  paginate,
  readJson,
  requireLogin,
  requireRepo,
  requireStr,
  str,
  validationFailed,
} from "./http.ts";
import type { RouteContext } from "./routes-repos.ts";
import { fileJsonForDiff } from "./routes-repos.ts";
import type {
  IssueRecord,
  Json,
  PullData,
  RepoRecord,
  ReviewCommentRecord,
  ReviewRecord,
} from "./store.ts";

export function registerPullRoutes(app: HostApp, ctx: RouteContext): void {
  const { store, ops } = ctx;

  const pullOf = (c: HostContext, repo: RepoRecord): IssueRecord & { pull: PullData } => {
    const n = intParam(c, "number");
    const issue = store.pull(repo, n);
    if (!issue) throw new HttpError(404, "Not Found");
    return issue;
  };

  app.get("/repos/:owner/:repo/pulls", (c) => {
    const repo = requireRepo(c, store, "pull_requests", "read");
    const state = c.req.query("state") ?? "open";
    const head = c.req.query("head");
    const base = c.req.query("base");
    const sort = c.req.query("sort") ?? "created";
    const direction = c.req.query("direction") ?? "desc";
    const pulls = [...repo.issues.values()]
      .filter((i): i is IssueRecord & { pull: PullData } => i.pull !== null)
      .filter((i) => state === "all" || i.state === state)
      .filter((i) => !head || `${repo.owner}:${i.pull.headRef}` === head || i.pull.headRef === head)
      .filter((i) => !base || i.pull.baseRef === base)
      .sort((a, b) => {
        const key = sort === "updated" ? "updatedAt" : "createdAt";
        const cmp = a[key].localeCompare(b[key]) || a.number - b.number;
        return direction === "asc" ? cmp : -cmp;
      });
    return c.json(
      paginate(
        c,
        pulls.map((i) => store.pullJson(repo, i)),
      ),
    );
  });

  app.post("/repos/:owner/:repo/pulls", async (c) => {
    const repo = requireRepo(c, store, "pull_requests", "write");
    const login = requireLogin(c);
    const body = await readJson(c);
    const title = requireStr(body, "title", "PullRequest");
    const head = requireStr(body, "head", "PullRequest");
    const base = requireStr(body, "base", "PullRequest");
    const issue = await ops.openPull(repo, {
      title,
      body: str(body, "body") ?? "",
      head,
      base,
      draft: bool(body, "draft") ?? false,
      user: login,
    });
    const stats = await ops.pullStats(repo, issue);
    return c.json(store.pullJson(repo, issue, stats), 201);
  });

  app.get("/repos/:owner/:repo/pulls/:number", async (c) => {
    const repo = requireRepo(c, store, "pull_requests", "read");
    const issue = pullOf(c, repo);
    await ops.computeMergeability(repo, issue);
    const stats = await ops.pullStats(repo, issue);
    return c.json(store.pullJson(repo, issue, stats));
  });

  app.patch("/repos/:owner/:repo/pulls/:number", async (c) => {
    const repo = requireRepo(c, store, "pull_requests", "write");
    const login = requireLogin(c);
    const issue = pullOf(c, repo);
    const body = await readJson(c);
    const title = str(body, "title");
    const text = str(body, "body");
    const state = str(body, "state");
    const base = str(body, "base");
    const now = store.clock.nowIso();
    let action = "edited";
    if (title !== undefined) issue.title = title;
    if (text !== undefined) issue.body = text;
    if (base !== undefined) {
      if (!(await repo.git.revParse(`refs/heads/${base}`))) {
        throw validationFailed([{ resource: "PullRequest", field: "base", code: "invalid" }]);
      }
      issue.pull.baseRef = base;
    }
    if (state === "closed" && issue.state === "open") {
      issue.state = "closed";
      issue.closedAt = now;
      action = "closed";
    } else if (state === "open" && issue.state === "closed" && !issue.pull.merged) {
      issue.state = "open";
      issue.closedAt = null;
      action = "reopened";
    }
    issue.updatedAt = now;
    await ops.computeMergeability(repo, issue);
    store.emit(repo, "pull_request", action, ops.pullPayload(repo, issue), login);
    return c.json(store.pullJson(repo, issue, await ops.pullStats(repo, issue)));
  });

  app.get("/repos/:owner/:repo/pulls/:number/merge", (c) => {
    const repo = requireRepo(c, store, "pull_requests", "read");
    const issue = pullOf(c, repo);
    if (!issue.pull.merged) throw new HttpError(404, "Not Found");
    return c.body(null, 204);
  });

  app.put("/repos/:owner/:repo/pulls/:number/merge", async (c) => {
    const repo = requireRepo(c, store, "pull_requests", "write");
    const login = requireLogin(c);
    requireRepo(c, store, "contents", "write");
    const issue = pullOf(c, repo);
    const body = await readJson(c);
    const methodRaw = str(body, "merge_method") ?? "merge";
    if (methodRaw !== "merge" && methodRaw !== "squash" && methodRaw !== "rebase") {
      throw validationFailed([{ resource: "PullRequest", field: "merge_method", code: "invalid" }]);
    }
    const method: MergeMethod = methodRaw;
    const { sha } = await ops.mergePull(repo, issue, {
      method,
      title: str(body, "commit_title"),
      message: str(body, "commit_message"),
      sha: str(body, "sha"),
      user: login,
    });
    return c.json({ sha, merged: true, message: "Pull Request successfully merged" });
  });

  app.put("/repos/:owner/:repo/pulls/:number/update-branch", async (c) => {
    const repo = requireRepo(c, store, "contents", "write");
    const login = requireLogin(c);
    const issue = pullOf(c, repo);
    if (issue.state !== "open") throw new HttpError(422, "Pull request is not open");
    const tip = await ops.updatePullBranch(repo, issue, login);
    if (!tip) throw new HttpError(422, "merge conflict between base and head");
    return c.json(
      {
        message: "Updating pull request branch.",
        url: `${store.baseUrl}/repos/${repo.fullName}/pulls/${issue.number}`,
      },
      202,
    );
  });

  app.get("/repos/:owner/:repo/pulls/:number/files", async (c) => {
    const repo = requireRepo(c, store, "pull_requests", "read");
    const issue = pullOf(c, repo);
    const stats = await ops.pullStats(repo, issue);
    const head = issue.pull.headSha;
    return c.json(
      paginate(
        c,
        stats.files.map((f) => fileJsonForDiff(store, repo, head, f)),
      ),
    );
  });

  app.get("/repos/:owner/:repo/pulls/:number/commits", async (c) => {
    const repo = requireRepo(c, store, "pull_requests", "read");
    const issue = pullOf(c, repo);
    const head = await repo.git.revParse(issue.pull.headSha);
    const base = await repo.git.revParse(issue.pull.baseSha);
    if (!head || !base) return c.json([]);
    const commits = (await repo.git.log([head, `^${base}`], 250)).reverse();
    return c.json(
      paginate(
        c,
        commits.map((info) => store.commitJson(repo, info)),
      ),
    );
  });

  app.get("/repos/:owner/:repo/pulls/:number/reviews", (c) => {
    const repo = requireRepo(c, store, "pull_requests", "read");
    const issue = pullOf(c, repo);
    return c.json(
      paginate(
        c,
        issue.pull.reviews.map((r) => store.reviewJson(repo, issue, r)),
      ),
    );
  });

  app.post("/repos/:owner/:repo/pulls/:number/reviews", async (c) => {
    const repo = requireRepo(c, store, "pull_requests", "write");
    const login = requireLogin(c);
    const issue = pullOf(c, repo);
    const body = await readJson(c);
    const event = str(body, "event") ?? "PENDING";
    const states: Record<string, ReviewRecord["state"]> = {
      APPROVE: "APPROVED",
      REQUEST_CHANGES: "CHANGES_REQUESTED",
      COMMENT: "COMMENTED",
      PENDING: "PENDING",
    };
    const state = states[event];
    if (!state)
      throw validationFailed([{ resource: "PullRequestReview", field: "event", code: "invalid" }]);
    const text = str(body, "body") ?? "";
    // Line comments of the review (GitHub: `comments: [{ path, line, body }]`); a review made
    // only of line comments may have no body.
    const lines = Array.isArray(body.comments) ? (body.comments as Json[]) : [];
    for (const l of lines) {
      if (!l || typeof l !== "object") continue;
      requireStr(l, "path", "PullRequestReviewComment");
      requireStr(l, "body", "PullRequestReviewComment");
    }
    if ((state === "CHANGES_REQUESTED" || state === "COMMENTED") && !text && !lines.length) {
      throw validationFailed([
        { resource: "PullRequestReview", field: "body", code: "missing_field" },
      ]);
    }
    const review: ReviewRecord = {
      id: store.nextId(),
      user: login,
      body: text,
      state,
      commitId: str(body, "commit_id") ?? issue.pull.headSha,
      submittedAt: store.clock.nowIso(),
    };
    issue.pull.reviews.push(review);
    for (const l of lines) {
      if (!l || typeof l !== "object") continue;
      addReviewComment(repo, issue, login, {
        reviewId: review.id,
        body: str(l, "body") ?? "",
        path: str(l, "path") ?? "",
        line: typeof l.line === "number" ? l.line : null,
        commitId: review.commitId,
        inReplyTo: null,
        emit: state !== "PENDING",
      });
    }
    issue.updatedAt = review.submittedAt;
    if (state !== "PENDING") {
      store.emit(
        repo,
        "pull_request_review",
        "submitted",
        {
          review: store.reviewJson(repo, issue, review),
          pull_request: store.pullJson(repo, issue),
        },
        login,
      );
    }
    return c.json(store.reviewJson(repo, issue, review));
  });

  // ---- review (line) comments ----------------------------------------------------------------
  const addReviewComment = (
    repo: RepoRecord,
    issue: IssueRecord & { pull: PullData },
    login: string,
    input: Omit<ReviewCommentRecord, "id" | "user" | "createdAt" | "updatedAt"> & {
      emit: boolean;
    },
  ): ReviewCommentRecord => {
    const now = store.clock.nowIso();
    const { emit, ...fields } = input;
    const rc: ReviewCommentRecord = {
      id: store.nextId(),
      user: login,
      createdAt: now,
      updatedAt: now,
      ...fields,
    };
    issue.pull.reviewComments.push(rc);
    issue.updatedAt = now;
    if (emit) {
      store.emit(
        repo,
        "pull_request_review_comment",
        "created",
        {
          comment: store.reviewCommentJson(repo, issue, rc),
          pull_request: store.pullJson(repo, issue),
        },
        login,
      );
    }
    return rc;
  };

  // `since` as GitHub reads it: comments updated at or after the ISO-8601 instant; oldest first.
  // A line comment of a review still pending is its author's draft and is not listed.
  app.get("/repos/:owner/:repo/pulls/:number/comments", (c) => {
    const repo = requireRepo(c, store, "pull_requests", "read");
    const issue = pullOf(c, repo);
    const sinceRaw = c.req.query("since");
    const since = sinceRaw ? Date.parse(sinceRaw) : Number.NaN;
    if (sinceRaw && Number.isNaN(since))
      throw validationFailed([
        { resource: "PullRequestReviewComment", field: "since", code: "invalid" },
      ]);
    const pending = new Set(
      issue.pull.reviews.filter((r) => r.state === "PENDING").map((r) => r.id),
    );
    const comments = issue.pull.reviewComments
      .filter((rc) => rc.reviewId === null || !pending.has(rc.reviewId))
      .filter((rc) => !sinceRaw || Date.parse(rc.updatedAt) >= since)
      .sort((a, b) => a.id - b.id);
    return c.json(
      paginate(
        c,
        comments.map((rc) => store.reviewCommentJson(repo, issue, rc)),
      ),
    );
  });

  // One line comment, or a reply to one (`in_reply_to`); like GitHub it is its own
  // COMMENTED review with no body.
  app.post("/repos/:owner/:repo/pulls/:number/comments", async (c) => {
    const repo = requireRepo(c, store, "pull_requests", "write");
    const login = requireLogin(c);
    const issue = pullOf(c, repo);
    const body = await readJson(c);
    const text = requireStr(body, "body", "PullRequestReviewComment");
    const replyTo = typeof body.in_reply_to === "number" ? body.in_reply_to : null;
    const parent =
      replyTo === null ? null : issue.pull.reviewComments.find((rc) => rc.id === replyTo);
    if (replyTo !== null && !parent) throw new HttpError(404, "Not Found");
    const path = parent?.path ?? requireStr(body, "path", "PullRequestReviewComment");
    const review: ReviewRecord = {
      id: store.nextId(),
      user: login,
      body: "",
      state: "COMMENTED",
      commitId: str(body, "commit_id") ?? issue.pull.headSha,
      submittedAt: store.clock.nowIso(),
    };
    issue.pull.reviews.push(review);
    const rc = addReviewComment(repo, issue, login, {
      reviewId: review.id,
      body: text,
      path,
      line: parent ? parent.line : typeof body.line === "number" ? body.line : null,
      commitId: review.commitId,
      inReplyTo: parent?.id ?? null,
      emit: true,
    });
    return c.json(store.reviewCommentJson(repo, issue, rc), 201);
  });

  app.get("/repos/:owner/:repo/pulls/:number/reviews/:review_id", (c) => {
    const repo = requireRepo(c, store, "pull_requests", "read");
    const issue = pullOf(c, repo);
    const id = intParam(c, "review_id");
    const review = issue.pull.reviews.find((r) => r.id === id);
    if (!review) throw new HttpError(404, "Not Found");
    return c.json(store.reviewJson(repo, issue, review));
  });
}
