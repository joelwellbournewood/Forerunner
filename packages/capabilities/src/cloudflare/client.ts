/**
 * Cloudflare REST API v4 client, restricted to one account and named zones (spec: "Cloudflare
 * token scoped to named zones and Workers. Each grant shows its scopes in the Extensions
 * panel"). The token is resolved from the vault by reference at call time and lives only in
 * the Authorization header; every message that could carry it (errors, logs, audit rows) is
 * scrubbed. Anything outside the configured scope is refused in code before any request:
 * zone paths are built by `zonePath` (which checks the id), account paths by `accountPath`
 * (which only knows the configured account). Endpoints that change a plan or buy something
 * are refused unless the caller proves a human said yes (`moneyApproved`), at every autonomy
 * level.
 *
 * Works against api.cloudflare.com and the fake Cloudflare API in the tests (same shapes).
 */
import {
  type Clock,
  ForerunnerError,
  type Logger,
  log,
  redact,
  systemClock,
} from "@forerunner/platform";
import { parseSecretRef, redactValues, resolveSecretRefs, type Vault } from "@forerunner/vault";
import {
  CLOUDFLARE_API_BASE_URL,
  type CloudflareScope,
  DEFAULT_CLOUDFLARE_SECRET_REF,
} from "./settings.ts";

// ---------------------------------------------------------------------------------------------
// Token source: the vault by reference, resolved at call time

export type TokenSource = () => Promise<string>;

export interface TokenSourceOptions {
  vault: Vault;
  /** `secret:<name>`; default `secret:cloudflare_api_token`. */
  ref?: string;
  /** Called with the secret name (never the value) each time it is resolved. */
  audit?: (name: string) => void;
}

/** Resolves the token from the vault on every call; the value is never cached here. */
export function cloudflareTokenSource(opts: TokenSourceOptions): TokenSource {
  const ref = opts.ref ?? DEFAULT_CLOUDFLARE_SECRET_REF;
  const name = parseSecretRef(ref);
  return async () => {
    const resolved = (await resolveSecretRefs({ token: ref }, opts.vault, new Set([name]), {
      audit: opts.audit,
    })) as { token: string };
    if (!resolved.token) {
      throw new ForerunnerError("provider_auth", "Cloudflare token is empty", {
        details: { ref },
      });
    }
    return resolved.token;
  };
}

/** A fixed token for callers that already resolved it (the runtime hooks do). */
export function staticTokenSource(token: string): TokenSource {
  if (!token) throw new ForerunnerError("provider_auth", "Cloudflare client needs a token");
  return async () => token;
}

// ---------------------------------------------------------------------------------------------
// API shapes

export interface ApiError {
  code: number;
  message: string;
}

export interface ResultInfo {
  page?: number;
  per_page?: number;
  total_pages?: number;
  count?: number;
  total_count?: number;
}

export interface ApiEnvelope<T> {
  success: boolean;
  errors?: ApiError[];
  messages?: unknown[];
  result: T;
  result_info?: ResultInfo;
}

export interface AccountInfo {
  id: string;
  name: string;
}

export interface ZoneInfo {
  id: string;
  name: string;
  status: string;
  accountId: string | null;
  plan: { id: string; name: string } | null;
}

export interface TokenPolicy {
  effect: "allow" | "deny";
  permissionGroups: { id: string; name: string }[];
  /** Flattened resource keys, e.g. `com.cloudflare.api.account.zone.<id>`. */
  resources: string[];
}

/** What the Extensions panel shows for the grant (S.5). Never the token value. */
export interface TokenVerification {
  id: string;
  status: string;
  notBefore: string | null;
  expiresOn: string | null;
  /** Human-readable lines: `<permission group> on <resource>`. */
  scopes: string[];
  /** False when the token cannot read its own policies (needs "API Tokens Read"). */
  scopesKnown: boolean;
  policies: TokenPolicy[];
  /** Configured zones or account the token's allow policies do not name. */
  warnings: string[];
}

export interface WorkerScriptInfo {
  id: string;
  etag: string | null;
  modifiedOn: string | null;
}

export interface WorkerBinding {
  type: string;
  name: string;
  [key: string]: unknown;
}

export interface WorkerUpload {
  script: string;
  /** Module file name inside the upload; default `index.js`. */
  mainModule?: string;
  bindings?: WorkerBinding[];
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  /** Durable Object migrations (`new_classes`, `new_sqlite_classes`, ...); paid. */
  migrations?: Record<string, unknown>;
  logpush?: boolean;
  usageModel?: string;
}

export interface WorkerRouteInfo {
  id: string;
  pattern: string;
  script: string | null;
}

export interface PagesProjectInfo {
  name: string;
  productionBranch: string;
  subdomain: string | null;
  domains: string[];
}

export interface PagesDeploymentInfo {
  id: string;
  url: string | null;
  environment: string;
  branch: string | null;
}

export interface PagesAssetUpload {
  /** The asset hash, which is the key. */
  key: string;
  /** Base64 content. */
  value: string;
  contentType: string;
}

export const DNS_RECORD_TYPES = [
  "A",
  "AAAA",
  "CNAME",
  "TXT",
  "MX",
  "SRV",
  "NS",
  "CAA",
  "PTR",
] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export interface DnsRecordInput {
  type: DnsRecordType;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  comment?: string;
}

export interface DnsRecordInfo {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority: number | null;
}

// ---------------------------------------------------------------------------------------------
// Money endpoints: refused without a human's answer, at every autonomy level

/** Paths that change a plan or buy something. Checked before any request is sent. */
export const MONEY_PATH_PATTERNS: readonly RegExp[] = [
  /\/subscriptions?(\/|\?|$)/,
  /\/billing(\/|\?|$)/,
  /\/rate_plans?(\/|\?|$)/,
  /\/workers\/subscription(\/|\?|$)/,
  /\/purchases?(\/|\?|$)/,
];

export function isMoneyPath(path: string): boolean {
  return MONEY_PATH_PATTERNS.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------------------------
// Client

export interface CloudflareClientOptions {
  scope: CloudflareScope;
  token: TokenSource;
  /** Default `https://api.cloudflare.com/client/v4`. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  /** Max seconds to wait for a 429 Retry-After before giving up. Default 60. */
  maxRateLimitWaitSec?: number;
  userAgent?: string;
  logger?: Logger;
}

export interface RequestOptions {
  /** JSON body. */
  body?: unknown;
  /** Multipart body (Workers upload, Pages deployment). */
  form?: FormData;
  query?: Record<string, string | number | undefined>;
  /** Bearer override (the Pages upload JWT); the account token is not sent then. */
  bearer?: string;
  /** Proof that a human approved a money action; without it money paths are refused. */
  moneyApproved?: boolean;
  /** Return null on 404 instead of throwing. */
  allow404?: boolean;
}

const MAX_ATTEMPTS = 3;
const SUCCESS_WITHOUT_BODY = 204;

export class CloudflareClient {
  readonly baseUrl: string;
  readonly scope: CloudflareScope;
  private readonly f: typeof fetch;
  private readonly clock: Clock;
  private readonly maxWaitMs: number;
  private readonly userAgent: string;
  private readonly logger: Logger;
  /** Token values handed out, so anything echoing one can be scrubbed. Never logged. */
  private readonly tokenValues = new Set<string>();
  private readonly zoneCache = new Map<string, ZoneInfo>();

  constructor(private readonly opts: CloudflareClientOptions) {
    if (!opts.scope.accountId) {
      throw new ForerunnerError("validation", "Cloudflare client needs an account id");
    }
    this.scope = { accountId: opts.scope.accountId, zoneIds: [...opts.scope.zoneIds] };
    this.baseUrl = (opts.baseUrl ?? CLOUDFLARE_API_BASE_URL).replace(/\/$/, "");
    this.f = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? systemClock;
    this.maxWaitMs = (opts.maxRateLimitWaitSec ?? 60) * 1000;
    this.userAgent = opts.userAgent ?? "forerunner";
    this.logger = opts.logger ?? log("cloudflare");
  }

  // -- scope ----------------------------------------------------------------------------------

  /** The zone id when it is in the configured list; `tool_not_allowed` otherwise. */
  assertZone(zoneId: string): string {
    if (!zoneId || !this.scope.zoneIds.includes(zoneId)) {
      throw new ForerunnerError(
        "tool_not_allowed",
        `zone ${zoneId || "(none)"} is not in this project's Cloudflare zone list`,
        { details: { zoneId, allowedZones: [...this.scope.zoneIds] } },
      );
    }
    return zoneId;
  }

  assertAccount(accountId: string): string {
    if (accountId !== this.scope.accountId) {
      throw new ForerunnerError(
        "tool_not_allowed",
        `account ${accountId || "(none)"} is not this project's Cloudflare account`,
        { details: { accountId, allowedAccount: this.scope.accountId } },
      );
    }
    return accountId;
  }

  /** Every zone-scoped path goes through here, so no call can name a zone outside the list. */
  zonePath(zoneId: string, suffix: string): string {
    return `/zones/${encodeURIComponent(this.assertZone(zoneId))}${suffix}`;
  }

  /** Every account-scoped path goes through here; only the configured account exists. */
  accountPath(suffix: string): string {
    return `/accounts/${encodeURIComponent(this.scope.accountId)}${suffix}`;
  }

  /** Remove any token value from a string (errors, logs, audit rows). */
  scrub(text: string): string {
    return redact(redactValues(text, this.tokenValues));
  }

  // -- transport ------------------------------------------------------------------------------

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestEnvelope<T>(method, path, opts)).result;
  }

  async requestEnvelope<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<ApiEnvelope<T>> {
    if (isMoneyPath(path) && opts.moneyApproved !== true) {
      throw new ForerunnerError(
        "approval_required",
        "creating a paid resource or changing a plan needs a human's approval at every autonomy level",
        { details: { path: this.scrub(path), actionClass: "financial" } },
      );
    }
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const bearer = opts.bearer ?? (await this.opts.token());
    this.tokenValues.add(bearer);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      "User-Agent": this.userAgent,
    };
    let body: RequestInit["body"];
    if (opts.form) {
      body = opts.form;
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res: Response;
      try {
        res = await this.f(url, { method, headers, body });
      } catch (e) {
        if (attempt < MAX_ATTEMPTS) {
          await this.clock.sleep(250 * attempt);
          continue;
        }
        throw new ForerunnerError(
          "unavailable",
          `Cloudflare API unreachable: ${this.scrub(e instanceof Error ? e.message : String(e))}`,
          { retryable: true, details: { method, path: this.scrub(path) } },
        );
      }
      if (res.status === 404 && opts.allow404) {
        await res.text().catch(() => "");
        return { success: true, errors: [], result: null as T };
      }
      const text = await res.text();
      let envelope: ApiEnvelope<T> | null = null;
      if (text) {
        try {
          envelope = JSON.parse(text) as ApiEnvelope<T>;
        } catch {
          envelope = null;
        }
      }
      if (res.ok && (res.status === SUCCESS_WITHOUT_BODY || envelope?.success !== false)) {
        return envelope ?? { success: true, errors: [], result: null as T };
      }
      if (res.status === 429 || res.status >= 500) {
        const retryAfterMs = retryAfterMsOf(res.headers.get("retry-after"), this.clock);
        const waitMs = res.status === 429 ? (retryAfterMs ?? 1000) : 500 * 2 ** (attempt - 1);
        if (attempt < MAX_ATTEMPTS && waitMs <= this.maxWaitMs) {
          this.logger.debug("cloudflare api retry", {
            method,
            path: this.scrub(path),
            status: res.status,
            waitMs,
          });
          await this.clock.sleep(waitMs);
          continue;
        }
      }
      throw this.mapFailure(method, path, res.status, envelope, text, res.headers);
    }
    throw new ForerunnerError("internal", "unreachable: request loop ended without a result");
  }

  private mapFailure(
    method: string,
    path: string,
    status: number,
    envelope: ApiEnvelope<unknown> | null,
    text: string,
    headers: Headers,
  ): ForerunnerError {
    const errors = (Array.isArray(envelope?.errors) ? envelope.errors : [])
      .filter((e): e is ApiError => !!e && typeof e === "object")
      .map((e) => ({ code: Number(e.code) || 0, message: this.scrub(String(e.message ?? "")) }));
    const summary =
      errors.length > 0
        ? errors.map((e) => `${e.code}: ${e.message}`).join("; ")
        : this.scrub(text.slice(0, 200)) || "(no body)";
    const details: Record<string, unknown> = {
      method,
      path: this.scrub(path),
      status,
      errors,
    };
    const codes = new Set(errors.map((e) => e.code));
    if (status === 401 || status === 403 || codes.has(10000) || codes.has(9109)) {
      return new ForerunnerError(
        "provider_auth",
        `Cloudflare refused the token or the permission (${status}): ${summary}`,
        { details },
      );
    }
    if (status === 404) {
      return new ForerunnerError("not_found", `Cloudflare: not found (${summary})`, { details });
    }
    if (status === 429) {
      const retryAfterMs = retryAfterMsOf(headers.get("retry-after"), this.clock);
      return new ForerunnerError("provider_rate_limit", "Cloudflare API rate limit exceeded", {
        retryable: true,
        details: { ...details, retryAfterMs },
      });
    }
    if (status >= 500) {
      return new ForerunnerError("provider_error", `Cloudflare API error ${status}: ${summary}`, {
        retryable: true,
        details,
      });
    }
    if (status >= 400) {
      return new ForerunnerError("validation", `Cloudflare rejected the request: ${summary}`, {
        details,
      });
    }
    return new ForerunnerError("provider_error", `Cloudflare API returned ${status}: ${summary}`, {
      details,
    });
  }

  // -- token ----------------------------------------------------------------------------------

  /** Token status and permission groups for the Extensions panel; never the value. */
  async verifyToken(): Promise<TokenVerification> {
    const verify = await this.request<{
      id: string;
      status: string;
      not_before?: string | null;
      expires_on?: string | null;
    }>("GET", "/user/tokens/verify");
    const base: TokenVerification = {
      id: String(verify.id ?? ""),
      status: String(verify.status ?? "unknown"),
      notBefore: verify.not_before ?? null,
      expiresOn: verify.expires_on ?? null,
      scopes: [],
      scopesKnown: false,
      policies: [],
      warnings: [],
    };
    if (!base.id) {
      base.warnings.push("the token did not report its id; permissions cannot be read");
      return base;
    }
    const raw =
      (await this.readTokenPolicies(`/user/tokens/${encodeURIComponent(base.id)}`)) ??
      (await this.readTokenPolicies(this.accountPath(`/tokens/${encodeURIComponent(base.id)}`)));
    if (!raw) {
      base.warnings.push(
        'the token cannot read its own permissions (needs "API Tokens Read"); scopes are not shown',
      );
      return base;
    }
    base.scopesKnown = true;
    base.policies = raw.map(normalisePolicy);
    base.scopes = scopeLines(base.policies, this.zoneCache);
    base.warnings.push(...coverageWarnings(base.policies, this.scope));
    return base;
  }

  private async readTokenPolicies(path: string): Promise<RawPolicy[] | null> {
    try {
      const token = await this.request<{ policies?: RawPolicy[] } | null>("GET", path, {
        allow404: true,
      });
      return Array.isArray(token?.policies) ? token.policies : null;
    } catch (e) {
      if (e instanceof ForerunnerError && (e.code === "provider_auth" || e.code === "not_found"))
        return null;
      throw e;
    }
  }

  // -- accounts and zones ---------------------------------------------------------------------

  /** The configured account only. */
  async getAccount(): Promise<AccountInfo> {
    const a = await this.request<{ id: string; name: string }>("GET", this.accountPath(""));
    return { id: String(a.id), name: String(a.name ?? "") };
  }

  /** The configured zones only, read through the account's zone list (paged). */
  async listZones(): Promise<ZoneInfo[]> {
    const wanted = new Set(this.scope.zoneIds);
    const found: ZoneInfo[] = [];
    for (let page = 1; page <= 100; page++) {
      const env = await this.requestEnvelope<RawZone[]>("GET", "/zones", {
        query: { "account.id": this.scope.accountId, per_page: 50, page },
      });
      for (const z of Array.isArray(env.result) ? env.result : []) {
        const info = zoneInfoOf(z);
        if (wanted.has(info.id) && info.accountId === this.scope.accountId) {
          found.push(info);
          this.zoneCache.set(info.id, info);
        }
      }
      const totalPages = env.result_info?.total_pages ?? 1;
      if (page >= totalPages || found.length === wanted.size) break;
    }
    return found;
  }

  async getZone(zoneId: string): Promise<ZoneInfo> {
    const cached = this.zoneCache.get(this.assertZone(zoneId));
    if (cached) return cached;
    const z = await this.request<RawZone>("GET", this.zonePath(zoneId, ""));
    const info = zoneInfoOf(z);
    if (info.accountId && info.accountId !== this.scope.accountId) {
      throw new ForerunnerError(
        "tool_not_allowed",
        `zone ${zoneId} belongs to another account than this project's`,
        { details: { zoneId, accountId: info.accountId } },
      );
    }
    this.zoneCache.set(info.id, info);
    return info;
  }

  /** The configured zone that holds `host` (longest match); `domain_not_allowed` otherwise. */
  async zoneForHost(host: string): Promise<ZoneInfo> {
    const h = normaliseHost(host);
    let best: ZoneInfo | null = null;
    for (const id of this.scope.zoneIds) {
      const zone = await this.getZone(id);
      const name = zone.name.toLowerCase();
      if ((h === name || h.endsWith(`.${name}`)) && (!best || name.length > best.name.length))
        best = zone;
    }
    if (!best) {
      throw new ForerunnerError(
        "domain_not_allowed",
        `host ${h} is not inside any of this project's Cloudflare zones`,
        { details: { host: h, allowedZones: [...this.scope.zoneIds] } },
      );
    }
    return best;
  }

  // -- workers --------------------------------------------------------------------------------

  async listWorkerScripts(): Promise<WorkerScriptInfo[]> {
    const scripts = await this.request<RawScript[]>("GET", this.accountPath("/workers/scripts"));
    return (Array.isArray(scripts) ? scripts : []).map(scriptInfoOf);
  }

  /** Multipart upload: a `metadata` JSON part and the module part named by `mainModule`. */
  async uploadWorkerScript(name: string, upload: WorkerUpload): Promise<WorkerScriptInfo> {
    const mainModule = upload.mainModule ?? "index.js";
    const metadata: Record<string, unknown> = {
      main_module: mainModule,
      bindings: upload.bindings ?? [],
    };
    if (upload.compatibilityDate) metadata.compatibility_date = upload.compatibilityDate;
    if (upload.compatibilityFlags?.length) metadata.compatibility_flags = upload.compatibilityFlags;
    if (upload.migrations) metadata.migrations = upload.migrations;
    if (upload.logpush !== undefined) metadata.logpush = upload.logpush;
    if (upload.usageModel) metadata.usage_model = upload.usageModel;
    const form = new FormData();
    form.append(
      "metadata",
      new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      "metadata.json",
    );
    form.append(
      mainModule,
      new Blob([upload.script], { type: "application/javascript+module" }),
      mainModule,
    );
    const r = await this.request<RawScript>(
      "PUT",
      this.accountPath(`/workers/scripts/${encodeURIComponent(name)}`),
      { form },
    );
    return scriptInfoOf({ ...r, id: r?.id ?? name });
  }

  async listWorkerRoutes(zoneId: string): Promise<WorkerRouteInfo[]> {
    const routes = await this.request<RawRoute[]>("GET", this.zonePath(zoneId, "/workers/routes"));
    return (Array.isArray(routes) ? routes : []).map(routeInfoOf);
  }

  async createWorkerRoute(
    zoneId: string,
    pattern: string,
    script: string,
  ): Promise<WorkerRouteInfo> {
    const r = await this.request<RawRoute>("POST", this.zonePath(zoneId, "/workers/routes"), {
      body: { pattern, script },
    });
    return routeInfoOf({ ...r, pattern: r?.pattern ?? pattern, script: r?.script ?? script });
  }

  async updateWorkerRoute(
    zoneId: string,
    routeId: string,
    pattern: string,
    script: string,
  ): Promise<WorkerRouteInfo> {
    const r = await this.request<RawRoute>(
      "PUT",
      this.zonePath(zoneId, `/workers/routes/${encodeURIComponent(routeId)}`),
      { body: { pattern, script } },
    );
    return routeInfoOf({ ...r, id: r?.id ?? routeId, pattern, script });
  }

  // -- pages ----------------------------------------------------------------------------------

  async getPagesProject(name: string): Promise<PagesProjectInfo | null> {
    const p = await this.request<RawPagesProject | null>(
      "GET",
      this.accountPath(`/pages/projects/${encodeURIComponent(name)}`),
      { allow404: true },
    );
    if (!p) return null;
    return {
      name: String(p.name ?? name),
      productionBranch: String(p.production_branch ?? "main"),
      subdomain: p.subdomain ?? null,
      domains: Array.isArray(p.domains) ? p.domains.map(String) : [],
    };
  }

  /** Short-lived JWT for the direct-upload asset endpoints. */
  async createPagesUploadToken(project: string): Promise<string> {
    const r = await this.request<{ jwt: string }>(
      "GET",
      this.accountPath(`/pages/projects/${encodeURIComponent(project)}/upload-token`),
    );
    if (!r?.jwt) throw new ForerunnerError("provider_error", "Pages upload token missing");
    this.tokenValues.add(r.jwt);
    return r.jwt;
  }

  /** Hashes the project does not have yet. */
  async checkMissingPagesAssets(jwt: string, hashes: string[]): Promise<string[]> {
    const r = await this.request<string[]>("POST", "/pages/assets/check-missing", {
      bearer: jwt,
      body: { hashes },
    });
    return Array.isArray(r) ? r.map(String) : [];
  }

  async uploadPagesAssets(jwt: string, assets: PagesAssetUpload[]): Promise<void> {
    if (assets.length === 0) return;
    await this.request<unknown>("POST", "/pages/assets/upload", {
      bearer: jwt,
      body: assets.map((a) => ({
        key: a.key,
        value: a.value,
        metadata: { contentType: a.contentType },
        base64: true,
      })),
    });
  }

  async upsertPagesAssetHashes(jwt: string, hashes: string[]): Promise<void> {
    if (hashes.length === 0) return;
    await this.request<unknown>("POST", "/pages/assets/upsert-hashes", {
      bearer: jwt,
      body: { hashes },
    });
  }

  /** Multipart: `manifest` (path -> hash JSON) and `branch`. */
  async createPagesDeployment(
    project: string,
    manifest: Record<string, string>,
    branch: string,
  ): Promise<PagesDeploymentInfo> {
    const form = new FormData();
    form.append("manifest", JSON.stringify(manifest));
    form.append("branch", branch);
    const d = await this.request<RawPagesDeployment>(
      "POST",
      this.accountPath(`/pages/projects/${encodeURIComponent(project)}/deployments`),
      { form },
    );
    return {
      id: String(d?.id ?? ""),
      url: d?.url ?? null,
      environment: String(d?.environment ?? ""),
      branch: d?.deployment_trigger?.metadata?.branch ?? branch,
    };
  }

  // -- dns ------------------------------------------------------------------------------------

  async listDnsRecords(
    zoneId: string,
    filter: { type?: string; name?: string } = {},
  ): Promise<DnsRecordInfo[]> {
    const records = await this.request<RawDnsRecord[]>(
      "GET",
      this.zonePath(zoneId, "/dns_records"),
      {
        query: { type: filter.type, name: filter.name, per_page: 100 },
      },
    );
    return (Array.isArray(records) ? records : []).map(dnsInfoOf);
  }

  async createDnsRecord(zoneId: string, record: DnsRecordInput): Promise<DnsRecordInfo> {
    const r = await this.request<RawDnsRecord>("POST", this.zonePath(zoneId, "/dns_records"), {
      body: dnsBody(record),
    });
    return dnsInfoOf(r);
  }

  async updateDnsRecord(
    zoneId: string,
    recordId: string,
    record: DnsRecordInput,
  ): Promise<DnsRecordInfo> {
    const r = await this.request<RawDnsRecord>(
      "PUT",
      this.zonePath(zoneId, `/dns_records/${encodeURIComponent(recordId)}`),
      { body: dnsBody(record) },
    );
    return dnsInfoOf(r);
  }

  // -- money ----------------------------------------------------------------------------------

  /** Changes a zone's plan. Refused unless `moneyApproved` carries a human's yes. */
  async changeZonePlan(
    zoneId: string,
    planId: string,
    opts: { moneyApproved: boolean },
  ): Promise<{ id: string; planId: string }> {
    const r = await this.request<{ id?: string; rate_plan?: { id?: string } }>(
      "PUT",
      this.zonePath(zoneId, "/subscription"),
      { body: { rate_plan: { id: planId } }, moneyApproved: opts.moneyApproved },
    );
    return { id: String(r?.id ?? ""), planId: String(r?.rate_plan?.id ?? planId) };
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers

interface RawZone {
  id: string;
  name: string;
  status?: string;
  account?: { id?: string; name?: string } | null;
  plan?: { id?: string; name?: string } | null;
}
interface RawScript {
  id?: string;
  etag?: string | null;
  modified_on?: string | null;
}
interface RawRoute {
  id?: string;
  pattern?: string;
  script?: string | null;
}
interface RawPagesProject {
  name?: string;
  production_branch?: string;
  subdomain?: string | null;
  domains?: unknown[];
}
interface RawPagesDeployment {
  id?: string;
  url?: string | null;
  environment?: string;
  deployment_trigger?: { metadata?: { branch?: string } };
}
interface RawDnsRecord {
  id?: string;
  type?: string;
  name?: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number | null;
}
interface RawPolicy {
  effect?: string;
  permission_groups?: { id?: string; name?: string }[];
  resources?: unknown;
}

function zoneInfoOf(z: RawZone): ZoneInfo {
  return {
    id: String(z.id),
    name: String(z.name ?? "").toLowerCase(),
    status: String(z.status ?? "unknown"),
    accountId: z.account?.id ? String(z.account.id) : null,
    plan: z.plan?.id ? { id: String(z.plan.id), name: String(z.plan.name ?? "") } : null,
  };
}

function scriptInfoOf(s: RawScript): WorkerScriptInfo {
  return { id: String(s.id ?? ""), etag: s.etag ?? null, modifiedOn: s.modified_on ?? null };
}

function routeInfoOf(r: RawRoute): WorkerRouteInfo {
  return { id: String(r.id ?? ""), pattern: String(r.pattern ?? ""), script: r.script ?? null };
}

function dnsInfoOf(r: RawDnsRecord): DnsRecordInfo {
  return {
    id: String(r.id ?? ""),
    type: String(r.type ?? ""),
    name: String(r.name ?? "").toLowerCase(),
    content: String(r.content ?? ""),
    ttl: typeof r.ttl === "number" ? r.ttl : 1,
    proxied: r.proxied === true,
    priority: typeof r.priority === "number" ? r.priority : null,
  };
}

function dnsBody(record: DnsRecordInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl ?? 1,
  };
  if (record.proxied !== undefined) body.proxied = record.proxied;
  if (record.priority !== undefined) body.priority = record.priority;
  if (record.comment !== undefined) body.comment = record.comment;
  return body;
}

/** Lower-cased host without a trailing dot; DNS labels may start with `_` (SRV, ACME). */
export function normaliseHost(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!/^[a-z0-9._-]+$/.test(h) || h.startsWith(".") || h.includes("..")) {
    throw new ForerunnerError("validation", `not a hostname: ${host.slice(0, 80)}`, {
      details: { host: host.slice(0, 80) },
    });
  }
  return h;
}

function retryAfterMsOf(header: string | null, clock: Clock): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - clock.now()) : null;
}

/** Flatten Cloudflare's nested resource objects into a list of keys. */
function flattenResources(resources: unknown, acc: string[] = []): string[] {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return acc;
  for (const [key, value] of Object.entries(resources as Record<string, unknown>)) {
    acc.push(key);
    if (value && typeof value === "object") flattenResources(value, acc);
  }
  return acc;
}

function normalisePolicy(p: RawPolicy): TokenPolicy {
  return {
    effect: p.effect === "deny" ? "deny" : "allow",
    permissionGroups: (Array.isArray(p.permission_groups) ? p.permission_groups : []).map((g) => ({
      id: String(g?.id ?? ""),
      name: String(g?.name ?? g?.id ?? ""),
    })),
    resources: flattenResources(p.resources),
  };
}

const ZONE_KEY = /^com\.cloudflare\.api\.account\.zone\.(.+)$/;
const ACCOUNT_KEY = /^com\.cloudflare\.api\.account\.([^.]+)$/;
const USER_KEY = /^com\.cloudflare\.api\.user\.(.+)$/;

export function describeResource(key: string, zones?: Map<string, ZoneInfo>): string {
  const zone = key.match(ZONE_KEY);
  if (zone) {
    const id = zone[1] ?? "";
    if (id === "*") return "all zones";
    const name = zones?.get(id)?.name;
    return name ? `zone ${name} (${id})` : `zone ${id}`;
  }
  const account = key.match(ACCOUNT_KEY);
  if (account) return account[1] === "*" ? "all accounts" : `account ${account[1]}`;
  const user = key.match(USER_KEY);
  if (user) return user[1] === "*" ? "the user" : `user ${user[1]}`;
  return key;
}

/** One line per permission group and policy: `<group> on <resources>`; deny lines are marked. */
export function scopeLines(policies: TokenPolicy[], zones?: Map<string, ZoneInfo>): string[] {
  const lines: string[] = [];
  for (const policy of policies) {
    const where = policy.resources.map((r) => describeResource(r, zones)).join(", ") || "(none)";
    for (const group of policy.permissionGroups) {
      lines.push(`${policy.effect === "deny" ? "deny " : ""}${group.name} on ${where}`);
    }
  }
  return [...new Set(lines)].sort();
}

/** Configured zones and the account that no allow policy names. */
export function coverageWarnings(policies: TokenPolicy[], scope: CloudflareScope): string[] {
  const allowKeys = new Set(
    policies.filter((p) => p.effect === "allow").flatMap((p) => p.resources),
  );
  const warnings: string[] = [];
  for (const zoneId of scope.zoneIds) {
    const covered =
      allowKeys.has(`com.cloudflare.api.account.zone.${zoneId}`) ||
      allowKeys.has("com.cloudflare.api.account.zone.*");
    if (!covered) warnings.push(`the token's permissions do not name zone ${zoneId}`);
  }
  const accountCovered =
    allowKeys.has(`com.cloudflare.api.account.${scope.accountId}`) ||
    allowKeys.has("com.cloudflare.api.account.*");
  if (!accountCovered) {
    warnings.push(
      `the token's permissions do not name account ${scope.accountId} (Workers and Pages need account permissions)`,
    );
  }
  return warnings;
}
