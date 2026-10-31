import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, describe, expect, it } from "vitest";
import type { QueryLike } from "../src/agent/sdk.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import type { PlanAllowanceView } from "../src/setup/types.ts";
import { configPath, SECRET_NAMES, type SetupConfig } from "../src/setup/wizard.ts";

/**
 * U-052: the Claude subscription's allowance was fixed at the USD 50 default on an installed
 * app (only `fr setup --plan-usd-monthly`, an environment variable or a hand-edited config.json
 * could change it), so a Max subscriber's tasks stopped early. Settings now has a field: the
 * person enters CHF a month, the daemon stores USD where the runtime reads it (config.json and
 * the subscription billing row), in force at once and after a restart.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
const OAUTH = ["sk-ant-oat01-", "allowance", "0".repeat(40)].join(""); // not-a-secret
const noSdk: QueryLike = () => ({
  async *[Symbol.asyncIterator]() {
    // never called
  },
});

describe("Settings → Claude subscription allowance (U-052)", () => {
  const runtimes: RuntimeApp[] = [];
  const vault = new MemoryVault({ [SECRET_NAMES.anthropicOauth]: OAUTH });
  const home = mkdtempSync(join(tmpdir(), "fr-allowance-"));
  const start = async (env: Record<string, string> = {}) => {
    const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home, ...env },
      dirs,
      clock: new SimulatedClock("2026-10-31T09:00:00Z"),
      stateUrl: `sqlite:${join(dirs.data, "state.sqlite")}`,
      vault,
      sdkQuery: noSdk,
      chfPerUsd: 0.8,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    runtimes.push(rt);
    const { app, token } = createDaemonApp(rt);
    const req = async (method: string, body?: unknown) => {
      const r = await app.request("/settings/plan-allowance", {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    const rowAllowance = async () =>
      (await rt.billing.sources()).find((s) => s.kind === "subscription")?.limits.planUsdMicro;
    return { rt, dirs, req, rowAllowance };
  };
  afterAll(async () => {
    for (const rt of runtimes) await rt.close().catch(() => undefined);
  });

  it("shows the default in CHF, stores what the person enters in USD, and keeps it after a restart", async () => {
    const first = await start();
    const before = (await first.req("GET")).body as PlanAllowanceView;
    expect(before).toMatchObject({
      subscription: true,
      usdMonthly: 50,
      chfMonthly: 40,
      chfPerUsd: 0.8,
      origin: "default",
      overridden: false,
      stopShare: 0.95,
    });

    // A Max subscriber enters CHF 160 a month.
    const saved = await first.req("POST", { chfMonthly: 160 });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ usdMonthly: 200, chfMonthly: 160, origin: "config" });
    expect(await first.rowAllowance()).toBe(200_000_000);
    expect(first.rt.billing.planAllowance).toMatchObject({ usdMonthly: 200, origin: "config" });
    const file = JSON.parse(readFileSync(configPath(first.dirs), "utf8")) as SetupConfig;
    expect(file.subscription).toEqual({ planUsdMonthly: 200 });

    // An amount that is not one is refused in words, and nothing changes.
    const refused = await first.req("POST", { chfMonthly: -5 });
    expect(refused.status).toBe(400);
    expect(String(refused.body.message)).toContain("positive amount of CHF per month");
    expect(await first.rowAllowance()).toBe(200_000_000);

    await first.rt.close();
    const second = await start();
    expect(second.rt.billing.planAllowance).toMatchObject({ usdMonthly: 200, origin: "config" });
    expect(await second.rowAllowance()).toBe(200_000_000);
    expect(((await second.req("GET")).body as PlanAllowanceView).chfMonthly).toBe(160);
    await second.rt.close();

    // FORERUNNER_PLAN_USD_MONTHLY decides when it is set: the field says so and stores nothing.
    const third = await start({ FORERUNNER_PLAN_USD_MONTHLY: "300" });
    expect((await third.req("GET")).body).toMatchObject({
      usdMonthly: 300,
      origin: "env",
      overridden: true,
    });
    const blocked = await third.req("POST", { chfMonthly: 400 });
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.message)).toContain("FORERUNNER_PLAN_USD_MONTHLY");
  }, 120_000);
});
