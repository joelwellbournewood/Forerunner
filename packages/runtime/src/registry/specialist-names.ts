/**
 * The names a plan may use for a specialist, and the registry entry each one means (U-014).
 * The project manager's prompt, and people, say "ops" or "data analyst"; the registry's
 * entries are `ops-deploy` and `data-analyst`. A name the registry does not have is looked up
 * here before the task is given up on.
 */
export const SPECIALIST_ALIASES: Readonly<Record<string, string>> = {
  ops: "ops-deploy",
  deploy: "ops-deploy",
  devops: "ops-deploy",
  deployer: "ops-deploy",
  writer: "writer-marketing",
  marketing: "writer-marketing",
  copywriter: "writer-marketing",
  "data-analysis": "data-analyst",
  analyst: "data-analyst",
  migration: "migration-specialist",
  migrator: "migration-specialist",
  "science-evaluation": "science-evaluator",
  scientist: "science-evaluator",
  developer: "coder",
  engineer: "coder",
  programmer: "coder",
  test: "tester",
  qa: "tester",
  research: "researcher",
  review: "reviewer",
  design: "designer",
  // U-022: a task only the person can do (answer questions) is planned for "person"; it is no
  // registry entry and never runs a specialist (`session/person-questions.ts`).
  human: "person",
  owner: "person",
  "the-person": "person",
  "the-human": "person",
};

/** `"Data Analyst"` → `"data-analyst"`, then the alias table: `"ops"` → `"ops-deploy"`. */
export function canonicalSpecialistName(name: string): string {
  const key = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  return SPECIALIST_ALIASES[key] ?? key;
}
