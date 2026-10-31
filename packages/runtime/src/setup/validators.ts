import { describeNetworkError, ForerunnerError } from "@forerunner/platform";

/**
 * Credential validators for the setup wizard (spec A: "Each credential request says what, why,
 * exact scopes, where to click, and how it will be verified. Validates on paste."). Every
 * validator takes an injected fetch so tests run against the fake git host or canned responses.
 * Values are never logged; results carry only facts about the credential.
 */
export interface ValidationResult {
  ok: boolean;
  /** Human-readable, safe to show. */
  summary: string;
  /** Specific problems to fix. */
  problems: string[];
  details: Record<string, unknown>;
}

export interface CredentialRequest {
  name: string;
  what: string;
  why: string;
  scopes: string[];
  whereToClick: string;
  howVerified: string;
}

export const CREDENTIAL_REQUESTS: Record<
  "github" | "anthropic" | "subscription",
  CredentialRequest
> = {
  github: {
    name: "GitHub token",
    what: "A fine-grained personal access token (or a GitHub App installation) for the repositories Forerunner may work in.",
    why: "Agents read code, open branches and pull requests, comment on issues and publish releases. Nothing else.",
    scopes: [
      "Repository access: only the repositories you select",
      "Contents: read and write",
      "Pull requests: read and write",
      "Issues: read and write",
      "Metadata: read",
      "Commit statuses: read (to see CI results)",
    ],
    whereToClick:
      "GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token",
    howVerified:
      "Forerunner calls GET /user and GET /user/repos and lists every repository the token reaches with the access GitHub reports (read and write, read only, admin); it warns when the token reaches none, can only read, or has admin rights, then saves it to the vault.",
  },
  anthropic: {
    name: "Anthropic API key",
    what: "An API key from the Claude Console (or a subscription token from `claude setup-token`).",
    why: "Model calls for sessions, specialists, the critic and chat. Spend is capped in code.",
    scopes: [
      "Workspace: a dedicated Forerunner workspace is recommended so spend is visible",
      "Set a monthly spend limit on the provider side as well",
    ],
    whereToClick: "console.anthropic.com → API keys → Create key",
    howVerified:
      "Forerunner calls GET /v1/models with the key; a 200 proves the key works, a 401 means it is wrong or revoked. No tokens are generated during the check. A subscription token (sk-ant-oat…) is never sent anywhere by Forerunner: its format is checked and Claude Code uses it.",
  },
  subscription: {
    name: "Claude subscription token",
    what: "A long-lived token from `claude setup-token` for your own Claude Pro, Max or Team plan.",
    why: "Day-to-day sessions and specialist runs through the Claude Agent SDK on the flat fee you already pay; the API key stays the fallback. Only your own agent ever uses it.",
    scopes: [
      "Your own plan only: a subscription token is never granted to another person's agent",
      "Plan usage limits apply; Forerunner stops subscription work at the plan share cap",
    ],
    whereToClick:
      "A terminal with Claude Code logged in: run `claude setup-token` and paste the token it prints",
    howVerified:
      "The format is checked on paste (sk-ant-oat…) and the token is stored in the vault by name; the first subscription run proves it works, and the live harness checks it against the Agent SDK. No request is made during setup.",
  },
};

/** The prefix of a token `claude setup-token` prints (an OAuth token, not an API key). */
export const SUBSCRIPTION_TOKEN_PREFIX = "sk-ant-oat";

/**
 * A subscription token is checked for its shape only (spec: validate on paste; a real call
 * through the Agent SDK is the live harness's job, never a unit test's): the `sk-ant-oat`
 * prefix, a plausible length, no whitespace. The value never enters the result.
 */
export function validateSubscriptionTokenFormat(token: string): ValidationResult {
  const v = token.trim();
  const problems: string[] = [];
  if (!v.startsWith(SUBSCRIPTION_TOKEN_PREFIX)) {
    const kind = classifyCredential(v);
    problems.push(
      kind === "anthropic_api_key"
        ? "This is an Anthropic API key (sk-ant-api…), not a subscription token; pass it as --anthropic-key."
        : `A subscription token from \`claude setup-token\` starts with ${SUBSCRIPTION_TOKEN_PREFIX}.`,
    );
  }
  if (/\s/.test(v)) problems.push("The token contains whitespace; paste it in one piece.");
  if (v.length < 40) problems.push("The token is too short to be a subscription token.");
  const ok = problems.length === 0;
  return {
    ok,
    summary: ok
      ? "Subscription token format accepted (sk-ant-oat…); stored for the Agent SDK path, verified on first use."
      : "The value is not a subscription token.",
    problems,
    details: { kind: "subscription", verified: "format" },
  };
}

export interface GitHubValidationOptions {
  token: string;
  /** Base API URL; the fake git host in tests, https://api.github.com in production. */
  apiBase?: string;
  /** owner/name repositories the user selected. */
  repos: string[];
  fetchImpl?: typeof fetch;
}

const REQUIRED_PERMISSIONS = ["pull", "push"] as const;

/**
 * A pasted credential split by a line break or a space (U-053: a key copied from a wrapped
 * e-mail or a PDF). Refused before anything is sent, in words that never show the value; sent
 * as a header it would fail with an error that quotes the whole header, the key included.
 */
export function splitValueProblem(value: string, what: string): ValidationResult | null {
  const v = value.trim();
  const kind = /[\r\n]/.test(v) ? "a line break" : /\s/.test(v) ? "a space" : null;
  if (!kind) return null;
  return {
    ok: false,
    summary: `The ${what} has ${kind} inside, so it was not checked or saved.`,
    problems: [
      `It has ${kind} inside. Copy the ${what} again in one piece, from the page that shows it (not from a wrapped e-mail or document), and paste it.`,
    ],
    details: { kind: "split_value" },
  };
}

export async function validateGitHubToken(
  opts: GitHubValidationOptions,
): Promise<ValidationResult> {
  const split = splitValueProblem(opts.token, "token");
  if (split) return split;
  const f = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "forerunner-setup",
  };
  const problems: string[] = [];
  const details: Record<string, unknown> = {};
  let res: Response;
  try {
    res = await f(`${base}/user`, { headers });
  } catch (e) {
    return {
      ok: false,
      summary: "Could not reach the GitHub API.",
      problems: [`Could not reach ${base}: ${describeNetworkError(e, [opts.token])}.`],
      details,
    };
  }
  if (res.status === 401)
    return {
      ok: false,
      summary: "GitHub rejected the token (401).",
      problems: ["The token is invalid, expired or revoked."],
      details,
    };
  if (!res.ok)
    return {
      ok: false,
      summary: `GitHub API error ${res.status}.`,
      problems: [`GET /user returned ${res.status}`],
      details,
    };
  const user = (await res.json()) as { login?: string };
  details.login = user.login;
  const classicScopes = res.headers.get("x-oauth-scopes");
  details.kind = classicScopes !== null ? "classic" : "fine_grained_or_app";
  if (classicScopes !== null) {
    const scopes = classicScopes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    details.scopes = scopes;
    if (scopes.includes("admin:org") || scopes.includes("delete_repo")) {
      problems.push(
        `Token has broad scopes (${scopes.filter((s) => s === "admin:org" || s === "delete_repo").join(", ")}); use a fine-grained token limited to the selected repositories.`,
      );
    }
    if (!scopes.includes("repo")) problems.push("Classic token lacks the 'repo' scope.");
  }
  const repoReport: Record<
    string,
    { ok: boolean; permissions?: Record<string, boolean>; status: number }
  > = {};
  for (const full of opts.repos) {
    try {
      const r = await f(`${base}/repos/${full}`, { headers });
      if (!r.ok) {
        repoReport[full] = { ok: false, status: r.status };
        problems.push(
          r.status === 404
            ? `No access to ${full} (404): add it to the token's repository list.`
            : `${full}: ${r.status}`,
        );
        continue;
      }
      const body = (await r.json()) as { permissions?: Record<string, boolean> };
      const perms = body.permissions ?? {};
      const missing = REQUIRED_PERMISSIONS.filter((p) => !perms[p]);
      repoReport[full] = { ok: missing.length === 0, permissions: perms, status: r.status };
      if (missing.length) problems.push(`${full}: missing ${missing.join(", ")} permission.`);
      if (perms.admin)
        problems.push(
          `${full}: token has admin rights; least privilege asks for contents, pull requests and issues only.`,
        );
    } catch (e) {
      repoReport[full] = { ok: false, status: 0 };
      problems.push(`${full}: ${describeNetworkError(e, [opts.token])}`);
    }
  }
  details.repos = repoReport;
  const blocking = problems.filter(
    (p) => !p.includes("admin rights") && !p.includes("broad scopes"),
  ).length;
  // Every repository the token reaches, with the access GitHub reports for it (U-051): the app
  // sends no repository list, so this is what the person sees about the token's reach. A token
  // that reaches nothing, or can only read, is saved with a warning; it is not refused.
  const reach = await reachableRepos(f, base, headers, opts.token);
  if ("error" in reach) {
    problems.push(
      `Could not list the repositories the token reaches (${reach.error}); check its repository access on GitHub.`,
    );
  } else {
    details.reachable = reach.repos;
    if (reach.truncated) details.reachableTruncated = true;
    const readOnly = reach.repos.filter((r) => r.access === "read");
    if (reach.repos.length === 0) {
      problems.push(
        "The token reaches no repository. On GitHub, edit the token: under Repository access choose Only select repositories, pick the ones your agent may work in, and give them Contents: Read and write.",
      );
    } else if (readOnly.length === reach.repos.length) {
      problems.push(
        "The token can only read every repository it reaches: your agent cannot push branches or open pull requests. On GitHub, give the token Contents: Read and write and Pull requests: Read and write.",
      );
    } else {
      for (const r of readOnly)
        problems.push(
          `${r.fullName}: read only. Your agent cannot push there; give the token Contents: Read and write on it, or leave it out.`,
        );
    }
    for (const r of reach.repos.filter((x) => x.access === "admin"))
      problems.push(
        `${r.fullName}: the token has admin rights there; least privilege asks for contents, pull requests and issues only.`,
      );
  }
  const ok = blocking === 0;
  const count = "error" in reach ? null : reach.repos.length;
  return {
    ok,
    summary: ok
      ? `Token works for ${user.login ?? "the user"}.${
          count === null
            ? ""
            : count === 0
              ? " It reaches no repository."
              : ` It reaches ${count}${"truncated" in reach && reach.truncated ? " or more" : ""} repositor${count === 1 ? "y" : "ies"}.`
        }`
      : "Token needs changes before it can be used.",
    problems,
    details,
  };
}

/** One repository a GitHub token reaches, with the access GitHub reports for it. */
export interface ReachableRepo {
  fullName: string;
  /** `admin`, `write` (push: contents read and write) or `read` (pull only). */
  access: "admin" | "write" | "read";
}

/** Pages of `GET /user/repos` followed at most (100 a page). */
const REACHABLE_PAGES_MAX = 10;

/**
 * `GET /user/repos` page by page (U-051): every repository the token can reach, with the
 * access in its `permissions`. A `Link: rel="next"` is followed only on the API's own origin,
 * so the token never goes anywhere else.
 */
async function reachableRepos(
  f: typeof fetch,
  base: string,
  headers: Record<string, string>,
  token: string,
): Promise<{ repos: ReachableRepo[]; truncated: boolean } | { error: string }> {
  const origin = originOf(base);
  const repos: ReachableRepo[] = [];
  let url: string | null = `${base}/user/repos?per_page=100&sort=full_name`;
  for (let page = 0; url && page < REACHABLE_PAGES_MAX; page++) {
    let res: Response;
    try {
      res = await f(url, { headers });
    } catch (e) {
      return { error: describeNetworkError(e, [token]) };
    }
    if (!res.ok) return { error: `GET /user/repos returned ${res.status}` };
    const items = (await res.json().catch(() => [])) as {
      full_name?: string;
      permissions?: Record<string, boolean>;
    }[];
    for (const it of Array.isArray(items) ? items : []) {
      if (!it.full_name) continue;
      const p = it.permissions ?? {};
      repos.push({
        fullName: it.full_name,
        access: p.admin ? "admin" : p.push ? "write" : "read",
      });
    }
    const next = nextLink(res.headers.get("link"));
    url = next && originOf(next) === origin ? next : null;
  }
  return { repos, truncated: url !== null };
}

function nextLink(link: string | null): string | null {
  for (const part of (link ?? "").split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (m?.[1]) return m[1];
  }
  return null;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export interface AnthropicValidationOptions {
  key: string;
  apiBase?: string;
  /** Workspace the key must act in: user-scoped keys (sk-ant-usr-…) are refused without it. */
  workspaceId?: string;
  fetchImpl?: typeof fetch;
}

export async function validateAnthropicKey(
  opts: AnthropicValidationOptions,
): Promise<ValidationResult> {
  // A subscription token is for Claude Code only (U-048, ADR 0098): Forerunner never sends it
  // to the API itself, so it is checked for its shape, like `--subscription-token`.
  if (opts.key.trim().startsWith(SUBSCRIPTION_TOKEN_PREFIX))
    return validateSubscriptionTokenFormat(opts.key);
  const split = splitValueProblem(opts.key, "key");
  if (split) return split;
  const f = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? "https://api.anthropic.com").replace(/\/$/, "");
  const headers: Record<string, string> = {
    "anthropic-version": "2023-06-01",
    "x-api-key": opts.key,
  };
  if (opts.workspaceId) headers["anthropic-workspace-id"] = opts.workspaceId;
  let res: Response;
  try {
    res = await f(`${base}/v1/models?limit=100`, { headers });
  } catch (e) {
    return {
      ok: false,
      summary: "Could not reach the Anthropic API.",
      problems: [`Could not reach ${base}: ${describeNetworkError(e, [opts.key])}.`],
      details: {},
    };
  }
  if (res.status === 401)
    return {
      ok: false,
      summary: "Anthropic rejected the key (401).",
      problems: ["The key is invalid or revoked."],
      details: { kind: "api_key" },
    };
  if (res.status === 403)
    return {
      ok: false,
      summary: "The key is not allowed to list models (403).",
      problems: ["Check the workspace and the key's permissions."],
      details: {},
    };
  if (!res.ok)
    return {
      ok: false,
      summary: `Anthropic API error ${res.status}.`,
      problems: [`GET /v1/models returned ${res.status}`],
      details: {},
    };
  const body = (await res.json()) as { data?: { id: string }[] };
  const ids = (body.data ?? []).map((m) => m.id);
  const problems: string[] = [];
  if (!ids.some((id) => /haiku/i.test(id)))
    problems.push("No Haiku model visible: chat and routing need one.");
  if (!ids.some((id) => /sonnet/i.test(id)))
    problems.push("No Sonnet model visible: the default specialist tier needs one.");
  return {
    ok: problems.length === 0,
    summary:
      problems.length === 0
        ? `Key works; ${ids.length} models visible.`
        : "Key works but the expected models are not visible.",
    problems,
    details: { kind: "api_key", models: ids },
  };
}

/** Guard used by the wizard before saving: a value that looks like a different credential type is rejected. */
export function classifyCredential(
  value: string,
): "github" | "anthropic_api_key" | "anthropic_oauth" | "unknown" {
  const v = value.trim();
  if (/^sk-ant-oat/.test(v)) return "anthropic_oauth";
  if (/^sk-ant-/.test(v)) return "anthropic_api_key";
  if (/^(gh[pousr]_|github_pat_)/.test(v)) return "github";
  return "unknown";
}

export function assertCredentialKind(value: string, expected: "github" | "anthropic"): void {
  const kind = classifyCredential(value);
  const okay =
    expected === "github"
      ? kind === "github"
      : kind === "anthropic_api_key" || kind === "anthropic_oauth";
  if (!okay && kind !== "unknown") {
    throw new ForerunnerError(
      "validation",
      `this looks like a ${kind.replaceAll("_", " ")}, not a ${expected} credential`,
    );
  }
}
