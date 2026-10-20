/**
 * Check runs, commit statuses (the CI result triggers) and repository webhooks.
 */

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
  strList,
  validationFailed,
  wildcardPath,
} from "./http.ts";
import { commitDetail, type RouteContext } from "./routes-repos.ts";
import type { CheckRunRecord, HookRecord, Json, StatusRecord } from "./store.ts";

const CONCLUSIONS = new Set([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
  "skipped",
  "stale",
]);

function outputOf(body: Json): CheckRunRecord["output"] | undefined {
  const o = body.output;
  if (!o || typeof o !== "object") return undefined;
  const out = o as Json;
  return {
    title: str(out, "title") ?? null,
    summary: str(out, "summary") ?? null,
    text: str(out, "text") ?? null,
  };
}

export function registerCheckRoutes(app: HostApp, ctx: RouteContext): void {
  const { store } = ctx;

  // ---- check runs ----------------------------------------------------------------------------
  app.post("/repos/:owner/:repo/check-runs", async (c) => {
    const repo = requireRepo(c, store, "checks", "write");
    const login = requireLogin(c);
    const body = await readJson(c);
    const name = requireStr(body, "name", "CheckRun");
    const headSha = requireStr(body, "head_sha", "CheckRun");
    if (!(await repo.git.revParse(headSha)))
      throw validationFailed([{ resource: "CheckRun", field: "head_sha", code: "invalid" }]);
    const conclusion = str(body, "conclusion") ?? null;
    if (conclusion !== null && !CONCLUSIONS.has(conclusion)) {
      throw validationFailed([{ resource: "CheckRun", field: "conclusion", code: "invalid" }]);
    }
    const statusRaw = str(body, "status") ?? (conclusion ? "completed" : "queued");
    if (statusRaw !== "queued" && statusRaw !== "in_progress" && statusRaw !== "completed") {
      throw validationFailed([{ resource: "CheckRun", field: "status", code: "invalid" }]);
    }
    if (statusRaw === "completed" && !conclusion) {
      throw validationFailed([
        { resource: "CheckRun", field: "conclusion", code: "missing_field" },
      ]);
    }
    const now = store.clock.nowIso();
    const run: CheckRunRecord = {
      id: store.nextId(),
      headSha,
      name,
      status: statusRaw,
      conclusion,
      startedAt: str(body, "started_at") ?? now,
      completedAt: statusRaw === "completed" ? (str(body, "completed_at") ?? now) : null,
      detailsUrl: str(body, "details_url") ?? null,
      externalId: str(body, "external_id") ?? null,
      output: outputOf(body) ?? { title: null, summary: null, text: null },
      app: login,
    };
    repo.checkRuns.set(run.id, run);
    store.checkRunsById.set(run.id, { repo, run });
    store.emit(repo, "check_run", "created", { check_run: store.checkRunJson(repo, run) }, login);
    if (run.status === "completed") {
      store.emit(
        repo,
        "check_run",
        "completed",
        { check_run: store.checkRunJson(repo, run) },
        login,
      );
    }
    return c.json(store.checkRunJson(repo, run), 201);
  });

  app.patch("/repos/:owner/:repo/check-runs/:id", async (c) => {
    const repo = requireRepo(c, store, "checks", "write");
    const login = requireLogin(c);
    const run = repo.checkRuns.get(intParam(c, "id"));
    if (!run) throw new HttpError(404, "Not Found");
    const body = await readJson(c);
    const name = str(body, "name");
    if (name !== undefined) run.name = name;
    const conclusion = str(body, "conclusion");
    if (conclusion !== undefined) {
      if (!CONCLUSIONS.has(conclusion))
        throw validationFailed([{ resource: "CheckRun", field: "conclusion", code: "invalid" }]);
      run.conclusion = conclusion;
    }
    const statusRaw = str(body, "status") ?? (conclusion !== undefined ? "completed" : undefined);
    const wasCompleted = run.status === "completed";
    if (statusRaw !== undefined) {
      if (statusRaw !== "queued" && statusRaw !== "in_progress" && statusRaw !== "completed") {
        throw validationFailed([{ resource: "CheckRun", field: "status", code: "invalid" }]);
      }
      run.status = statusRaw;
    }
    if (run.status === "completed") {
      if (!run.conclusion)
        throw validationFailed([
          { resource: "CheckRun", field: "conclusion", code: "missing_field" },
        ]);
      run.completedAt = str(body, "completed_at") ?? run.completedAt ?? store.clock.nowIso();
    } else {
      run.completedAt = null;
    }
    const details = str(body, "details_url");
    if (details !== undefined) run.detailsUrl = details;
    const external = str(body, "external_id");
    if (external !== undefined) run.externalId = external;
    const output = outputOf(body);
    if (output) run.output = output;
    const action = run.status === "completed" && !wasCompleted ? "completed" : "rerequested";
    store.emit(repo, "check_run", action, { check_run: store.checkRunJson(repo, run) }, login);
    return c.json(store.checkRunJson(repo, run));
  });

  app.get("/repos/:owner/:repo/check-runs/:id", (c) => {
    const repo = requireRepo(c, store, "checks", "read");
    const run = repo.checkRuns.get(intParam(c, "id"));
    if (!run) throw new HttpError(404, "Not Found");
    return c.json(store.checkRunJson(repo, run));
  });

  const checkRunsFor = async (c: HostContext, ref: string) => {
    const repo = requireRepo(c, store, "checks", "read");
    const sha = await repo.git.revParse(ref);
    if (!sha) throw new HttpError(422, "No commit found for SHA");
    const checkName = c.req.query("check_name");
    const status = c.req.query("status");
    const runs = [...repo.checkRuns.values()]
      .filter((r) => r.headSha === sha)
      .filter((r) => !checkName || r.name === checkName)
      .filter((r) => !status || r.status === status)
      .sort((a, b) => a.id - b.id);
    const page = paginate(c, runs);
    return c.json({
      total_count: runs.length,
      check_runs: page.map((r) => store.checkRunJson(repo, r)),
    });
  };

  // ---- commit statuses -----------------------------------------------------------------------
  app.post("/repos/:owner/:repo/statuses/:sha", async (c) => {
    const repo = requireRepo(c, store, "statuses", "write");
    const login = requireLogin(c);
    const sha = await repo.git.revParse(c.req.param("sha") ?? "");
    if (!sha) throw new HttpError(422, "No commit found for SHA");
    const body = await readJson(c);
    const state = requireStr(body, "state", "Status");
    if (state !== "error" && state !== "failure" && state !== "pending" && state !== "success") {
      throw validationFailed([{ resource: "Status", field: "state", code: "invalid" }]);
    }
    const now = store.clock.nowIso();
    const status: StatusRecord = {
      id: store.nextId(),
      sha,
      state,
      description: str(body, "description") ?? null,
      targetUrl: str(body, "target_url") ?? null,
      context: str(body, "context") ?? "default",
      creator: login,
      createdAt: now,
      updatedAt: now,
    };
    repo.statuses.push(status);
    store.emit(
      repo,
      "status",
      null,
      {
        id: status.id,
        sha,
        name: repo.fullName,
        state,
        description: status.description,
        target_url: status.targetUrl,
        context: status.context,
        created_at: now,
        updated_at: now,
        branches: [],
      },
      login,
    );
    return c.json(store.statusJson(repo, status), 201);
  });

  const statusesFor = async (c: HostContext, ref: string) => {
    const repo = requireRepo(c, store, "statuses", "read");
    const sha = await repo.git.revParse(ref);
    if (!sha) throw new HttpError(422, "No commit found for SHA");
    const list = repo.statuses.filter((s) => s.sha === sha).sort((a, b) => b.id - a.id);
    return c.json(
      paginate(
        c,
        list.map((s) => store.statusJson(repo, s)),
      ),
    );
  };

  const combinedStatusFor = async (c: HostContext, ref: string) => {
    const repo = requireRepo(c, store, "statuses", "read");
    const sha = await repo.git.revParse(ref);
    if (!sha) throw new HttpError(422, "No commit found for SHA");
    const latestByContext = new Map<string, StatusRecord>();
    for (const s of repo.statuses.filter((x) => x.sha === sha)) latestByContext.set(s.context, s);
    const statuses = [...latestByContext.values()];
    const states = statuses.map((s) => s.state);
    const combined =
      states.length === 0
        ? "pending"
        : states.includes("error") || states.includes("failure")
          ? "failure"
          : states.includes("pending")
            ? "pending"
            : "success";
    return c.json({
      state: combined,
      sha,
      total_count: statuses.length,
      statuses: statuses.map((s) => store.statusJson(repo, s)),
      repository: store.repoJson(repo, null),
      commit_url: `${store.baseUrl}/repos/${repo.fullName}/commits/${sha}`,
      url: `${store.baseUrl}/repos/${repo.fullName}/commits/${sha}/status`,
    });
  };

  // One dispatcher for everything under /commits/<ref>, because refs may contain slashes
  // ("feature/x") and arrive either raw or percent-encoded (the real adapter encodes).
  app.get("/repos/:owner/:repo/commits/*", (c) => {
    const rest = wildcardPath(c, "/commits/");
    for (const [suffix, handler] of [
      ["/check-runs", checkRunsFor],
      ["/statuses", statusesFor],
      ["/status", combinedStatusFor],
    ] as const) {
      if (rest.endsWith(suffix)) return handler(c, rest.slice(0, -suffix.length));
    }
    return commitDetail(c, store, rest);
  });

  // ---- webhooks ------------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/hooks", (c) => {
    const repo = requireRepo(c, store, "webhooks", "read");
    return c.json(
      paginate(
        c,
        [...repo.hooks.values()].map((h) => store.hookJson(repo, h)),
      ),
    );
  });

  app.post("/repos/:owner/:repo/hooks", async (c) => {
    const repo = requireRepo(c, store, "webhooks", "write");
    const login = requireLogin(c);
    const body = await readJson(c);
    const config = (body.config ?? {}) as Json;
    const url = str(config, "url");
    if (!url)
      throw validationFailed([{ resource: "Hook", field: "config.url", code: "missing_field" }]);
    const events = strList(body, "events") ?? ["push"];
    const now = store.clock.nowIso();
    const hook: HookRecord = {
      id: store.nextId(),
      active: bool(body, "active") ?? true,
      events,
      url,
      contentType: str(config, "content_type") === "form" ? "form" : "json",
      secret: str(config, "secret") ?? null,
      insecureSsl: str(config, "insecure_ssl") ?? "0",
      createdAt: now,
      updatedAt: now,
      lastResponse: { code: null, status: "unused", message: null },
    };
    repo.hooks.set(hook.id, hook);
    store.emit(
      repo,
      "ping",
      null,
      { zen: "Keep it logically awesome.", hook_id: hook.id, hook: store.hookJson(repo, hook) },
      login,
    );
    return c.json(store.hookJson(repo, hook), 201);
  });

  app.get("/repos/:owner/:repo/hooks/:id", (c) => {
    const repo = requireRepo(c, store, "webhooks", "read");
    const hook = repo.hooks.get(intParam(c, "id"));
    if (!hook) throw new HttpError(404, "Not Found");
    return c.json(store.hookJson(repo, hook));
  });

  app.patch("/repos/:owner/:repo/hooks/:id", async (c) => {
    const repo = requireRepo(c, store, "webhooks", "write");
    const hook = repo.hooks.get(intParam(c, "id"));
    if (!hook) throw new HttpError(404, "Not Found");
    const body = await readJson(c);
    const active = bool(body, "active");
    if (active !== undefined) hook.active = active;
    const events = strList(body, "events");
    if (events !== undefined) hook.events = events;
    const config = body.config as Json | undefined;
    if (config) {
      const url = str(config, "url");
      if (url !== undefined) hook.url = url;
      const secret = str(config, "secret");
      if (secret !== undefined) hook.secret = secret || null;
      const ct = str(config, "content_type");
      if (ct !== undefined) hook.contentType = ct === "form" ? "form" : "json";
    }
    hook.updatedAt = store.clock.nowIso();
    return c.json(store.hookJson(repo, hook));
  });

  app.delete("/repos/:owner/:repo/hooks/:id", (c) => {
    const repo = requireRepo(c, store, "webhooks", "write");
    const hook = repo.hooks.get(intParam(c, "id"));
    if (!hook) throw new HttpError(404, "Not Found");
    repo.hooks.delete(hook.id);
    return c.body(null, 204);
  });

  app.post("/repos/:owner/:repo/hooks/:id/pings", (c) => {
    const repo = requireRepo(c, store, "webhooks", "write");
    const login = requireLogin(c);
    const hook = repo.hooks.get(intParam(c, "id"));
    if (!hook) throw new HttpError(404, "Not Found");
    store.emit(
      repo,
      "ping",
      null,
      { zen: "Keep it logically awesome.", hook_id: hook.id, hook: store.hookJson(repo, hook) },
      login,
    );
    return c.body(null, 204);
  });

  app.get("/repos/:owner/:repo/hooks/:id/deliveries", (c) => {
    const repo = requireRepo(c, store, "webhooks", "read");
    const hook = repo.hooks.get(intParam(c, "id"));
    if (!hook) throw new HttpError(404, "Not Found");
    const deliveries = store.events
      .flatMap((e) => e.deliveries.map((d) => ({ event: e, delivery: d })))
      .filter(({ delivery }) => delivery.hookId === hook.id)
      .map(({ event, delivery }) => ({
        id: delivery.id,
        guid: delivery.id,
        delivered_at: delivery.at,
        redelivery: false,
        duration: 0,
        status: delivery.status === "delivered" ? "OK" : delivery.status,
        status_code: delivery.responseStatus,
        event: event.event,
        action: event.action,
        installation_id: null,
        repository_id: repo.id,
        url: delivery.url,
      }));
    return c.json(paginate(c, deliveries));
  });
}
