/**
 * The PC side of the phase 5 gate (ADR 0045): the daemon's own `desktop` device row
 * (`registerDesktopDevice`, as `composeRuntime` makes it, with the identity file under the
 * install's config dir) and the daemon's `RemoteCommandWatcher` (`packages/runtime/src/remote`,
 * ADR 0041) with the deps `composeRuntime` gives it, here with the conversation agent as the
 * `chat` port too, so the phone's quick-chat envelope runs on the PC (spec R.5). The poll runs
 * on the simulated clock; `drainPc` advances the clock by one poll and awaits the drain, which
 * is what the daemon's tick does.
 */
import { join, osFacts } from "@forerunner/platform";
import {
  type CommandLoop,
  type ConversationAgent,
  RemoteCommandWatcher,
  registerDesktopDevice,
} from "@forerunner/runtime";
import type { DeviceRow, JsonObject, RemoteCommandRow } from "@forerunner/state";
import { settle } from "./scenario-voice.ts";
import type { Install, ScenarioWorld } from "./scenario-world.ts";

export const PC_POLL_MS = 500;

/** The install's PC as a `desktop` device of its human, registered the way the daemon does it. */
export function registerPc(world: ScenarioWorld, install: Install): Promise<DeviceRow> {
  return registerDesktopDevice({
    store: world.store,
    dirs: { config: join(world.root, `daemon-${install.name.toLowerCase()}`, "config") },
    humanId: install.human.id,
    name: `${install.human.name}'s PC`,
    platform: osFacts().platform,
  });
}

export interface PcOptions {
  install: Install;
  commands: CommandLoop;
  conversation: ConversationAgent;
  pcDeviceId: string;
  /** The principal's conversation session: the activity log a plan's sentence goes to. */
  sessionId: string;
  pollMs?: number;
  onHandled?: (row: RemoteCommandRow, result: JsonObject) => void;
}

export function pcFor(world: ScenarioWorld, opts: PcOptions): RemoteCommandWatcher {
  const { install } = opts;
  return new RemoteCommandWatcher({
    store: world.store,
    clock: world.clock,
    kill: install.kill,
    start: (req) => install.scheduler.request(req),
    commands: opts.commands,
    chat: (req) => opts.conversation.chat(req),
    conversationSessionId: async () => opts.sessionId,
    deviceId: opts.pcDeviceId,
    agentId: install.agent.id,
    humanId: install.human.id,
    pollMs: opts.pollMs ?? PC_POLL_MS,
    ...(opts.onHandled ? { onHandled: opts.onHandled } : {}),
  });
}

/** One poll of the PC: the clock moves by the poll interval and the drain is awaited. */
export async function drainPc(world: ScenarioWorld, pc: RemoteCommandWatcher): Promise<number> {
  await world.clock.advance(pc.stats.pollMs);
  const n = await pc.drain();
  await settle();
  return n;
}
