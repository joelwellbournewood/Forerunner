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

  it("lists the repositories the token reaches with their access, and warns about read-only and admin (U-051)", async () => {
    // What the app sends: the token alone, no repository list.
    const f = router({
      "/user": () => json({ login: "j" }),
      "/user/repos": () =>
        json([
          { full_name: "j/site", permissions: { admin: false, push: true, pull: true } },
          { full_name: "j/notes", permissions: { admin: false, push: false, pull: true } },
          { full_name: "org/infra", permissions: { admin: true, push: true, pull: true } },
        ]),
    });
    const r = await validateGitHubToken({
      token: "t",
      apiBase: "http://x",
      repos: [],
      fetchImpl: f,
    });
    expect(r.ok).toBe(true);
    expect(r.details.reachable).toEqual([
      { fullName: "j/site", access: "write" },
      { fullName: "j/notes", access: "read" },
      { fullName: "org/infra", access: "admin" },
    ]);
    expect(r.summary).toBe("Token works for j. It reaches 3 repositories.");
    const text = r.problems.join("\n");
    expect(text).toMatch(/j\/notes: read only/);
    expect(text).toMatch(/Contents: Read and write/);
    expect(text).toMatch(/org\/infra: the token has admin rights/);
  });

  it("warns when the token reaches no repository, or can only read every one (U-051)", async () => {
    const none = await validateGitHubToken({
      token: "t",
      apiBase: "http://x",
      repos: [],
      fetchImpl: router({ "/user": () => json({ login: "j" }), "/user/repos": () => json([]) }),
    });
    expect(none.details.reachable).toEqual([]);
    expect(none.summary).toBe("Token works for j. It reaches no repository.");
    expect(none.problems.join("\n")).toMatch(/reaches no repository.*Only select repositories/s);

    const readOnly = await validateGitHubToken({
      token: "t",
      apiBase: "http://x",
      repos: [],
      fetchImpl: router({
        "/user": () => json({ login: "j" }),
        "/user/repos": () =>
          json([{ full_name: "j/site", permissions: { push: false, pull: true } }]),
      }),
    });
    expect(readOnly.problems.join("\n")).toMatch(/can only read/);
  });

  it("follows the next page on the API host only (U-051)", async () => {
    const urls: string[] = [];
    const f = (async (input: string | URL) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      if (url.pathname === "/user") return json({ login: "j" });
      if (url.searchParams.get("page") === "2")
        return json([{ full_name: "j/b", permissions: { push: true, pull: true } }], 200, {
          link: '<http://elsewhere.test/user/repos?page=3>; rel="next"',
        });
      return json([{ full_name: "j/a", permissions: { push: true, pull: true } }], 200, {
        link: '<http://x/user/repos?per_page=100&page=2>; rel="next"',
      });
    }) as typeof fetch;
    const r = await validateGitHubToken({
      token: "t",
      apiBase: "http://x",
      repos: [],
      fetchImpl: f,
    });
    expect((r.details.reachable as { fullName: string }[]).map((x) => x.fullName)).toEqual([
      "j/a",
      "j/b",
    ]);
    expect(urls.some((u) => u.includes("elsewhere"))).toBe(false);
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
    const seen: { url: string; auth: string | null }[] = [];
    const f = (async (input: string | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return String(input).includes("/user/repos") ? json([]) : json({ login: "j" });
    }) as typeof fetch;
    await validateGitHubToken({
      token: "abc",
      apiBase: "http://fake-host:1234/",
      repos: [],
      fetchImpl: f,
    });
    expect(seen[0]).toEqual({ url: "http://fake-host:1234/user", auth: "Bearer abc" });
    // Every later call (the repositories it reaches, U-051) goes to the same base, the same way.
    for (const s of seen) {
      expect(s.url.startsWith("http://fake-host:1234/")).toBe(true);
      expect(s.auth).toBe("Bearer abc");
    }
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

describe("a network error keeps its cause (U-053)", () => {
  const failing = (code: string, message: string): typeof fetch =>
    (async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
    }) as typeof fetch;
  const key = ["sk-ant-api03-", "net", "4".repeat(40)].join(""); // not-a-secret

  it.each([
    ["ENOTFOUND", "getaddrinfo ENOTFOUND api.anthropic.com", /could not find the server/i],
    ["ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443", /refused the connection/i],
    [
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "unable to verify the first certificate",
      /certificate.*proxy/i,
    ],
    ["ETIMEDOUT", "connect ETIMEDOUT 10.0.0.1:443", /did not answer in time/i],
  ])("%s says what failed, not only 'fetch failed'", async (code, message, expected) => {
    const r = await validateAnthropicKey({
      key,
      apiBase: "http://x",
      fetchImpl: failing(code, message),
    });
    expect(r.ok).toBe(false);
    const text = r.problems.join("\n");
    expect(text).toMatch(expected);
    expect(text).toContain(code);
    expect(text).not.toContain(key);
    const gh = await validateGitHubToken({
      token: "t0ken-value",
      apiBase: "http://x",
      repos: [],
      fetchImpl: failing(code, message),
    });
    expect(gh.problems.join("\n")).toMatch(expected);
  });

  it("a proxy that refuses says so", async () => {
    const r = await validateAnthropicKey({
      key,
      apiBase: "http://x",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed", {
          cause: new Error("Proxy response (407) !== 200 when HTTP Tunneling"),
        });
      }) as typeof fetch,
    });
    expect(r.problems.join("\n")).toMatch(/proxy/i);
    expect(r.problems.join("\n")).toContain("407");
  });

  it("a value with a line break inside is refused before anything is sent", async () => {
    let requests = 0;
    const counting = (async () => {
      requests++;
      return json({});
    }) as typeof fetch;
    const broken = `${key.slice(0, 20)}\n${key.slice(20)}`;
    const r = await validateAnthropicKey({ key: broken, apiBase: "http://x", fetchImpl: counting });
    const g = await validateGitHubToken({
      token: "abc\ndef",
      apiBase: "http://x",
      repos: [],
      fetchImpl: counting,
    });
    expect(requests).toBe(0);
    for (const res of [r, g]) {
      expect(res.ok).toBe(false);
      expect(res.problems.join("\n")).toContain("line break");
    }
    expect(JSON.stringify(r)).not.toContain(key.slice(20));
    expect(JSON.stringify(g)).not.toContain("def");
  });
});
