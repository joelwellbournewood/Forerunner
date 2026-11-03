import { describe, expect, it } from "vitest";
import {
  type ActionClass,
  type AutonomyLevel,
  decideAutonomy,
} from "../src/enforcement/autonomy.ts";

const levels: AutonomyLevel[] = [0, 1, 2, 3, 4];

describe("autonomy policy", () => {
  it("always needs a human for destructive, financial, credential, permission and capability actions", () => {
    for (const level of levels) {
      for (const a of [
        "destructive",
        "financial",
        "credential",
        "permission_change",
        "capability_grant",
      ] as ActionClass[]) {
        expect(decideAutonomy(a, { level, planApproved: true })).toBe("approval_required");
        expect(decideAutonomy(a, { level, actionApproved: true })).toBe("allow");
      }
    }
  });

  it("level 0 proposes only; reads are always fine", () => {
    expect(decideAutonomy("routine_reversible", { level: 0 })).toBe("approval_required");
    expect(decideAutonomy("read", { level: 0 })).toBe("allow");
  });

  it("level 1 runs routine actions only after the plan is approved", () => {
    expect(decideAutonomy("routine_reversible", { level: 1 })).toBe("approval_required");
    expect(decideAutonomy("routine_reversible", { level: 1, planApproved: true })).toBe("allow");
    expect(decideAutonomy("merge_pr", { level: 1, planApproved: true })).toBe("approval_required");
  });

  it("level 2 frees routine reversible work, asks for the rest", () => {
    expect(decideAutonomy("routine_reversible", { level: 2 })).toBe("allow");
    expect(decideAutonomy("non_routine", { level: 2 })).toBe("approval_required");
    expect(decideAutonomy("merge_pr", { level: 2 })).toBe("approval_required");
    expect(decideAutonomy("deploy_staging", { level: 2 })).toBe("approval_required");
  });

  it("level 3 also deploys to staging; no level frees a merge, the project's merge mode or the person's Merge approves each one", () => {
    // The owner's decision of 2026-11-02 (merge-in-app): merging is its own per-project setting,
    // separate from level 3 (before: level 3 freed merge_pr, spec J.9).
    expect(decideAutonomy("merge_pr", { level: 3 })).toBe("approval_required");
    expect(decideAutonomy("merge_pr", { level: 4 })).toBe("approval_required");
    expect(decideAutonomy("merge_pr", { level: 2, actionApproved: true })).toBe("allow");
    expect(decideAutonomy("deploy_staging", { level: 3 })).toBe("allow");
    expect(decideAutonomy("deploy_production", { level: 3 })).toBe("approval_required");
    expect(decideAutonomy("external_send", { level: 3 })).toBe("approval_required");
  });

  it("level 4 does everything except the always-human classes", () => {
    expect(decideAutonomy("deploy_production", { level: 4 })).toBe("allow");
    expect(decideAutonomy("external_send", { level: 4 })).toBe("allow");
    expect(decideAutonomy("destructive", { level: 4 })).toBe("approval_required");
  });
});
