/**
 * @forerunner/e2e: the nine release scenarios (`scenarios/*.scenario.test.ts` on the scenario
 * world of `scenario-world.ts`, fake provider, no network) and the phase gate harnesses that run
 * end to end on the fake provider: the phase 3 critic calibration over the real eval sets with
 * the escalation ceiling, the phase 4 four simulated weeks of memory, the phase 5 simulated
 * week through the UI and the phone (`gate5-*.ts`), and the phase 7 UI change shipped as a
 * signed update to two installs, the broken build rolled back and the weekly model watch
 * adopted. See docs/maintainers/testing.md, "Gate harnesses" and
 * "Scenarios".
 */
export * from "./eval-defects.ts";
export * from "./four-weeks.ts";
export * from "./gate5-daemon.ts";
export * from "./gate5-pc.ts";
export * from "./gate5-phone.ts";
export * from "./gate5-week.ts";
export * from "./gate7-model-watch.ts";
export * from "./gate7-release.ts";
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
