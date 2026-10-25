import { currentPlatform, isAbsolute, normalize, resolve } from "@forerunner/platform";

/**
 * Locator normalisation for source discovery (spec A.4, ADR 0056). A project's `repos` entry
 * may name a GitHub repository as `owner/name` (what the PR executor reads), as an HTTPS or
 * SSH URL (what the New project dialog pastes) or as an absolute folder path; a scan finds
 * repositories by owner and name and folders by path. One *key* per thing covers every
 * spelling so a duplicate is told apart from a new candidate: `github:<owner>/<name>` in lower
 * case for a repository, `folder:<normalised absolute path>` for a folder (lower-cased on
 * Windows, where paths compare case-insensitively).
 *
 * A URL names its host, and only a URL on one of the install's git hosts is a repository of
 * this install's GitHub (`DEFAULT_REPO_HOSTS`, or what `repoHostsFor` reads from the
 * configuration: the API base and the git remote base). `https://gitlab.com/acme/alpha` is
 * neither the GitHub `acme/alpha` nor its duplicate; other git hosts come later (ADR 0056,
 * amendment of 2026-10-25).
 */
export interface RepoLocator {
  owner: string;
  name: string;
  /** The form a project's repos entry carries: `owner/name`. */
  locator: string;
  key: string;
  /** The host the spelling named (lower-cased, without `www.`), or null for a bare `owner/name`. */
  host: string | null;
}

/** The git host a repository URL may name when the install configures none. */
export const DEFAULT_REPO_HOSTS: readonly string[] = ["github.com"];

/** GitHub login rules: 1 to 39 characters, alphanumerics and hyphens, no leading hyphen. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Repository names: GitHub allows letters, digits, `.`, `-` and `_` up to 100 characters. */
const REPO_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function isGitHubLogin(value: string): boolean {
  return LOGIN.test(value) && !value.endsWith("-");
}

export function repoKey(owner: string, name: string): string {
  return `github:${owner.toLowerCase()}/${name.toLowerCase()}`;
}

/** A hostname as it is compared: lower-cased, a leading `www.` dropped. */
function canonicalHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "");
}

/** Whether `host` (as a URL named it) is one of the install's git hosts. */
export function isRepoHost(host: string, hosts: readonly string[] = DEFAULT_REPO_HOSTS): boolean {
  const h = canonicalHost(host);
  return hosts.some((x) => canonicalHost(x) === h);
}

/**
 * The hosts a repository URL may name on this install: the host of the git remote base (A.3
 * import, default `github.com`) and the host of the GitHub API base (`api.` dropped:
 * `api.github.com` is `github.com`; a GitHub Enterprise base `https://ghe/api/v3` is `ghe`).
 * An unparsable value is skipped; the list is never empty.
 */
export function repoHostsFor(opts: {
  githubApiBase?: string | undefined;
  gitRemoteBase?: string | undefined;
}): string[] {
  const out: string[] = [];
  const add = (host: string | null) => {
    if (host && !out.includes(host)) out.push(host);
  };
  add(hostnameOf(opts.gitRemoteBase ?? "https://github.com"));
  add(hostnameOf(opts.githubApiBase ?? "https://api.github.com")?.replace(/^api\./, "") ?? null);
  return out.length ? out : [...DEFAULT_REPO_HOSTS];
}

function hostnameOf(url: string): string | null {
  try {
    const h = canonicalHost(new URL(url).hostname);
    return h || null;
  } catch {
    return null;
  }
}

function ownerName(owner: string, name: string, host: string | null): RepoLocator | null {
  const n = name.endsWith(".git") ? name.slice(0, -4) : name;
  if (!isGitHubLogin(owner) || !REPO_NAME.test(n) || n === "." || n === "..") return null;
  return { owner, name: n, locator: `${owner}/${n}`, key: repoKey(owner, n), host };
}

/**
 * `owner/name`, `owner/name.git`, `github.com/owner/name`, `https://host/owner/name[.git][/…]`,
 * `git@host:owner/name.git` and `ssh://git@host/owner/name.git` all name the same repository,
 * when the host they name is one of `hosts` (`"any"` accepts every host and reports it in
 * `host`, for a caller that wants to say which host was refused). Anything else (a bare
 * login, a deeper path, a folder, a URL on another git host) is null.
 */
export function parseRepoLocator(
  input: string,
  hosts: readonly string[] | "any" = DEFAULT_REPO_HOSTS,
): RepoLocator | null {
  const parsed = parseAnyHost(input);
  if (!parsed) return null;
  if (hosts === "any" || parsed.host === null || isRepoHost(parsed.host, hosts)) return parsed;
  return null;
}

function parseAnyHost(input: string): RepoLocator | null {
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) return null;
  const scp = /^[A-Za-z0-9_.-]+@([^:/\s]+):([^/\s]+)\/([^/\s]+)$/.exec(raw);
  if (scp?.[1] && scp[2] && scp[3]) return ownerName(scp[2], scp[3], canonicalHost(scp[1]));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || !parts[0] || !parts[1] || !url.hostname) return null;
    return ownerName(parts[0], parts[1], canonicalHost(url.hostname));
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 3 && parts[0]?.includes(".") && parts[1] && parts[2]) {
    return ownerName(parts[1], parts[2], canonicalHost(parts[0]));
  }
  if (parts.length === 2 && parts[0] && parts[1]) return ownerName(parts[0], parts[1], null);
  return null;
}

/** An absolute folder path, resolved and without a trailing separator. */
export function normaliseFolder(path: string): string {
  return normalize(resolve(path.trim()));
}

export function folderKey(path: string): string {
  const p = normaliseFolder(path);
  return `folder:${currentPlatform() === "windows" ? p.toLowerCase() : p}`;
}

/**
 * The keys a project's repos entries cover; entries that are neither a repository on one of
 * `hosts` nor an absolute path are skipped.
 */
export function keysOfProject(
  repos: readonly string[],
  hosts: readonly string[] = DEFAULT_REPO_HOSTS,
): string[] {
  const keys: string[] = [];
  for (const entry of repos) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const t = entry.trim();
    if (isAbsolute(t)) {
      keys.push(folderKey(t));
      continue;
    }
    const repo = parseRepoLocator(t, hosts);
    if (repo) keys.push(repo.key);
  }
  return keys;
}
