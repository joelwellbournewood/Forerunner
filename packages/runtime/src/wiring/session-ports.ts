import type { CommandPorts } from "@forerunner/commands";
import { errorMessage, log } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { KillSwitch } from "../enforcement/killswitch.ts";

/**
 * The command registry's `pauseSession` and `resumeSession` ports for the daemon (spec Q,
 * R.4; ADR 0030, ADR 0041). `session.stop` is the kill switch (the task in flight is aborted,
 * the session ends `killed`); `session.pause` is the graceful stop. The session runner has
 * no pause lever of its own, but between tasks it re-reads the agent's inbox and ends the
 * session when a message starting with "pause" or "stop" waits there (`stopped_by_message`;
 * the remaining tasks go to the handoff's `next`, where the next session picks them up). A
 * pause from the phone, the chat or the palette therefore:
 *
 * 1. marks the row `paused` at once, so the UI and the phone see it and no second pause is
 *    planned (`session.pause` only pauses a `running` row), and
 * 2. when the session runs in this process (it is registered with the kill switch), sends the
 *    agent that message naming the session, so the task in flight finishes, no new one starts
 *    and the runner closes the session with its handoff (`paused -> stopped`, a legal move).
 *
 * A session running elsewhere (the cloud runner) gets the status only. `resumeSession`, the
 * undo, withdraws the pause message while it is unread and puts a `paused` row back to
 * `running`; a session the runner already closed stays closed (nothing resumes a handoff).
 * A pause that lands during the last task is read by the inbox re-check before the session-end
 * writes (spec E.4): nothing is left to defer, so the session ends `stopped` with the pause
 * named in its handoff (`end_inbox`) and the row leaves `paused`.
 */
export interface SessionPortsDeps {
  store: Pick<StateStore, "session" | "message">;
  kill: Pick<KillSwitch, "activeCount">;
  /** The principal agent whose sessions these are: sender and addressee of the pause message. */
  agentId: string;
  humanId: string;
}

const PAUSE_BODY_RE = /^pause: (.*) \(session ([^\s()]+)\)$/s;

/** The body of the pause message the runner reads between tasks; names the session. */
export function pauseMessageBody(sessionId: string, reason: string): string {
  const text = reason.replace(/\s+/g, " ").trim().slice(0, 200) || "paused by command";
  return `pause: ${text} (session ${sessionId})`;
}

/** The session a pause message names, or null for any other message. */
export function pausedSessionOf(body: string): string | null {
  const m = PAUSE_BODY_RE.exec(body);
  return m?.[2] ?? null;
}

export function sessionPausePorts(
  deps: SessionPortsDeps,
): Pick<CommandPorts, "pauseSession" | "resumeSession"> {
  const logger = log("session-ports");
  const { store, kill, agentId, humanId } = deps;
  return {
    async pauseSession(sessionId, reason) {
      const row = await store.session.mustGet(sessionId);
      const live = kill.activeCount({ sessionId }) > 0;
      if (row.status === "running") await store.session.setStatus(row.id, row.version, "paused");
      if (!live) {
        logger.info("session paused by status only (not running in this process)", {
          sessionId,
          status: row.status,
        });
        return;
      }
      await store.message.send({
        from_agent_id: agentId,
        to_agent_id: agentId,
        project_id: row.project_id,
        type: "request",
        body: pauseMessageBody(sessionId, reason),
        requires_ack: false,
        author_agent: agentId,
        author_human: humanId,
      });
      logger.info("session pausing: the task in flight finishes, no new one starts", {
        sessionId,
        reason,
      });
    },
    async resumeSession(sessionId, reason) {
      let withdrawn = 0;
      try {
        const unread = await store.message.inbox({ agentId }, { unreadOnly: true, limit: 100 });
        for (const m of unread) {
          if (m.from_agent_id !== agentId || pausedSessionOf(m.body) !== sessionId) continue;
          await store.message.markRead(m.id);
          withdrawn++;
        }
      } catch (e) {
        logger.warn("could not withdraw the pause message", { sessionId, error: errorMessage(e) });
      }
      const row = await store.session.mustGet(sessionId);
      if (row.status === "paused") {
        await store.session.setStatus(row.id, row.version, "running");
        logger.info("session resumed", { sessionId, reason, withdrawn });
        return;
      }
      logger.warn("session not resumed: it is no longer paused", {
        sessionId,
        status: row.status,
        reason,
        withdrawn,
      });
    },
  };
}
