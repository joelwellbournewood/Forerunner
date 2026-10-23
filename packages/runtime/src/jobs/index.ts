/**
 * Monthly jobs on the session scheduler (ADR 0060): the critic calibration (spec H.7) and the
 * handover test (spec P.15). Both are local jobs routed before the sync gate, like the model
 * watch; the composition root registers their schedules from the settings before every tick.
 */
export * from "./calibration.ts";
export * from "./cli.ts";
export * from "./handover.ts";
export * from "./handover-seed.ts";
