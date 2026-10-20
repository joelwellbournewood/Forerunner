/**
 * The notifier of an install on the scenario world (spec K, J, ADR 0017): the production
 * `Notifier` with its rules (urgency, quiet hours, dedupe, retry, audit row per delivery, an
 * event on the session the notification names) over the world's store, with one recording
 * channel in the desktop channel's place, so a scenario can assert what reached the human
 * without an OS notifier. `bindProducers` gives the same producers the daemon composes.
 */

import {
  bindProducers,
  type Channel,
  type ChannelContext,
  type ChannelResult,
  type Notification,
  type NotificationRecord,
  Notifier,
  type ProducerHooks,
} from "@forerunner/runtime";
import type { HumanRow } from "@forerunner/state";
import type { ScenarioWorld } from "./scenario-world.ts";

/** Records every notification it is handed to; stands in for the desktop channel. */
export class RecordingChannel implements Channel {
  readonly name = "desktop" as const;
  readonly sent: Array<{ notification: Notification; ctx: ChannelContext }> = [];
  configured(): string | null {
    return null;
  }
  async send(n: Notification, ctx: ChannelContext): Promise<ChannelResult> {
    this.sent.push({ notification: n, ctx });
    return { ok: true, detail: "recorded by the scenario" };
  }
}

export interface ScenarioNotifier {
  notifier: Notifier;
  channel: RecordingChannel;
  producers: ProducerHooks;
  /** Records of one human, newest first (what `GET /notifications/recent` lists). */
  recent(humanId: string): NotificationRecord[];
}

export function scenarioNotifier(world: ScenarioWorld): ScenarioNotifier {
  const channel = new RecordingChannel();
  const notifier = new Notifier({
    clock: world.clock,
    channels: [channel],
    humans: {
      get: (id) => world.store.human.get(id),
      patch: (id, patch) => world.store.human.patch(id, patch as Partial<HumanRow>),
    },
    audit: world.store.auditLog,
    events: world.store.event,
  });
  return {
    notifier,
    channel,
    producers: bindProducers(notifier),
    recent: (humanId) => notifier.recent({ humanId, limit: 200 }),
  };
}
