/**
 * Classic repository projects: projects, columns and cards (the one-way task mirror target).
 */

import type { HostApp, HostContext } from "./http.ts";
import {
  bool,
  guardRepo,
  HttpError,
  intParam,
  num,
  paginate,
  readJson,
  requireLogin,
  requireRepo,
  requireStr,
  str,
  validationFailed,
} from "./http.ts";
import type { RouteContext } from "./routes-repos.ts";
import type { CardRecord, ColumnRecord, ProjectRecord } from "./store.ts";
import type { PermissionLevel } from "./types.ts";

export function registerProjectRoutes(app: HostApp, ctx: RouteContext): void {
  const { store } = ctx;

  const projectOf = (c: HostContext, level: PermissionLevel, param = "id"): ProjectRecord => {
    const p = store.projects.get(intParam(c, param));
    if (!p) throw new HttpError(404, "Not Found");
    guardRepo(c, p.repo, "projects", level);
    return p;
  };
  const columnOf = (c: HostContext, level: PermissionLevel, param = "id"): ColumnRecord => {
    const col = store.columns.get(intParam(c, param));
    if (!col) throw new HttpError(404, "Not Found");
    guardRepo(c, col.project.repo, "projects", level);
    return col;
  };
  const cardOf = (c: HostContext, level: PermissionLevel, param = "id"): CardRecord => {
    const card = store.cards.get(intParam(c, param));
    if (!card) throw new HttpError(404, "Not Found");
    guardRepo(c, card.column.project.repo, "projects", level);
    return card;
  };

  const place = <T extends { id: number }>(list: T[], item: T, position: string | undefined) => {
    const idx = list.indexOf(item);
    if (idx !== -1) list.splice(idx, 1);
    const after = position?.startsWith("after:") ? Number(position.slice(6)) : null;
    if (position === "first" || position === "top") list.unshift(item);
    else if (after !== null) {
      const at = list.findIndex((x) => x.id === after);
      if (at === -1)
        throw validationFailed([{ resource: "Position", field: "position", code: "invalid" }]);
      list.splice(at + 1, 0, item);
    } else list.push(item);
  };

  // ---- projects ------------------------------------------------------------------------------
  app.get("/repos/:owner/:repo/projects", (c) => {
    const repo = requireRepo(c, store, "projects", "read");
    const state = c.req.query("state") ?? "open";
    const list = repo.projects.filter((p) => state === "all" || p.state === state);
    return c.json(
      paginate(
        c,
        list.map((p) => store.projectJson(p)),
      ),
    );
  });

  app.post("/repos/:owner/:repo/projects", async (c) => {
    const repo = requireRepo(c, store, "projects", "write");
    const login = requireLogin(c);
    const body = await readJson(c);
    const now = store.clock.nowIso();
    const project: ProjectRecord = {
      id: store.nextId(),
      number: repo.nextProjectNumber++,
      name: requireStr(body, "name", "Project"),
      body: str(body, "body") ?? "",
      state: "open",
      repo,
      creator: login,
      createdAt: now,
      updatedAt: now,
      columns: [],
    };
    repo.projects.push(project);
    store.projects.set(project.id, project);
    return c.json(store.projectJson(project), 201);
  });

  app.get("/projects/:id", (c) => c.json(store.projectJson(projectOf(c, "read"))));

  app.patch("/projects/:id", async (c) => {
    const project = projectOf(c, "write");
    const body = await readJson(c);
    const name = str(body, "name");
    if (name !== undefined) project.name = name;
    const text = str(body, "body");
    if (text !== undefined) project.body = text;
    const state = str(body, "state");
    if (state === "open" || state === "closed") project.state = state;
    project.updatedAt = store.clock.nowIso();
    return c.json(store.projectJson(project));
  });

  app.delete("/projects/:id", (c) => {
    const project = projectOf(c, "write");
    project.repo.projects = project.repo.projects.filter((p) => p !== project);
    store.projects.delete(project.id);
    for (const col of project.columns) {
      store.columns.delete(col.id);
      for (const card of col.cards) store.cards.delete(card.id);
    }
    return c.body(null, 204);
  });

  // ---- columns -------------------------------------------------------------------------------
  app.get("/projects/:id/columns", (c) => {
    const project = projectOf(c, "read");
    return c.json(
      paginate(
        c,
        project.columns.map((col) => store.columnJson(col)),
      ),
    );
  });

  app.post("/projects/:id/columns", async (c) => {
    const project = projectOf(c, "write");
    const body = await readJson(c);
    const now = store.clock.nowIso();
    const col: ColumnRecord = {
      id: store.nextId(),
      name: requireStr(body, "name", "ProjectColumn"),
      project,
      cards: [],
      createdAt: now,
      updatedAt: now,
    };
    project.columns.push(col);
    store.columns.set(col.id, col);
    return c.json(store.columnJson(col), 201);
  });

  app.get("/projects/columns/:id", (c) => c.json(store.columnJson(columnOf(c, "read"))));

  app.patch("/projects/columns/:id", async (c) => {
    const col = columnOf(c, "write");
    const body = await readJson(c);
    col.name = requireStr(body, "name", "ProjectColumn");
    col.updatedAt = store.clock.nowIso();
    return c.json(store.columnJson(col));
  });

  app.delete("/projects/columns/:id", (c) => {
    const col = columnOf(c, "write");
    col.project.columns = col.project.columns.filter((x) => x !== col);
    store.columns.delete(col.id);
    for (const card of col.cards) store.cards.delete(card.id);
    return c.body(null, 204);
  });

  app.post("/projects/columns/:id/moves", async (c) => {
    const col = columnOf(c, "write");
    const body = await readJson(c);
    place(col.project.columns, col, requireStr(body, "position", "ProjectColumn"));
    return c.json({}, 201);
  });

  // ---- cards ---------------------------------------------------------------------------------
  app.get("/projects/columns/:id/cards", (c) => {
    const col = columnOf(c, "read");
    const filter = c.req.query("archived_state") ?? "not_archived";
    const cards = col.cards.filter((card) =>
      filter === "all" ? true : filter === "archived" ? card.archived : !card.archived,
    );
    return c.json(
      paginate(
        c,
        cards.map((card) => store.cardJson(card)),
      ),
    );
  });

  app.post("/projects/columns/:id/cards", async (c) => {
    const col = columnOf(c, "write");
    const login = requireLogin(c);
    const body = await readJson(c);
    const note = str(body, "note") ?? null;
    const contentId = num(body, "content_id") ?? null;
    const contentTypeRaw = str(body, "content_type");
    let contentType: CardRecord["contentType"] = null;
    if (contentId !== null) {
      if (contentTypeRaw !== "Issue" && contentTypeRaw !== "PullRequest") {
        throw validationFailed([
          { resource: "ProjectCard", field: "content_type", code: "invalid" },
        ]);
      }
      contentType = contentTypeRaw;
      const repo = col.project.repo;
      const issue = [...repo.issues.values()].find(
        (i) => i.id === contentId || i.number === contentId,
      );
      if (!issue)
        throw validationFailed([{ resource: "ProjectCard", field: "content_id", code: "invalid" }]);
    } else if (note === null) {
      throw validationFailed([{ resource: "ProjectCard", field: "note", code: "missing_field" }]);
    }
    const now = store.clock.nowIso();
    const card: CardRecord = {
      id: store.nextId(),
      note,
      archived: false,
      column: col,
      contentId: contentId !== null ? resolveIssueNumber(col, contentId) : null,
      contentType,
      creator: login,
      createdAt: now,
      updatedAt: now,
    };
    col.cards.unshift(card);
    store.cards.set(card.id, card);
    return c.json(store.cardJson(card), 201);
  });

  app.get("/projects/columns/cards/:id", (c) => c.json(store.cardJson(cardOf(c, "read"))));

  app.patch("/projects/columns/cards/:id", async (c) => {
    const card = cardOf(c, "write");
    const body = await readJson(c);
    const note = str(body, "note");
    if (note !== undefined) card.note = note;
    const archived = bool(body, "archived");
    if (archived !== undefined) card.archived = archived;
    // Extension: `column_id` on PATCH moves the card (GitHub uses POST .../moves).
    const columnId = num(body, "column_id");
    if (columnId !== undefined) moveCard(card, columnId, str(body, "position"));
    card.updatedAt = store.clock.nowIso();
    return c.json(store.cardJson(card));
  });

  app.post("/projects/columns/cards/:id/moves", async (c) => {
    const card = cardOf(c, "write");
    const body = await readJson(c);
    const position = requireStr(body, "position", "ProjectCard");
    moveCard(card, num(body, "column_id") ?? card.column.id, position);
    card.updatedAt = store.clock.nowIso();
    return c.json({}, 201);
  });

  app.delete("/projects/columns/cards/:id", (c) => {
    const card = cardOf(c, "write");
    card.column.cards = card.column.cards.filter((x) => x !== card);
    store.cards.delete(card.id);
    return c.body(null, 204);
  });

  function moveCard(card: CardRecord, columnId: number, position: string | undefined): void {
    const target = store.columns.get(columnId);
    if (!target || target.project !== card.column.project) {
      throw validationFailed([{ resource: "ProjectCard", field: "column_id", code: "invalid" }]);
    }
    card.column.cards = card.column.cards.filter((x) => x !== card);
    card.column = target;
    place(target.cards, card, position ?? "top");
  }

  function resolveIssueNumber(col: ColumnRecord, contentId: number): number {
    const repo = col.project.repo;
    const issue = [...repo.issues.values()].find(
      (i) => i.id === contentId || i.number === contentId,
    );
    return issue ? issue.number : contentId;
  }
}
