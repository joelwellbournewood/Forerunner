import { errorMessage, ForerunnerError, log } from "@forerunner/platform";
import { DEFAULT_MANIFEST_ASSET_NAME, type UpdateFeedConfig } from "./config.ts";
import {
  ReleasesDocument,
  type SignedManifest,
  SignedManifest as SignedManifestSchema,
  type UpdateChannel,
} from "./manifest.ts";
import { sortVersionsDesc } from "./semver.ts";

/**
 * Where releases come from. Two implementations: GitHub Releases (each release carries the
 * signed manifest as an asset; owner/repo and the API base come from config) and a plain
 * releases.json at a URL. Both return untrusted documents: nothing here checks a signature,
 * that is the verifier's job. Lists are newest first.
 */
export interface ReleaseFeed {
  readonly kind: "github" | "json" | "memory";
  latest(channel: UpdateChannel): Promise<SignedManifest | null>;
  list(channel: UpdateChannel): Promise<SignedManifest[]>;
}

const logger = log("update:feed");

function sortedByVersion(items: SignedManifest[], channel: UpdateChannel): SignedManifest[] {
  return sortVersionsDesc(
    items.filter((r) => r.manifest.channel === channel),
    (r) => r.manifest.version,
  );
}

async function fetchJson(f: typeof fetch, url: string, headers: Record<string, string>) {
  let res: Response;
  try {
    res = await f(url, { headers });
  } catch (e) {
    throw new ForerunnerError("unavailable", `release feed unreachable: ${errorMessage(e)}`, {
      details: { url },
      retryable: true,
    });
  }
  if (!res.ok) {
    throw new ForerunnerError("unavailable", `release feed answered ${res.status} for ${url}`, {
      details: { url, status: res.status },
      retryable: res.status >= 500,
    });
  }
  try {
    return (await res.json()) as unknown;
  } catch (e) {
    throw new ForerunnerError("validation", `release feed returned invalid JSON: ${url}`, {
      cause: e,
    });
  }
}

export interface GitHubReleasesFeedOptions {
  owner: string;
  repo: string;
  apiBase?: string;
  manifestAssetName?: string;
  /** Optional token for private repositories; by reference, resolved by the caller. */
  token?: string;
  fetchImpl?: typeof fetch;
  perPage?: number;
}

interface GhAsset {
  name?: unknown;
  browser_download_url?: unknown;
}
interface GhRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: unknown;
}

/**
 * GitHub REST releases endpoint. Every non-draft release with a manifest asset is a candidate;
 * the manifest's own `channel` decides where it belongs (pre-release flags are advisory).
 */
export class GitHubReleasesFeed implements ReleaseFeed {
  readonly kind = "github" as const;
  private readonly apiBase: string;
  private readonly assetName: string;
  private readonly f: typeof fetch;
  private readonly headers: Record<string, string>;
  private readonly perPage: number;

  constructor(private readonly opts: GitHubReleasesFeedOptions) {
    if (!opts.owner || !opts.repo)
      throw new ForerunnerError("validation", "GitHubReleasesFeed needs owner and repo");
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.assetName = opts.manifestAssetName ?? DEFAULT_MANIFEST_ASSET_NAME;
    this.f = opts.fetchImpl ?? fetch;
    this.perPage = opts.perPage ?? 30;
    this.headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "forerunner-updater",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    };
  }

  get releasesUrl(): string {
    const { owner, repo } = this.opts;
    return `${this.apiBase}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${this.perPage}`;
  }

  async list(channel: UpdateChannel): Promise<SignedManifest[]> {
    const body = await fetchJson(this.f, this.releasesUrl, this.headers);
    if (!Array.isArray(body))
      throw new ForerunnerError("validation", "GitHub releases endpoint did not return a list");
    const out: SignedManifest[] = [];
    for (const rel of body as GhRelease[]) {
      if (rel.draft) continue;
      const assets = Array.isArray(rel.assets) ? (rel.assets as GhAsset[]) : [];
      const asset = assets.find((a) => a.name === this.assetName);
      if (!asset || typeof asset.browser_download_url !== "string") continue;
      let doc: unknown;
      try {
        doc = await fetchJson(this.f, asset.browser_download_url, {
          Accept: "application/octet-stream",
          "User-Agent": "forerunner-updater",
          ...(this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {}),
        });
      } catch (e) {
        logger.warn("release manifest unreadable", {
          tag: String(rel.tag_name ?? ""),
          error: errorMessage(e),
        });
        continue;
      }
      const parsed = SignedManifestSchema.safeParse(doc);
      if (!parsed.success) {
        logger.warn("release manifest malformed", { tag: String(rel.tag_name ?? "") });
        continue;
      }
      out.push(parsed.data);
    }
    return sortedByVersion(out, channel);
  }

  async latest(channel: UpdateChannel): Promise<SignedManifest | null> {
    return (await this.list(channel))[0] ?? null;
  }
}

export interface JsonFeedOptions {
  url: string;
  fetchImpl?: typeof fetch;
}

/** A releases.json manifest at a configurable URL ({ schema: 1, releases: SignedManifest[] }). */
export class JsonFeed implements ReleaseFeed {
  readonly kind = "json" as const;
  private readonly f: typeof fetch;

  constructor(private readonly opts: JsonFeedOptions) {
    this.f = opts.fetchImpl ?? fetch;
  }

  async list(channel: UpdateChannel): Promise<SignedManifest[]> {
    const body = await fetchJson(this.f, this.opts.url, {
      Accept: "application/json",
      "User-Agent": "forerunner-updater",
    });
    const parsed = ReleasesDocument.safeParse(body);
    if (!parsed.success) {
      throw new ForerunnerError("validation", `releases.json is malformed at ${this.opts.url}`, {
        details: { issues: parsed.error.issues.slice(0, 5).map((i) => i.message) },
      });
    }
    return sortedByVersion(parsed.data.releases, channel);
  }

  async latest(channel: UpdateChannel): Promise<SignedManifest | null> {
    return (await this.list(channel))[0] ?? null;
  }
}

/** In-memory feed for tests and for installs without a configured feed. */
export class MemoryReleaseFeed implements ReleaseFeed {
  readonly kind = "memory" as const;
  constructor(public releases: SignedManifest[] = []) {}

  async list(channel: UpdateChannel): Promise<SignedManifest[]> {
    return sortedByVersion(this.releases, channel);
  }
  async latest(channel: UpdateChannel): Promise<SignedManifest | null> {
    return (await this.list(channel))[0] ?? null;
  }
}

export function feedFromConfig(
  cfg: UpdateFeedConfig | null,
  opts: { fetchImpl?: typeof fetch; token?: string } = {},
): ReleaseFeed {
  if (!cfg) return new MemoryReleaseFeed([]);
  if (cfg.kind === "github") {
    return new GitHubReleasesFeed({
      owner: cfg.owner,
      repo: cfg.repo,
      apiBase: cfg.apiBase,
      manifestAssetName: cfg.manifestAssetName,
      fetchImpl: opts.fetchImpl,
      token: opts.token,
    });
  }
  return new JsonFeed({ url: cfg.url, fetchImpl: opts.fetchImpl });
}
