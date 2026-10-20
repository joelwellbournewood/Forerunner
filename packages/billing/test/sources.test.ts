import { ForerunnerError } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  assertBillingSource,
  assertCredentialRef,
  FakeProbe,
  isEstimatedKind,
  ledgerKindFor,
  makeBillingSource,
} from "../src/sources.ts";

// Built at runtime so the repository secret scan never sees a credential shape.
const fakeKey = ["sk-ant-", "api03-", "abcdefghijklmnopqrstuvwxyz0123456789"].join(""); // not-a-secret

describe("billing sources", () => {
  it("maps source kinds to ledger kinds", () => {
    expect(ledgerKindFor("subscription")).toBe("subscription");
    expect(ledgerKindFor("plan_credits")).toBe("plan_credits");
    expect(ledgerKindFor("api_key")).toBe("api");
    expect(ledgerKindFor("fake")).toBe("api");
    expect(isEstimatedKind("subscription")).toBe(true);
    expect(isEstimatedKind("api_key")).toBe(false);
  });

  it("accepts reference names and rejects anything shaped like a credential", () => {
    expect(assertCredentialRef("anthropic_api_key")).toBe("anthropic_api_key");
    expect(assertCredentialRef("secret:github_pat")).toBe("secret:github_pat");
    expect(() => assertCredentialRef(fakeKey)).toThrow(ForerunnerError);
    try {
      assertCredentialRef(fakeKey);
    } catch (e) {
      const err = e as ForerunnerError;
      expect(err.message).not.toContain("api03");
      expect(JSON.stringify(err.details)).not.toContain("api03");
    }
    expect(() => assertCredentialRef("")).toThrow(ForerunnerError);
    expect(() => assertCredentialRef("a".repeat(65))).toThrow(ForerunnerError);
    expect(() => assertCredentialRef("has space")).toThrow(ForerunnerError);
  });

  it("validates a source record", () => {
    const s = makeBillingSource({ id: "s1", kind: "api_key", humanId: "alice" });
    expect(s).toMatchObject({ enabled: true, priority: 100, limits: {}, label: "api_key s1" });
    expect(() => assertBillingSource({ ...s, limits: { planShareCap: 2 } })).toThrow(
      ForerunnerError,
    );
    expect(() => assertBillingSource({ ...s, extra: 1 })).toThrow(/invalid billing source/);
    expect(() =>
      makeBillingSource({ id: "s2", kind: "api_key", humanId: "alice", credentialRef: fakeKey }),
    ).toThrow(ForerunnerError);
  });

  it("FakeProbe answers available by default and records calls", async () => {
    const probe = new FakeProbe({ s1: { available: false, reason: "expired" } });
    const s1 = makeBillingSource({ id: "s1", kind: "subscription", humanId: "alice" });
    const s2 = makeBillingSource({ id: "s2", kind: "api_key", humanId: "alice" });
    expect(await probe.status(s1)).toEqual({ available: false, reason: "expired" });
    expect(await probe.status(s2)).toEqual({ available: true });
    probe.set("s2", { available: true, planUsageShare: 0.3 });
    expect((await probe.status(s2)).planUsageShare).toBe(0.3);
    expect(probe.calls).toEqual(["s1", "s2", "s2"]);
  });
});
