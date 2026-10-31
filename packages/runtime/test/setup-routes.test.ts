import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { appDirs, join, systemClock } from "@forerunner/platform";
import type { StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { describe, expect, it } from "vitest";
import {
  createSetupRoutes,
  GITHUB_TOKEN_URL,
  type SetupCheckView,
  type SetupStatusView,
} from "../src/setup/routes.ts";
import { readConfig, SECRET_NAMES } from "../src/setup/wizard.ts";
import type { RestartRequest } from "../src/update/ports.ts";

/**
 * The app's setup assistant (ADR 0092). 1.0.0 took credentials only through `fr setup` in a
 * terminal, which a new user of the MSI does not have; the app opened on a fake provider. The
 * routes check a pasted value with the same validators, store it by name only when it passes,
 * never echo it, and restart the daemon once so the runtime composes with it.
 */

// Credential-shaped values built by concatenation so no scanner sees a token. // not-a-secret
const GH_TOKEN = ["github_pat_", "setup_routes_", "1".repeat(40)].join(""); // not-a-secret
const BAD_GH_TOKEN = ["github_pat_", "setup_routes_", "0".repeat(40)].join(""); // not-a-secret
const API_KEY = ["sk-ant-api03-", "setuproutes", "2".repeat(60)].join(""); // not-a-secret
const SUB_TOKEN = ["sk-ant-oat01-", "setuproutes", "3".repeat(60)].join(""); // not-a-secret

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.host === "gh.test" && url.pathname === "/user") {
      return headers.get("authorization") === `Bearer ${GH_TOKEN}`
        ? json({ login: "joel" })
        : new Response("", { status: 401 });
    }
    if (url.host === "gh.test" && url.pathname === "/repos/joel/site") {
      return json({ permissions: { pull: true, push: true, admin: false } });
    }
    if (url.host === "an.test" && url.pathname === "/v1/models") {
      return headers.get("x-api-key") === API_KEY
        ? json({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-sonnet-5-5" }] })
        : new Response("", { status: 401 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function harness(initial: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "fr-setup-routes-"));
  const env = {
    FORERUNNER_HOME: home,
    FORERUNNER_GITHUB_API: "http://gh.test",
    FORERUNNER_ANTHROPIC_API: "http://an.test",
    // Never read by the routes: only the pasted value counts.
    FORERUNNER_GITHUB_TOKEN: BAD_GH_TOKEN,
  };
  const dirs = appDirs({ env });
  const vault = new MemoryVault(initial);
  const human = { id: "h1", name: "Dada-", timezone: "UTC" };
  const audit: Record<string, unknown>[] = [];
  const store = {
    human: {
      get: async () => ({ ...human }),
      patch: async (_id: string, p: Partial<typeof human>) => Object.assign(human, p),
    },
    auditLog: { append: async (row: Record<string, unknown>) => audit.push(row) },
  } as unknown as Pick<StateStore, "human" | "auditLog">;
  const restarts: RestartRequest[] = [];
  const app = createSetupRoutes({
    dirs,
    vault,
    env,
    clock: systemClock,
    store,
    humanId: "h1",
    appVersion: "1.0.1",
    restarter: { restart: async (r) => void restarts.push(r) },
    fetchImpl: fakeFetch(),
    restartDelayMs: 0,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { dirs, vault, human, audit, restarts, call };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("setup assistant routes (ADR 0092)", () => {
  it("a fresh install shows the assistant with nothing stored and the links to get each credential", async () => {
    const h = harness();
    const { status, body } = await h.call("GET", "/setup");
    const view = body as unknown as SetupStatusView;
    expect(status).toBe(200);
    expect(view.complete).toBe(false);
    expect(view.showAssistant).toBe(true);
    expect(view.credentials).toEqual({
      github: false,
      anthropicApiKey: false,
      subscription: false,
    });
    expect(view.restartNeeded).toBe(false);
    expect(view.name).toBe("Dada-");
    expect(view.links.githubToken).toBe(GITHUB_TOKEN_URL);
    // The GitHub form opens with the permissions the setup guide lists, not Workflows.
    for (const p of [
      "contents=write",
      "pull_requests=write",
      "issues=write",
      "statuses=read",
      "metadata=read",
    ]) {
      expect(GITHUB_TOKEN_URL).toContain(p);
    }
    expect(view.githubPermissions.join("\n")).toContain("Commit statuses: read");
    expect(view.githubPermissions.join("\n")).not.toContain("Workflows");
  });

  it("an API key that passes is stored by name and never echoed; a wrong one is explained and not stored", async () => {
    const h = harness();
    const bad = await h.call("POST", "/setup/anthropic", { value: `${API_KEY}x` });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.summary).toMatch(/401/);
    expect(await h.vault.has(SECRET_NAMES.anthropic)).toBe(false);

    const good = await h.call("POST", "/setup/anthropic", { value: `  ${API_KEY}\n` });
    const view = good.body as unknown as SetupCheckView;
    expect(view.ok).toBe(true);
    expect(view.kind).toBe("api_key");
    expect(await h.vault.get(SECRET_NAMES.anthropic)).toBe(API_KEY);
    expect(view.status.credentials.anthropicApiKey).toBe(true);
    expect(view.status.restartNeeded).toBe(true);
    const everything = JSON.stringify([bad.body, good.body, h.audit]);
    expect(everything).not.toContain(API_KEY);
    expect(readFileSync(join(h.dirs.config, "config.json"), "utf8")).not.toContain(API_KEY);
    expect(h.audit.map((a) => [a.tool, a.allowed, a.input_summary])).toEqual([
      ["setup.credential", false, `name: ${SECRET_NAMES.anthropic}`],
      ["setup.credential", true, `name: ${SECRET_NAMES.anthropic}`],
    ]);
  });

  it("a subscription token is told apart by its prefix and stored under its own name", async () => {
    const h = harness();
    const r = await h.call("POST", "/setup/anthropic", { value: SUB_TOKEN });
    expect(r.body.ok).toBe(true);
    expect(r.body.kind).toBe("subscription");
    expect(await h.vault.get(SECRET_NAMES.anthropicOauth)).toBe(SUB_TOKEN);
    expect(await h.vault.has(SECRET_NAMES.anthropic)).toBe(false);
  });

  it("a value pasted in the wrong box is refused with what belongs there", async () => {
    const h = harness();
    const a = await h.call("POST", "/setup/anthropic", { value: GH_TOKEN });
    expect(a.status).toBe(400);
    expect(String(a.body.message)).toMatch(/GitHub token/);
    const g = await h.call("POST", "/setup/github", { token: API_KEY });
    expect(g.status).toBe(400);
    expect(String(g.body.message)).toMatch(/Anthropic credential/);
    expect(await h.vault.list()).toEqual([]);
    expect(JSON.stringify([a.body, g.body])).not.toContain(API_KEY);
  });

  it("a GitHub token is checked against the API (and the repositories given) before it is stored", async () => {
    const h = harness();
    const bad = await h.call("POST", "/setup/github", { token: BAD_GH_TOKEN });
    expect(bad.body.ok).toBe(false);
    expect(await h.vault.has(SECRET_NAMES.github)).toBe(false);

    const good = await h.call("POST", "/setup/github", { token: GH_TOKEN, repos: ["joel/site"] });
    expect(good.body.ok).toBe(true);
    expect(good.body.login).toBe("joel");
    expect(await h.vault.get(SECRET_NAMES.github)).toBe(GH_TOKEN);
    expect(readConfig(h.dirs)?.repos).toEqual(["joel/site"]);
    expect(JSON.stringify(good.body)).not.toContain(GH_TOKEN);

    const malformed = await h.call("POST", "/setup/github", {
      token: GH_TOKEN,
      repos: ["not a repo"],
    });
    expect(malformed.status).toBe(400);
  });

  it("the profile step names the human and sets the time zone, refusing an unknown zone", async () => {
    const h = harness();
    const r = await h.call("POST", "/setup/profile", { name: "Joel", timezone: "Europe/Zurich" });
    expect(r.status).toBe(200);
    expect(h.human).toMatchObject({ name: "Joel", timezone: "Europe/Zurich" });
    expect(readConfig(h.dirs)).toMatchObject({ humanName: "Joel", timezone: "Europe/Zurich" });
    const bad = await h.call("POST", "/setup/profile", { timezone: "Mars/Olympus" });
    expect(bad.status).toBe(400);
  });

  it("finish restarts the daemon once when a credential is new, and the assistant stays closed", async () => {
    const h = harness();
    await h.call("POST", "/setup/anthropic", { value: API_KEY });
    const done = await h.call("POST", "/setup/finish");
    expect(done.body.restarting).toBe(true);
    await settle();
    expect(h.restarts).toEqual([{ reason: "setup", targetVersion: "1.0.1", fromVersion: "1.0.1" }]);
    expect(readConfig(h.dirs)?.setupAcknowledgedAt).toEqual(expect.any(String));
    const after = (await h.call("GET", "/setup")).body as unknown as SetupStatusView;
    // GitHub was skipped: not complete, but closed until the human opens it from Settings.
    expect(after.complete).toBe(false);
    expect(after.showAssistant).toBe(false);
  });

  it("finish without anything new does not restart; complete credentials never show the assistant", async () => {
    const h = harness({ [SECRET_NAMES.github]: GH_TOKEN, [SECRET_NAMES.anthropic]: API_KEY });
    const view = (await h.call("GET", "/setup")).body as unknown as SetupStatusView;
    expect(view.complete).toBe(true);
    expect(view.showAssistant).toBe(false);
    const done = await h.call("POST", "/setup/finish");
    expect(done.body.restarting).toBe(false);
    await settle();
    expect(h.restarts).toEqual([]);
  });
});

describe("a pasted value with a line break (U-053)", () => {
  it("a key or token with a line break inside is refused in words that never show it", async () => {
    const h = harness();
    // What a paste from a wrapped e-mail or a PDF sends: the key broken in two.
    const brokenKey = `${API_KEY.slice(0, 30)}\n${API_KEY.slice(30)}`;
    const claude = await h.call("POST", "/setup/anthropic", { value: brokenKey });
    expect(claude.status).toBe(200);
    expect(claude.body).toMatchObject({ ok: false });
    const said = JSON.stringify(claude.body);
    expect(said).toContain("line break");
    expect(said).not.toContain(API_KEY.slice(0, 30));
    expect(said).not.toContain(API_KEY.slice(30));
    expect(await h.vault.has(SECRET_NAMES.anthropic)).toBe(false);

    const brokenToken = `${GH_TOKEN.slice(0, 25)}\r\n${GH_TOKEN.slice(25)}`;
    const github = await h.call("POST", "/setup/github", { token: brokenToken });
    expect(github.body).toMatchObject({ ok: false });
    const saidGh = JSON.stringify(github.body);
    expect(saidGh).toContain("line break");
    expect(saidGh).not.toContain(GH_TOKEN.slice(0, 25));
    expect(saidGh).not.toContain(GH_TOKEN.slice(25));
    expect(await h.vault.has(SECRET_NAMES.github)).toBe(false);
    // The audit row names the credential, never the value.
    expect(JSON.stringify(h.audit)).not.toContain(GH_TOKEN.slice(25));
  });
});
