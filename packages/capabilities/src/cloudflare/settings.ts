/**
 * Per-project Cloudflare settings (spec: "Rules that apply everywhere" -> least privilege:
 * "Cloudflare token scoped to named zones and Workers"; Human checklist: "Cloudflare API token
 * scoped to the zones and Workers it may touch"). The settings name the one account and the
 * zones a project may touch; the client refuses, in code and before any request, anything
 * outside them. The token is a secret reference (`secret:<name>`), never a value.
 *
 * Stored under `project.settings.cloudflare` (JSON). See docs/maintainers/cloudflare.md.
 */
import { ForerunnerError } from "@forerunner/platform";
import type { ProjectRow } from "@forerunner/state";
import { z } from "zod";

export const CLOUDFLARE_SETTINGS_KEY = "cloudflare";
/** Matches the extension catalog entry's secret name. */
export const DEFAULT_CLOUDFLARE_SECRET_REF = "secret:cloudflare_api_token";
export const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
/** Names a stand-in API base URL; set by the install owner (CI, the fake API), never by a project. */
export const CLOUDFLARE_API_BASE_ENV = "FORERUNNER_CLOUDFLARE_API_BASE";
export const DEFAULT_WORKER_STAGING_SUFFIX = "-staging";
export const DEFAULT_PAGES_STAGING_BRANCH = "staging";

/** Same shape as the vault's SECRET_NAME_PATTERN behind the "secret:" prefix. */
export const SECRET_REFERENCE_PATTERN = /^secret:[a-z][a-z0-9_.:-]{0,127}$/;
/**
 * Only the catalog's `cloudflare_api_token` or a name under the `cloudflare` prefix may be the
 * token. Project settings are project-wide data on the shared state: a collaborator who could
 * name any vault entry (`secret:anthropic_api_key`) would have the next free `read` call send
 * it as a Bearer token.
 */
export const CLOUDFLARE_SECRET_REFERENCE_PATTERN = /^secret:cloudflare([._-][a-z0-9_.:-]{1,116})?$/;

/** Cloudflare ids are 32 hex characters; the stand-in uses short ids, so the rule is loose. */
const cloudflareId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "must be a Cloudflare id (letters, digits, _ and -)");

const secretReference = z
  .string()
  .regex(SECRET_REFERENCE_PATTERN, "must be a secret reference (secret:<name>), never a value")
  .regex(
    CLOUDFLARE_SECRET_REFERENCE_PATTERN,
    "must name the Cloudflare token (secret:cloudflare_api_token or secret:cloudflare.<name>), never another credential of the install",
  );

export const CloudflareSettingsSchema = z.object({
  /** The one account this project may touch. */
  account_id: cloudflareId,
  /** The zones this project may touch; anything else is refused before any request. */
  zone_ids: z.array(cloudflareId).default([]),
  secret_ref: secretReference.default(DEFAULT_CLOUDFLARE_SECRET_REF),
  /**
   * API base URL. Accepted only as the Cloudflare API, a stand-in on this machine (loopback)
   * or the stand-in the install owner named (`FORERUNNER_CLOUDFLARE_API_BASE`, or the
   * `baseUrl` the wiring passes): `parseCloudflareSettings` refuses any other host, so a
   * project's settings can never send the token elsewhere.
   */
  base_url: z.string().url().optional(),
  workers: z
    .object({
      /** Staging deploys go to `<name><staging_suffix>` (wrangler's environment naming). */
      staging_suffix: z.string().min(1).max(32).default(DEFAULT_WORKER_STAGING_SUFFIX),
    })
    .default({ staging_suffix: DEFAULT_WORKER_STAGING_SUFFIX }),
  pages: z
    .object({
      /** Staging deploys are preview deployments on this branch, never the production branch. */
      staging_branch: z.string().min(1).max(200).default(DEFAULT_PAGES_STAGING_BRANCH),
    })
    .default({ staging_branch: DEFAULT_PAGES_STAGING_BRANCH }),
});
export type CloudflareSettings = z.infer<typeof CloudflareSettingsSchema>;
export type CloudflareSettingsInput = z.input<typeof CloudflareSettingsSchema>;

/** What the client enforces: the account and the zones a project may touch. */
export interface CloudflareScope {
  accountId: string;
  zoneIds: readonly string[];
}

export function scopeOf(
  settings: Pick<CloudflareSettings, "account_id" | "zone_ids">,
): CloudflareScope {
  return { accountId: settings.account_id, zoneIds: [...settings.zone_ids] };
}

export interface CloudflareSettingsOptions {
  /** The one stand-in base URL allowed besides the API and loopback (see `standInBaseUrlOf`). */
  standInBaseUrl?: string;
}

/** The stand-in the install owner allowed: the wiring's `baseUrl`, else the environment. */
export function standInBaseUrlOf(opts: {
  baseUrl?: string;
  env?: Record<string, string | undefined>;
}): string | undefined {
  return opts.baseUrl ?? (opts.env ?? process.env)[CLOUDFLARE_API_BASE_ENV] ?? undefined;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Where a project may send the token: the Cloudflare API, a stand-in on this machine (loopback,
 * where nothing leaves the install) or the one stand-in the install owner named. Any other
 * host is refused before any request, whatever the project settings say.
 */
export function isAllowedBaseUrl(url: string, standInBaseUrl?: string): boolean {
  const trimmed = url.replace(/\/+$/, "");
  if (trimmed === CLOUDFLARE_API_BASE_URL) return true;
  if (standInBaseUrl && trimmed === standInBaseUrl.replace(/\/+$/, "")) return true;
  try {
    const host = new URL(url).hostname;
    return LOOPBACK_HOSTS.has(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

/** Parse settings from a value (settings UI, CLI); throws `validation` with the issues. */
export function parseCloudflareSettings(
  raw: unknown,
  opts: CloudflareSettingsOptions = {},
): CloudflareSettings {
  const parsed = CloudflareSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ForerunnerError(
      "validation",
      `invalid Cloudflare settings: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
      { details: { issues: parsed.error.issues.map((i) => i.path.join(".")) } },
    );
  }
  const { base_url } = parsed.data;
  if (base_url !== undefined && !isAllowedBaseUrl(base_url, opts.standInBaseUrl)) {
    throw new ForerunnerError(
      "validation",
      `invalid Cloudflare settings: base_url must be the Cloudflare API (${CLOUDFLARE_API_BASE_URL}); a stand-in is named by the install owner through ${CLOUDFLARE_API_BASE_ENV}, never by a project`,
      { details: { issues: ["base_url"] } },
    );
  }
  return parsed.data;
}

/**
 * The project's Cloudflare settings, or null when the project has none. Present but invalid
 * settings throw `validation` so a typo never silently widens the scope.
 */
export function cloudflareSettingsOf(
  project: Pick<ProjectRow, "settings">,
  opts: CloudflareSettingsOptions = {},
): CloudflareSettings | null {
  const raw = (project.settings as Record<string, unknown>)[CLOUDFLARE_SETTINGS_KEY];
  if (raw === undefined || raw === null) return null;
  return parseCloudflareSettings(raw, opts);
}
