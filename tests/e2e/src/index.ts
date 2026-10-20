/**
 * @forerunner/e2e: the nine release scenarios (`scenarios/`, live models inside the testing
 * budget) and the phase gate harnesses that run end to end on the fake provider: the phase 3
 * critic calibration over the real eval sets with the escalation ceiling, and the phase 4 four
 * simulated weeks of memory. See docs/maintainers/testing.md, "Gate harnesses".
 */
export * from "./eval-defects.ts";
export * from "./four-weeks.ts";
export * from "./world.ts";
