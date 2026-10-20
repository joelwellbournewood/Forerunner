/**
 * The command registry and the conversation agent on the scenario world: what the daemon
 * composes for one install (`composeRuntime`: `CommandLoop` over the store with the billing
 * rate and the scheduler and kill switch as its session ports, `ConversationAgent` on the
 * install's driver with the command tools), assembled here for an install of the world so a
 * scenario can talk to the agent (scenario 3, by voice) or run a phone's plan through the
 * registry (scenario 9). Nothing is loosened: the executor's risk policy, the change log, the
 * timed reverts and the undo are the production code paths.
 *
 * - `commandLoopFor(world, install)`: the `CommandLoop` of the install (persisted command
 *   table, the rate through the billing package's `FixedRateSource`, `session.start` through
 *   the install's scheduler, `session.stop` through its kill switch).
 * - `conversationAgentFor(world, install, commands)`: the conversation agent of the install
 *   on the world's fake provider (`fake-haiku`, the text-chat rung).
 * - `commandTurnFor(install, sessionId, over)`: a `CommandTurn` as the daemon builds one.
 * - `chatTurn(phrase)`, `chatAfterTool(phrase)`: predicates for scripting the conversation
 *   agent's model calls (the human's words are in the first user message).
 */
import {
  CommandLoop,
  type CommandTurn,
  ConversationAgent,
  type ModelRequest,
  sessionCommandPorts,
} from "@forerunner/runtime";
// `@forerunner/billing` is not declared in tests/e2e/package.json (see scenario-world.ts for
// the same note on capabilities); the relative path reaches the sources the daemon composes.
import { FixedRateSource } from "../../../packages/billing/src/index.ts";
import type { Install, ScenarioWorld } from "./scenario-world.ts";
import { flatPricing, lastIsToolResult } from "./world.ts";

/** CHF per USD on the world's ledger (`statePorts` in scenario-world.ts uses the same figure). */
export const SCENARIO_CHF_PER_USD = 0.8;

export async function commandLoopFor(world: ScenarioWorld, install: Install): Promise<CommandLoop> {
  const rates = new FixedRateSource(SCENARIO_CHF_PER_USD);
  const commands = new CommandLoop({
    store: world.store,
    clock: world.clock,
    ports: {
      // The day's rate from the billing package, as the daemon's `chfPerUsd` port reads it.
      chfPerUsd: (dateIso) => rates.chfPerUsd(dateIso),
      ...sessionCommandPorts({ scheduler: install.scheduler, kill: install.kill }),
    },
  });
  await commands.start();
  return commands;
}

export function conversationAgentFor(
  world: ScenarioWorld,
  install: Install,
  commands: CommandLoop,
): ConversationAgent {
  return new ConversationAgent({
    store: world.store,
    clock: world.clock,
    tokens: install.tokens,
    kill: install.kill,
    provider: world.gated,
    pricing: flatPricing,
    billingSourceId: `bs-${install.name.toLowerCase()}`,
    hooksDriver: install.driver,
    modelId: "fake-haiku",
    commands,
  });
}

export function commandTurnFor(
  install: Install,
  sessionId: string,
  over: Partial<CommandTurn> = {},
): CommandTurn {
  return {
    humanId: install.human.id,
    agentId: install.agent.id,
    activeProjectId: null,
    sessionId,
    source: "text",
    wordsUsed: "",
    deviceId: null,
    ...over,
  };
}

/** The human's words of a conversation turn: the first user message after the volatile preamble. */
export function wordsOf(req: ModelRequest): string {
  const first = req.messages[0];
  if (first?.role !== "user") return "";
  if (typeof first.content === "string") return first.content;
  return first.content
    .map((b) =>
      (b as { type?: string; text?: string }).type === "text"
        ? ((b as { text?: string }).text ?? "")
        : "",
    )
    .join("");
}

/** The conversation agent's first model call of a turn whose words include `phrase`. */
export function chatTurn(phrase: string): (req: ModelRequest) => boolean {
  return (req) => wordsOf(req).includes(phrase) && !lastIsToolResult(req);
}

/** The conversation agent's call after a command tool came back, in the turn with `phrase`. */
export function chatAfterTool(phrase: string): (req: ModelRequest) => boolean {
  return (req) => wordsOf(req).includes(phrase) && lastIsToolResult(req);
}
