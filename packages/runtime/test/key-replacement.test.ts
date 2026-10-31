import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, SimulatedClock } from "@forerunner/platform";
import { MemoryVault } from "@forerunner/vault";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { createDaemonApp } from "../src/daemon/server.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * U-049: a key replaced in the app (a revoked Claude key, an expired GitHub token) was saved
 * but the model provider and the git host kept the one read when the service started, until a
 * restart nothing announced. The person replaces each one through the setup assistant's routes
 * (what Settings → Accounts and keys opens); the very next chat message and the next GitHub
 * call use the new one, `GET /setup` asks for no restart, and after a restart the new ones
 * still stand.
 */
const REGISTRY = join(process.cwd(), "evals", "registry");
// Credential-shaped fixtures, built by concatenation so no scanner sees a token.
const KEY_A = ["sk-ant-api03-", "first", "1".repeat(40)].join(""); // not-a-secret
const KEY_B = ["sk-ant-api03-", "second", "2".repeat(40)].join(""); // not-a-secret
const GH_A = ["github_pat_", "first_", "1".repeat(40)].join(""); // not-a-secret
const GH_B = ["github_pat_", "second_", "2".repeat(40)].join(""); // not-a-secret

function sse(text: string): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "m1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    },
    { type: "message_stop" },
  ];
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("a replaced key is used at once (U-049)", () => {
  const runtimes: RuntimeApp[] = [];
  const messagesKeys: string[] = [];
  const githubAuth: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const r = input instanceof Request ? input : null;
    const url = new URL(String(r ? r.url : input));
    const headers = new Headers(init?.headers ?? r?.headers);
    if (url.pathname === "/v1/messages") {
      messagesKeys.push(headers.get("x-api-key") ?? "");
      return sse("Hi.");
    }
    if (url.pathname === "/v1/models")
      return json({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }] });
    if (url.pathname === "/user") return json({ login: "joel" });
    if (url.pathname === "/repos/joel/site") {
      githubAuth.push(headers.get("authorization") ?? "");
      return json({
        name: "site",
        full_name: "joel/site",
        owner: { login: "joel" },
        default_branch: "main",
        clone_url: "https://github.com/joel/site.git",
      });
    }
    return new Response("not here", { status: 404 });
  };
  const vault = new MemoryVault();
  const home = mkdtempSync(join(tmpdir(), "fr-keyswap-"));
  const dirs = appDirs({ env: { FORERUNNER_HOME: home } });
  const start = async () => {
    const rt = await composeRuntime({
      env: { FORERUNNER_HOME: home },
      dirs,
      config: null,
      clock: new SimulatedClock("2026-10-31T09:00:00Z"),
      stateUrl: `sqlite:${join(dirs.data, "state.sqlite")}`,
      vault,
      fetchImpl,
      registryDir: REGISTRY,
      identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
      appVersion: "0.1.0-test",
    });
    runtimes.push(rt);
    const { app, token } = createDaemonApp(rt);
    const req = (path: string, body?: unknown) =>
      app.request(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const chat = async (text: string) => {
      const r = await req("/chat", { humanId: rt.human.id, agentId: rt.agent.id, text });
      return ((await r.json()) as { reply: string }).reply;
    };
    return { rt, req, chat };
  };
  beforeAll(() => {
    // Nothing reaches the network, whichever fetch a part of the runtime uses.
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl);
  });
  afterAll(async () => {
    for (const rt of runtimes) await rt.close().catch(() => undefined);
    vi.restoreAllMocks();
  });

  it("the next chat message and the next GitHub call use the new key, without a restart, and after one", async () => {
    await vault.set(SECRET_NAMES.anthropic, KEY_A);
    await vault.set(SECRET_NAMES.github, GH_A);
    const first = await start();
    expect(await first.chat("hello")).toBe("Hi.");
    expect(messagesKeys).toEqual([KEY_A]);
    await first.rt.gitHost.getRepo({ owner: "joel", name: "site" });
    expect(githubAuth).toEqual([`Bearer ${GH_A}`]);

    // Settings → Accounts and keys: paste a new Claude key, then a new GitHub token.
    const claude = (await (await first.req("/setup/anthropic", { value: KEY_B })).json()) as {
      ok: boolean;
      status: { restartNeeded: boolean };
    };
    expect(claude.ok).toBe(true);
    const github = (await (await first.req("/setup/github", { token: GH_B })).json()) as {
      ok: boolean;
      status: { restartNeeded: boolean };
    };
    expect(github.ok).toBe(true);
    expect(github.status.restartNeeded).toBe(false);

    expect(await first.chat("hello again")).toBe("Hi.");
    expect(messagesKeys).toEqual([KEY_A, KEY_B]);
    await first.rt.gitHost.getRepo({ owner: "joel", name: "site" });
    expect(githubAuth).toEqual([`Bearer ${GH_A}`, `Bearer ${GH_B}`]);

    // Across a restart the new ones stand.
    await first.rt.close();
    const second = await start();
    expect(await second.chat("still there?")).toBe("Hi.");
    expect(messagesKeys.at(-1)).toBe(KEY_B);
    await second.rt.gitHost.getRepo({ owner: "joel", name: "site" });
    expect(githubAuth.at(-1)).toBe(`Bearer ${GH_B}`);
  }, 120_000);
});
