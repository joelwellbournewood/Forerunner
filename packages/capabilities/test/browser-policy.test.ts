import { isForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { hostCovered, SitePolicy, splitHostPattern, urlHost } from "../src/browser/policy.ts";

describe("host patterns", () => {
  it("follow domainCovered: exact host or wildcard subdomains", () => {
    expect(hostCovered("example.com", "443", ["example.com"])).toBe(true);
    expect(hostCovered("www.example.com", "443", ["example.com"])).toBe(false);
    expect(hostCovered("www.example.com", "443", ["*.example.com"])).toBe(true);
    expect(hostCovered("example.com", "443", ["*.example.com"])).toBe(true);
    expect(hostCovered("notexample.com", "443", ["*.example.com"])).toBe(false);
    expect(hostCovered("EXAMPLE.com", "443", ["example.com"])).toBe(true);
  });

  it("narrow to one port when the pattern names it", () => {
    expect(hostCovered("127.0.0.1", "8080", ["127.0.0.1:8080"])).toBe(true);
    expect(hostCovered("127.0.0.1", "8081", ["127.0.0.1:8080"])).toBe(false);
    expect(hostCovered("127.0.0.1", "8081", ["127.0.0.1"])).toBe(true);
    expect(hostCovered("api.example.com", "8443", ["*.example.com:8443"])).toBe(true);
    expect(hostCovered("api.example.com", "443", ["*.example.com:8443"])).toBe(false);
    expect(splitHostPattern("[::1]:9000")).toEqual({ host: "[::1]", port: "9000" });
    expect(() => splitHostPattern("http://x")).toThrow(/invalid host pattern/);
  });

  it("parse URLs into host and effective port", () => {
    expect(urlHost("https://Example.com/x")).toEqual({
      scheme: "https:",
      host: "example.com",
      port: "443",
    });
    expect(urlHost("http://127.0.0.1:8080/")).toEqual({
      scheme: "http:",
      host: "127.0.0.1",
      port: "8080",
    });
    expect(urlHost("not a url")).toBeNull();
  });
});

describe("SitePolicy", () => {
  const policy = new SitePolicy({
    allow: ["*.example.com", "127.0.0.1:8080"],
    block: ["evil.example.com", "*.ads.example.com"],
  });

  it("allows only the allow list, block list first", () => {
    expect(policy.check("https://www.example.com/").reason).toBe("allowed");
    expect(policy.check("https://evil.example.com/").reason).toBe("blocked");
    expect(policy.check("https://a.ads.example.com/x.js").reason).toBe("blocked");
    expect(policy.check("https://other.test/").reason).toBe("not_allowed");
    expect(policy.check("http://127.0.0.1:8080/").allowed).toBe(true);
    expect(policy.check("http://127.0.0.1:8081/").reason).toBe("not_allowed");
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
