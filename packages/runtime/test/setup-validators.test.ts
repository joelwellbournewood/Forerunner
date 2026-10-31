import { describe, expect, it } from "vitest";
import {
  assertCredentialKind,
  classifyCredential,
  validateAnthropicKey,
  validateGitHubToken,
} from "../src/setup/validators.ts";

function router(routes: Record<string, (init?: RequestInit) => Response>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${url.pathname}`;
    const handler = routes[key];
    if (!handler) return new Response("not found", { status: 404 });
    return handler(init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("GitHub token validation", () => {
  it("accepts a fine-grained token with push access to the selected repos", async () => {
    const f = router({
      "/user": () => json({ login: "j" }),
      "/repos/o/a": () => json({ permissions: { pull: true, push: true, admin: false } }),
    });
    const r = await validateGitHubToken({
      token: "t",
      apiBase: "http://x",
      repos: ["o/a"],
      fetchImpl: f,
    });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("j");
    expect(r.details.kind).toBe("fine_grained_or_app");
  });

  it("reports missing repos, missing permissions and broad classic scopes", async () => {
    const f = router({
      "/user": () => json({ login: "j" }, 200, { "x-oauth-scopes": "repo, admin:org" }),
      "/repos/o/a": () => json({ permissions: { pull: true, push: false } }),
    });
    const r = await validateGitHubToken({
      token: "t",
      apiBase: "http://x",
      repos: ["o/a", "o/missing"],
      fetchImpl: f,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/missing push/);
    expect(r.problems.join("\n")).toMatch(/No access to o\/missing/);
    expect(r.problems.join("\n")).toMatch(/broad scopes/);
    expect(r.details.kind).toBe("classic");
  });

  it("explains a 401 and never echoes the token", async () => {
    const f = router({ "/user": () => new Response("", { status: 401 }) });
    const r = await validateGitHubToken({
      token: "super-secret-token",
      apiBase: "http://x",
      repos: [],
      fetchImpl: f,
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("super-secret-token");
  });

  it("sends the token as a bearer header to the configured base", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const f = (async (input: string | URL, init?: RequestInit) => {
      seen = { url: String(input), auth: new Headers(init?.headers).get("authorization") };
      return json({ login: "j" });
    }) as typeof fetch;
    await validateGitHubToken({
      token: "abc",
      apiBase: "http://fake-host:1234/",
      repos: [],
      fetchImpl: f,
    });
    expect(seen).toEqual({ url: "http://fake-host:1234/user", auth: "Bearer abc" });
  });
});

describe("Anthropic key validation", () => {
  it("accepts a key that can list the expected models and distinguishes subscription tokens", async () => {
    let headers: Headers | null = null;
    const f = (async (_i: string | URL, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return json({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }] });
    }) as typeof fetch;
    const r = await validateAnthropicKey({
      key: "sk-ant-api03-x",
      apiBase: "http://x",
      fetchImpl: f,
    });
    expect(r.ok).toBe(true);
    expect(headers!.get("x-api-key")).toBe("sk-ant-api03-x");
    // A subscription token is told apart and never sent anywhere (U-048): it is for Claude
    // Code only, so the check is its format; the last request is still the API key's.
    const r2 = await validateAnthropicKey({
      key: `sk-ant-oat01-${"y".repeat(40)}`,
      apiBase: "http://x",
      fetchImpl: f,
    });
    expect(r2.details.kind).toBe("subscription");
    expect(headers!.get("authorization")).toBeNull();
    expect(headers!.get("x-api-key")).toBe("sk-ant-api03-x");
  });

  it("reports 401 and missing tiers", async () => {
    const bad = await validateAnthropicKey({
      key: "k",
      apiBase: "http://x",
      fetchImpl: router({ "/v1/models": () => new Response("", { status: 401 }) }),
    });
    expect(bad.ok).toBe(false);
    const thin = await validateAnthropicKey({
      key: "k",
      apiBase: "http://x",
      fetchImpl: router({ "/v1/models": () => json({ data: [{ id: "claude-opus-5-5" }] }) }),
    });
    expect(thin.ok).toBe(false);
    expect(thin.problems).toHaveLength(2);
  });
});

describe("credential classification", () => {
  it("recognises shapes and refuses a swapped credential", () => {
    const gh = ["ghp_", "x".repeat(36)].join(""); // not-a-secret
    const ant = ["sk-ant-", "api03-", "y".repeat(20)].join(""); // not-a-secret
    expect(classifyCredential(gh)).toBe("github");
    expect(classifyCredential(ant)).toBe("anthropic_api_key");
    expect(classifyCredential("hello")).toBe("unknown");
    expect(() => assertCredentialKind(gh, "anthropic")).toThrow(/looks like a github/);
    expect(() => assertCredentialKind(ant, "github")).toThrow(/anthropic api key/);
    expect(() => assertCredentialKind("hello", "github")).not.toThrow();
  });
});
