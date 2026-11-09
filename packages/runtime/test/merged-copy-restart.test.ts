import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { GitHubHost } from "@forerunner/capabilities";
import { appDirs, dirname, join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost, FakeProvider } from "@forerunner/testenv";
import { MemoryVault } from "@forerunner/vault";
import { afterEach, describe, expect, it } from "vitest";
import { composeRuntime, type RuntimeApp } from "../src/daemon/compose.ts";
import { SECRET_NAMES } from "../src/setup/wizard.ts";

/**
 * This computer's copy across a restart (leftovers7-tailmerge, TM-9; validation rule 4): when
 * the copy stops following what is merged (R-copystuck), why is a file in the copy's `.git`
 * (`CopyRecord.stopped`). The runtime composed twice on one home still says so on Files, also
 * after the first refresh of the new daemon, and follows again once the person's change is
 * put away.
 */
const identity = { name: "Alice (Forerunner)", email: "alice@example.test" };
const FULL = "alice/app";
const roots: string[] = [];
const hosts: FakeGitHost[] = [];
const apps: RuntimeApp[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => undefined);
  for (const h of hosts.splice(0)) await h.stop();
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe("leftovers7-tailmerge, wave 13", { timeout: 180_000 }, () => {
  it("a copy that stopped following still says so after the daemon restarts, with the file, and follows again once it is moved away (TM-9)", async () => {
    const clock = new SimulatedClock("2026-11-09T09:00:00Z");
    const home = mkdtempSync(join(tmpdir(), "fr-copy-restart-"));
    roots.push(home);
    const host = await FakeGitHost.start({ rootDir: join(home, "host"), clock });
    hosts.push(host);
    host.createUser({ login: "alice", name: "Alice", email: identity.email });
    await host.createRepo({
      owner: "alice",
      name: "app",
      private: true,
      defaultBranch: "main",
      initialFiles: { "README.md": "# app\n" },
    });
    const ghToken = host.createToken({ owner: "alice", kind: "classic", scopes: ["repo"] }).token;
    const env = { FORERUNNER_HOME: home };
    const dirs = appDirs({ env });
    const vault = new MemoryVault();
    await vault.set(SECRET_NAMES.github, ghToken);
    const stateUrl = `sqlite:${join(home, "state.sqlite")}`;
    const compose = () =>
      composeRuntime({
        env,
        dirs,
        config: {
          version: 1,
          profile: "default",
          timezone: "UTC",
          githubApiBase: host.baseUrl,
          anthropicApiBase: "http://an.test",
          repos: [],
          credentials: { github: true, anthropic: false, anthropicSubscription: false },
          stateUrl,
        },
        clock,
        stateUrl,
        vault,
        gitHost: new GitHubHost({ token: ghToken, baseUrl: host.baseUrl, clock }),
        provider: new FakeProvider({ replies: [], clock, latency: "none" }),
        registryDir: join(process.cwd(), "evals", "registry"),
        identity: { humanName: "J", timezone: "Europe/Zurich", agentName: "Alice" },
        appVersion: "0.1.0-test",
        startServices: false,
      });

    // ---- the first daemon: the copy follows main, then stops at the person's change -------
    const rt = await compose();
    apps.push(rt);
    const project = await rt.store.project.insert({
      name: "App",
      goal: "Ship the app",
      repos: [FULL],
      stage: "build",
      status: "active",
      budget_usd_micro: 10_000_000,
      autonomy_level: 2,
      summary_cache: {},
      data_assets: [],
      settings: { members: [rt.agent.id] },
      small_project_mode: false,
      active: true,
    });
    expect(await rt.docs.refreshCopy(project)).toEqual({ refreshed: true });
    const local = rt.docs.copyView(project)?.localOnly?.folder ?? "";
    expect(local).not.toBe("");
    const copy = dirname(local);
    // The person edits README.md in the copy; a merge on GitHub then changes it too.
    writeFileSync(join(copy, "README.md"), "# my own notes\n");
    await host.seedCommit(FULL, { "README.md": "# app, merged\n" }, "Merge the readme", "main");
    await clock.advance(60_000);
    await rt.docs.refreshCopy(project);
    const stopped = rt.docs.copyView(project)?.stopped;
    expect(stopped).toEqual({
      reason: "changed",
      files: ["README.md"],
      line: "You changed README.md in this copy, and a merge changed it too: move your change out of the way and the copy follows again.",
    });
    const updatedAt = rt.docs.copyView(project)?.updatedAt;
    await rt.close();
    apps.splice(apps.indexOf(rt), 1);

    // ---- the second daemon on the same home: Files still says it, before and after a refresh --
    const again = await compose();
    apps.push(again);
    const reread = await again.store.project.mustGet(project.id);
    expect(again.docs.copyView(reread)).toMatchObject({ updatedAt, stopped });
    await clock.advance(60_000);
    await again.docs.refreshCopy(reread);
    expect(again.docs.copyView(reread)).toMatchObject({ updatedAt, stopped });
    // Put back: the next refresh brings the copy to what is merged and says nothing more.
    writeFileSync(join(copy, "README.md"), "# app\n");
    await clock.advance(60_000);
    await again.docs.refreshCopy(reread);
    const after = again.docs.copyView(reread);
    expect(after?.stopped ?? null).toBeNull();
    expect(after?.updatedAt).toBe(clock.nowIso());
  });
});
