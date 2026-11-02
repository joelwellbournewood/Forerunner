// What a journey names the project it creates, when the walker gives no --project: the brief's
// first words, as a person names a project after what it is, then the time, so a second walk on
// the same bench gets a name of its own. Before (live B, 2026-11-02), intake.cjs named every
// project "Quote page HH:MM:SS" whatever the brief.
"use strict";

/** "A todo list" at 16:45:30 -> "A todo list 16:45:30"; at most 40 characters before the time. */
function projectNameFor(brief, now = new Date()) {
  const first = String(brief ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  let name = (first ?? "").replace(/\s+/g, " ");
  if (name.length > 40) {
    const cut = name.slice(0, 41);
    const space = cut.lastIndexOf(" ");
    name = space > 10 ? cut.slice(0, space) : name.slice(0, 40);
  }
  name = name.replace(/[\s.,;:!?…-]+$/, "") || "Project";
  return `${name} ${now.toISOString().slice(11, 19)}`;
}

module.exports = { projectNameFor };
