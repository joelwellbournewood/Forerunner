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
export const DEFAULT_WORKER_STAGING_SUFFIX = "-staging";
export const DEFAULT_PAGES_STAGING_BRANCH = "staging";

/** Same shape as the vault's SECRET_NAME_PATTERN behind the "secret:" prefix. */
export const SECRET_REFERENCE_PATTERN = /^secret:[a-z][a-z0-9_.:-]{0,127}$/;

/** Cloudflare ids are 32 hex characters; the stand-in uses short ids, so the rule is loose. */
const cloudflareId = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "must be a Cloudflare id (letters, digits, _ and -)");

const secretReference = z
  .string()
  .regex(SECRET_REFERENCE_PATTERN, "must be a secret reference (secret:<name>), never a value");

export const CloudflareSettingsSchema = z.object({
  /** The one account this project may touch. */
  account_id: cloudflareId,
  /** The zones this project may touch; anything else is refused before any request. */
  zone_ids: z.array(cloudflareId).default([]),
  secret_ref: secretReference.default(DEFAULT_CLOUDFLARE_SECRET_REF),
  /** API base URL; only the stand-in changes it. */
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

/** Parse settings from a value (settings UI, CLI); throws `validation` with the issues. */
export function parseCloudflareSettings(raw: unknown): CloudflareSettings {
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
  return parsed.data;
}

/**
 * The project's Cloudflare settings, or null when the project has none. Present but invalid
 * settings throw `validation` so a typo never silently widens the scope.
 */
export function cloudflareSettingsOf(
  project: Pick<ProjectRow, "settings">,
): CloudflareSettings | null {
  const raw = (project.settings as Record<string, unknown>)[CLOUDFLARE_SETTINGS_KEY];
  if (raw === undefined || raw === null) return null;
  return parseCloudflareSettings(raw);
}
