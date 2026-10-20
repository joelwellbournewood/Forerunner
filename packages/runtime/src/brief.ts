import { ForerunnerError } from "@forerunner/platform";
import { z } from "zod";

/**
 * Delegation brief (spec C). The runtime rejects briefs missing any field, so a principal agent
 * cannot delegate vaguely.
 */
export const DelegationBriefSchema = z.object({
  goal: z.string().trim().min(10, "goal must say what done looks like (at least 10 characters)"),
  contextLinks: z
    .array(z.string().trim().min(1))
    .min(1, "at least one context link (file, doc, task or URL)"),
  constraints: z
    .array(z.string().trim().min(1))
    .min(1, "at least one constraint (or 'none stated' explicitly)"),
  acceptanceCriteria: z
    .array(z.string().trim().min(5))
    .min(1, "at least one checkable acceptance criterion"),
  budgetUsdMicro: z.number().int().positive("budget must be a positive amount"),
  riskTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  specialist: z.string().trim().min(1),
  timeoutMs: z.number().int().positive().optional(),
  taskId: z.string().optional(),
  projectId: z.string().optional(),
});

export type DelegationBrief = z.infer<typeof DelegationBriefSchema>;

export function validateBrief(input: unknown): DelegationBrief {
  const r = DelegationBriefSchema.safeParse(input);
  if (!r.success) {
    const missing = r.error.issues.map((i) => `${i.path.join(".") || "brief"}: ${i.message}`);
    throw new ForerunnerError(
      "brief_incomplete",
      `delegation brief rejected: ${missing.join("; ")}`,
      {
        details: { issues: missing },
      },
    );
  }
  return r.data;
}

/** Render the brief as the specialist's first user message. */
export function renderBrief(b: DelegationBrief): string {
  return [
    `# Task brief`,
    `## Goal`,
    b.goal,
    `## Context`,
    ...b.contextLinks.map((c) => `- ${c}`),
    `## Constraints`,
    ...b.constraints.map((c) => `- ${c}`),
    `## Acceptance criteria (the critic checks each)`,
    ...b.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`),
    `## Limits`,
    `- Budget: USD ${(b.budgetUsdMicro / 1_000_000).toFixed(2)} (hard cap, enforced)`,
    `- Risk tier: ${b.riskTier}`,
    b.timeoutMs ? `- Timeout: ${Math.round(b.timeoutMs / 1000)} s` : "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
