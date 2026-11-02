// @vitest-environment node
import { eventAudience, PERSON_EVENT_TYPES } from "@forerunner/runtime/daemon/event-audience";
import { describe, expect, it } from "vitest";
import { fakeEventAudience } from "./fake-daemon.ts";

/**
 * The UI's stand-in daemon splits a session's log as the daemon does (validation rule 3;
 * design §3.7). The daemon's `eventView` passes each line's payload to `eventAudience`, whose
 * marks (`again`, `handedFrom`, `review`, `couldNot`, a killed run's outcome) make a person
 * line a detail; the stand-in called it without the payload, so a marked line stayed a person
 * line on every screen test (the system-text review of wave 3, leftover 39).
 */
describe("the fake daemon's log split follows the daemon's, payload marks included", () => {
  const marked: [string, Record<string, unknown>][] = [
    ["task.started", { again: true }],
    ["task.started", { again: true, handedFrom: "coder" }],
    ["task.finished", { review: true, couldNot: "no data file" }],
    ["task.finished", { review: true, again: true }],
    ["task.finished", { outcome: "killed" }],
    ["task.finished", { review: true }],
  ];

  it("every marked line is split as the daemon splits it", () => {
    for (const [type, payload] of marked)
      expect(fakeEventAudience(type, payload), `${type} ${JSON.stringify(payload)}`).toBe(
        eventAudience(type, payload),
      );
    // The marks matter: these are details on the daemon, not person lines.
    expect(fakeEventAudience("task.started", { again: true })).toBe("detail");
    expect(fakeEventAudience("task.finished", { outcome: "killed" })).toBe("detail");
    expect(fakeEventAudience("task.started", { again: true, handedFrom: "coder" })).toBe("person");
  });

  it("unmarked lines, a payload that is not an object and the stand-in's scripted lines", () => {
    for (const type of PERSON_EVENT_TYPES) expect(fakeEventAudience(type, {})).toBe("person");
    expect(fakeEventAudience("task.step", { step: 1 })).toBe("detail");
    expect(fakeEventAudience("task.started", null)).toBe("person");
    expect(fakeEventAudience("task.started", ["again"])).toBe("person");
    for (const type of ["task.claimed", "run.started", "run.finished", "escalation"])
      expect(fakeEventAudience(type, {})).toBe("person");
  });
});
