import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { FakeProvider, textReply } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommandResultViewSchema,
  DAEMON_ROUTES,
  ModelSettingsView,
} from "../src/daemon/api-types.ts";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { pricingFor } from "../src/wiring/billing-ports.ts";

/**
 * The daemon side of spec D.4 (ADR 0072): `GET /settings/models` shows the settings in force per
 * agent mode and per specialist, temperature only for a provider that accepts one, and
 * `model.settings.set` on `POST /commands/execute` writes the principal's `model_config` with a
 * change card, a change log row and an undo.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");

const apps: RuntimeApp[] = [];
afterEach(async () => {
  for (const rt of apps.splice(0)) await rt.close();
});

async function daemon(acceptsTemperature: boolean, opts: { providerName?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fr-model-settings-"));
  const clock = new SimulatedClock("2026-10-23T08:00:00Z");
  const provider = new FakeProvider({
    clock,
    latency: "none",
    capabilities: { acceptsTemperature },
  });
  // Under another name (e.g. "anthropic", so the daemon prices calls from the price table and
  // the ladder names Claude ids); the fake still answers and records every call.
  // Every use goes through the wrapper (the fake's script state then lives on it).
  const named: FakeProvider = opts.providerName
    ? Object.create(provider, { name: { value: opts.providerName } })
    : provider;
  const rt = await composeRuntime({
    env: { FORERUNNER_HOME: home },
    dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
    config: null,
    clock,
    stateUrl: "sqlite::memory:",
    vault: new MemoryVault(),
    provider: named,
    registryDir: REGISTRY,
    identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
    appVersion: "0.1.0-test",
  });
  apps.push(rt);
  const { app, token } = createDaemonApp(rt);
  const req = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
  const view = async () => ModelSettingsView.parse(await (await req("/settings/models")).json());
  const execute = async (params: Record<string, unknown>, confirm?: "tap") =>
    CommandResultViewSchema.parse(
      await (
        await req("/commands/execute", {
          method: "POST",
          body: JSON.stringify({
            commands: [{ name: "model.settings.set", params }],
            wordsUsed: `Settings: ${JSON.stringify(params)}`,
            source: "ui",
            ...(confirm ? { confirm } : {}),
          }),
        })
      ).json(),
    );
  return { rt, req, view, execute, provider: named };
}

describe("GET /settings/models and model.settings.set (spec D.4)", () => {
  it("is listed in the route table", () => {
    expect(DAEMON_ROUTES.modelSettings).toMatch(/^GET \/settings\/models/);
  });

  it("serves the agents and the ten specialists with the effort-table defaults, no temperature", async () => {
    const d = await daemon(false);
    const v = await d.view();
    expect(v.provider).toEqual({ name: "fake", acceptsTemperature: false, fastMode: false });
    const alice = v.agents.find((a) => a.kind === "principal");
    expect(alice).toMatchObject({ name: "Alice", editable: true });
    expect(alice?.modes.find((m) => m.mode === "planning")).toMatchObject({
      model: "fake-sonnet",
      maxTokens: { value: 16_000, source: "table" },
      timeoutMinutes: { value: 5 },
    });
    expect(v.agents.find((a) => a.kind === "critic")?.editable).toBe(false);
    expect(v.specialists).toHaveLength(10);
    const coder = v.specialists.find((s) => s.name === "coder");
    expect(coder?.settings).toMatchObject({
      tier: { value: "sonnet", source: "specialist" },
      maxTokens: { value: 4096, source: "table" },
      speedMode: { value: "standard", source: "table" },
      timeoutMinutes: { value: 45, source: "specialist" },
    });
    for (const s of v.specialists) expect(s.settings).not.toHaveProperty("temperature");
  });

  it("writes an override with a change log row, shows it, and undoes it", async () => {
    const d = await daemon(false);
    const r = await d.execute({ specialist: "coder", field: "max_tokens", value: 8000 });
    expect(r.status).toBe("done");
    expect(r.sentence).toBe(
      "Set the max tokens per call of the coder specialist for Alice from the default to 8000. Undo.",
    );
    expect((await d.rt.store.agent.mustGet(d.rt.agent.id)).model_config).toEqual({
      specialists: { coder: { max_tokens: 8000 } },
    });
    const coder = (await d.view()).specialists.find((s) => s.name === "coder");
    expect(coder?.settings.maxTokens).toEqual({
      value: 8000,
      default: 4096,
      source: "agent",
      defaultSource: "table",
    });
    const row = await d.rt.store.changeLog.mustGet(r.changeLogId as string);
    expect(row).toMatchObject({ source: "ui", sentence: r.sentence, scope: "global" });
    expect(JSON.stringify(row.commands)).toContain("model.settings.set");
    const undo = await d.req(`/changes/${r.changeLogId}/undo`, { method: "POST", body: "{}" });
    expect(undo.status).toBe(200);
    expect((await d.rt.store.agent.mustGet(d.rt.agent.id)).model_config).toEqual({});
  });

  it("asks for a yes before a costlier rung, and refuses bad values and unknown specialists", async () => {
    const d = await daemon(false);
    const pending = await d.execute({ mode: "planning", field: "tier", value: "opus" });
    expect(pending.status).toBe("pending");
    const tapped = await d.execute({ mode: "planning", field: "tier", value: "opus" }, "tap");
    expect(tapped.status).toBe("done");
    expect((await d.view()).agents[0]?.modes[0]?.tier).toMatchObject({
      value: "opus",
      source: "agent",
    });
    const tooMany = await d.execute({ specialist: "coder", field: "max_tokens", value: 500_000 });
    expect(tooMany).toMatchObject({ status: "refused", code: "validation" });
    const unknown = await d.execute({ specialist: "nobody", field: "max_tokens", value: 100 });
    expect(unknown).toMatchObject({ status: "refused", code: "not_found" });
    const badSpeed = await d.execute({ specialist: "coder", field: "speed_mode", value: "warp" });
    expect(badSpeed).toMatchObject({ status: "refused", code: "validation" });
    // The registry's coder says max_effort high: max is refused, high is taken.
    const tooHard = await d.execute({ specialist: "coder", field: "effort", value: "max" }, "tap");
    expect(tooHard).toMatchObject({ status: "refused", code: "validation" });
    expect(tooHard.reason).toMatch(/at most at high/);
    expect(
      (await d.execute({ specialist: "coder", field: "effort", value: "high" }, "tap")).status,
    ).toBe("done");
  });

  it("prices a chat turn as the rung the human chose, not the table's (composed daemon)", async () => {
    const d = await daemon(false, { providerName: "anthropic" });
    const usage = {
      input_tokens: 2000,
      output_tokens: 300,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const chat = async () => {
      d.provider.pushReplies(textReply("ok", { usage, ttftMs: 0 }));
      const conversation = d.rt.conversation;
      if (!conversation) throw new Error("no conversation agent");
      return conversation.chat({ humanId: d.rt.human.id, agentId: d.rt.agent.id, text: "hello" });
    };
    const table = await chat();
    expect(d.provider.calls.at(-1)?.request.model).toBe("claude-haiku-5-5");

    expect(table.costUsdMicro).toBe(pricingFor("claude-haiku-5-5").cost(usage));
    const set = await d.execute({ mode: "text_chat", field: "tier", value: "opus" }, "tap");
    expect(set.status).toBe("done");
    const opus = await chat();
    expect(d.provider.calls.at(-1)?.request.model).toBe("claude-opus-5-5");
    expect(opus.costUsdMicro).toBe(pricingFor("claude-opus-5-5").cost(usage));
    expect(opus.costUsdMicro).toBeGreaterThan(10 * table.costUsdMicro);
  });

  it("refuses a temperature where the provider accepts none, and shows and stores one where it does", async () => {
    const without = await daemon(false);
    const refused = await without.execute({
      specialist: "coder",
      field: "temperature",
      value: 0.3,
    });
    expect(refused.status).toBe("refused");
    expect(refused.reason).toMatch(/does not accept a temperature/);

    const withTemp = await daemon(true);
    expect((await withTemp.view()).specialists[0]?.settings.temperature).toMatchObject({
      value: null,
      source: "table",
    });
    const set = await withTemp.execute({ specialist: "coder", field: "temperature", value: 0.3 });
    expect(set.status).toBe("done");
    const coder = (await withTemp.view()).specialists.find((s) => s.name === "coder");
    expect(coder?.settings.temperature).toMatchObject({ value: 0.3, source: "agent" });
  });
});
