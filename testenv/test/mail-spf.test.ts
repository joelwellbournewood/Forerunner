import { describe, expect, it } from "vitest";
import { checkSpf, ipMatches, normalizeIp, type SpfPolicy } from "../src/mail/spf.ts";

const policy: SpfPolicy = {
  "example.test": { allowedIps: ["192.0.2.25", "198.51.100.0/24"], all: "fail" },
  "soft.test": { allowedIps: ["203.0.113.7"], all: "softfail" },
  "Neutral.Test": { allowedIps: [], all: "neutral" },
};

describe("checkSpf", () => {
  it("passes a listed address and a CIDR member", () => {
    expect(checkSpf({ ip: "192.0.2.25", mailFromDomain: "example.test", policy })).toBe("pass");
    expect(checkSpf({ ip: "198.51.100.200", mailFromDomain: "example.test", policy })).toBe("pass");
  });

  it("maps the all mechanism to fail, softfail and neutral", () => {
    expect(checkSpf({ ip: "192.0.2.99", mailFromDomain: "example.test", policy })).toBe("fail");
    expect(checkSpf({ ip: "192.0.2.99", mailFromDomain: "soft.test", policy })).toBe("softfail");
    expect(checkSpf({ ip: "192.0.2.99", mailFromDomain: "neutral.test", policy })).toBe("neutral");
  });

  it("returns none for a domain without policy, an empty domain, or no policy at all", () => {
    expect(checkSpf({ ip: "192.0.2.25", mailFromDomain: "unknown.test", policy })).toBe("none");
    expect(checkSpf({ ip: "192.0.2.25", mailFromDomain: "", policy })).toBe("none");
    expect(checkSpf({ ip: "192.0.2.25", mailFromDomain: "example.test", policy: undefined })).toBe(
      "none",
    );
  });

  it("matches IPv4-mapped IPv6 addresses and compares domains case-insensitively", () => {
    expect(normalizeIp("::FFFF:192.0.2.25")).toBe("192.0.2.25");
    expect(checkSpf({ ip: "::ffff:192.0.2.25", mailFromDomain: "EXAMPLE.test", policy })).toBe(
      "pass",
    );
    expect(ipMatches("::1", "::1")).toBe(true);
    expect(ipMatches("127.0.0.1", "::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects malformed CIDR specs instead of matching everything", () => {
    expect(ipMatches("10.0.0.1", "10.0.0.0/33")).toBe(false);
    expect(ipMatches("10.0.0.1", "10.0.0/8")).toBe(false);
    expect(ipMatches("10.0.0.1", "0.0.0.0/0")).toBe(true);
    expect(ipMatches("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipMatches("11.1.2.3", "10.0.0.0/8")).toBe(false);
  });
});
