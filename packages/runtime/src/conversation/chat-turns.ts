import { type Depth, STOPPING_STEP } from "./depth.ts";

/**
 * The chat turns in flight (d1109-chat-depth, ADR 0114; the owner's words of 2026-11-09: "There
 * should be something indicating what the chat is doing when waiting"): one entry per turn while
 * its answer is made, with what it is doing now, since when, how deep it goes and the controller
 * that stops it. The daemon serves it on the conversation view (`answering`), so a reload or the
 * other surface (the Chat tab, Talk) shows the same line and Stop; Stop aborts the controller,
 * which every model run of the turn receives as its signal. A dropped stream, a reload or a
 * closed Talk panel never ends a turn: only Stop, the turn's own end or the daemon's.
 */
export interface ChatTurnEntry {
  turnId: string;
  humanId: string;
  /** The conversation's project, null for the one outside any project. */
  conversationProjectId: string | null;
  /** What chat is doing now, in the step line's words; null before the first step. */
  step: string | null;
  /** When the turn started (ISO-8601 UTC). */
  since: string;
  depth: Depth;
  /** Aborted by Stop: every model run of the turn ends as killed. */
  controller: AbortController;
  /** Set by Stop, so the reply says the person stopped it. */
  stopped: boolean;
  /** Answer now (a thorough pass only): its next call carries the wrap-up. */
  answerNow?: () => boolean;
}

export type ChatTurnListener = (conversationProjectId: string | null) => void;

export class ChatTurns {
  private readonly turns = new Map<string, ChatTurnEntry>();
  private readonly listeners = new Set<ChatTurnListener>();

  /**
   * `startedAt`: when this daemon started (ISO, from its Clock: AGENTS.md): a person's line older
   * than it without a reply was cut off by a restart.
   */
  constructor(readonly startedAt: string) {}

  begin(o: {
    turnId: string;
    humanId: string;
    conversationProjectId: string | null;
    since: string;
    depth?: Depth;
  }): ChatTurnEntry {
    const entry: ChatTurnEntry = {
      ...o,
      step: null,
      depth: o.depth ?? "quick",
      controller: new AbortController(),
      stopped: false,
    };
    this.turns.set(o.turnId, entry);
    this.changed(entry);
    return entry;
  }

  /** A new step line (the conversation's screens re-read on it). */
  step(turnId: string, line: string): void {
    const e = this.turns.get(turnId);
    if (!e || e.step === line) return;
    e.step = line;
    this.changed(e);
  }

  setDepth(turnId: string, depth: Depth): void {
    const e = this.turns.get(turnId);
    if (e) e.depth = depth;
  }

  end(turnId: string): void {
    const e = this.turns.get(turnId);
    if (!e) return;
    this.turns.delete(turnId);
    this.changed(e);
  }

  get(turnId: string): ChatTurnEntry | undefined {
    return this.turns.get(turnId);
  }

  /** The turn in flight in a conversation, if any (the newest). */
  inFlight(conversationProjectId: string | null): ChatTurnEntry | undefined {
    let found: ChatTurnEntry | undefined;
    for (const e of this.turns.values())
      if (e.conversationProjectId === conversationProjectId) found = e;
    return found;
  }

  /** Stop: the turn's runs end as killed; false when it is not in flight (finished already). */
  stop(turnId: string): boolean {
    const e = this.turns.get(turnId);
    if (!e) return false;
    if (!e.stopped) {
      e.stopped = true;
      // The answering line says it while the run ends (a reload shows the same).
      e.step = STOPPING_STEP;
      this.changed(e);
      e.controller.abort(new Error("stopped by the person"));
    }
    return true;
  }

  on(listener: ChatTurnListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(e: ChatTurnEntry): void {
    for (const l of this.listeners) {
      try {
        l(e.conversationProjectId);
      } catch {
        // A listener's failure never ends a turn.
      }
    }
  }
}
