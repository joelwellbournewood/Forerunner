import { ForerunnerError } from "@forerunner/platform";
import type { DeviceRow } from "@forerunner/state";
import type { Actor, CommandSource, Risk } from "./types.ts";

/**
 * Confirmation by risk (spec Q, table "Confirmation by risk"):
 *   low    -> act at once, then state what was done, with undo;
 *   medium -> change card, then a "yes", a tap, or an email reply;
 *   high   -> change card, then confirmation in the app on a paired device, with biometric
 *             on the phone. A chat or email "yes" alone is never enough.
 * An agent changing its own limits (budget, autonomy, capability) always needs a human's
 * confirmation, whatever the risk (spec Q "limits still hold").
 */
export type ConfirmationDecision = "act" | "needs_yes" | "needs_device";

export interface PolicyState {
  /** The command changes a limit (CommandDef.limit). */
  limitChange: boolean;
}

export const PENDING_TTL_MS = 10 * 60 * 1000;

export type ConfirmationAnswer =
  | { kind: "yes" | "no" | "tap"; by: Actor; source?: CommandSource }
  | { kind: "email"; token: string; by: Actor }
  | { kind: "device"; deviceId: string; biometric: boolean; by?: Actor };

export class ConfirmationPolicy {
  decide(
    risk: Risk,
    actor: Actor,
    _source: CommandSource,
    state: PolicyState,
  ): ConfirmationDecision {
    if (risk === "high") return "needs_device";
    if (actor.kind === "agent" && state.limitChange) return "needs_yes";
    if (risk === "medium") return "needs_yes";
    return "act";
  }

  /**
   * Whether an answer satisfies a decision. Returns "confirmed" or "declined"; throws
   * ForerunnerError("approval_required") when the answer is not enough (an agent's yes, a
   * chat or email yes for a high-risk change, a phone without biometric, a revoked device).
   */
  check(
    decision: ConfirmationDecision,
    answer: ConfirmationAnswer,
    ctx: { humanId: string; emailToken: string; device?: DeviceRow | undefined },
  ): "confirmed" | "declined" {
    if (answer.kind === "no") return "declined";
    if (decision === "act") return "confirmed";
    if (answer.kind === "device") {
      const device = ctx.device;
      if (!device) {
        throw new ForerunnerError("approval_required", "unknown device; pair it first", {
          details: { deviceId: answer.deviceId },
        });
      }
      if (device.revoked) {
        throw new ForerunnerError("approval_required", "this device was revoked", {
          details: { deviceId: device.id },
        });
      }
      if (device.owner_human_id !== ctx.humanId) {
        throw new ForerunnerError("approval_required", "the device belongs to someone else", {
          details: { deviceId: device.id },
        });
      }
      // Two kinds of device confirm a high-risk change, and no other: the desktop alone (the
      // PC the human sits at, which the daemon names for itself after the state service
      // checked the phone), and a phone with its biometric. A web page (ADR 0034: it always
      // signs biometric=0, its high-risk answers go through the state service's re-entered
      // code) and a runner have no second factor to bring, so a `biometric: true` they present
      // is not believed; a device kind this policy does not know is refused the same way. The
      // rule holds for every decision a device answers, as the biometric rule always did.
      if (device.kind !== "desktop") {
        if (device.kind !== "phone") {
          throw new ForerunnerError(
            "approval_required",
            `a ${device.kind} device cannot confirm a high-risk change; confirm on the desktop or on the phone with biometric`,
            { details: { deviceId: device.id, kind: device.kind } },
          );
        }
        if (!answer.biometric) {
          throw new ForerunnerError(
            "approval_required",
            "a high-risk change needs biometric confirmation on the phone",
            { details: { deviceId: device.id, kind: device.kind } },
          );
        }
      }
      if (answer.by && (answer.by.kind !== "human" || answer.by.id !== ctx.humanId)) {
        throw new ForerunnerError(
          "approval_required",
          "only the human the change is for can confirm it",
          { details: { by: answer.by, deviceId: device.id } },
        );
      }
      return "confirmed";
    }
    if (decision === "needs_device") {
      throw new ForerunnerError(
        "approval_required",
        "a chat or email yes alone is not enough for a high-risk change; confirm in the app on a paired device",
        { details: { answer: answer.kind } },
      );
    }
    // needs_yes
    if (answer.by.kind !== "human") {
      throw new ForerunnerError("approval_required", "only a human can confirm this change", {
        details: { actor: answer.by },
      });
    }
    if (answer.by.id !== ctx.humanId) {
      // A yes from another human (shared store, shared project) never confirms someone's change.
      throw new ForerunnerError(
        "approval_required",
        "only the human the change is for can confirm it",
        { details: { by: answer.by.id } },
      );
    }
    if (answer.kind === "email") {
      if (answer.token !== ctx.emailToken) {
        throw new ForerunnerError("approval_required", "the email reply token does not match", {
          details: { token: answer.token.slice(0, 4) },
        });
      }
      return "confirmed";
    }
    return "confirmed";
  }
}

export function riskNeedsDevice(risk: Risk): boolean {
  return risk === "high";
}
