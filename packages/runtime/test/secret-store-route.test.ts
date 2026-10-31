import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, Logger, type LogRecord, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { STORABLE_SECRET_NAMES } from "../src/secrets/store-types.ts";
import { ScriptedProvider } from "./helpers.ts";

/**
 * U-054: the agent mailbox's password and the cloud voice keys could only be stored with
 * `fr vault set`, which the installed app does not have. `POST /secrets/store` stores one
 * secret from a closed allowlist (never a reserved name, never the install's own credentials);
 * the value goes to the vault and nowhere else: not in the answer, the audit log or a log line.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const PASSWORD = ["app", "pass", "word", "1".repeat(12)].join("-"); // not-a-secret
const DEEPGRAM = ["dg", "0123456789abcdef".repeat(2)].join(""); // not-a-secret

describe("POST /secrets/store (U-054)", () => {
  let rt: RuntimeApp;
  let app: ReturnType<typeof createDaemonApp>["app"];
  let token: string;
  const vault = new MemoryVault();
  const logs: LogRecord[] = [];
  let offLogs: () => void = () => {};
  const req = async (method: string, body?: unknown) => {
    const r = await app.request("/secrets/store", {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, text: await r.text() };
  };

  beforeAll(async () => {
    offLogs = Logger.addSink((r) => logs.push(r));
    const home = mkdtempSync(join(tmpdir(), "fr-secret-store-"));
    const clock = new SimulatedClock("2026-10-31T09:00:00Z");
    rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs: appDirs({ env: { FORERUNNER_HOME: home } }),
      config: null,
      clock,
      stateUrl: "sqlite::memory:",
      vault,
      provider: new ScriptedProvider([{ text: "ok" }], clock),
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    ({ app, token } = createDaemonApp(rt));
  }, 120_000);
  afterAll(async () => {
    offLogs();
    await rt?.close();
  });

  it("lists what the app may store, stores a mailbox password and a voice key, and never sends one back", async () => {
    const before = JSON.parse((await req("GET")).text) as {
      secrets: { name: string; stored: boolean }[];
    };
    expect(before.secrets.map((s) => s.name)).toEqual(STORABLE_SECRET_NAMES);
    expect(before.secrets.every((s) => !s.stored)).toBe(true);

    const mail = await req("POST", { name: "agent_imap_password", value: ` ${PASSWORD} ` });
    expect(mail.status).toBe(200);
    expect(JSON.parse(mail.text)).toEqual({
      name: "agent_imap_password",
      stored: true,
      ref: "secret:agent_imap_password",
    });
    expect(await vault.get("agent_imap_password")).toBe(PASSWORD);
    const voice = await req("POST", { name: "deepgram_api_key", value: DEEPGRAM });
    expect(voice.status).toBe(200);
    expect(await vault.get("deepgram_api_key")).toBe(DEEPGRAM);

    const after = await req("GET");
    expect(after.text).not.toContain(PASSWORD);
    expect(after.text).not.toContain(DEEPGRAM);
    const stored = (JSON.parse(after.text) as { secrets: { name: string; stored: boolean }[] })
      .secrets;
    expect(stored.filter((s) => s.stored).map((s) => s.name)).toEqual([
      "agent_imap_password",
      "deepgram_api_key",
    ]);
    // The audit says which, never what; no log line carries a value.
    const audit = await rt.store.auditLog.list({ tool: "secrets.store" } as never, { limit: 10 });
    expect(audit.map((a) => a.input_summary).sort()).toEqual([
      "name: agent_imap_password",
      "name: deepgram_api_key",
    ]);
    expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
    expect(JSON.stringify(logs)).not.toContain(DEEPGRAM);
  });

  it("refuses a name off the allowlist, a reserved name and the install's own credentials", async () => {
    for (const name of [
      "forerunner.install_wrap_key",
      "github_token",
      "anthropic_api_key",
      "anthropic_subscription_token",
      "my_other_secret",
    ]) {
      const r = await req("POST", { name, value: PASSWORD });
      expect(r.status).toBe(400);
      expect(r.text).toContain("is not a secret the app stores");
      expect(r.text).not.toContain(PASSWORD);
      // Nothing was written under it (the install wrap key may exist: it is the runtime's own).
      expect(await vault.get(name)).not.toBe(PASSWORD);
    }
  });

  it("refuses a value with a line break, or an API key with a space, without quoting it", async () => {
    const broken = await req("POST", {
      name: "agent_smtp_password",
      value: `${PASSWORD.slice(0, 8)}\n${PASSWORD.slice(8)}`,
    });
    expect(broken.status).toBe(400);
    expect(broken.text).toContain("line break inside");
    expect(broken.text).not.toContain(PASSWORD.slice(8));
    const spaced = await req("POST", {
      name: "cartesia_api_key",
      value: `${DEEPGRAM.slice(0, 10)} ${DEEPGRAM.slice(10)}`,
    });
    expect(spaced.status).toBe(400);
    expect(spaced.text).toContain("space inside");
    expect(spaced.text).not.toContain(DEEPGRAM.slice(10));
    expect(await vault.has("agent_smtp_password")).toBe(false);
    expect(await vault.has("cartesia_api_key")).toBe(false);
    // A password may hold spaces (some providers show app passwords in groups of four).
    expect(
      (await req("POST", { name: "agent_smtp_password", value: "abcd efgh ijkl" })).status,
    ).toBe(200);
  });
});
