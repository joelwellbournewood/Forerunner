import { SimulatedClock } from "@forerunner/platform";
import {
  type AgentRow,
  type DeviceRow,
  type HumanRow,
  openStore,
  type ProjectRow,
  type SessionRow,
  type StateStore,
} from "@forerunner/state";
import {
  type CommandContext,
  CommandExecutor,
  type CommandPorts,
  type CommandRegistry,
  defaultRegistry,
  type KillScope,
  type SessionStartPortRequest,
} from "../src/index.ts";

/** 20:00 in Europe/Zurich (CEST, UTC+2) on a Tuesday. */
export const START = "2026-10-20T18:00:00.000Z";
/** 06:00 Europe/Zurich the next morning. */
export const TOMORROW_0600 = "2026-10-21T04:00:00.000Z";
/** CHF per USD in every test: CHF 20 = USD 25. */
export const RATE = 0.8;
export const TZ = "Europe/Zurich";

export interface FakePorts extends CommandPorts {
  starts: SessionStartPortRequest[];
  kills: { scope: KillScope | "all"; reason: string }[];
  failStart?: Error;
}

export interface World {
  store: StateStore;
  clock: SimulatedClock;
  registry: CommandRegistry;
  executor: CommandExecutor;
  ports: FakePorts;
  human: HumanRow;
  other: HumanRow;
  agent: AgentRow;
  pharma: ProjectRow;
  supplement: ProjectRow;
  game: ProjectRow;
  phone: DeviceRow;
  desktop: DeviceRow;
  conversation: SessionRow;
  ctx(overrides?: Partial<CommandContext>): CommandContext;
}

export async function world(): Promise<World> {
  const clock = new SimulatedClock(START);
  const store = await openStore({ url: "sqlite::memory:", clock });
  const human = await store.human.insert({
    name: "Joel",
    email: "joel@example.test",
    timezone: TZ,
  });
  const other = await store.human.insert({
    name: "Mara",
    email: "mara@example.test",
    timezone: TZ,
  });
  const agent = await store.agent.insert({
    name: "Alice",
    owner_human_id: human.id,
    kind: "principal",
    memory_location: "",
  });
  const pharma = await store.project.insert({
    name: "PharmaWatch",
    goal: "Watch pharma news",
    autonomy_level: 2,
  });
  const supplement = await store.project.insert({ name: "Supplement Site", autonomy_level: 2 });
  const game = await store.project.insert({
    name: "Game",
    autonomy_level: 2,
    settings: { shared_with: [other.id] },
  });
  const phone = await store.device.register({
    owner_human_id: human.id,
    name: "Pixel 8",
    platform: "android",
    public_key: ["pk", "phone", "fixture"].join("-"), // not-a-secret
    kind: "phone",
  });
  const desktop = await store.device.register({
    owner_human_id: human.id,
    name: "Workstation",
    platform: "linux",
    public_key: ["pk", "desktop", "fixture"].join("-"), // not-a-secret
    kind: "desktop",
  });
  const conversation = await store.session.insert({
    agent_id: agent.id,
    project_id: pharma.id,
    trigger: "manual",
    plan: {},
    budget_cap_usd_micro: 0,
    step_cap: 1_000_000,
    spent_usd_micro: 0,
    steps: 0,
    started_at: clock.nowIso(),
    status: "planned",
    summary: "conversation",
    handoff: {},
    runner: "pc",
  });
  const ports: FakePorts = {
    starts: [],
    kills: [],
    chfPerUsd: async () => RATE,
    startSession: async (req) => {
      if (ports.failStart) throw ports.failStart;
      ports.starts.push(req);
      return { sessionId: `s-${ports.starts.length}` };
    },
    kill: async (scope, reason) => {
      ports.kills.push({ scope, reason });
      return { stoppedRuns: 1, killedProcesses: 0 };
    },
  };
  const registry = defaultRegistry();
  await registry.persist(store);
  const executor = new CommandExecutor({ registry, store, clock });
  const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
    actor: { kind: "human", id: human.id },
    humanId: human.id,
    agentId: agent.id,
    activeProjectId: pharma.id,
    store,
    clock,
    ports,
    source: "chat",
    wordsUsed: "",
    timezone: TZ,
    deviceId: null,
    sessionId: conversation.id,
    ...overrides,
  });
  return {
    store,
    clock,
    registry,
    executor,
    ports,
    human,
    other,
    agent,
    pharma,
    supplement,
    game,
    phone,
    desktop,
    conversation,
    ctx,
  };
}

/** Let asynchronous work triggered by a timer finish. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 2));
}
