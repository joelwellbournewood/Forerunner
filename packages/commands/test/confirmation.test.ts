import { isForerunnerError } from "@forerunner/platform";
import type { DeviceRow } from "@forerunner/state";
import { describe, expect, it } from "vitest";
import { type Actor, ConfirmationPolicy, type Risk } from "../src/index.ts";

const human: Actor = { kind: "human", id: "h1" };
const agent: Actor = { kind: "agent", id: "a1" };
const policy = new ConfirmationPolicy();

function device(kind: DeviceRow["kind"], extra: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: `d-${kind}`,
    created_at: "",
    updated_at: "",
    author_agent: null,
    author_human: null,
    version: 1,
    owner_human_id: "h1",
    name: kind,
    platform: "x",
    public_key: ["pk", kind].join("-"), // not-a-secret
    kind,
    last_seen: null,
    revoked: false,
    revoked_at: null,
    paired_at: "",
    push_token: null,
    ...extra,
  };
}

function refused(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(isForerunnerError(e, "approval_required")).toBe(true);
    return (e as Error).message;
  }
  throw new Error("expected a refusal");
}

describe("ConfirmationPolicy.decide (spec Q risk table)", () => {
  it.each<[Risk, Actor, string]>([
    ["low", human, "act"],
    ["medium", human, "needs_yes"],
    ["high", human, "needs_device"],
    ["low", agent, "act"],
    ["medium", agent, "needs_yes"],
    ["high", agent, "needs_device"],
  ])("%s risk by a %o -> %s", (risk, actor, expected) => {
    expect(policy.decide(risk, actor, "chat", { limitChange: false })).toBe(expected);
  });

  it("an agent changing its own limits needs a human whatever the risk", () => {
    expect(policy.decide("low", agent, "api", { limitChange: true })).toBe("needs_yes");
    expect(policy.decide("medium", agent, "api", { limitChange: true })).toBe("needs_yes");
    expect(policy.decide("high", agent, "api", { limitChange: true })).toBe("needs_device");
    expect(policy.decide("low", human, "ui", { limitChange: true })).toBe("act");
  });
});

describe("ConfirmationPolicy.check", () => {
  const ctx = { humanId: "h1", emailToken: "FR-abc123" };

  it("medium: a human yes, tap or matching email reply confirms; no declines", () => {
    expect(policy.check("needs_yes", { kind: "yes", by: human }, ctx)).toBe("confirmed");
    expect(policy.check("needs_yes", { kind: "tap", by: human }, ctx)).toBe("confirmed");
    expect(policy.check("needs_yes", { kind: "email", token: "FR-abc123", by: human }, ctx)).toBe(
      "confirmed",
    );
    expect(policy.check("needs_yes", { kind: "no", by: human }, ctx)).toBe("declined");
  });

  it("medium: an agent's yes and a wrong email token are refused", () => {
    expect(refused(() => policy.check("needs_yes", { kind: "yes", by: agent }, ctx))).toMatch(
      /only a human/,
    );
    expect(
      refused(() => policy.check("needs_yes", { kind: "email", token: "FR-zzz", by: human }, ctx)),
    ).toMatch(/token/);
  });

  it("high: a chat or email yes alone is not enough", () => {
    expect(refused(() => policy.check("needs_device", { kind: "yes", by: human }, ctx))).toMatch(
      /not enough .* paired device/,
    );
    expect(refused(() => policy.check("needs_device", { kind: "tap", by: human }, ctx))).toMatch(
      /paired device/,
    );
    expect(
      refused(() =>
        policy.check("needs_device", { kind: "email", token: "FR-abc123", by: human }, ctx),
      ),
    ).toMatch(/paired device/);
  });

  it("high: a phone needs biometric, a desktop does not, revoked or foreign devices never do", () => {
    const phone = device("phone");
    expect(
      refused(() =>
        policy.check(
          "needs_device",
          { kind: "device", deviceId: phone.id, biometric: false },
          { ...ctx, device: phone },
        ),
      ),
    ).toMatch(/biometric/);
    expect(
      policy.check(
        "needs_device",
        { kind: "device", deviceId: phone.id, biometric: true },
        { ...ctx, device: phone },
      ),
    ).toBe("confirmed");
    const desktop = device("desktop");
    expect(
      policy.check(
        "needs_device",
        { kind: "device", deviceId: desktop.id, biometric: false },
        { ...ctx, device: desktop },
      ),
    ).toBe("confirmed");
    const revoked = device("phone", { revoked: true });
    expect(
      refused(() =>
        policy.check(
          "needs_device",
          { kind: "device", deviceId: revoked.id, biometric: true },
          { ...ctx, device: revoked },
        ),
      ),
    ).toMatch(/revoked/);
    const foreign = device("phone", { owner_human_id: "someone-else" });
    expect(
      refused(() =>
        policy.check(
          "needs_device",
          { kind: "device", deviceId: foreign.id, biometric: true },
          { ...ctx, device: foreign },
        ),
      ),
    ).toMatch(/someone else/);
    expect(
      refused(() =>
        policy.check("needs_device", { kind: "device", deviceId: "ghost", biometric: true }, ctx),
      ),
    ).toMatch(/unknown device/);
  });

  it("a device confirmation also satisfies a medium decision; act accepts anything but no", () => {
    const desktop = device("desktop");
    expect(
      policy.check(
        "needs_yes",
        { kind: "device", deviceId: desktop.id, biometric: false },
        { ...ctx, device: desktop },
      ),
    ).toBe("confirmed");
    expect(policy.check("act", { kind: "yes", by: agent }, ctx)).toBe("confirmed");
    expect(policy.check("act", { kind: "no", by: human }, ctx)).toBe("declined");
  });
});

describe("ConfirmationPolicy.check: the answer must come from the human the change is for", () => {
  const ctx = { humanId: "h1", emailToken: "FR-abc123" };
  const other: Actor = { kind: "human", id: "h2" };

  it("medium: another human's yes, tap or email reply is refused", () => {
    expect(refused(() => policy.check("needs_yes", { kind: "yes", by: other }, ctx))).toMatch(
      /the human the change is for/,
    );
    expect(refused(() => policy.check("needs_yes", { kind: "tap", by: other }, ctx))).toMatch(
      /the human the change is for/,
    );
    expect(
      refused(() =>
        policy.check("needs_yes", { kind: "email", token: "FR-abc123", by: other }, ctx),
      ),
    ).toMatch(/the human the change is for/);
  });

  it("high: a device answer that names another human is refused even on the owner's device", () => {
    const desktop = device("desktop");
    expect(
      refused(() =>
        policy.check(
          "needs_device",
          { kind: "device", deviceId: desktop.id, biometric: false, by: other },
          { ...ctx, device: desktop },
        ),
      ),
    ).toMatch(/the human the change is for/);
    expect(
      policy.check(
        "needs_device",
        { kind: "device", deviceId: desktop.id, biometric: false, by: human },
        { ...ctx, device: desktop },
      ),
    ).toBe("confirmed");
  });
});
