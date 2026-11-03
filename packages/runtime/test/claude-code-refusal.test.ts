import { describe, expect, it } from "vitest";
import { isClaudeCodeRefusal } from "../src/provider/usage-limit.ts";

/**
 * U-078: which Claude Code results mean Anthropic refused the sign-in (`provider_auth`: marked
 * refused, one card, the work waits or moves on), as the SDK driver reads them. The review of
 * credential-limits: any error text holding "401" counted, so a run whose own output mentioned
 * the number (a failing test, a log line) marked the subscription refused.
 */
describe("isClaudeCodeRefusal", () => {
  it.each([
    ["an authentication_failed assistant error", "authentication_failed", ""],
    [
      "an API error 401",
      null,
      'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    ],
    ["a 401 Unauthorized", null, "Request failed: 401 Unauthorized"],
    ["an HTTP status 401", null, "HTTP status 401 from api.anthropic.com"],
    ["an expired sign-in", null, "OAuth token has expired"],
    ["a sign-in to renew", null, "Not logged in. Please run /login"],
  ])("%s is a refusal", (_label, kind, text) => {
    expect(isClaudeCodeRefusal(kind, text)).toBe(true);
  });

  it.each([
    ["a test that expects 401", "expected 401 to be 200 in test/login.test.ts"],
    ["a log line with the number", "wrote 401 lines to notes.md, then the tool failed"],
    ["a usage limit", "You've hit your limit · resets 3pm"],
    ["an overloaded API", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'],
  ])("%s is no refusal", (_label, text) => {
    expect(isClaudeCodeRefusal(null, text)).toBe(false);
  });
});
