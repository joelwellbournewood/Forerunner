import type { JsonObject, ProjectRow } from "@forerunner/state";
import { JOINED_FROM_KEY } from "../sources/repository-words.ts";

/**
 * Make one project (d1109-onerepo-join, ADR 0117 amended 2026-11-16): the words and the settings
 * readers of a join, apart from `join-preview.ts` so the command registry and the UI's fake
 * daemon say the same sentences without the store or the git host. Every sentence follows design
 * section 5: one sentence read at a glance, names in quotes, no ids, CHF only.
 *
 * The owner's words (2026-11-09): "There should not be 2 projects in one repo. If there are
 * multiple people and agents, and even if they are working on different parts of a bigger
 * project, they should be working on one project. Make it such that multiple projects are not
 * done on one repo, in an intelligent way."
 */

/** The settings key of a project closed into another (`{ project, name, at }`). */
export const JOINED_INTO_KEY = "joined_into";
/** The links a closed project had, kept for its Undo (its `repos` is emptied). */
export const WAS_LINKED_KEY = "was_linked";

function settingsOf(project: Pick<ProjectRow, "settings">): JsonObject {
  const s = project.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

/** Where a closed project's work went: the kept project, its name then, and when. */
export interface JoinedInto {
  project: string;
  name: string;
  at: string;
}

/** A project closed into another by Make one project, or null for any other. */
export function joinedIntoOf(project: Pick<ProjectRow, "status" | "settings">): JoinedInto | null {
  if (project.status !== "archived") return null;
  const raw = settingsOf(project)[JOINED_INTO_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as JsonObject;
  if (typeof o.project !== "string" || !o.project) return null;
  return {
    project: o.project,
    name: typeof o.name === "string" ? o.name : "",
    at: typeof o.at === "string" ? o.at : "",
  };
}

/** The ids of the projects closed into this one (its `joined_from`), oldest first. */
export function joinedFromOf(project: Pick<ProjectRow, "settings">): string[] {
  const raw = settingsOf(project)[JOINED_FROM_KEY];
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && !!x) : [];
}

/** "3 Nov" in the person's time zone (UTC when it is not known). */
export function joinDayWords(iso: string, timezone?: string | null): string {
  let zone = timezone || "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short" })
    .format(new Date(t))
    .replace(",", "");
}

/** Names in quotes, joined as a person writes a list: '"A"', '"A" and "B"', '"A", "B" and "C"'. */
export function quotedList(names: readonly string[]): string {
  const q = names.map((n) => `"${n}"`);
  if (q.length <= 1) return q[0] ?? "";
  return `${q.slice(0, -1).join(", ")} and ${q[q.length - 1]}`;
}

/**
 * OJ-01: the Overview line of a project that shares its repository or folder with another project
 * on this computer (made before one repository was one project): '"Site" and "Kite club" both
 * work in o/site.' The projects oldest first, so both Overviews say the same.
 */
export function sharedLinkSentence(
  names: readonly string[],
  link: { kind: "repo" | "folder"; locator: string },
): string {
  const where = link.kind === "repo" ? link.locator : "the same folder";
  return `${quotedList(names)} ${names.length === 2 ? "both" : "all"} work in ${where}.`;
}

/** OJ-01: what Make one project does, said with the button (at most 100 characters). */
export const MAKE_ONE_EXPLAIN =
  "You choose which to keep; the other's tasks, plan and cards move into it.";

/** OJ-06: the status sentence of a project closed into another: 'Joined into "Site" on 9 Nov.' */
export function joinedIntoSentence(into: JoinedInto, timezone?: string | null): string {
  const day = into.at ? joinDayWords(into.at, timezone) : "";
  return `Joined into "${into.name}"${day ? ` on ${day}` : ""}.`;
}

/** OJ-06: the kept project's Overview line: 'Includes the work of "Kite club".' */
export function includesWorkSentence(names: readonly string[]): string {
  return `Includes the work of ${quotedList(names)}.`;
}

/**
 * OJ-06: what a project closed into another answers to new work (a task, a note for the next
 * session, a setting, a change from its chat): '"Kite club" joined "Site", so its work runs there.'
 * The same sentence answers a start (`removedProjectRefusal` in @forerunner/commands).
 */
export function joinedRefusalSentence(name: string, into: string): string {
  return `"${name}" joined "${into}", so its work runs there.`;
}

/**
 * OJ-06: the commands a project closed into another (or removed, W15B-02) still answers: reading
 * its summary, a stop (the safe direction), the answer to a card left on it, and Make one project,
 * which says itself why it cannot keep or close it. Any other command is new work for it (a task,
 * a note, a setting, a switch to it) and is refused with `joinedRefusalSentence` (the executor's
 * `refuseClosedProject`; the UI's fake daemon reads the same set).
 */
export const OPEN_ON_A_CLOSED_PROJECT: ReadonlySet<string> = new Set([
  "summary.speak",
  "session.stop",
  "session.pause",
  "request.answer",
  "project.join",
]);

/** OJ-06: the joined project's Tasks tab, with Open it: 'Its tasks are in "Site".' */
export function joinedTasksSentence(into: string): string {
  return `Its tasks are in "${into}".`;
}

/**
 * OJ-06: the joined project's Chat tab, with Open it: its conversation stays to read, and the kept
 * project's chat answers about the joined work (its recall reads the joined project's records).
 */
export function joinedChatSentence(into: string): string {
  return `This chat is kept to read; ask about its work in the Chat of "${into}".`;
}

/** OJ-07: the kept project's Costs line: 'Spent in "Kite club" before it joined: CHF 3.20' */
export function spentBeforeJoinSentence(name: string, amount: string): string {
  return `Spent in "${name}" before it joined: ${amount}`;
}

/** OJ-10: the kept project's Sessions line: '"Kite club" had 3 sessions before it joined.' */
export function sessionsBeforeJoinSentence(name: string, count: number): string {
  return `"${name}" had ${count} ${count === 1 ? "session" : "sessions"} before it joined.`;
}

// --- The change, its read-back and its Undo ---------------------------------------------------

/** OJ-02: the change sentence, also the Changes row: 'Made one project: "Kite club" joined "Site".' */
export function joinSentence(keep: string, closed: readonly string[]): string {
  return `Made one project: ${quotedList(closed)} joined "${keep}".`;
}

/** OJ-08: the read-back question (chat answers it with Yes or No). */
export function joinAsk(keep: string, closed: readonly string[]): string {
  return `Make one project: move the tasks, plan and cards of ${quotedList(closed)} into "${keep}"? Changes has its Undo.`;
}

/** OJ-04: the sentence of the join's Undo. */
export function joinUndoneSentence(closed: readonly string[]): string {
  return closed.length === 1
    ? `"${closed[0]}" is its own project again.`
    : `${quotedList(closed)} are their own projects again.`;
}

/** OJ-05: what moves, in one line of the dialog. */
export function joinMovesLine(keep: string, closed: readonly string[]): string {
  return `The tasks, plan, cards and pull requests of ${quotedList(closed)} move into "${keep}".`;
}

/** OJ-05: what stays, in one line of the dialog. */
export function joinStaysLine(closed: readonly string[]): string {
  return closed.length === 1
    ? `"${closed[0]}" keeps its sessions, changes and spending to read; no budget changes.`
    : `${quotedList(closed)} keep their sessions, changes and spending to read; no budget changes.`;
}

/**
 * OJ-05: one setting of the kept project that differs, as the dialog names it ('Status pull
 * request: the setting of "Kite flyers" applies to the moved work: off.'; L4-github-113: without
 * the possessive, as L4-github-108 words the project names).
 */
export function settingAppliesLine(setting: string, keep: string, value: string): string {
  return `${setting}: the setting of "${keep}" applies to the moved work: ${value}.`;
}

// --- Refusals (one sentence each: what holds it, what to do) ----------------------------------

/** A session works on one of the projects now. */
export function joinRefusedRunning(name: string): string {
  return `A session is working on "${name}". Make one project when it ends.`;
}

/** The plan of a project that would close waits for the person's answer. */
export function joinRefusedPlan(name: string): string {
  return `The plan of "${name}" waits for your answer. Answer it first.`;
}

/** The plan of one of them is being drafted now (its planning call runs). */
export function joinRefusedDrafting(name: string): string {
  return `The plan of "${name}" is being drafted. Make one project when it waits for you.`;
}

/** OJ-11: of a pair here, the one worked on together with another Forerunner is the one kept. */
export function keptTogetherLine(name: string): string {
  return `"${name}" is the project GitHub knows, so it is kept.`;
}

/** A merge of one of its pull requests is in flight. */
export function joinRefusedMerging(name: string): string {
  return `A pull request of "${name}" is being merged. Try again in a minute.`;
}

/**
 * A session of one of them waits to go on after its Claude credential, a Start is kept for the
 * reset, or a hands-off start is held: 'A session of "Kite club" waits to go on at 15:40. Make
 * one project after it ran, or cancel it first.'
 */
export function joinRefusedWaiting(name: string, when: string | null): string {
  return `A session of "${name}" waits to go on${when ? ` ${when}` : ""}. Make one project after it ran, or cancel it first.`;
}

/**
 * A hands-off start held on one of them (quiet hours, another session first). L4-creds-28: one
 * sentence of at most 100 characters (a consequence line, design section 5 rule 1); the
 * setting's name is the dialog's link ("When work is ready"), not in the sentence.
 */
export function joinRefusedHeldStart(name: string): string {
  // L4e-left-8 (l4-github-carried): not "soon": quiet hours can hold the start for hours, and
  // the held start keeps no time to name.
  return `A session of "${name}" waits to start by itself: make one project after it ran.`;
}

/** The projects share no repository or folder. */
export function joinRefusedNoLink(names: readonly string[]): string {
  return `${quotedList(names)} do not work in the same repository or folder, so they stay apart.`;
}

/** A project is not the person's own. */
export const JOIN_REFUSED_NOT_YOURS = "Only your own projects can be made one.";

/** A project was removed or joined before. */
export function joinRefusedGone(name: string): string {
  return `"${name}" is no longer a project here, so it cannot be made one with another.`;
}

/** The kept project is among the ones to close, or nothing to close. */
export const JOIN_REFUSED_CHOOSE = "Choose the project to keep and at least one other.";

// --- Undo refusals: fragments the screens complete ("Cannot be undone now: ….") --------------

/** OJ-04: a session of the kept project runs. */
export function joinUndoRunning(keep: string): string {
  return `a session is working on "${keep}". Undo when it ends`;
}

/** OJ-04: a moved task's merge is in flight. */
export function joinUndoMerging(closed: string): string {
  return `a pull request of the work from "${closed}" is being merged. Try again in a minute`;
}

/**
 * OJ-04: a task of the kept project that was not moved waits for a moved one: '"Shop page" waits
 * for "Cart", which came from "Kite club": change that first'.
 */
export function joinUndoDependency(waiting: string, moved: string, closed: string): string {
  return `"${waiting}" waits for "${moved}", which came from "${closed}": change that first`;
}

/** OJ-04: a moved task now waits for a task of the kept project. */
export function joinUndoDependsOnKept(moved: string, closed: string, kept: string): string {
  return `"${moved}", which came from "${closed}", waits for "${kept}": change that first`;
}

/** OJ-06: the kept project's creation cannot be undone while it includes another's work. */
export function createUndoJoined(names: readonly string[]): string {
  return `this project includes the work of ${quotedList(names)}`;
}
