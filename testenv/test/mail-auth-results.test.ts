import { describe, expect, it } from "vitest";
import {
  type AuthResults,
  formatAuthenticationResults,
  parseAuthenticationResults,
} from "../src/mail/auth-results.ts";

describe("Authentication-Results", () => {
  it("round-trips what the local server writes", () => {
    const results: AuthResults = {
      dkim: "fail",
      dkimDomain: "example.test",
      dkimSelector: "fr1",
      dkimReason: "body hash mismatch",
      aligned: false,
      spf: "softfail",
      spfDomain: "example.test",
      dmarc: "fail",
      fromDomain: "example.test",
    };
    const header = formatAuthenticationResults("mx.example.test", results);
    expect(header).toBe(
      "mx.example.test; dkim=fail (body hash mismatch) header.d=example.test header.s=fr1; spf=softfail smtp.mailfrom=example.test; dmarc=fail header.from=example.test (dkim.aligned=no)",
    );
    expect(parseAuthenticationResults(header)).toEqual({
      authservId: "mx.example.test",
      ...results,
    });
  });

  it("parses the shape Gmail writes, including header.i and folded lines", () => {
    const header =
      "mx.google.com;\r\n       dkim=pass header.i=@example.test header.s=20230601 header.b=abcDEF12;\r\n       spf=pass (google.com: domain of alice@example.test designates 192.0.2.25 as permitted sender) smtp.mailfrom=alice@example.test;\r\n       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.test";
    expect(parseAuthenticationResults(header)).toEqual({
      authservId: "mx.google.com",
      dkim: "pass",
      dkimDomain: "example.test",
      dkimSelector: "20230601",
      spf: "pass",
      spfDomain: "example.test",
      dmarc: "pass",
      fromDomain: "example.test",
    });
  });

  it("parses the shape Microsoft writes, without an authserv-id and with a trailing semicolon", () => {
    const header =
      "spf=fail (sender IP is 198.51.100.7) smtp.mailfrom=example.test; dkim=none (message not signed) header.d=none;dmarc=fail action=oreject header.from=example.test;";
    expect(parseAuthenticationResults(header)).toEqual({
      authservId: "",
      dkim: "none",
      dkimDomain: "none",
      dkimReason: "message not signed",
      spf: "fail",
      spfDomain: "example.test",
      dmarc: "fail",
      fromDomain: "example.test",
    });
  });

  it("maps unknown verdicts to none rather than guessing", () => {
    expect(
      parseAuthenticationResults("mx; dkim=temperror; spf=permerror; dmarc=bestguesspass"),
    ).toEqual({
      authservId: "mx",
      dkim: "none",
      spf: "none",
      dmarc: "none",
    });
  });
});
