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

/**
 * d1109-selftasks-run, run C (ST-1, ADR 0119; the owner, 2026-11-09: "The agent changing its own
 * tasks with the autonomy level deciding when it asks first. That's also good.", and the session
 * lead's notes of 16:35 UTC: "The agent changes its own tasks without asking from Standard up;
 * at Advisor and Assisted it asks first on one card"). The agent's bounded fixes of its own task
 * list are their own class, `plan_fix`: free from Standard (level 2) up, asked first at Advisor
 * and Assisted (also once the plan is approved), and a human's yes frees it at every level.
 */
describe("d1109-selftasks-run, run C: plan_fix (ST-1)", () => {
  it("asks first at Advisor and Assisted, also with the plan approved, and is free from Standard up", () => {
    expect(decideAutonomy("plan_fix", { level: 0 })).toBe("approval_required");
    expect(decideAutonomy("plan_fix", { level: 0, planApproved: true })).toBe("approval_required");
    expect(decideAutonomy("plan_fix", { level: 1 })).toBe("approval_required");
    expect(decideAutonomy("plan_fix", { level: 1, planApproved: true })).toBe("approval_required");
    expect(decideAutonomy("plan_fix", { level: 2 })).toBe("allow");
    expect(decideAutonomy("plan_fix", { level: 3 })).toBe("allow");
    expect(decideAutonomy("plan_fix", { level: 4 })).toBe("allow");
  });

  it("a yes frees it at every level", () => {
    for (const level of levels)
      expect(decideAutonomy("plan_fix", { level, actionApproved: true })).toBe("allow");
  });

  it("every other row of the table answers as before", () => {
    const table: Record<string, string[]> = {};
    for (const a of [
      "read",
      "routine_reversible",
      "non_routine",
      "merge_pr",
      "deploy_staging",
      "deploy_production",
      "external_send",
    ] as ActionClass[])
      table[a] = levels.map((level) => decideAutonomy(a, { level }));
    expect(table).toEqual({
      read: ["allow", "allow", "allow", "allow", "allow"],
      routine_reversible: ["approval_required", "approval_required", "allow", "allow", "allow"],
      non_routine: [
        "approval_required",
        "approval_required",
        "approval_required",
        "allow",
        "allow",
      ],
      merge_pr: Array(5).fill("approval_required"),
      deploy_staging: [
        "approval_required",
        "approval_required",
        "approval_required",
        "allow",
        "allow",
      ],
      deploy_production: [
        "approval_required",
        "approval_required",
        "approval_required",
        "approval_required",
        "allow",
      ],
      external_send: [
        "approval_required",
        "approval_required",
        "approval_required",
        "approval_required",
        "allow",
      ],
    });
  });
});
