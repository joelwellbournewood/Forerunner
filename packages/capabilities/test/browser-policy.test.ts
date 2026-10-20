import { isForerunnerError } from "@forerunner/platform";
import { domainAllowed, domainCovered, hostnameOf } from "@forerunner/runtime";
import { describe, expect, it } from "vitest";
import {
  hostCovered,
  normaliseHostPattern,
  REDIRECT_STUB_ATTR,
  redirectHopHeaders,
  redirectKeepsMethod,
  redirectStub,
  redirectTarget,
  SitePolicy,
  STREAMED_RESOURCE_TYPES,
  urlHost,
} from "../src/browser/policy.ts";

describe("host patterns", () => {
  it("follow domainCovered: exact host or wildcard subdomains, any port", () => {
    expect(hostCovered("example.com", ["example.com"])).toBe(true);
    expect(hostCovered("www.example.com", ["example.com"])).toBe(false);
    expect(hostCovered("www.example.com", ["*.example.com"])).toBe(true);
    expect(hostCovered("example.com", ["*.example.com"])).toBe(true);
    expect(hostCovered("notexample.com", ["*.example.com"])).toBe(false);
    expect(hostCovered("EXAMPLE.com", ["example.com"])).toBe(true);
    expect(hostCovered("127.0.0.1", ["127.0.0.1"])).toBe(true);
    expect(hostCovered("[::1]", ["[::1]"])).toBe(true);
  });

  it("accept exactly what a token domain can be: no scheme, port or path", () => {
    expect(normaliseHostPattern(" Example.COM ")).toBe("example.com");
    expect(normaliseHostPattern("*.example.com")).toBe("*.example.com");
    expect(normaliseHostPattern("[::1]")).toBe("[::1]");
    for (const bad of [
      "",
      "http://x",
      "example.com/path",
      "127.0.0.1:8080",
      "*.example.com:8443",
    ]) {
      expect(() => normaliseHostPattern(bad), bad).toThrow(/host pattern/);
      expect(() => new SitePolicy({ allow: [bad] }), bad).toThrow(/host pattern/);
    }
  });

  it("parse URLs into scheme and host", () => {
    expect(urlHost("https://Example.com/x")).toEqual({ scheme: "https:", host: "example.com" });
    expect(urlHost("http://127.0.0.1:8080/")).toEqual({ scheme: "http:", host: "127.0.0.1" });
    expect(urlHost("not a url")).toBeNull();
  });

  it("decide every URL exactly as the runtime hooks and token do", () => {
    const patterns = ["*.example.com", "127.0.0.1", "api.other.test"];
    const policy = new SitePolicy({ allow: patterns });
    const urls = [
      "https://example.com/",
      "https://www.example.com/x",
      "https://www.example.com:8443/x",
      "https://notexample.com/",
      "http://127.0.0.1/",
      "http://127.0.0.1:3000/",
      "http://127.0.0.1:9000/",
      "http://localhost:3000/",
      "https://api.other.test/",
      "https://v2.api.other.test/",
    ];
    for (const url of urls) {
      const host = hostnameOf(url);
      expect(host, url).not.toBeNull();
      const hooks = host !== null && domainAllowed(host, patterns);
      expect(policy.isAllowed(url), url).toBe(hooks);
      expect(policy.isAllowed(url), url).toBe(host !== null && domainCovered(host, patterns));
    }
  });
});

describe("SitePolicy", () => {
  const policy = new SitePolicy({
    allow: ["*.example.com", "127.0.0.1"],
    block: ["evil.example.com", "*.ads.example.com"],
  });

  it("allows only the allow list, block list first", () => {
    expect(policy.check("https://www.example.com/").reason).toBe("allowed");
    expect(policy.check("https://evil.example.com/").reason).toBe("blocked");
    expect(policy.check("https://a.ads.example.com/x.js").reason).toBe("blocked");
    expect(policy.check("https://other.test/").reason).toBe("not_allowed");
    expect(policy.check("http://127.0.0.1:8080/").allowed).toBe(true);
    expect(policy.check("http://127.0.0.1:8081/").allowed).toBe(true);
    expect(policy.check("http://localhost:8080/").reason).toBe("not_allowed");
    expect(policy.check("file:///etc/passwd").reason).toBe("scheme");
    expect(policy.check("javascript:alert(1)").reason).toBe("scheme");
    expect(policy.check("nope").reason).toBe("invalid");
  });

  it("an empty allow list allows nothing", () => {
    const none = new SitePolicy({ allow: [] });
    expect(none.isAllowed("https://www.example.com/")).toBe(false);
  });

  it("assert throws domain_not_allowed with details before any action", () => {
    expect(policy.assert("https://www.example.com/").allowed).toBe(true);
    const err = (() => {
      try {
        policy.assert("https://evil.example.com/pay", "download");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(isForerunnerError(err, "domain_not_allowed")).toBe(true);
    expect((err as { message: string }).message).toContain("block list");
    expect((err as { details: Record<string, unknown> }).details).toMatchObject({
      host: "evil.example.com",
      reason: "blocked",
      action: "download",
    });
    expect(() => policy.assert("ftp://www.example.com/")).toThrow(/only http and https/);
    expect(() => policy.assert("")).toThrow(/invalid URL/);
  });

  it("is built from token claims and can only be narrowed", () => {
    const fromToken = SitePolicy.fromClaims(
      { allowedDomains: ["*.example.com", "api.other.test"] },
      ["evil.example.com"],
    );
    expect(fromToken.allow).toEqual(["*.example.com", "api.other.test"]);
    expect(fromToken.isAllowed("https://evil.example.com/")).toBe(false);
    const narrowed = fromToken.narrowedBy(
      new SitePolicy({ allow: ["*.example.com"], block: ["x.example.com"] }),
    );
    expect(narrowed.allow).toEqual(["*.example.com"]);
    expect(narrowed.isAllowed("https://api.other.test/")).toBe(false);
    expect(narrowed.isAllowed("https://x.example.com/")).toBe(false);
    expect(narrowed.isAllowed("https://y.example.com/")).toBe(true);
    expect(fromToken.toJSON()).toEqual({
      allow: ["*.example.com", "api.other.test"],
      block: ["evil.example.com"],
    });
  });
});

describe("redirect handling helpers", () => {
  it("resolves a 3xx Location against the request URL and ignores everything else", () => {
    expect(redirectTarget(302, "/next?x=1", "https://a.test/from/here")).toBe(
      "https://a.test/next?x=1",
    );
    expect(redirectTarget(301, "https://b.test/", "https://a.test/")).toBe("https://b.test/");
    expect(redirectTarget(200, "https://b.test/", "https://a.test/")).toBeNull();
    expect(redirectTarget(302, undefined, "https://a.test/")).toBeNull();
    expect(redirectTarget(302, "", "https://a.test/")).toBeNull();
    expect(redirectTarget(304, "/x", "https://a.test/")).toBe("https://a.test/x");
  });

  it("keeps the request method and body only for 307 and 308", () => {
    expect(redirectKeepsMethod(307)).toBe(true);
    expect(redirectKeepsMethod(308)).toBe(true);
    for (const s of [301, 302, 303]) expect(redirectKeepsMethod(s)).toBe(false);
  });

  it("never carries cookies, host or length onto a hop it follows itself", () => {
    const headers = {
      Cookie: "sid=abc",
      Host: "a.test",
      "Content-Length": "12",
      "Content-Type": "application/json",
      "User-Agent": "Forerunner-AI-Agent/1.0",
      Accept: "*/*",
    };
    expect(redirectHopHeaders(headers, false)).toEqual({
      "user-agent": "Forerunner-AI-Agent/1.0",
      accept: "*/*",
    });
    expect(redirectHopHeaders(headers, true)).toEqual({
      "content-type": "application/json",
      "user-agent": "Forerunner-AI-Agent/1.0",
      accept: "*/*",
    });
  });

  it("builds a redirect stub that names the target without letting it break out", () => {
    const target = 'https://a.test/x?q=1&r=<"y">&s=</script><script>alert(1)</script>';
    const stub = redirectStub(target);
    expect(stub).toContain(
      `${REDIRECT_STUB_ATTR}="https://a.test/x?q=1&amp;r=&lt;&quot;y&quot;&gt;&amp;s=&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;"`,
    );
    // exactly one real closing script tag: the target's own is escaped inside the JS string
    expect(stub.split("</script>")).toHaveLength(2);
    expect(stub).toContain("\\u003c/script>");
    expect(stub).toContain("window.top !== window");
  });

  it("names the streamed resource types that bypass the proxy after the host check", () => {
    expect([...STREAMED_RESOURCE_TYPES].sort()).toEqual(["eventsource", "media", "websocket"]);
  });
});
