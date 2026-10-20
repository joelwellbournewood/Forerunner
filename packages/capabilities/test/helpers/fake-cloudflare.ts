/**
 * Fake Cloudflare REST API v4 on 127.0.0.1 (node:http) with the shapes the client uses: token
 * verify and policies, accounts and zones, Worker scripts (multipart) and routes, Pages direct
 * upload (upload token, check-missing, upload, upsert-hashes, deployment), DNS records and the
 * zone subscription (money). It records every request so tests can prove what was and was not
 * sent, and it can echo the Authorization header in an error body to prove scrubbing.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeZone {
  id: string;
  name: string;
  accountId: string;
  planId?: string;
}

export interface FakePolicy {
  effect: "allow" | "deny";
  permission_groups: { id: string; name: string }[];
  resources: Record<string, unknown>;
}

export interface FakeCloudflareOptions {
  token: string;
  tokenId?: string;
  accountId: string;
  accountName?: string;
  zones: FakeZone[];
  policies?: FakePolicy[];
  /** Pages projects that exist: name -> production branch. */
  pagesProjects?: Record<string, string>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

export interface FakeFailure {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Echo the Authorization header inside the error message (a hostile server). */
  echoAuth?: boolean;
  /** Only this many times (default 1). */
  times?: number;
}

interface Route {
  id: string;
  pattern: string;
  script: string | null;
}
interface DnsRec {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
  comment?: string;
}
interface Deployment {
  id: string;
  project: string;
  branch: string;
  environment: string;
  manifest: Record<string, string>;
}
interface Script {
  metadata: Record<string, unknown>;
  modules: Record<string, string>;
  contentTypes: Record<string, string>;
}

const PAGES_JWT_PREFIX = "pages-upload-";

export class FakeCloudflare {
  readonly requests: RecordedRequest[] = [];
  readonly scripts = new Map<string, Script>();
  readonly routes = new Map<string, Route[]>();
  readonly dns = new Map<string, DnsRec[]>();
  readonly deployments: Deployment[] = [];
  readonly assets = new Map<string, Set<string>>();
  readonly uploads: { key: string; contentType: string; bytes: number }[] = [];
  readonly planChanges: { zoneId: string; planId: string }[] = [];
  readonly uploadJwt: string;
  private failures: FakeFailure[] = [];
  private server: Server | null = null;
  private counter = 0;
  baseUrl = "";

  constructor(private readonly opts: FakeCloudflareOptions) {
    this.uploadJwt = `${PAGES_JWT_PREFIX}${["one", "two", "three"].join("-")}`; // not-a-secret
    for (const z of opts.zones) {
      this.routes.set(z.id, []);
      this.dns.set(z.id, []);
    }
    for (const name of Object.keys(opts.pagesProjects ?? {})) this.assets.set(name, new Set());
  }

  /** Make the next matching request fail with this status. */
  failNext(f: FakeFailure): void {
    this.failures.push({ times: 1, ...f });
  }

  /** Paths of the recorded requests that would change something. */
  writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify(envelope(false, null, [{ code: 1, message: String(e) }])));
      });
    });
    this.server = server;
    await new Promise<void>((resolveStart) => server.listen(0, "127.0.0.1", resolveStart));
    const addr = server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${addr.port}/client/v4`;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolveStop) => server.close(() => resolveStop()));
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/^\/client\/v4/, "");
    const method = req.method ?? "GET";
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] ?? null;
    const authorization =
      typeof req.headers.authorization === "string" ? req.headers.authorization : null;
    let body: unknown = null;
    if (contentType?.startsWith("application/json") && raw.length) {
      body = JSON.parse(raw.toString("utf8"));
    } else if (contentType?.startsWith("multipart/form-data")) {
      const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
      const parts: Record<string, { filename: string | null; type: string; text: string }> = {};
      for (const [name, value] of form.entries()) {
        if (typeof value === "string") parts[name] = { filename: null, type: "", text: value };
        else parts[name] = { filename: value.name, type: value.type, text: await value.text() };
      }
      body = parts;
    } else if (raw.length) {
      body = raw.toString("utf8");
    }
    const query: Record<string, string> = {};
    for (const [k, v] of url.searchParams) query[k] = v;
    this.requests.push({ method, path, query, authorization, contentType, body });

    const failure = this.failures[0];
    if (failure) {
      failure.times = (failure.times ?? 1) - 1;
      if (failure.times <= 0) this.failures.shift();
      const message = failure.echoAuth
        ? `server error while handling ${authorization ?? "(no auth)"}`
        : "injected failure";
      res.writeHead(failure.status, {
        "content-type": "application/json",
        ...(failure.headers ?? {}),
      });
      res.end(
        JSON.stringify(
          failure.body ?? envelope(false, null, [{ code: 10_000 + failure.status, message }]),
        ),
      );
      return;
    }

    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const ok = (result: unknown, info?: Record<string, number>) =>
      send(200, { ...envelope(true, result), ...(info ? { result_info: info } : {}) });
    const authError = () =>
      send(401, envelope(false, null, [{ code: 10000, message: "Authentication error" }]));
    const forbidden = () =>
      send(
        403,
        envelope(false, null, [
          { code: 9109, message: "Unauthorized to access requested resource" },
        ]),
      );
    const notFound = (what: string) =>
      send(404, envelope(false, null, [{ code: 7003, message: `${what} not found` }]));

    // Pages asset endpoints use the upload JWT; everything else the account token.
    if (path.startsWith("/pages/assets/")) {
      if (bearer !== this.uploadJwt) return authError();
      const project = [...this.assets.keys()][0] ?? "";
      const assets = this.assets.get(project) ?? new Set<string>();
      const b = body as
        | { hashes?: string[] }
        | { key: string; value: string; metadata: { contentType: string } }[];
      if (path === "/pages/assets/check-missing" && method === "POST") {
        const hashes = (b as { hashes?: string[] }).hashes ?? [];
        return ok(hashes.filter((h) => !assets.has(h)));
      }
      if (path === "/pages/assets/upload" && method === "POST") {
        for (const item of b as {
          key: string;
          value: string;
          metadata: { contentType: string };
        }[]) {
          assets.add(item.key);
          this.uploads.push({
            key: item.key,
            contentType: item.metadata.contentType,
            bytes: Buffer.from(item.value, "base64").length,
          });
        }
        return ok({ successful_key_count: (b as unknown[]).length, unsuccessful_keys: [] });
      }
      if (path === "/pages/assets/upsert-hashes" && method === "POST") {
        for (const h of (b as { hashes?: string[] }).hashes ?? []) assets.add(h);
        return ok({ success: true });
      }
      return notFound("route");
    }

    if (bearer !== this.opts.token) return authError();

    if (path === "/user/tokens/verify" && method === "GET") {
      return ok({
        id: this.opts.tokenId ?? "tok1",
        status: "active",
        not_before: null,
        expires_on: null,
      });
    }
    const tokenMatch = path.match(/^\/user\/tokens\/([^/]+)$/);
    if (tokenMatch && method === "GET") {
      if (tokenMatch[1] !== (this.opts.tokenId ?? "tok1")) return notFound("token");
      return ok({ id: tokenMatch[1], status: "active", policies: this.opts.policies ?? [] });
    }

    if (path === "/zones" && method === "GET") {
      const account = query["account.id"];
      const perPage = Number(query.per_page ?? 20);
      const page = Number(query.page ?? 1);
      const all = this.opts.zones.filter((z) => !account || z.accountId === account);
      const slice = all.slice((page - 1) * perPage, page * perPage);
      return ok(slice.map(zoneBody), {
        page,
        per_page: perPage,
        total_pages: Math.max(1, Math.ceil(all.length / perPage)),
        count: slice.length,
        total_count: all.length,
      });
    }

    const zoneMatch = path.match(/^\/zones\/([^/]+)(.*)$/);
    if (zoneMatch) {
      const zone = this.opts.zones.find((z) => z.id === zoneMatch[1]);
      if (!zone) return forbidden();
      const rest = zoneMatch[2] ?? "";
      if (rest === "" && method === "GET") return ok(zoneBody(zone));
      if (rest === "/workers/routes" && method === "GET") return ok(this.routes.get(zone.id));
      if (rest === "/workers/routes" && method === "POST") {
        const b = body as { pattern: string; script: string };
        const route = { id: this.nextId("route"), pattern: b.pattern, script: b.script };
        this.routes.get(zone.id)?.push(route);
        return ok(route);
      }
      const routeMatch = rest.match(/^\/workers\/routes\/([^/]+)$/);
      if (routeMatch && method === "PUT") {
        const route = this.routes.get(zone.id)?.find((r) => r.id === routeMatch[1]);
        if (!route) return notFound("route");
        const b = body as { pattern: string; script: string };
        route.pattern = b.pattern;
        route.script = b.script;
        return ok(route);
      }
      if (rest === "/dns_records" && method === "GET") {
        const list = (this.dns.get(zone.id) ?? []).filter(
          (r) => (!query.type || r.type === query.type) && (!query.name || r.name === query.name),
        );
        return ok(list);
      }
      if (rest === "/dns_records" && method === "POST") {
        const b = body as Omit<DnsRec, "id">;
        const rec: DnsRec = {
          id: this.nextId("dns"),
          type: b.type,
          name: b.name,
          content: b.content,
          ttl: b.ttl ?? 1,
          proxied: b.proxied ?? false,
          priority: b.priority ?? null,
          comment: b.comment,
        };
        this.dns.get(zone.id)?.push(rec);
        return ok(rec);
      }
      const dnsMatch = rest.match(/^\/dns_records\/([^/]+)$/);
      if (dnsMatch && method === "PUT") {
        const rec = this.dns.get(zone.id)?.find((r) => r.id === dnsMatch[1]);
        if (!rec) return notFound("record");
        const b = body as Partial<DnsRec>;
        Object.assign(rec, {
          type: b.type ?? rec.type,
          name: b.name ?? rec.name,
          content: b.content ?? rec.content,
          ttl: b.ttl ?? rec.ttl,
          proxied: b.proxied ?? rec.proxied,
          priority: b.priority ?? rec.priority,
        });
        return ok(rec);
      }
      if (rest === "/subscription" && method === "PUT") {
        const b = body as { rate_plan?: { id?: string } };
        const planId = b.rate_plan?.id ?? "";
        this.planChanges.push({ zoneId: zone.id, planId });
        zone.planId = planId;
        return ok({ id: this.nextId("sub"), rate_plan: { id: planId } });
      }
      return notFound("route");
    }

    const accountMatch = path.match(/^\/accounts\/([^/]+)(.*)$/);
    if (accountMatch) {
      if (accountMatch[1] !== this.opts.accountId) return forbidden();
      const rest = accountMatch[2] ?? "";
      if (rest === "" && method === "GET") {
        return ok({ id: this.opts.accountId, name: this.opts.accountName ?? "Fake account" });
      }
      if (rest === "/workers/scripts" && method === "GET") {
        return ok(
          [...this.scripts.keys()].map((id) => ({ id, etag: `etag-${id}`, modified_on: null })),
        );
      }
      const scriptMatch = rest.match(/^\/workers\/scripts\/([^/]+)$/);
      if (scriptMatch && method === "PUT") {
        const parts = body as Record<
          string,
          { filename: string | null; type: string; text: string }
        >;
        const metadataPart = parts.metadata;
        if (!metadataPart) {
          return send(
            400,
            envelope(false, null, [{ code: 10021, message: "metadata part missing" }]),
          );
        }
        const metadata = JSON.parse(metadataPart.text) as Record<string, unknown>;
        const modules: Record<string, string> = {};
        const contentTypes: Record<string, string> = {};
        for (const [name, part] of Object.entries(parts)) {
          if (name === "metadata") continue;
          modules[name] = part.text;
          contentTypes[name] = part.type;
        }
        const main = String(metadata.main_module ?? "");
        if (!modules[main]) {
          return send(
            400,
            envelope(false, null, [{ code: 10021, message: `main module ${main} missing` }]),
          );
        }
        const name = decodeURIComponent(scriptMatch[1] ?? "");
        this.scripts.set(name, { metadata, modules, contentTypes });
        return ok({
          id: name,
          etag: `etag-${name}-${this.counter}`,
          modified_on: "2026-01-05T08:00:00Z",
        });
      }
      const pagesMatch = rest.match(/^\/pages\/projects\/([^/]+)(.*)$/);
      if (pagesMatch) {
        const name = decodeURIComponent(pagesMatch[1] ?? "");
        const productionBranch = this.opts.pagesProjects?.[name];
        if (productionBranch === undefined) return notFound("project");
        const tail = pagesMatch[2] ?? "";
        if (tail === "" && method === "GET") {
          return ok({
            name,
            production_branch: productionBranch,
            subdomain: `${name}.pages.dev`,
            domains: [`${name}.pages.dev`],
          });
        }
        if (tail === "/upload-token" && method === "GET") return ok({ jwt: this.uploadJwt });
        if (tail === "/deployments" && method === "POST") {
          const parts = body as Record<string, { text: string }>;
          const manifest = JSON.parse(parts.manifest?.text ?? "{}") as Record<string, string>;
          const branch = parts.branch?.text ?? productionBranch;
          const assets = this.assets.get(name) ?? new Set<string>();
          const missing = Object.values(manifest).filter((h) => !assets.has(h));
          if (missing.length) {
            return send(
              400,
              envelope(false, null, [
                { code: 8000000, message: `assets missing: ${missing.join(",")}` },
              ]),
            );
          }
          const environment = branch === productionBranch ? "production" : "preview";
          const id = this.nextId("dep");
          this.deployments.push({ id, project: name, branch, environment, manifest });
          return ok({
            id,
            url: `https://${id}.${name}.pages.dev`,
            environment,
            deployment_trigger: { metadata: { branch } },
          });
        }
      }
      return notFound("route");
    }
    return notFound("route");
  }
}

function envelope(
  success: boolean,
  result: unknown,
  errors: { code: number; message: string }[] = [],
) {
  return { success, errors, messages: [], result };
}

function zoneBody(z: FakeZone) {
  return {
    id: z.id,
    name: z.name,
    status: "active",
    account: { id: z.accountId, name: "Fake account" },
    plan: { id: z.planId ?? "free", name: z.planId ?? "Free Website" },
  };
}
