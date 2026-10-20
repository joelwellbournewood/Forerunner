import { type Clock, ForerunnerError } from "@forerunner/platform";
import type { Database } from "../db/types.ts";
import { ENTITIES, type EntityDef } from "../schema.ts";
import type { MessageRow, NewMessage } from "../types.ts";
import { type ListOptions, Repository } from "./base.ts";

export type InboxTarget = { agentId: string } | { humanId: string };

export class MessageRepo extends Repository<MessageRow> {
  constructor(db: Database, clock: Clock) {
    super(db, ENTITIES.message as EntityDef, clock);
  }

  /** Send a message; it needs an agent or a human addressee. */
  async send(input: NewMessage): Promise<MessageRow> {
    if (!input.to_agent_id && !input.to_human_id) {
      throw new ForerunnerError("validation", "message needs to_agent_id or to_human_id");
    }
    return this.insert(input);
  }

  /** Inbox of an agent or a human, oldest first. */
  inbox(
    target: InboxTarget,
    opts: { unreadOnly?: boolean } & ListOptions = {},
  ): Promise<MessageRow[]> {
    const { unreadOnly, ...list } = opts;
    const addressee =
      "agentId" in target ? { to_agent_id: target.agentId } : { to_human_id: target.humanId };
    return this.list({ ...addressee, ...(unreadOnly ? { read_at: null } : {}) }, list);
  }

  async markDelivered(id: string): Promise<MessageRow> {
    const m = await this.mustGet(id);
    if (m.delivered_at) return m;
    return this.patch(id, { delivered_at: this.clock.nowIso() });
  }

  /** Read implies delivered. First receipt wins. */
  async markRead(id: string): Promise<MessageRow> {
    const m = await this.mustGet(id);
    if (m.read_at) return m;
    const now = this.clock.nowIso();
    return this.patch(id, { read_at: now, delivered_at: m.delivered_at ?? now });
  }

  /** Acted implies read and delivered. */
  async markActed(id: string): Promise<MessageRow> {
    const m = await this.mustGet(id);
    if (m.acted_at) return m;
    const now = this.clock.nowIso();
    return this.patch(id, {
      acted_at: now,
      read_at: m.read_at ?? now,
      delivered_at: m.delivered_at ?? now,
    });
  }

  /** requires_ack messages from an agent that nobody acted on yet (resurface at the next session). */
  unacknowledged(fromAgentId: string, opts: ListOptions = {}): Promise<MessageRow[]> {
    return this.list({ from_agent_id: fromAgentId, requires_ack: true, acted_at: null }, opts);
  }

  replies(messageId: string): Promise<MessageRow[]> {
    return this.list({ reply_to: messageId });
  }
}
