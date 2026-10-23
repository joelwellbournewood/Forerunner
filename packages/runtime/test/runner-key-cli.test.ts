import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import type { HumanRequestRow } from "@forerunner/state";
import {
  MemoryVault,
  openVault,
  runnerKeySecretName,
  UNLOCK_CARD_KIND,
  UNLOCK_HKDF_INFO_PREFIX,
  UNLOCK_PROTOCOL_VERSION,
} from "@forerunner/vault";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../src/cli/main.ts";
import { RunnerUnlockAnswerView } from "../src/daemon/api-types.ts";
import { parseRunnerKeyFile, registerRunnerKeyCli } from "../src/secrets/runner-key-cli.ts";
import { createRunnerUnlockRoutes } from "../src/secrets/runner-unlock-routes.ts";

/**
 * `fr runner-key` (spec S.12, ADR 0068, review finding 3): the human's way to put a cloud
 * runner's vault key where the desktop daemon looks for it. The key comes from a file, lands
 * under `cloud_runner_vault_key:<runner>`, is never printed, and is exactly what the daemon's
 * wrap route then hands the runner (unwrapped here as the runner does).
 */
const SPKI = Buffer.from("302a300506032b656e032100", "hex");
const RUNNER = "runner-eu";
const encodings = (b: Buffer) => [b.toString("base64"), b.toString("hex"), b.toString("base64url")];

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "fr-runner-key-"));
}

function cli(vault: MemoryVault, cwd: string) {
  const lines: string[] = [];
  const program = new Command().exitOverride();
  registerRunnerKeyCli(program, {
    open: async () => vault,
    out: (l) => lines.push(l),
    cwd: () => cwd,
  });
  const run = (...args: string[]) => program.parseAsync(["node", "fr", "runner-key", ...args]);
  return { run, lines };
}

/** The daemon route over `vault`, with one open unlock request filed by a runner. */
async function wrapThroughDaemon(vault: MemoryVault) {
  const clock = new SimulatedClock("2026-10-23T09:00:00Z");
  const pair = generateKeyPairSync("x25519");
  const nonce = randomBytes(32);
  const card = {
    kind: UNLOCK_CARD_KIND,
    version: UNLOCK_PROTOCOL_VERSION,
    runnerId: RUNNER,
    challengeId: randomUUID(),
    runnerPublicKey: pair.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(SPKI.length)
      .toString("base64"),
    nonce: nonce.toString("base64"),
    expiresAt: new Date(clock.now() + 600_000).toISOString(),
  };
  const row = {
    id: "req_unlock",
    human_id: "human_ada",
    kind: "credential",
    status: "open",
    change_card: card,
  } as unknown as HumanRequestRow;
  const app = createRunnerUnlockRoutes({
    vault,
    clock,
    auditLog: { append: async () => ({}) as never },
    requests: { get: async (id: string) => (id === row.id ? row : undefined) as never },
    humanId: () => "human_ada",
  });
  const res = await app.request("/runner-unlock/wrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requestId: row.id }),
  });
  expect(res.status).toBe(200);
  const answer = RunnerUnlockAnswerView.parse(await res.json());
  const device = createPublicKey({
    key: Buffer.concat([SPKI, Buffer.from(answer.devicePublicKey, "base64")]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: pair.privateKey, publicKey: device });
  const wrap = Buffer.from(
    hkdfSync("sha256", shared, nonce, `${UNLOCK_HKDF_INFO_PREFIX}${card.challengeId}`, 32),
  );
  const d = createDecipheriv("aes-256-gcm", wrap, Buffer.from(answer.iv, "base64"));
  d.setAAD(Buffer.from(`${RUNNER}:${card.challengeId}`));
  d.setAuthTag(Buffer.from(answer.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(answer.ciphertext, "base64")), d.final()]);
}

describe("fr runner-key", () => {
  it("imports a raw vault.key; the daemon's wrap route then hands the runner exactly that key", async () => {
    const dir = scratch();
    const key = randomBytes(32);
    writeFileSync(join(dir, "vault.key"), key);
    const vault = new MemoryVault();
    const { run, lines } = cli(vault, dir);
    await run("import", RUNNER, "vault.key");
    expect(lines.join("\n")).toContain(`Stored the vault key of runner "${RUNNER}"`);
    expect(await vault.get(runnerKeySecretName(RUNNER))).toBe(key.toString("base64"));
    expect((await wrapThroughDaemon(vault)).equals(key)).toBe(true);

    await run("status", RUNNER);
    expect(lines.at(-1)).toBe("cloud_runner_vault_key:runner-eu: present in the memory vault");
    for (const enc of encodings(key)) expect(lines.join("\n")).not.toContain(enc);
  });

  it("accepts the base64 of the key and replaces an older one", async () => {
    const dir = scratch();
    const vault = new MemoryVault();
    await vault.set(runnerKeySecretName(RUNNER), randomBytes(32).toString("base64"));
    const key = randomBytes(32);
    const file = join(dir, "key.txt");
    writeFileSync(file, `${key.toString("base64")}\n`);
    const { run, lines } = cli(vault, "/elsewhere");
    await run("import", RUNNER, file);
    expect(lines.at(-1)).toMatch(/^Replaced the vault key/);
    expect((await wrapThroughDaemon(vault)).equals(key)).toBe(true);
    for (const enc of encodings(key)) expect(lines.join("\n")).not.toContain(enc);
  });

  it("refuses a file that is not a 32-byte key and stores nothing", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "short.key"), randomBytes(16));
    writeFileSync(join(dir, "text.key"), "not a key at all");
    const vault = new MemoryVault();
    const { run } = cli(vault, dir);
    await expect(run("import", RUNNER, "short.key")).rejects.toMatchObject({
      code: "validation",
    });
    await expect(run("import", RUNNER, "text.key")).rejects.toMatchObject({ code: "validation" });
    expect(await vault.list()).toEqual([]);
    expect(parseRunnerKeyFile(new Uint8Array(32).fill(7))).toEqual(new Uint8Array(32).fill(7));
    expect(parseRunnerKeyFile(new TextEncoder().encode("c2hvcnQ="))).toBeNull();
  });

  it("status says missing with the import hint; remove deletes the entry", async () => {
    const vault = new MemoryVault();
    await vault.set(runnerKeySecretName(RUNNER), randomBytes(32).toString("base64"));
    const { run, lines } = cli(vault, "/");
    await run("remove", RUNNER);
    expect(lines.at(-1)).toBe("Removed cloud_runner_vault_key:runner-eu.");
    await run("status", RUNNER);
    expect(lines.at(-1)).toContain("missing from the memory vault (fr runner-key import runner-eu");
    await run("remove", RUNNER);
    expect(lines.at(-1)).toBe("cloud_runner_vault_key:runner-eu was not stored.");
  });

  it("is wired into fr and writes the vault the daemon opens for the profile", async () => {
    const home = scratch();
    const env = {
      FORERUNNER_HOME: home,
      FORERUNNER_VAULT_BACKEND: "file",
      FORERUNNER_LOG_LEVEL: "error",
    };
    const key = randomBytes(32);
    writeFileSync(join(home, "runner.key"), key);
    const lines: string[] = [];
    await buildProgram({ env, out: (l) => lines.push(l), cwd: () => home }).parseAsync([
      "node",
      "fr",
      "runner-key",
      "import",
      RUNNER,
      "runner.key",
    ]);
    expect(lines.join("\n")).toContain("in the file vault");
    // The daemon's own open (compose.ts): the config's profile, else "default", this env.
    const vault = await openVault({ profile: "default", env });
    expect(await vault.get(runnerKeySecretName(RUNNER))).toBe(key.toString("base64"));
  });
});
