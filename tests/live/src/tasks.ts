/**
 * The three small coder tasks of the phase 1 live halves (spec, Build order: "the same session
 * runs once on a subscription and once on an API key"), in one place so both halves seed
 * exactly the same work, plus the long task the kill-switch case starts and stops.
 */
export interface LiveTaskSpec {
  title: string;
  outcome: string;
  acceptanceCriteria: string[];
}

export const PHASE1_TASKS: readonly LiveTaskSpec[] = [
  {
    title: "Add a greet function",
    outcome:
      "src/greet.ts exports greet(name: string): string that returns the text Hello, <name>! and test/greet.test.ts covers it with node:test",
    acceptanceCriteria: [
      "src/greet.ts exports greet(name: string): string",
      'greet("Ada") returns "Hello, Ada!"',
      "test/greet.test.ts exists, imports greet from ../src/greet.ts and asserts the example with node:assert/strict and node:test",
    ],
  },
  {
    title: "Add a clamp function",
    outcome:
      "src/clamp.ts exports clamp(n: number, min: number, max: number): number that limits n to [min, max] and throws a RangeError when min > max, with test/clamp.test.ts",
    acceptanceCriteria: [
      "src/clamp.ts exports clamp(n: number, min: number, max: number): number",
      "clamp returns min when n < min, max when n > max, and n otherwise",
      "clamp throws RangeError when min > max",
      "test/clamp.test.ts exists and covers the three cases with node:test and node:assert/strict",
    ],
  },
  {
    title: "Start a changelog",
    outcome:
      "CHANGELOG.md exists with an Unreleased heading and one bullet that names the add function as the first feature",
    acceptanceCriteria: [
      "CHANGELOG.md exists at the repository root",
      "CHANGELOG.md has a heading that contains the word Unreleased",
      "under that heading one bullet names the add function",
    ],
  },
];

export const PHASE1_KILL_TASK: LiveTaskSpec = {
  title: "Add a word list",
  outcome:
    "src/words.ts exports WORDS, an array of 300 distinct lowercase English words, and isWord(w: string): boolean",
  acceptanceCriteria: [
    "src/words.ts exports WORDS: readonly string[] with 300 distinct lowercase words",
    "src/words.ts exports isWord(w: string): boolean",
  ],
};

/** The caps both halves run under: USD 0.40 per task, USD 3 per session (micro-USD). */
export const PHASE1_TASK_CAP_USD_MICRO = 400_000;
export const PHASE1_SESSION_CAP_USD_MICRO = 3_000_000;
