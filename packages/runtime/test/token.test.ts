import { isForerunnerError, join } from "@forerunner/platform";
import { INSTALL_WRAP_KEY_NAME } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import { TokenIssuer } from "../src/enforcement/token.ts";
import { harness, issue } from "./helpers.ts";

describe("capability tokens", () => {
  it("verifies its own signature and rejects tampering", () => {
    const h = harness();
    const t = issue(h, { allowedTools: ["echo"] });
    expect(h.tokens.verify(t, h.clock.now()).allowedTools).toEqual(["echo"]);
    const forged = { ...t, claims: { ...t.claims, allowedTools: ["echo", "delete_repo"] } };
    expect(() => h.tokens.verify(forged, h.clock.now())).toThrow(/signature invalid/);
    const other = new TokenIssuer();
    expect(() => other.verify(t, h.clock.now())).toThrow(/signature invalid/);
  });

  it("never allows a wildcard tool list", () => {
    const h = harness();
    expect(() => issue(h, { allowedTools: ["*"] })).toThrow(/cannot allow every tool/);
  });

  it("never grants a reserved secret name (the install wrapping key), so no run token can carry it", () => {
    const h = harness();
    try {
      issue(h, { grantedSecrets: ["github_token", INSTALL_WRAP_KEY_NAME] });
      throw new Error("should have thrown");
    } catch (e) {
      expect(isForerunnerError(e, "secret_reserved")).toBe(true);
      expect((e as { details: { name: string } }).details.name).toBe(INSTALL_WRAP_KEY_NAME);
    }
    expect(h.tokens.claimsForRun("run-1")).toBeUndefined();
    // derive cannot smuggle it in either: the parent never had it, and the issuer re-checks
    const parent = issue(h, { grantedSecrets: ["github_token"] });
    const child = h.tokens.derive(parent, {
      runId: "run-2",
      grantedSecrets: ["github_token", INSTALL_WRAP_KEY_NAME],
    });
    expect(child.claims.grantedSecrets).toEqual(["github_token"]);
  });

  it("expires and can be revoked", () => {
    const h = harness();
    const t = issue(h, { expiresAt: new Date(h.clock.now() + 1000).toISOString() });
    expect(() => h.tokens.verify(t, h.clock.now() + 1000)).toThrow(/expired/);
    h.tokens.revoke(t.claims.id);
    expect(() => h.tokens.verify(t, h.clock.now())).toThrow(/revoked/);
  });

  it("claimsForRun returns the run's newest live token; a same-instant re-issue wins by issue order", async () => {
    const h = harness();
    expect(h.tokens.claimsForRun("run-x")).toBeUndefined();
    const first = issue(h, { runId: "run-x", allowedDomains: ["a.example"] });
    // The simulated clock does not move: both tokens carry the same `issuedAt`.
    const second = issue(h, { runId: "run-x", allowedDomains: ["b.example"] });
    expect(second.claims.issuedAt).toBe(first.claims.issuedAt);
    expect(h.tokens.claimsForRun("run-x")?.id).toBe(second.claims.id);
    // A revoked re-issue falls back to the live one; an expired one is never returned.
    h.tokens.revoke(second.claims.id);
    expect(h.tokens.claimsForRun("run-x")?.id).toBe(first.claims.id);
    await h.clock.advance(3_600_000);
    expect(h.tokens.claimsForRun("run-x")).toBeUndefined();
    // A later clock tick orders by time again, whatever the insertion order.
    const third = issue(h, { runId: "run-x" });
    await h.clock.advance(1);
    const fourth = issue(h, { runId: "run-x" });
    expect(fourth.claims.issuedAt > third.claims.issuedAt).toBe(true);
    expect(h.tokens.claimsForRun("run-x")?.id).toBe(fourth.claims.id);
  });

  it("derived tokens never widen and depth grows by one", () => {
    const h = harness();
    const parent = issue(h, {
      allowedTools: ["echo", "read_file"],
      allowedPaths: [join("/", "w", "a")],
      allowedDomains: ["*.example.org", "api.github.com"],
      grantedSecrets: ["gh"],
      budgetUsdMicro: 500,
      depth: 0,
      maxDepth: 2,
    });
    const child = h.tokens.derive(parent, {
      runId: "run-2",
      allowedTools: ["read_file", "delete_repo"],
      allowedPaths: [join("/", "w", "a", "task-1"), join("/", "w", "b")],
      allowedDomains: ["docs.example.org", "api.github.com", "evil.com", "*.sub.example.org"],
      budgetUsdMicro: 900,
      grantedSecrets: ["gh", "aws"],
    });
    expect(child.claims.allowedTools).toEqual(["read_file"]);
    expect(child.claims.allowedPaths).toEqual([join("/", "w", "a", "task-1")]);
    expect(child.claims.allowedDomains).toEqual([
      "docs.example.org",
      "api.github.com",
      "*.sub.example.org",
    ]);
    expect(child.claims.budgetUsdMicro).toBe(500);
    expect(child.claims.grantedSecrets).toEqual(["gh"]);
    expect(child.claims.depth).toBe(1);
    const grandchild = h.tokens.derive(child, { runId: "run-3" });
    expect(grandchild.claims.depth).toBe(2);
    expect(() => h.tokens.derive(grandchild, { runId: "run-4" })).toThrow(/depth 3 exceeds max 2/);
  });
});
