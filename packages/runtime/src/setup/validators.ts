import { ForerunnerError } from "@forerunner/platform";

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
      "Forerunner calls GET /user and checks each selected repository's permissions; it reports what the token can and cannot do before saving it to the vault.",
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
      "Forerunner calls GET /v1/models with the key; a 200 proves the key works, a 401 means it is wrong or revoked. No tokens are generated during the check.",
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

export async function validateGitHubToken(
  opts: GitHubValidationOptions,
): Promise<ValidationResult> {
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
      problems: [String(e instanceof Error ? e.message : e)],
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
      problems.push(`${full}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  details.repos = repoReport;
  const ok =
    problems.filter((p) => !p.includes("admin rights") && !p.includes("broad scopes")).length === 0;
  return {
    ok,
    summary: ok
      ? `Token works for ${user.login ?? "the user"} on ${opts.repos.length} repositor${opts.repos.length === 1 ? "y" : "ies"}.`
      : "Token needs changes before it can be used.",
    problems,
    details,
  };
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
  const f = opts.fetchImpl ?? fetch;
  const base = (opts.apiBase ?? "https://api.anthropic.com").replace(/\/$/, "");
  const isOauth = opts.key.startsWith("sk-ant-oat");
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (isOauth) headers.Authorization = `Bearer ${opts.key}`;
  else headers["x-api-key"] = opts.key;
  if (opts.workspaceId) headers["anthropic-workspace-id"] = opts.workspaceId;
  let res: Response;
  try {
    res = await f(`${base}/v1/models?limit=100`, { headers });
  } catch (e) {
    return {
      ok: false,
      summary: "Could not reach the Anthropic API.",
      problems: [String(e instanceof Error ? e.message : e)],
      details: {},
    };
  }
  if (res.status === 401)
    return {
      ok: false,
      summary: "Anthropic rejected the key (401).",
      problems: ["The key is invalid or revoked."],
      details: { kind: isOauth ? "subscription" : "api_key" },
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
    details: { kind: isOauth ? "subscription" : "api_key", models: ids },
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
