import { z } from "zod";

/**
 * Task priority as people and models set and see it (U-041, the owner's decision): Low, Medium
 * or High. Up to 1.0.4 it was a number the New task dialog labelled "Priority (1 high)" while the
 * planner ran the higher number first. The column stays numeric (`task.priority`, higher runs
 * first) so the stored order is unchanged; only the three words cross a screen, a route, a
 * prompt or a model's reply.
 *
 * - A stored number reads as its level: 0 to 3 low, 4 to 6 medium, 7 and up high
 *   (`priorityLevel`). Rows written up to 1.0.4 hold 0 to 10; they keep their numbers, so the
 *   planner orders them exactly as before, and a 9 still runs before a 6.
 * - A level is written as its number (`PRIORITY_VALUES`): low 1, medium 5, high 10, the ends
 *   of the low and high bands, so a new High task never waits behind an older High one and a
 *   new Low one never runs before an older Low one.
 * - An old number from a model or an old client is read as its level (`readPriority`), so a
 *   reply that still says 7 is accepted as high, never refused over this.
 *
 * This module imports nothing but zod: the UI loads it in a browser.
 */
export const TASK_PRIORITIES = ["low", "medium", "high"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** What a new task gets when nobody says: the middle level (the dialog's and Chat's default). */
export const DEFAULT_TASK_PRIORITY: TaskPriority = "medium";

/** How a level reads on a screen. */
export const PRIORITY_LABELS: Readonly<Record<TaskPriority, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** The number a level is stored as (`task.priority`, higher runs first). */
export const PRIORITY_VALUES: Readonly<Record<TaskPriority, number>> = {
  low: 1,
  medium: 5,
  high: 10,
};

/** The level a stored number reads as: 0 to 3 low, 4 to 6 medium, 7 and up high. */
export function priorityLevel(stored: number): TaskPriority {
  if (stored >= 7) return "high";
  if (stored >= 4) return "medium";
  return "low";
}

/**
 * A priority as given (a level in any case, "Low" from a screen, an old number from a model or
 * a client, a number in a string) as its level; null when it is none of these.
 */
export function readPriority(input: unknown): TaskPriority | null {
  if (typeof input === "number") return Number.isFinite(input) ? priorityLevel(input) : null;
  if (typeof input !== "string") return null;
  const word = input.trim().toLowerCase();
  if ((TASK_PRIORITIES as readonly string[]).includes(word)) return word as TaskPriority;
  if (word === "normal" || word === "med") return "medium";
  if (/^\d{1,2}$/.test(word)) return priorityLevel(Number(word));
  return null;
}

/** The stored number of a priority as given; the default level's for one that is not readable. */
export function storedPriority(input: unknown): number {
  return PRIORITY_VALUES[readPriority(input) ?? DEFAULT_TASK_PRIORITY];
}

/**
 * A priority in a body, a plan or a command: one of the three words, or an old number read as
 * its level. Its JSON Schema (what a model is shown) lists the three words only.
 */
export const TaskPrioritySchema = z.preprocess(
  (v) => readPriority(v) ?? v,
  z.enum(TASK_PRIORITIES),
);
