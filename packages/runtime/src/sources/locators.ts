import { currentPlatform, isAbsolute, normalize, resolve } from "@forerunner/platform";

/**
 * Locator normalisation for source discovery (spec A.4, ADR 0056). A project's `repos` entry
 * may name a GitHub repository as `owner/name` (what the PR executor reads), as an HTTPS or
 * SSH URL (what the New project dialog pastes) or as an absolute folder path; a scan finds
 * repositories by owner and name and folders by path. One *key* per thing covers every
 * spelling so a duplicate is told apart from a new candidate: `github:<owner>/<name>` in lower
 * case for a repository, `folder:<normalised absolute path>` for a folder (lower-cased on
 * Windows, where paths compare case-insensitively).
 */
export interface RepoLocator {
  owner: string;
  name: string;
  /** The form a project's repos entry carries: `owner/name`. */
  locator: string;
  key: string;
}

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

function ownerName(owner: string, name: string): RepoLocator | null {
  const n = name.endsWith(".git") ? name.slice(0, -4) : name;
  if (!isGitHubLogin(owner) || !REPO_NAME.test(n) || n === "." || n === "..") return null;
  return { owner, name: n, locator: `${owner}/${n}`, key: repoKey(owner, n) };
}

/**
 * `owner/name`, `owner/name.git`, `github.com/owner/name`, `https://host/owner/name[.git][/…]`,
 * `git@host:owner/name.git` and `ssh://git@host/owner/name.git` all name the same repository.
 * Anything else (a bare login, a deeper path, a folder) is null.
 */
export function parseRepoLocator(input: string): RepoLocator | null {
  const raw = input.trim().replace(/\/+$/, "");
  if (!raw) return null;
  const scp = /^[A-Za-z0-9_.-]+@[^:/\s]+:([^/\s]+)\/([^/\s]+)$/.exec(raw);
  if (scp?.[1] && scp[2]) return ownerName(scp[1], scp[2]);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return ownerName(parts[0], parts[1]);
  }
  const parts = raw.split("/").filter(Boolean);
  if (parts.length === 3 && parts[0]?.includes(".") && parts[1] && parts[2]) {
    return ownerName(parts[1], parts[2]);
  }
  if (parts.length === 2 && parts[0] && parts[1]) return ownerName(parts[0], parts[1]);
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

/** The keys a project's repos entries cover; entries that are neither are skipped. */
export function keysOfProject(repos: readonly string[]): string[] {
  const keys: string[] = [];
  for (const entry of repos) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const t = entry.trim();
    if (isAbsolute(t)) {
      keys.push(folderKey(t));
      continue;
    }
    const repo = parseRepoLocator(t);
    if (repo) keys.push(repo.key);
  }
  return keys;
}
