import { createServer, type Server } from "node:http";

/**
 * A GitHub Projects V2 GraphQL stand-in over node:http for unit tests of the GitHub adapter.
 * It dispatches on the operation name the adapter sends, keeps a tiny store (owners,
 * projects, fields, items) and records every request body so tests can assert the exact
 * GraphQL documents and variables that went over the wire. The fake git host in testenv
 * only speaks classic (REST) projects, which GitHub retired; Projects V2 is GraphQL-only.
 */
export interface GqlRequest {
  operationName: string;
  query: string;
  variables: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

interface FakeField {
  id: string;
  name: string;
  dataType: "TITLE" | "TEXT" | "SINGLE_SELECT" | "NUMBER";
  options: { id: string; name: string; color: string; description: string }[];
}

interface FakeItem {
  id: string;
  isArchived: boolean;
  content: { __typename: "DraftIssue" | "Issue"; id: string; title: string; body: string };
  values: Map<string, { text?: string; optionId?: string }>; // fieldId -> value
}

interface FakeProject {
  id: string;
  number: number;
  title: string;
  url: string;
  closed: boolean;
  ownerLogin: string;
  fields: FakeField[];
  items: FakeItem[];
}

export interface FakeProjectsOptions {
  /** Known owners (users or orgs). */
  owners?: string[];
  /** Page size for item listing (small values exercise pagination). */
  pageSize?: number;
}

export class FakeProjectsGraphql {
  readonly requests: GqlRequest[] = [];
  readonly projects = new Map<string, FakeProject>();
  /** Queue of canned responses: each entry answers the next request instead of the store. */
  readonly canned: { status: number; headers?: Record<string, string>; body: unknown }[] = [];
  private seq = 1;
  private server: Server | null = null;
  url = "";
  private readonly owners: Map<string, string>;
  private readonly pageSize: number;

  constructor(opts: FakeProjectsOptions = {}) {
    this.owners = new Map((opts.owners ?? ["acme"]).map((o) => [o, `O_${o}`]));
    this.pageSize = opts.pageSize ?? 100;
  }

  private nextId(prefix: string): string {
    return `${prefix}_${this.seq++}`;
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const canned = this.canned.shift();
        if (canned) {
          res.writeHead(canned.status, { "content-type": "application/json", ...canned.headers });
          res.end(JSON.stringify(canned.body));
          return;
        }
        if (req.url !== "/graphql" || req.method !== "POST") {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: `unhandled ${req.method} ${req.url}` }));
          return;
        }
        let parsed: { query?: string; variables?: Record<string, unknown>; operationName?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ message: "bad json" }));
          return;
        }
        const op = parsed.operationName ?? "";
        this.requests.push({
          operationName: op,
          query: parsed.query ?? "",
          variables: parsed.variables ?? {},
          headers: req.headers,
        });
        try {
          const data = this.handle(op, parsed.query ?? "", parsed.variables ?? {});
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data }));
        } catch (e) {
          const err = e as { gql?: { type: string; message: string } };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              data: null,
              errors: [err.gql ?? { type: "INTERNAL", message: String(e) }],
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const addr = this.server?.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  ops(): string[] {
    return this.requests.map((r) => r.operationName);
  }

  /** Create a project directly (as if a human had), with GitHub's default Status field. */
  seedProject(ownerLogin: string, title: string): FakeProject {
    const id = this.nextId("PVT");
    const p: FakeProject = {
      id,
      number: this.projects.size + 1,
      title,
      url: `https://github.example/${ownerLogin}/projects/${this.projects.size + 1}`,
      closed: false,
      ownerLogin,
      fields: [
        { id: this.nextId("PVTF"), name: "Title", dataType: "TITLE", options: [] },
        {
          id: this.nextId("PVTSSF"),
          name: "Status",
          dataType: "SINGLE_SELECT",
          options: ["Todo", "In Progress", "Done"].map((n) => ({
            id: this.nextId("OPT"),
            name: n,
            color: "GRAY",
            description: "",
          })),
        },
      ],
      items: [],
    };
    this.projects.set(id, p);
    return p;
  }

  private fail(type: string, message: string): never {
    throw { gql: { type, message } };
  }

  private project(id: unknown): FakeProject {
    const p = this.projects.get(String(id));
    if (!p) this.fail("NOT_FOUND", `project ${String(id)} not found`);
    return p;
  }

  private fieldJson(f: FakeField) {
    return {
      id: f.id,
      name: f.name,
      dataType: f.dataType,
      ...(f.dataType === "SINGLE_SELECT"
        ? { options: f.options.map((o) => ({ id: o.id, name: o.name })) }
        : {}),
    };
  }

  private itemJson(p: FakeProject, it: FakeItem) {
    const nodes: unknown[] = [];
    for (const [fieldId, v] of it.values) {
      const f = p.fields.find((x) => x.id === fieldId);
      if (!f) continue;
      if (v.text !== undefined) nodes.push({ text: v.text, field: { name: f.name } });
      else if (v.optionId !== undefined) {
        const o = f.options.find((x) => x.id === v.optionId);
        nodes.push({ name: o?.name ?? "", field: { name: f.name } });
      }
    }
    return {
      id: it.id,
      isArchived: it.isArchived,
      content: { ...it.content },
      fieldValues: { nodes },
    };
  }

  private handle(op: string, query: string, v: Record<string, unknown>): unknown {
    switch (op) {
      case "MirrorOwnerProjects": {
        const ownerId = this.owners.get(String(v.login));
        if (!ownerId) return { repositoryOwner: null };
        const nodes = [...this.projects.values()]
          .filter((p) => p.ownerLogin === v.login && p.title.includes(String(v.query ?? "")))
          .map((p) => ({
            id: p.id,
            number: p.number,
            title: p.title,
            url: p.url,
            closed: p.closed,
          }));
        return { repositoryOwner: { id: ownerId, projectsV2: { nodes } } };
      }
      case "MirrorCreateProject": {
        const login = [...this.owners.entries()].find(([, id]) => id === v.ownerId)?.[0];
        if (!login) this.fail("NOT_FOUND", "owner not found");
        const p = this.seedProject(login, String(v.title));
        return {
          createProjectV2: {
            projectV2: { id: p.id, number: p.number, title: p.title, url: p.url, closed: false },
          },
        };
      }
      case "MirrorFields": {
        const p = this.project(v.projectId);
        return { node: { fields: { nodes: p.fields.map((f) => this.fieldJson(f)) } } };
      }
      case "MirrorCreateField": {
        const p = this.project(v.projectId);
        if (p.fields.some((f) => f.name.toLowerCase() === String(v.name).toLowerCase()))
          this.fail("UNPROCESSABLE", "Name has already been taken");
        const options = (v.options as FakeField["options"] | null) ?? [];
        for (const o of options) {
          if (typeof o.color !== "string" || typeof o.description !== "string")
            this.fail("UNPROCESSABLE", "option needs color and description");
        }
        const f: FakeField = {
          id: this.nextId(v.dataType === "SINGLE_SELECT" ? "PVTSSF" : "PVTF"),
          name: String(v.name),
          dataType: v.dataType === "SINGLE_SELECT" ? "SINGLE_SELECT" : "TEXT",
          options: options.map((o) => ({ ...o, id: this.nextId("OPT") })),
        };
        p.fields.push(f);
        return { createProjectV2Field: { projectV2Field: this.fieldJson(f) } };
      }
      case "MirrorUpdateFieldOptions": {
        const p = [...this.projects.values()].find((x) => x.fields.some((f) => f.id === v.fieldId));
        const f = p?.fields.find((x) => x.id === v.fieldId);
        if (!f) this.fail("NOT_FOUND", "field not found");
        const options = v.options as FakeField["options"];
        f.options = options.map((o) => ({
          ...o,
          id: f.options.find((x) => x.name === o.name)?.id ?? this.nextId("OPT"),
        }));
        return { updateProjectV2Field: { projectV2Field: this.fieldJson(f) } };
      }
      case "MirrorItems": {
        const p = this.project(v.projectId);
        const start = v.after ? Number(String(v.after).slice(2)) : 0;
        const page = p.items.slice(start, start + this.pageSize);
        const end = start + page.length;
        return {
          node: {
            items: {
              pageInfo: { hasNextPage: end < p.items.length, endCursor: `c:${end}` },
              nodes: page.map((it) => this.itemJson(p, it)),
            },
          },
        };
      }
      case "MirrorAddDraft": {
        const p = this.project(v.projectId);
        const it: FakeItem = {
          id: this.nextId("PVTI"),
          isArchived: false,
          content: {
            __typename: "DraftIssue",
            id: this.nextId("DI"),
            title: String(v.title),
            body: String(v.body ?? ""),
          },
          values: new Map(),
        };
        p.items.push(it);
        return {
          addProjectV2DraftIssue: { projectItem: { id: it.id, content: { id: it.content.id } } },
        };
      }
      case "MirrorUpdateDraft": {
        const it = [...this.projects.values()]
          .flatMap((p) => p.items)
          .find((x) => x.content.id === v.draftIssueId);
        if (!it) this.fail("NOT_FOUND", "draft not found");
        it.content.title = String(v.title);
        it.content.body = String(v.body ?? "");
        return { updateProjectV2DraftIssue: { draftIssue: { id: it.content.id } } };
      }
      case "MirrorSetFields": {
        const p = this.project(v.projectId);
        const it = p.items.find((x) => x.id === v.itemId);
        if (!it) this.fail("NOT_FOUND", "item not found");
        if (it.isArchived) this.fail("UNPROCESSABLE", "item is archived");
        const out: Record<string, unknown> = {};
        for (const [alias, body] of [...query.matchAll(/(f\d+): (\w+)\(input: \{([^}]*)\}/g)]
          .map((m) => [m[1] as string, m[2] as string, m[3] as string] as const)
          .map(([a, name, input]) => [a, { name, input }] as const)) {
          const fieldVar = /fieldId: \$(\w+)/.exec(body.input)?.[1] ?? "";
          const field = p.fields.find((f) => f.id === v[fieldVar]);
          if (!field) this.fail("NOT_FOUND", `field ${String(v[fieldVar])} not found`);
          if (body.name === "clearProjectV2ItemFieldValue") {
            it.values.delete(field.id);
          } else {
            const valueVar = /value: \$(\w+)/.exec(body.input)?.[1] ?? "";
            const value = v[valueVar] as { text?: string; singleSelectOptionId?: string };
            if (value.singleSelectOptionId !== undefined) {
              if (!field.options.some((o) => o.id === value.singleSelectOptionId))
                this.fail("UNPROCESSABLE", "unknown option");
              it.values.set(field.id, { optionId: value.singleSelectOptionId });
            } else it.values.set(field.id, { text: String(value.text ?? "") });
          }
          out[alias] = { projectV2Item: { id: it.id } };
        }
        return out;
      }
      case "MirrorArchiveItem":
      case "MirrorUnarchiveItem": {
        const p = this.project(v.projectId);
        const it = p.items.find((x) => x.id === v.itemId);
        if (!it) this.fail("NOT_FOUND", "item not found");
        it.isArchived = op === "MirrorArchiveItem";
        return op === "MirrorArchiveItem"
          ? { archiveProjectV2Item: { item: { id: it.id } } }
          : { unarchiveProjectV2Item: { item: { id: it.id } } };
      }
      default:
        this.fail("INTERNAL", `unhandled operation ${op}`);
    }
  }
}
