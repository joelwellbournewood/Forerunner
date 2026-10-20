/**
 * Shared fixture for the Cloudflare tests: the fake API on 127.0.0.1, a memory vault holding
 * the token by reference, an in-memory state store (audit rows, human requests), a simulated
 * clock, and a client plus deployer restricted to one account and two of the fake's three zones.
 */
import { SimulatedClock } from "@forerunner/platform";
import type { ToolExecutionContext } from "@forerunner/runtime";
import { openStore, type ProjectRow, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import {
  CloudflareClient,
  CloudflareDeployer,
  type CloudflareSettings,
  type CloudflareSettingsInput,
  cloudflareTokenSource,
  FakeCloudflareApprovals,
  parseCloudflareSettings,
  scopeOf,
} from "../../src/cloudflare/index.ts";
import { FakeCloudflare, type FakeCloudflareOptions, type FakePolicy } from "./fake-cloudflare.ts";

export const TOKEN = ["cf", "fake", "api", "token", "value", "0123456789"].join("-"); // not-a-secret
export const TOKEN_REF = "secret:cloudflare_api_token";
export const ACCOUNT = "acc0123456789abcdef0123456789abcd";
export const ZONE_A = "zonea0123456789abcdef0123456789ab";
export const ZONE_B = "zoneb0123456789abcdef0123456789ab";
/** Belongs to the account but is not in the project's list. */
export const ZONE_OTHER = "zonec0123456789abcdef0123456789ab";
export const ZONE_A_NAME = "example.test";
export const ZONE_B_NAME = "example-two.test";
export const ZONE_OTHER_NAME = "other.test";

export const HUMAN = "human-1";
export const AGENT = "agent-alice";
export const SESSION = "session-1";
export const RUN = "run-1";

export function fullPolicies(): FakePolicy[] {
  return [
    {
      effect: "allow",
      permission_groups: [
        { id: "pg-workers", name: "Workers Scripts Write" },
        { id: "pg-pages", name: "Cloudflare Pages Write" },
        { id: "pg-tokens", name: "API Tokens Read" },
      ],
      resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
    },
    {
      effect: "allow",
      permission_groups: [
        { id: "pg-dns", name: "DNS Write" },
        { id: "pg-routes", name: "Workers Routes Write" },
      ],
      resources: {
        [`com.cloudflare.api.account.${ACCOUNT}`]: {
          [`com.cloudflare.api.account.zone.${ZONE_A}`]: "*",
          [`com.cloudflare.api.account.zone.${ZONE_B}`]: "*",
        },
      },
    },
  ];
}

export function settingsInput(
  over: Partial<CloudflareSettingsInput> = {},
): CloudflareSettingsInput {
  return {
    account_id: ACCOUNT,
    zone_ids: [ZONE_A, ZONE_B],
    secret_ref: TOKEN_REF,
    ...over,
  };
}

export interface WorldOptions {
  fake?: Partial<FakeCloudflareOptions>;
  settings?: Partial<CloudflareSettingsInput>;
  approvals?: FakeCloudflareApprovals;
  autonomy?: 0 | 1 | 2 | 3 | 4;
  /** Write audit rows through the store (default true). */
  audit?: boolean;
}

export interface World {
  fake: FakeCloudflare;
  vault: MemoryVault;
  store: StateStore;
  clock: SimulatedClock;
  settings: CloudflareSettings;
  client: CloudflareClient;
  approvals: FakeCloudflareApprovals;
  deployer: CloudflareDeployer;
  project: ProjectRow;
  ctx: ToolExecutionContext;
  stop(): Promise<void>;
}

export async function cloudflareWorld(opts: WorldOptions = {}): Promise<World> {
  const fake = new FakeCloudflare({
    token: TOKEN,
    tokenId: "tok1",
    accountId: ACCOUNT,
    zones: [
      { id: ZONE_A, name: ZONE_A_NAME, accountId: ACCOUNT },
      { id: ZONE_B, name: ZONE_B_NAME, accountId: ACCOUNT },
      { id: ZONE_OTHER, name: ZONE_OTHER_NAME, accountId: ACCOUNT },
    ],
    policies: fullPolicies(),
    pagesProjects: { "my-site": "main" },
    ...opts.fake,
  });
  const baseUrl = await fake.start();
  const clock = new SimulatedClock();
  const vault = new MemoryVault({ cloudflare_api_token: TOKEN });
  const store = await openStore({ url: "sqlite::memory:", clock });
  const settings = parseCloudflareSettings(settingsInput({ base_url: baseUrl, ...opts.settings }));
  await store.human.insert({ id: HUMAN, name: "J", email: "j@example.test" });
  await store.agent.insert({ id: AGENT, name: "Alice", owner_human_id: HUMAN });
  const project = await store.project.insert({
    name: "Deploy me",
    autonomy_level: opts.autonomy ?? 3,
    settings: { cloudflare: JSON.parse(JSON.stringify(settings)) },
  });
  await store.session.insert({ id: SESSION, agent_id: AGENT, project_id: project.id });
  const client = new CloudflareClient({
    scope: scopeOf(settings),
    token: cloudflareTokenSource({ vault, ref: settings.secret_ref }),
    baseUrl,
    clock,
  });
  const approvals = opts.approvals ?? new FakeCloudflareApprovals("approved");
  const deployer = new CloudflareDeployer({
    client,
    settings,
    approvals,
    audit: opts.audit === false ? undefined : store.auditLog,
    clock,
  });
  const ctx: ToolExecutionContext = {
    runId: RUN,
    sessionId: SESSION,
    agentId: AGENT,
    humanId: HUMAN,
    projectId: project.id,
    allowedPaths: [],
    signal: new AbortController().signal,
  };
  return {
    fake,
    vault,
    store,
    clock,
    settings,
    client,
    approvals,
    deployer,
    project,
    ctx,
    async stop() {
      await fake.stop();
      await store.close();
    },
  };
}

export function actorOf(
  w: World,
  autonomy: 0 | 1 | 2 | 3 | 4,
  tool?: { name: string; input: unknown },
) {
  return {
    runId: RUN,
    sessionId: SESSION,
    agentId: AGENT,
    humanId: HUMAN,
    projectId: w.project.id,
    autonomy,
    tool,
  };
}

export const WORKER_SCRIPT = 'export default { fetch() { return new Response("hi"); } };';

/**
 * Awaits `p` while pumping the simulated clock, so retries that sleep on the clock (5xx
 * backoff, Retry-After) run to completion.
 */
export async function settle<T>(clock: SimulatedClock, p: Promise<T>): Promise<T> {
  let done = false;
  const guarded = p.finally(() => {
    done = true;
  });
  guarded.catch(() => undefined);
  while (!done) {
    if (clock.pendingTimers() > 0) await clock.advance(1000);
    else await new Promise<void>((r) => setImmediate(r));
  }
  return guarded;
}
