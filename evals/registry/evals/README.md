# Golden eval sets

One directory per specialist, one JSON file per task: `evals/<specialist>/NNN-<slug>.json`.
The schema is `EvalTaskSchema` in `evals/src/types.ts` (the repository copy of the registry
lives next to the runner; in the `forerunner-registry` repository the layout is the same).
`pnpm vitest run --project unit evals/test` validates every file and runs the reference
solutions through the checks, so a task that cannot pass its own checks never lands.

## Why these exist

- **Activation gate** (spec C): a specialist goes live only after human approval and a passing
  eval set. The ten starting specialists are active by decision; new ones ship with at least
  10 tasks and must pass 90%.
- **Critic calibration** (spec H, phase 3 gate): every task has a `seeded_defect` variant. The
  critic must catch at least 80% of seeded defects and accept at least 90% of clean results.
  The expected-output driver (`expectedOutputDriver` in `evals/src/runner.ts`) produces both
  variants without a model.
- **Model watch** (spec D): new model candidates and lower effort levels are measured on these
  sets before a switch is proposed.

## Task file

```json
{
  "id": "coder-001",
  "specialist": "coder",
  "title": "Add a clamp function with tests",
  "brief": {
    "goal": "...", "contextLinks": ["src/math.ts"], "constraints": ["..."],
    "acceptanceCriteria": ["..."], "budgetUsdMicro": 500000, "riskTier": 1
  },
  "setup": { "files": { "package.json": "...", "src/math.ts": "..." } },
  "checks": [
    { "kind": "file_contains", "path": "src/math.ts", "text": "export function clamp" },
    { "kind": "command_exit0", "argv": ["node", "--experimental-strip-types", "--test", "test/grader.test.ts"] },
    { "kind": "rubric", "criteria": ["..."] }
  ],
  "grader_files": { "test/grader.test.ts": "..." },
  "expected_files": { "src/math.ts": "...", "test/clamp.test.ts": "..." },
  "expected_clean_output": "one line for humans",
  "seeded_defect": { "description": "...", "how_to_detect": "...", "files": { "src/math.ts": "..." } },
  "tags": ["typescript", "tests"]
}
```

| Field | Meaning |
| --- | --- |
| `id` | `<specialist>-NNN`; NNN matches the file name. Unique within the set. |
| `brief` | The delegation brief minus `specialist`/ids (the runner adds them). Same rules as `validateBrief` in the runtime: goal, context links, constraints, checkable acceptance criteria, budget in USD micro-units, risk tier. |
| `setup.files` | Fixture files written into a fresh task directory before the specialist starts. Relative forward-slash paths, no `..`. |
| `checks` | Graded in order. `file_exists`, `file_contains`, `regex` (`path` omitted = the final message; flags go in `flags`, not inline), `command_exit0` (argv array, never a shell string; `node` is always available), `json_path` (RFC 6901 pointer, optional `equals`, `exists: false` for absence), `rubric` (criteria for the critic; the runner reports `needs_model`). |
| `grader_files` | Written after the specialist finishes and before checks run. Hidden tests live here so the specialist cannot pass by writing weak tests. |
| `expected_files` | The reference solution. The expected-output driver writes it; it must pass every mechanical check. |
| `expected_final_text` | Reference final message when checks grade the message instead of files. |
| `expected_clean_output` | One line for humans reading reports. |
| `seeded_defect` | A planted defect: `description`, `how_to_detect`, and `files` and/or `final_text` that overlay the expected output. The overlay must fail at least one mechanical check (the test suite enforces this) and `how_to_detect` tells the critic calibration reviewer where to look. |
| `tags` | Free-form, used for reports and filtering. |

Pass or fail is decided by the mechanical checks. A task whose mechanical checks all pass and
that has a rubric is reported `needs_model`; the critic grades it and the calibration gate
counts its verdict. `passRate` is `passed / (passed + failed)`.

## Adding a task

1. Copy the closest existing file, give it the next number and a slug, and set `id`.
2. Write the brief as a principal agent would: a goal that says what done looks like,
   acceptance criteria the checks can verify.
3. Write fixtures that are small and deterministic. Coder fixtures use `node:test` with
   `node --experimental-strip-types --test <file>`; no enums, namespaces or constructor
   parameter properties (type stripping does not support them). Researcher fixtures are
   short fictional documents; questions are answerable from them alone.
4. Put the reference solution in `expected_files` and the hidden tests in `grader_files`.
5. Plant one realistic defect in `seeded_defect.files` (an off-by-one, a swapped role, an
   invented figure) and say how to detect it. Keep it subtle enough that a lazy review would
   miss it and clear enough that a careful one would not.
6. Run `pnpm vitest run --project unit evals/test`. The suite loads both sets, validates the
   schema, runs the clean variant (must pass every mechanical check) and the seeded variant
   (must fail at least one).
7. Prompts and tasks are versioned together: when a specialist's prompt changes, re-run its
   set and record the pass rate with the new `prompt_version` in `docs/status/gates.md`.

Nothing in a fixture may look like a credential. If a fixture must contain a token-shaped
string, build it by concatenation and mark the line `// not-a-secret`.
