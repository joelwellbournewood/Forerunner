import type { PlanCommand } from "../api/state-client.ts";
import type { MobileChangeCard } from "./change-card.ts";
import { type MobileStorage, readJson, writeJson } from "./storage.ts";

/**
 * The phone's change log (spec Q.11): every change the phone asked for, with the words
 * used, the commands sent, the card, what the PC reported back and a one-tap undo while the
 * change is still reversible. The service keeps the remote command rows; this log is the
 * phone's own view of them (the service has no change-log route for devices yet), persisted
 * per install so it survives a restart and capped at 200 entries.
 */
export type ChangeStatus = "sent" | "picked_up" | "done" | "failed" | "undone";

export interface ChangeEntry {
  id: string;
  at: string;
  wordsUsed: string;
  source: "chat" | "ui" | "voice";
  plan: PlanCommand[];
  card: MobileChangeCard;
  remoteCommandId: string | null;
  status: ChangeStatus;
  result: unknown;
  /** The inverse plan, or null when the change cannot be undone. */
  undoPlan: PlanCommand[] | null;
  /** Set when the undo was sent: the entry that undid this one. */
  undoneBy: string | null;
  /** This entry undoes another one (its id). */
  undoOf: string | null;
}

export const CHANGE_LOG_MAX = 200;

export class ChangeLog {
  private entries: ChangeEntry[];

  constructor(
    private readonly storage: MobileStorage,
    private readonly key: string,
  ) {
    this.entries = readJson<ChangeEntry[]>(storage, key, []).filter(isEntry);
  }

  all(): ChangeEntry[] {
    return [...this.entries].sort((a, b) => b.at.localeCompare(a.at));
  }

  get(id: string): ChangeEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  byRemoteCommand(remoteCommandId: string): ChangeEntry | undefined {
    return this.entries.find((e) => e.remoteCommandId === remoteCommandId);
  }

  add(entry: ChangeEntry): ChangeEntry {
    this.entries = [entry, ...this.entries.filter((e) => e.id !== entry.id)].slice(
      0,
      CHANGE_LOG_MAX,
    );
    this.persist();
    return entry;
  }

  update(id: string, patch: Partial<ChangeEntry>): ChangeEntry | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.entries = this.entries.map((e) => (e.id === id ? next : e));
    this.persist();
    return next;
  }

  /** Status from a remote command row's lifecycle; `undone` and `failed` are never overwritten. */
  applyRemoteStatus(
    remoteCommandId: string,
    status: string,
    result: unknown,
  ): ChangeEntry | undefined {
    const entry = this.byRemoteCommand(remoteCommandId);
    if (!entry || entry.status === "undone") return entry;
    const mapped: ChangeStatus | null =
      status === "picked_up"
        ? "picked_up"
        : status === "done"
          ? "done"
          : status === "failed"
            ? "failed"
            : null;
    if (!mapped) return entry;
    return this.update(entry.id, { status: mapped, result });
  }

  /** True while the change can still be undone: it has an inverse and was not undone or refused. */
  canUndo(entry: ChangeEntry): boolean {
    return (
      entry.undoPlan !== null &&
      entry.undoPlan.length > 0 &&
      entry.status !== "undone" &&
      entry.status !== "failed"
    );
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  private persist(): void {
    writeJson(this.storage, this.key, this.entries);
  }
}

function isEntry(value: unknown): value is ChangeEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.at === "string" &&
    typeof e.wordsUsed === "string" &&
    Array.isArray(e.plan) &&
    !!e.card &&
    typeof e.status === "string"
  );
}
