import { existsSync, readFileSync } from "node:fs";
import { type AppDirs, appDirs, ForerunnerError, join } from "@forerunner/platform";
import { z } from "zod";
import { UPDATE_CHANNELS } from "./manifest.ts";

/**
 * Updater configuration: `update.json` in the config directory, overridden by FORERUNNER_UPDATE_*
 * environment variables. Nothing here names an organisation or host: the feed (owner/repo or a
 * manifest URL) and the trusted signing keys are supplied by the install.
 */
export const TrustedKey = z.object({
  /** Key id as written into signatures; derived from the public key when omitted. */
  id: z.string().min(1).optional(),
  /** Ed25519 public key: base64 of the raw 32 bytes, or a PEM SubjectPublicKeyInfo. */
  publicKey: z.string().min(1),
});
export type TrustedKey = z.infer<typeof TrustedKey>;

export const UpdateFeedConfig = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    owner: z.string().min(1),
    repo: z.string().min(1),
    /** GitHub REST base URL (api.github.com, GitHub Enterprise or the fake git host). */
    apiBase: z.url().optional(),
    /** Asset name of the signed manifest on each release. */
    manifestAssetName: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal("json"), url: z.url() }),
]);
export type UpdateFeedConfig = z.infer<typeof UpdateFeedConfig>;

export const UpdateConfig = z.object({
  channel: z.enum(UPDATE_CHANNELS).default("stable"),
  feed: UpdateFeedConfig.nullable().default(null),
  trustedKeys: z.array(TrustedKey).default([]),
  /** Install an older release than the running one. Off unless a human turns it on. */
  allowDowngrade: z.boolean().default(false),
  /** How long the first start after an update may take to pass its health check. */
  healthTimeoutMs: z.number().int().positive().default(60_000),
  /** Check the feed on start and on a schedule (the UI shows "Update available"). */
  autoCheck: z.boolean().default(true),
});
export type UpdateConfig = z.infer<typeof UpdateConfig>;

export const DEFAULT_MANIFEST_ASSET_NAME = "forerunner-release.json";

export function updateConfigPath(dirs: AppDirs = appDirs()): string {
  return join(dirs.config, "update.json");
}

/** "id=base64,id2=base64" or "base64,base64" (ids derived). */
export function parseTrustedKeysEnv(value: string): TrustedKey[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      // base64 keys end in "=" padding; only a "name=value" form with a plausible id splits.
      if (eq > 0 && /^[A-Za-z0-9_.:-]+$/.test(entry.slice(0, eq)) && entry.length - eq > 20) {
        return { id: entry.slice(0, eq), publicKey: entry.slice(eq + 1) };
      }
      return { publicKey: entry };
    });
}

/** "github:owner/repo" or an https URL of a releases.json. */
export function parseFeedEnv(value: string, apiBase?: string): UpdateFeedConfig {
  const v = value.trim();
  const gh = /^github:([^/\s]+)\/([^/\s]+)$/.exec(v);
  if (gh) {
    return {
      kind: "github",
      owner: gh[1] as string,
      repo: gh[2] as string,
      ...(apiBase ? { apiBase } : {}),
    };
  }
  if (/^https?:\/\//.test(v)) return { kind: "json", url: v };
  throw new ForerunnerError(
    "validation",
    "FORERUNNER_UPDATE_FEED must be github:<owner>/<repo> or an http(s) URL",
  );
}

/**
 * Read the updater configuration: file first (missing file means defaults), then environment
 * overrides. A malformed file is a validation error, never a silent fallback.
 */
export function readUpdateConfig(
  dirs: AppDirs = appDirs(),
  env: NodeJS.ProcessEnv = process.env,
): UpdateConfig {
  let raw: unknown = {};
  const p = updateConfigPath(dirs);
  if (existsSync(p)) {
    try {
      raw = JSON.parse(readFileSync(p, "utf8"));
    } catch (e) {
      throw new ForerunnerError("validation", `update.json is not valid JSON: ${p}`, {
        cause: e,
      });
    }
  }
  const parsed = UpdateConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ForerunnerError(
      "validation",
      `update.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const cfg = parsed.data;
  const channel = env.FORERUNNER_UPDATE_CHANNEL;
  if (channel) {
    const c = z.enum(UPDATE_CHANNELS).safeParse(channel);
    if (!c.success)
      throw new ForerunnerError("validation", `FORERUNNER_UPDATE_CHANNEL must be stable or beta`);
    cfg.channel = c.data;
  }
  if (env.FORERUNNER_UPDATE_FEED)
    cfg.feed = parseFeedEnv(env.FORERUNNER_UPDATE_FEED, env.FORERUNNER_UPDATE_API_BASE);
  if (env.FORERUNNER_UPDATE_TRUSTED_KEYS)
    cfg.trustedKeys = parseTrustedKeysEnv(env.FORERUNNER_UPDATE_TRUSTED_KEYS);
  if (env.FORERUNNER_UPDATE_ALLOW_DOWNGRADE)
    cfg.allowDowngrade = /^(1|true|yes)$/i.test(env.FORERUNNER_UPDATE_ALLOW_DOWNGRADE);
  if (env.FORERUNNER_UPDATE_HEALTH_TIMEOUT_MS) {
    const n = Number(env.FORERUNNER_UPDATE_HEALTH_TIMEOUT_MS);
    if (!Number.isInteger(n) || n <= 0)
      throw new ForerunnerError("validation", "FORERUNNER_UPDATE_HEALTH_TIMEOUT_MS must be > 0");
    cfg.healthTimeoutMs = n;
  }
  return cfg;
}
