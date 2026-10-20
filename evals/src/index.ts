/**
 * @forerunner/evals: golden task sets per specialist and the eval runner. Task files live in the
 * registry (`evals/registry/evals/<specialist>/`); this package validates them, prepares fixture
 * directories, runs a driver (a real specialist or the expected-output fake) and grades the
 * result with mechanical checks, leaving rubric checks to the critic.
 */
export * from "./checks.ts";
export * from "./runner.ts";
export * from "./types.ts";
