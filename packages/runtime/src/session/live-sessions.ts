/**
 * The sessions running now, one per project, each with the handle its runner registered
 * (d1109-starts-engine S-7, ADR 0118, the owner's option C: "the session keeps its promise and
 * spare budget isn't wasted"). Work prepared outside the runner (an answer, a Tasks-row action,
 * chat) asks the handle whether it may join: the session's own tasks keep their room, and a
 * newcomer joins only when its estimate fits what is left of the work budget after them. The
 * decision is made at the action, so the line the person reads ("It joins the session that is
 * running.") is true; admitting never raises a budget.
 */

/** Who prepared the work: the person, the system (a raised limit, a credential back), the agent. */
export type PrepareBy = "person" | "system" | "agent";

/**
 * What a session answered for one task: it runs in this session (`joined`), it does not fit now
 * (`no_room`: it joins if budget is left after the session's own tasks, else the next Start),
 * it is larger than the session's whole work budget (`too_large`, l4-starts-sessions
 * L4-money-203: it never joins this session and runs in its turn at the next Start, D4), or the
 * session takes no new work (`stopping`: Stop after this task, the wrap-up, its end review or its
 * last look found nothing; the task waits for the next Start and does not run here).
 */
export type AdmitOutcome = "joined" | "no_room" | "too_large" | "stopping";

/**
 * How a task relates to the session's promise (D7, d1109-selftasks-run builds on it): a part of
 * a promised task it was split from is the session's own up to that task's remaining estimate;
 * a step added before a promised task is a newcomer, and when it does not fit the promised task
 * leaves the promise with it (both named once in the result).
 */
export interface AdmitContext {
  /** The promised task this one was split from. */
  partOf?: string;
  /** The promised task this one was added before. */
  before?: string;
}

/** What a running session offers to work prepared outside it (`LiveSessions.forProject`). */
export interface AdmitHandle {
  sessionId: string;
  agentId: string;
  projectId: string;
  /** Ask whether these tasks may join, each read fresh; the answer per task id. */
  admit(
    taskIds: readonly string[],
    by: PrepareBy,
    context?: AdmitContext,
  ): Promise<Map<string, AdmitOutcome>>;
  /**
   * What `admit` would answer now, read-only (chat's read-back of a move, l4-starts-carried
   * L4g-left-2): nothing joins and nothing is noted. A task above the session's whole work budget
   * reads `too_large`, as the admit decides it (L4-money-203); one that may fit reads `no_room`
   * (the room rule's words: the room is decided at the move). Absent on an older handle.
   */
  preview?(taskIds: readonly string[]): Promise<Map<string, AdmitOutcome>>;
  /**
   * Take tasks back as the session's own (a task that waited for its Claude credential inside
   * this session, after "Use API key": d1109-cred-engine), so the session runs them again.
   */
  readmit(taskIds: readonly string[]): void;
  /** Set while the session's last look runs: an admit then answers `stopping`. */
  closing: boolean;
}

/** The registry the runner writes and `prepareWork` reads (one handle per project). */
export class LiveSessions {
  private readonly byProject = new Map<string, AdmitHandle>();

  /** Register a running session's handle; the returned function unregisters exactly it. */
  register(handle: AdmitHandle): () => void {
    this.byProject.set(handle.projectId, handle);
    return () => {
      if (this.byProject.get(handle.projectId) === handle) this.byProject.delete(handle.projectId);
    };
  }

  /** The handle of the session running for this project now, if any. */
  forProject(projectId: string): AdmitHandle | undefined {
    return this.byProject.get(projectId);
  }

  /** The handles of every session running now (read-only). */
  all(): AdmitHandle[] {
    return [...this.byProject.values()];
  }
}
