/**
 * The human's conversation session: the session row whose event log holds the chat, the voice
 * turns, the approvals and what was read aloud. The conversation agent owns it when a model
 * credential exists; without one (a CLI composition, a daemon set up for voice summaries only)
 * the daemon keeps one `conversation` row of the principal agent itself.
 */
import type { Clock } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import type { ConversationAgent } from "../conversation/agent.ts";

export interface ConversationSessionDeps {
  conversation: Pick<ConversationAgent, "conversationSessionId"> | null;
  agent: { id: string };
  store: Pick<StateStore, "session">;
  clock: Clock;
}

export async function conversationSessionId(rt: ConversationSessionDeps): Promise<string> {
  if (rt.conversation) return rt.conversation.conversationSessionId(rt.agent.id, null);
  const existing = await rt.store.session.list(
    { agent_id: rt.agent.id, trigger: "manual", summary: "conversation" } as never,
    { limit: 1 },
  );
  if (existing[0]) return existing[0].id;
  const row = await rt.store.session.insert({
    agent_id: rt.agent.id,
    project_id: null,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 0,
    step_cap: 1_000_000,
    spent_usd_micro: 0,
    steps: 0,
    started_at: rt.clock.nowIso(),
    status: "planned",
    summary: "conversation",
    handoff: {},
    runner: "pc",
    author_agent: rt.agent.id,
  });
  return row.id;
}
