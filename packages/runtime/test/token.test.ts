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

  it("expires and can be revoked", () => {
    const h = harness();
    const t = issue(h, { expiresAt: new Date(h.clock.now() + 1000).toISOString() });
    expect(() => h.tokens.verify(t, h.clock.now() + 1000)).toThrow(/expired/);
    h.tokens.revoke(t.claims.id);
    expect(() => h.tokens.verify(t, h.clock.now())).toThrow(/revoked/);
  });

  it("derived tokens never widen and depth grows by one", () => {
    const h = harness();
    const parent = issue(h, {
      allowedTools: ["echo", "read_file"],
      allowedPaths: ["/w/a"],
      grantedSecrets: ["gh"],
      budgetUsdMicro: 500,
      depth: 0,
      maxDepth: 2,
    });
    const child = h.tokens.derive(parent, {
      runId: "run-2",
      allowedTools: ["read_file", "delete_repo"],
      budgetUsdMicro: 900,
      grantedSecrets: ["gh", "aws"],
    });
    expect(child.claims.allowedTools).toEqual(["read_file"]);
    expect(child.claims.budgetUsdMicro).toBe(500);
    expect(child.claims.grantedSecrets).toEqual(["gh"]);
    expect(child.claims.depth).toBe(1);
    const grandchild = h.tokens.derive(child, { runId: "run-3" });
    expect(grandchild.claims.depth).toBe(2);
    expect(() => h.tokens.derive(grandchild, { runId: "run-4" })).toThrow(/depth 3 exceeds max 2/);
  });
});
