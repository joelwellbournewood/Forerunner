import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { ForerunnerError, join, resolve } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { KillSwitch } from "../src/enforcement/killswitch.ts";
import { domainCovered, type SignedToken, TokenIssuer } from "../src/enforcement/token.ts";
import { harness, issue } from "./helpers.ts";

/**
 * Security review of the capability token (spec S.3, ADR 0004): forging, replay after a
 * revocation, scope widening on derive, expiry, and the kill switch's revocation. Every test
 * is an attack on the token and asserts the issuer's answer. A test marked `it.fails` is a
 * finding on the current code (see the comment above it); it starts passing once the fix is in,
 * at which point the `.fails` must be removed.
 */

/** A deep copy of a token so a mutation never touches the issuer's own record. */
function copy(t: SignedToken): SignedToken {
  return structuredClone(t);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ForerunnerError);
    expect((e as ForerunnerError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ForerunnerError(${code})`);
}

describe("capability tokens: forging", () => {
  it("every widened claim invalidates the signature: tools, paths, domains, secrets, budget, autonomy, owner, depth, expiry", () => {
    const h = harness();
    const t = issue(h, { allowedTools: ["echo"], autonomy: 1, budgetUsdMicro: 100 });
    const attacks: ((c: SignedToken["claims"]) => void)[] = [
      (c) => c.allowedTools.push("delete_repo"),
      (c) => c.allowedPaths.push(resolve(tmpdir())),
      (c) => c.allowedDomains.push("*.example.com"),
      (c) => c.grantedSecrets.push("github_pat"),
      (c) => {
        c.budgetUsdMicro = 100_000_000;
      },
      (c) => {
        c.autonomy = 4;
      },
      (c) => {
        c.planApproved = true;
      },
      (c) => {
        c.ownerHumanId = "someone-else";
      },
      (c) => {
        c.agentId = "someone-elses-agent";
      },
      (c) => {
        c.maxDepth = 99;
      },
      (c) => {
        c.expiresAt = "2999-01-01T00:00:00.000Z";
      },
      (c) => {
        c.id = "another-token-id";
      },
      // An extra claim the issuer never signed.
      (c) => {
        (c as unknown as Record<string, unknown>).extra = true;
      },
    ];
    for (const attack of attacks) {
      const forged = copy(t);
      attack(forged.claims);
      expectCode(() => h.tokens.verify(forged), "tool_not_allowed");
    }
    // The untouched token still verifies: the attacks above did not poison the issuer.
    expect(h.tokens.verify(t).id).toBe(t.claims.id);
  });

  it("re-ordering the claim keys without changing them is not a forgery (canonical signing)", () => {
    const h = harness();
    const t = issue(h);
    const reordered = {
      claims: Object.fromEntries(Object.entries(t.claims).reverse()) as SignedToken["claims"],
      signature: t.signature,
    };
    expect(h.tokens.verify(reordered).id).toBe(t.claims.id);
  });

  it("a token signed by another issuer (another process, another key) is refused", () => {
    const h = harness();
    const other = new TokenIssuer({ now: () => h.clock.now() });
    const foreign = other.issue({ ...issue(h).claims });
    expectCode(() => h.tokens.verify(foreign), "tool_not_allowed");
  });

  it("garbage, empty, odd-length, wrong-length and random signatures are all refused", () => {
    const h = harness();
    const t = issue(h);
    for (const signature of [
      "",
      "zz",
      "not hex at all",
      t.signature.slice(0, -2),
      `${t.signature}00`,
      randomBytes(32).toString("hex"),
      "0".repeat(64),
    ]) {
      expectCode(() => h.tokens.verify({ claims: t.claims, signature }), "tool_not_allowed");
    }
  });
});

describe("capability tokens: expiry and revocation", () => {
  it("expires at the exact instant and stays expired", () => {
    const h = harness();
    const now = h.clock.now();
    const t = issue(h, { expiresAt: new Date(now + 1_000).toISOString() });
    expect(h.tokens.verify(t, now + 999).id).toBe(t.claims.id);
    expectCode(() => h.tokens.verify(t, now + 1_000), "timeout");
    expectCode(() => h.tokens.verify(t, now + 10_000_000), "timeout");
  });

  it("the kill switch revokes the scope's tokens at once; other agents keep theirs; resume never un-revokes", async () => {
    const h = harness();
    const alice = issue(h, { runId: "a", sessionId: "sa", agentId: "alice" });
    const alice2 = issue(h, { runId: "a2", sessionId: "sa2", agentId: "alice" });
    const bob = issue(h, { runId: "b", sessionId: "sb", agentId: "bob" });
    const report = await h.kill.stop({ agentId: "alice" }, "test");
    expect(report.revokedTokens).toBe(2);
    expectCode(() => h.tokens.verify(alice), "killed");
    expectCode(() => h.tokens.verify(alice2), "killed");
    expect(h.tokens.verify(bob).id).toBe(bob.claims.id);
    // Lifting the freeze lets new sessions start; a revoked token is dead for good (no replay).
    h.kill.resume();
    expectCode(() => h.tokens.verify(alice), "killed");
    expect(h.tokens.claimsForRun("a")).toBeUndefined();
    expect(h.tokens.claimsForRun("b")?.id).toBe(bob.claims.id);
  });

  it("a global stop revokes every token except a protected (conversation) session's", async () => {
    const h = harness();
    const tokens = new TokenIssuer({ now: () => h.clock.now() });
    const ks = new KillSwitch(tokens);
    const { id: _id, issuedAt: _issuedAt, ...claims } = issue(h).claims;
    const work = tokens.issue({ ...claims, runId: "w", sessionId: "work" });
    const chat = tokens.issue({ ...claims, runId: "c", sessionId: "chat" });
    ks.register({
      agentId: claims.agentId,
      sessionId: "chat",
      controller: new AbortController(),
      label: "chat",
      protected: true,
    });
    await ks.stop("all", "test");
    expectCode(() => tokens.verify(work), "killed");
    expect(tokens.verify(chat).id).toBe(chat.claims.id);
  });

  // security finding (low): `issue` accepts any string as `expiresAt`; an unparseable value
  // gives NaN and `NaN <= now` is false, so the token never expires. Nothing in the runtime
  // passes one today, but the issuer is the last line and should refuse at issue (or treat
  // an unparseable expiry as already expired).
  it.fails("security finding: a token whose expiresAt is not a date is refused at issue or treated as expired", () => {
    const h = harness();
    let refused = false;
    try {
      const t = issue(h, { expiresAt: "never" });
      h.tokens.verify(t, h.clock.now() + 10 * 365 * 24 * 3_600_000);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe("capability tokens: derive never widens", () => {
  it("tools and secrets are the intersection; a child cannot name what the parent lacks", () => {
    const h = harness();
    const parent = issue(h, { allowedTools: ["read_file", "echo"], grantedSecrets: ["gh"] });
    const child = h.tokens.derive(parent, {
      runId: "child",
      allowedTools: ["read_file", "delete_repo", "use_secret"],
      grantedSecrets: ["gh", "aws", "anthropic_api_key"],
    });
    expect(child.claims.allowedTools).toEqual(["read_file"]);
    expect(child.claims.grantedSecrets).toEqual(["gh"]);
    expect(child.claims.depth).toBe(parent.claims.depth + 1);
    expect(child.claims.autonomy).toBe(parent.claims.autonomy);
    expect(child.claims.planApproved).toBe(parent.claims.planApproved);
    expect(child.claims.ownerHumanId).toBe(parent.claims.ownerHumanId);
    expect(child.claims.agentId).toBe(parent.claims.agentId);
  });

  it("paths: only roots inside a parent root survive (no .., no prefix look-alikes, no absolute escapes)", () => {
    const h = harness();
    const root = resolve(tmpdir(), "fr-sec-work");
    const parent = issue(h, { allowedPaths: [root] });
    const child = h.tokens.derive(parent, {
      runId: "child",
      allowedPaths: [
        join(root, "sub"),
        root,
        join(root, "..", "etc"),
        join(root, "sub", "..", ".."),
        `${root}2`,
        resolve(tmpdir()),
        ".",
        "",
      ],
    });
    expect(child.claims.allowedPaths).toEqual([join(root, "sub"), root]);
  });

  it("domains: a wildcard cannot widen, a look-alike is not inside, case does not matter", () => {
    const h = harness();
    const parent = issue(h, { allowedDomains: ["*.example.com", "api.other.org"] });
    const child = h.tokens.derive(parent, {
      runId: "child",
      allowedDomains: [
        "sub.example.com",
        "*.sub.example.com",
        "API.OTHER.ORG",
        "example.com",
        "evil-example.com",
        "example.com.evil.net",
        "*.com",
        "*",
        "other.org",
        "*.other.org",
        "127.0.0.1",
      ],
    });
    expect(child.claims.allowedDomains).toEqual([
      "sub.example.com",
      "*.sub.example.com",
      "api.other.org",
      "example.com",
    ]);
    expect(domainCovered("evil-example.com", ["*.example.com"])).toBe(false);
    expect(domainCovered("*.com", ["*.example.com"])).toBe(false);
    expect(domainCovered("example.com", ["example.com."])).toBe(false);
  });

  it("budget: the child gets the minimum; NaN and negative budgets are refused, infinity is clamped", () => {
    const h = harness();
    const parent = issue(h, { budgetUsdMicro: 1_000 });
    expect(
      h.tokens.derive(parent, { runId: "c", budgetUsdMicro: 1_000_000 }).claims.budgetUsdMicro,
    ).toBe(1_000);
    expect(h.tokens.derive(parent, { runId: "c", budgetUsdMicro: 10 }).claims.budgetUsdMicro).toBe(
      10,
    );
    expectCode(
      () => h.tokens.derive(parent, { runId: "c", budgetUsdMicro: Number.NaN }),
      "validation",
    );
    expectCode(() => h.tokens.derive(parent, { runId: "c", budgetUsdMicro: -1 }), "validation");
    expect(
      h.tokens.derive(parent, { runId: "c", budgetUsdMicro: Number.POSITIVE_INFINITY }).claims
        .budgetUsdMicro,
    ).toBe(1_000);
  });

  it("expiry: a later expiresAt is clamped to the parent's; an earlier one is kept", () => {
    const h = harness();
    const now = h.clock.now();
    const parent = issue(h, { expiresAt: new Date(now + 60_000).toISOString() });
    const later = h.tokens.derive(parent, {
      runId: "c",
      expiresAt: new Date(now + 600_000).toISOString(),
    });
    expect(later.claims.expiresAt).toBe(parent.claims.expiresAt);
    const earlier = h.tokens.derive(parent, {
      runId: "c2",
      expiresAt: new Date(now + 1_000).toISOString(),
    });
    expect(earlier.claims.expiresAt).toBe(new Date(now + 1_000).toISOString());
  });

  it("depth grows by one and stops at maxDepth: a sub-agent tree cannot go deeper than the grant", () => {
    const h = harness();
    const root = issue(h, { depth: 0, maxDepth: 2 });
    const c1 = h.tokens.derive(root, { runId: "c1" });
    const c2 = h.tokens.derive(c1, { runId: "c2" });
    expect(c2.claims.depth).toBe(2);
    expectCode(() => h.tokens.derive(c2, { runId: "c3" }), "depth_exceeded");
  });

  it("deriving from a tampered, revoked or expired parent is refused", () => {
    const h = harness();
    const parent = issue(h);
    const tampered = copy(parent);
    tampered.claims.allowedTools.push("delete_repo");
    expectCode(() => h.tokens.derive(tampered, { runId: "c" }), "tool_not_allowed");
    const expired = issue(h, {
      runId: "e",
      expiresAt: new Date(h.clock.now() + 10).toISOString(),
    });
    h.clock.advance(11);
    expectCode(() => h.tokens.derive(expired, { runId: "c" }), "timeout");
    h.tokens.revoke(parent.claims.id);
    expectCode(() => h.tokens.derive(parent, { runId: "c" }), "killed");
  });

  it("a wildcard tool list is refused at issue and cannot be smuggled in through derive", () => {
    const h = harness();
    expectCode(() => issue(h, { allowedTools: ["*"] }), "validation");
    const parent = issue(h, { allowedTools: ["echo"] });
    const child = h.tokens.derive(parent, { runId: "c", allowedTools: ["*", "echo"] });
    expect(child.claims.allowedTools).toEqual(["echo"]);
  });
});
