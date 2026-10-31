import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, type Clock, isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import { openStore, type StateStore } from "@forerunner/state";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type ComposeOptions, composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import {
  describeIdentityCheck,
  EMPTY_HUMAN_STORE,
  HUMAN_ENV,
  installIdentitySelectors,
  lookupInstallHuman,
} from "../src/daemon/identity.ts";
import { configPath, runSetup, type SetupConfig } from "../src/setup/wizard.ts";

// The private memory index (ADR 0083) as compose opens it, with every close recorded: a
// refused start must close what it opened (review finding 4). The wrapper is transparent.
const closedIndexes = vi.hoisted(() => [] as string[]);
vi.mock("../src/loop/memory.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/loop/memory.ts")>();
  return {
    ...mod,
    openPrivateIndex: async (url: string, clock: Clock) => {
      const store = await mod.openPrivateIndex(url, clock);
      return {
        ...store,
        close: async () => {
          closedIndexes.push(url);
          await store.close();
        },
      };
    },
  };
});

/**
 * Install identity on a shared store (triage 2026-10-23 P0 #2, ADR 0082): a daemon binds to
 * its own human, never to the store's first one. Two installs on one `sqlite:<file>` store
 * stand in for two PCs on the shared Postgres (ADR 0024): the store dialect is not what makes
 * a store shared, and the rule is the same on both.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

const HUMAN = {
  timezone: "Europe/Zurich",
  notify_prefs: {},
  default_autonomy: 2,
  monthly_cap_usd_micro: 100_000_000,
  locale: "en",
};

function home(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function minimalConfig(stateUrl: string, over: Partial<SetupConfig> = {}): SetupConfig {
  return {
    version: 1,
    profile: "default",
    timezone: "UTC",
    githubApiBase: "http://gh.test",
    anthropicApiBase: "http://an.test",
    repos: [],
    credentials: { github: false, anthropic: false, anthropicSubscription: false },
    stateUrl,
    ...over,
  };
}

async function compose(
  installHome: string,
  stateUrl: string,
  clock: SimulatedClock,
  opts: Partial<ComposeOptions> = {},
): Promise<RuntimeApp> {
  const env = { FORERUNNER_HOME: installHome, ...(opts.env ?? {}) };
  return composeRuntime({
    env,
    dirs: appDirs({ env }),
    config: null,
    clock,
    stateUrl,
    vault: new MemoryVault(),
    provider: new FakeProvider({
      replies: [textReply("ok", { times: Number.POSITIVE_INFINITY })],
      clock,
      latency: "none",
    }),
    registryDir: REGISTRY,
    appVersion: "0.1.0-test",
    startServices: false,
    ...opts,
  });
}

const code = (e: unknown): string | undefined => (isForerunnerError(e) ? e.code : undefined);

describe("install identity on a shared store", () => {
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");
  let shared: string;
  let store: StateStore;
  let jId = "";
  let mId = "";
  const open: RuntimeApp[] = [];

  beforeAll(async () => {
    shared = `sqlite:${join(home("fr-identity-shared-"), "shared.sqlite")}`;
    store = await openStore({ url: shared, clock });
    jId = (await store.human.insert({ name: "J", email: "j@example.test", ...HUMAN })).id;
    mId = (await store.human.insert({ name: "M", email: "m@example.test", ...HUMAN })).id;
  });
  afterAll(async () => {
    for (const rt of open) await rt.close();
    await store.close();
  });

  it("two installs on one store each bind to their own human and agent", async () => {
    const rtJ = await compose(home("fr-identity-j-"), shared, clock, {
      identity: { humanId: jId, agentName: "Alice" },
    });
    open.push(rtJ);
    const rtM = await compose(home("fr-identity-m-"), shared, clock, {
      env: { [HUMAN_ENV]: "M@Example.test" },
      identity: { agentName: "Bob" },
    });
    open.push(rtM);

    expect(rtJ.human.id).toBe(jId);
    expect(rtJ.identity).toEqual({ humanId: jId, source: "option", selector: jId });
    expect(rtM.human.id).toBe(mId);
    expect(rtM.identity).toEqual({ humanId: mId, source: "env", selector: "M@Example.test" });

    // The agent and the critic are the human's own; the second install never takes the first's.
    const alice = await store.agent.mustGet(rtJ.agent.id);
    const bob = await store.agent.mustGet(rtM.agent.id);
    expect(alice.owner_human_id).toBe(jId);
    expect(bob.owner_human_id).toBe(mId);
    expect(bob.id).not.toBe(alice.id);
    expect((await store.agent.mustGet(rtJ.criticAgent.id)).owner_human_id).toBe(jId);
    expect((await store.agent.mustGet(rtM.criticAgent.id)).owner_human_id).toBe(mId);
    expect(await store.human.count()).toBe(2);
    // A restart of M's install finds the same rows again.
    const again = await compose(home("fr-identity-m2-"), shared, clock, {
      env: { [HUMAN_ENV]: mId },
    });
    open.push(again);
    expect(again.human.id).toBe(mId);
    expect(again.agent.id).toBe(bob.id);
    expect(await store.agent.count()).toBe(4);
  });

  it("an install naming no human on a store with two is refused before anything is written", async () => {
    const humans = await store.human.count();
    const agents = await store.agent.count();
    await expect(compose(home("fr-identity-none-"), shared, clock)).rejects.toSatisfy(
      (e: unknown) => code(e) === "identity_ambiguous",
    );
    expect(await store.human.count()).toBe(humans);
    expect(await store.agent.count()).toBe(agents);
  });

  it("a selector that names nobody is not_found, and nothing is created", async () => {
    const humans = await store.human.count();
    await expect(
      compose(home("fr-identity-nobody-"), shared, clock, { identity: { humanId: "nobody" } }),
    ).rejects.toSatisfy((e: unknown) => code(e) === "not_found");
    await expect(
      compose(home("fr-identity-nobody2-"), shared, clock, {
        env: { [HUMAN_ENV]: "x@example.test" },
      }),
    ).rejects.toSatisfy((e: unknown) => code(e) === "not_found");
    expect(await store.human.count()).toBe(humans);
  });

  it("config.json selects by id, then by email; an unknown email joins as a new human", async () => {
    const byId = await compose(home("fr-identity-cfg-id-"), shared, clock, {
      config: minimalConfig(shared, { humanId: mId, humanEmail: "j@example.test" }),
    });
    open.push(byId);
    expect(byId.human.id).toBe(mId);
    expect(byId.identity.source).toBe("config");

    const byEmail = await compose(home("fr-identity-cfg-email-"), shared, clock, {
      config: minimalConfig(shared, { humanEmail: "J@EXAMPLE.test" }),
    });
    open.push(byEmail);
    expect(byEmail.human.id).toBe(jId);
    expect(byEmail.identity).toEqual({ humanId: jId, source: "email", selector: "J@EXAMPLE.test" });

    // The joining PC: its email matches nobody, so its own human is created with it; the
    // next start finds that row again instead of creating another.
    const cfg = minimalConfig(shared, { humanName: "K", humanEmail: "k@example.test" });
    const joined = await compose(home("fr-identity-cfg-join-"), shared, clock, { config: cfg });
    open.push(joined);
    expect(joined.identity.source).toBe("created");
    const k = await store.human.mustGet(joined.human.id);
    expect(k.name).toBe("K");
    expect(k.email).toBe("k@example.test");
    expect(k.id).not.toBe(jId);
    expect(k.id).not.toBe(mId);
    expect(await store.human.count()).toBe(3);
    const rejoined = await compose(home("fr-identity-cfg-join2-"), shared, clock, { config: cfg });
    open.push(rejoined);
    expect(rejoined.human.id).toBe(k.id);
    expect(rejoined.identity.source).toBe("email");
    expect(rejoined.agent.id).toBe(joined.agent.id);
    expect(await store.human.count()).toBe(3);
  });

  it("the environment selector wins over config.json", async () => {
    const rt = await compose(home("fr-identity-env-wins-"), shared, clock, {
      env: { [HUMAN_ENV]: jId },
      config: minimalConfig(shared, { humanId: mId }),
    });
    open.push(rt);
    expect(rt.human.id).toBe(jId);
    expect(rt.identity.source).toBe("env");
  });

  it("the agent is one of the human's own principals, by name when there are several", async () => {
    const zed = await store.agent.insert({
      name: "Zed",
      owner_human_id: jId,
      model_config: {},
      memory_location: "local",
      status: "active",
      kind: "principal",
    });
    const named = await compose(home("fr-identity-agent-"), shared, clock, {
      identity: { humanId: jId, agentName: "zed" },
    });
    open.push(named);
    expect(named.agent.id).toBe(zed.id);
    const unnamed = await compose(home("fr-identity-agent2-"), shared, clock, {
      identity: { humanId: jId },
    });
    open.push(unnamed);
    expect((await store.agent.mustGet(unnamed.agent.id)).owner_human_id).toBe(jId);
    expect(unnamed.agent.name).toBe("Alice");
    // Naming another human's agent never crosses over: M's install asking for "Zed" gets its own.
    const crossed = await compose(home("fr-identity-agent3-"), shared, clock, {
      identity: { humanId: mId, agentName: "Zed" },
    });
    open.push(crossed);
    expect((await store.agent.mustGet(crossed.agent.id)).owner_human_id).toBe(mId);
    expect(crossed.agent.name).toBe("Bob");
    // A caller that resolved the agent itself (the cloud runner) names it by id, ahead of the
    // name; another human's agent by id is refused, never adopted and never replaced by one
    // of the human's own (review finding 2).
    const byId = await compose(home("fr-identity-agent4-"), shared, clock, {
      identity: { humanId: jId, agentId: zed.id, agentName: "Alice" },
    });
    open.push(byId);
    expect(byId.agent.id).toBe(zed.id);
    const agents = await store.agent.count();
    await expect(
      compose(home("fr-identity-agent5-"), shared, clock, {
        identity: { humanId: mId, agentId: zed.id },
      }),
    ).rejects.toSatisfy((e: unknown) => code(e) === "not_found");
    expect(await store.agent.count()).toBe(agents);
  });

  it("lookupInstallHuman and the doctor's check describe the binding without creating anything", async () => {
    const env = { [HUMAN_ENV]: "" };
    const ambiguous = await lookupInstallHuman(
      store,
      installIdentitySelectors({ env, config: minimalConfig(shared) }),
    );
    expect(ambiguous.kind).toBe("ambiguous");
    const check = describeIdentityCheck(ambiguous);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("3 humans");
    expect(check.detail).toContain(HUMAN_ENV);
    expect(check.detail).toContain("j@example.test");

    const bound = await lookupInstallHuman(
      store,
      installIdentitySelectors({ env: { [HUMAN_ENV]: "m@example.test" }, config: null }),
    );
    expect(bound).toMatchObject({ kind: "bound", source: "env", human: { id: mId } });
    expect(describeIdentityCheck(bound)).toMatchObject({ ok: true });
    expect(describeIdentityCheck(bound).detail).toContain("M <m@example.test>");

    const joining = await lookupInstallHuman(
      store,
      installIdentitySelectors({ env, config: minimalConfig(shared, { humanEmail: "z@x.test" }) }),
    );
    expect(joining).toEqual({ kind: "none", email: "z@x.test", humans: 3 });
    const joinCheck = describeIdentityCheck(joining);
    expect(joinCheck.ok).toBe(true);
    expect(joinCheck.detail).toContain("z@x.test");
    expect(joinCheck.detail).toContain("first start");

    const missing = await lookupInstallHuman(
      store,
      installIdentitySelectors({ env, config: minimalConfig(shared, { humanId: "ghost" }) }),
    );
    expect(missing).toEqual({ kind: "not_found", selector: "ghost", source: "config" });
    expect(describeIdentityCheck(missing).ok).toBe(false);
    expect(await store.human.count()).toBe(3);
  });

  it("a refused start closes the private memory index it opened", async () => {
    const indexUrl = `sqlite:${join(home("fr-identity-index-"), "private.sqlite")}`;
    await expect(
      compose(home("fr-identity-refused-index-"), shared, clock, { privateIndexUrl: indexUrl }),
    ).rejects.toSatisfy((e: unknown) => code(e) === "identity_ambiguous");
    expect(closedIndexes).toContain(indexUrl);
  });

  it("a recorded humanId that names nobody falls through to the configured email, never to another row", async () => {
    // The install that moved to this store (fr setup --state-url ... --email ...): config.json
    // still carries the id the daemon recorded on the old store. Its email binds the row that
    // has it, or creates the install's own human; the stale id is reported, never another row.
    const env = { [HUMAN_ENV]: "" };
    const humans = await store.human.count();
    const asM = await compose(home("fr-identity-stale-m-"), shared, clock, {
      config: minimalConfig(shared, { humanId: "stale-from-sqlite", humanEmail: "m@example.test" }),
    });
    open.push(asM);
    expect(asM.human.id).toBe(mId);
    expect(asM.identity).toEqual({
      humanId: mId,
      source: "email",
      selector: "m@example.test",
      staleConfigHumanId: "stale-from-sqlite",
    });
    const cfg = minimalConfig(shared, {
      humanName: "K2",
      humanEmail: "k2@example.test",
      humanId: "stale-from-sqlite",
    });
    const joined = await compose(home("fr-identity-stale-join-"), shared, clock, { config: cfg });
    open.push(joined);
    expect(joined.identity.source).toBe("created");
    expect(joined.identity.staleConfigHumanId).toBe("stale-from-sqlite");
    expect((await store.human.mustGet(joined.human.id)).email).toBe("k2@example.test");
    expect([jId, mId]).not.toContain(joined.human.id);
    expect(await store.human.count()).toBe(humans + 1);
    // Without an email the stale id stays a refusal: nothing names this install's human.
    await expect(
      compose(home("fr-identity-stale-none-"), shared, clock, {
        config: minimalConfig(shared, { humanId: "stale-from-sqlite" }),
      }),
    ).rejects.toSatisfy((e: unknown) => code(e) === "not_found");
    // FORERUNNER_HUMAN is given per start and stays strict.
    await expect(
      compose(home("fr-identity-stale-env-"), shared, clock, {
        env: { [HUMAN_ENV]: "stale-from-sqlite" },
        config: minimalConfig(shared, { humanEmail: "m@example.test" }),
      }),
    ).rejects.toSatisfy((e: unknown) => code(e) === "not_found");
    expect(await store.human.count()).toBe(humans + 1);
    // fr doctor says what the next start does, naming the stale id.
    const lookup = await lookupInstallHuman(
      store,
      installIdentitySelectors({
        env,
        config: minimalConfig(shared, {
          humanId: "stale-from-sqlite",
          humanEmail: "j@example.test",
        }),
      }),
    );
    expect(lookup).toMatchObject({
      kind: "bound",
      source: "email",
      human: { id: jId },
      staleConfigHumanId: "stale-from-sqlite",
    });
    const check = describeIdentityCheck(lookup);
    expect(check.ok).toBe(true);
    expect(check.detail).toContain("stale-from-sqlite");
    expect(check.detail).toContain("names nobody");
    expect(check.detail).toContain("J <j@example.test>");
    // Without a store yet (fr doctor before the daemon's first start, or the data folder lost):
    // config.json's recorded id names nobody and the start creates the human again, the id
    // reported (U-050); the environment's selector stays strict; an email or nothing is
    // "created at the daemon's first start".
    const noStore = await lookupInstallHuman(
      EMPTY_HUMAN_STORE,
      installIdentitySelectors({ env, config: minimalConfig(shared, { humanId: "h-123" }) }),
    );
    expect(noStore).toEqual({ kind: "none", email: null, humans: 0, staleConfigHumanId: "h-123" });
    expect(describeIdentityCheck(noStore)).toMatchObject({ ok: true });
    expect(
      await lookupInstallHuman(
        EMPTY_HUMAN_STORE,
        installIdentitySelectors({ env: { [HUMAN_ENV]: "h-123" }, config: null }),
      ),
    ).toEqual({ kind: "not_found", selector: "h-123", source: "env" });
    expect(
      await lookupInstallHuman(
        EMPTY_HUMAN_STORE,
        installIdentitySelectors({
          env,
          config: minimalConfig(shared, { humanEmail: "a@b.test" }),
        }),
      ),
    ).toEqual({ kind: "none", email: "a@b.test", humans: 0 });
    expect(
      await lookupInstallHuman(EMPTY_HUMAN_STORE, installIdentitySelectors({ env, config: null })),
    ).toEqual({ kind: "none", email: null, humans: 0 });
  });
  it("a refusal names only steps the installed app has, never an fr command (U-050)", async () => {
    // A recorded id that names nobody on a store that holds other people (a shared store):
    // still refused, since nothing names this install's human, but in words a person can follow.
    const refused = await compose(home("fr-identity-refusal-words-"), shared, clock, {
      config: minimalConfig(shared, { humanId: "stale-from-elsewhere" }),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(code(refused)).toBe("not_found");
    const message = (refused as Error).message;
    expect(message).not.toMatch(/\bfr (setup|doctor)\b/);
    expect(message).toContain(HUMAN_ENV);
    expect(message).toContain("config.json");
    const ambiguous = await compose(home("fr-identity-refusal-ambiguous-"), shared, clock).then(
      () => null,
      (e: unknown) => e,
    );
    expect(code(ambiguous)).toBe("identity_ambiguous");
    expect((ambiguous as Error).message).not.toMatch(/\bfr (setup|doctor)\b/);
  });
});

describe("install identity on a single-human store", () => {
  const clock = new SimulatedClock("2026-10-23T09:00:00Z");
  const open: RuntimeApp[] = [];
  afterAll(async () => {
    for (const rt of open) await rt.close();
  });

  it("a solo install creates its human on first run and finds it again without a selector", async () => {
    const solo = `sqlite:${join(home("fr-identity-solo-"), "state.sqlite")}`;
    const first = await compose(home("fr-identity-solo-a-"), solo, clock, {
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    });
    open.push(first);
    expect(first.identity).toEqual({ humanId: first.human.id, source: "created", selector: null });
    expect(first.human.name).toBe("J");
    const second = await compose(home("fr-identity-solo-b-"), solo, clock);
    open.push(second);
    expect(second.human.id).toBe(first.human.id);
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.identity).toEqual({ humanId: first.human.id, source: "only", selector: null });
    expect(await second.store.human.count()).toBe(1);
  });

  it("an install started from its config.json records the bound human there, never an override", async () => {
    const solo = `sqlite:${join(home("fr-identity-record-"), "state.sqlite")}`;
    const installHome = home("fr-identity-record-home-");
    const env = { FORERUNNER_HOME: installHome };
    const dirs = appDirs({ env });
    mkdirSync(dirs.config, { recursive: true });
    const file = configPath(dirs);
    writeFileSync(
      file,
      `${JSON.stringify(minimalConfig(solo, { humanName: "J", humanEmail: "j@solo.test" }))}\n`,
    );
    const rt = await compose(installHome, solo, clock, { config: undefined });
    open.push(rt);
    expect(rt.config?.humanEmail).toBe("j@solo.test");
    expect(rt.identity.source).toBe("created");
    const written = JSON.parse(readFileSync(file, "utf8")) as SetupConfig;
    expect(written.humanId).toBe(rt.human.id);
    expect(written.humanEmail).toBe("j@solo.test");

    // An override from the environment binds this start only; the file keeps its own id.
    const other = await rt.store.human.insert({ name: "Guest", email: "g@solo.test", ...HUMAN });
    const overridden = await compose(installHome, solo, clock, {
      config: undefined,
      env: { [HUMAN_ENV]: other.id },
    });
    open.push(overridden);
    expect(overridden.human.id).toBe(other.id);
    expect((JSON.parse(readFileSync(file, "utf8")) as SetupConfig).humanId).toBe(rt.human.id);
    // Without the override the recorded id binds, not the store's first row or the email.
    const back = await compose(installHome, solo, clock, { config: undefined });
    open.push(back);
    expect(back.human.id).toBe(rt.human.id);
    expect(back.identity.source).toBe("config");
  });

  it("a wiped store with a recorded humanId starts again by email and records the new id", async () => {
    // The data directory is gone, the config directory is not: config.json names a human the
    // fresh store does not hold. The start creates the install's own human from the configured
    // email and overwrites the stale id, instead of refusing until the file is edited by hand.
    const fresh = `sqlite:${join(home("fr-identity-wiped-"), "state.sqlite")}`;
    const installHome = home("fr-identity-wiped-home-");
    const env = { FORERUNNER_HOME: installHome };
    const dirs = appDirs({ env });
    mkdirSync(dirs.config, { recursive: true });
    const file = configPath(dirs);
    writeFileSync(
      file,
      `${JSON.stringify(minimalConfig(fresh, { humanName: "J", humanEmail: "j@solo.test", humanId: "stale-before-the-wipe" }))}\n`,
    );
    const rt = await compose(installHome, fresh, clock, { config: undefined });
    open.push(rt);
    expect(rt.identity.source).toBe("created");
    expect(rt.identity.staleConfigHumanId).toBe("stale-before-the-wipe");
    expect(rt.human.name).toBe("J");
    expect((await rt.store.human.mustGet(rt.human.id)).email).toBe("j@solo.test");
    expect(await rt.store.human.count()).toBe(1);
    expect((JSON.parse(readFileSync(file, "utf8")) as SetupConfig).humanId).toBe(rt.human.id);
    const again = await compose(installHome, fresh, clock, { config: undefined });
    open.push(again);
    expect(again.identity).toEqual({
      humanId: rt.human.id,
      source: "config",
      selector: rt.human.id,
    });
  });

  it("a lost data folder with the settings kept: the service recreates the human and agent and starts (U-050)", async () => {
    // The installed app: the setup assistant writes config.json without an email, the daemon
    // records the human it created there, then the data folder (state.sqlite) is lost. The next
    // start refused with "run fr setup --human-id", a command the installed app does not have.
    const installHome = home("fr-identity-lostdata-");
    const env = { FORERUNNER_HOME: installHome };
    const dirs = appDirs({ env });
    const stateUrl = `sqlite:${join(dirs.data, "state.sqlite")}`;
    mkdirSync(dirs.config, { recursive: true });
    mkdirSync(dirs.data, { recursive: true });
    const file = configPath(dirs);
    writeFileSync(file, `${JSON.stringify(minimalConfig(stateUrl, { humanName: "Joel" }))}\n`);
    const before = await compose(installHome, stateUrl, clock, { config: undefined });
    const lostHumanId = before.human.id;
    expect((JSON.parse(readFileSync(file, "utf8")) as SetupConfig).humanId).toBe(lostHumanId);
    await before.close();
    rmSync(dirs.data, { recursive: true, force: true });

    const after = await compose(installHome, stateUrl, clock, { config: undefined });
    open.push(after);
    expect(after.identity).toMatchObject({
      source: "created",
      staleConfigHumanId: lostHumanId,
    });
    expect(after.human.id).not.toBe(lostHumanId);
    expect(after.human.name).toBe("Joel");
    expect(after.agent.id).toEqual(expect.any(String));
    expect(await after.store.agent.principals(after.human.id)).toHaveLength(1);
    // The new id is recorded, so the start after this one binds by it.
    expect((JSON.parse(readFileSync(file, "utf8")) as SetupConfig).humanId).toBe(after.human.id);
    const third = await compose(installHome, stateUrl, clock, { config: undefined });
    open.push(third);
    expect(third.identity).toMatchObject({ source: "config", humanId: after.human.id });
  });

  it("fr setup persists the selector and keeps it across later runs", async () => {
    const installHome = home("fr-identity-setup-");
    const env = { FORERUNNER_HOME: installHome };
    const dirs = appDirs({ env });
    const first = await runSetup(new MemoryVault(), {
      nonInteractive: true,
      dirs,
      env,
      humanName: "J",
      humanEmail: "J@Example.test",
      humanId: "h-123",
    });
    expect(first.config.humanEmail).toBe("j@example.test");
    expect(first.config.humanId).toBe("h-123");
    expect(existsSync(configPath(dirs))).toBe(true);
    const later = await runSetup(new MemoryVault(), { nonInteractive: true, dirs, env });
    expect(later.config.humanEmail).toBe("j@example.test");
    expect(later.config.humanId).toBe("h-123");
    await expect(
      runSetup(new MemoryVault(), { nonInteractive: true, dirs, env, humanEmail: "not-an-email" }),
    ).rejects.toSatisfy((e: unknown) => code(e) === "validation");
  });
});
