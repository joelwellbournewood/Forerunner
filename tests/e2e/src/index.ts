/**
 * @forerunner/e2e: the nine release scenarios (`scenarios/*.scenario.test.ts` on the scenario
 * world of `scenario-world.ts`, fake provider, no network) and the phase gate harnesses that run
 * end to end on the fake provider: the phase 3 critic calibration over the real eval sets with
 * the escalation ceiling, and the phase 4 four simulated weeks of memory. See
 * docs/maintainers/testing.md, "Gate harnesses" and "Scenarios".
 */
export * from "./eval-defects.ts";
export * from "./four-weeks.ts";
export * from "./scenario-capabilities.ts";
export * from "./scenario-cloud-runner.ts";
export * from "./scenario-commands.ts";
export * from "./scenario-handover.ts";
export * from "./scenario-mail.ts";
export * from "./scenario-notify.ts";
export * from "./scenario-phone.ts";
export * from "./scenario-scripts.ts";
export * from "./scenario-support.ts";
export * from "./scenario-update.ts";
export * from "./scenario-voice.ts";
export * from "./scenario-world.ts";
export * from "./world.ts";
