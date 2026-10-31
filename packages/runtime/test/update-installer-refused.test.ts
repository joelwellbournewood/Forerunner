import { existsSync, readdirSync } from "node:fs";
import { ForerunnerError } from "@forerunner/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubReleasesFeed } from "../src/update/feed.ts";
import { isInstallerArtifact } from "../src/update/manifest.ts";
import { readPointer, versionsRoot } from "../src/update/pointer.ts";
import { StaticExtensionCatalog, StaticModelWatchReport } from "../src/update/ports.ts";
import { createUpdateRoutes } from "../src/update/screen.ts";
import { buildRelease, FakeReleaseServer, makeHarness } from "./update-helpers.ts";

/**
 * U-070: the daemon took an installer (the MSI, the AppImage) as an update. It staged the file
 * as a "version" with no runnable runtime and restarted; the old build came back up, the health
 * check rolled the update back and marked the release rolled back in the shared release table,
 * so every install on that store then refused the real release. An installer is refused before
 * anything is downloaded, staged, recorded or restarted, with a message that says what to do.
 */
const server = new FakeReleaseServer();
let feed: GitHubReleasesFeed;

const INSTALLERS = {
  "windows-x64": "Forerunner_1.2.0_x64_en-US.msi",
  "linux-x64": "Forerunner_1.2.0_amd64.AppImage",
} as const;

beforeAll(async () => {
  await server.start();
  buildRelease(server, {
    version: "1.2.0",
    platforms: ["windows-x64", "linux-x64"],
    names: INSTALLERS,
  });
  feed = new GitHubReleasesFeed({ owner: "owner", repo: "repo", apiBase: server.url });
});
afterAll(() => server.stop());

async function refused(p: Promise<unknown>): Promise<ForerunnerError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ForerunnerError);
  return e as ForerunnerError;
}

describe("an installer is never applied as an update (U-070)", () => {
  it("knows an installer by its file name", () => {
    for (const name of [
      "Forerunner_1.2.0_x64_en-US.msi",
      "Forerunner_1.2.0_x64-setup.EXE",
      "Forerunner_1.2.0_amd64.AppImage",
      "forerunner_1.2.0_amd64.deb",
      "forerunner-1.2.0.x86_64.rpm",
    ])
      expect(isInstallerArtifact(name), name).toBe(true);
    for (const name of ["forerunner-1.2.0-windows-x64.zip", "forerunner-1.2.0.apk"])
      expect(isInstallerArtifact(name), name).toBe(false);
  });

  for (const platform of ["windows-x64", "linux-x64"] as const) {
    it(`refuses ${INSTALLERS[platform]} before anything is downloaded, staged, recorded or restarted`, async () => {
      const h = await makeHarness({ feed, platform });
      try {
        // Offered as available, so the Updates screen can show "Download the installer".
        expect((await h.manager.check()).available?.version).toBe("1.2.0");
        const downloadsBefore = server.requests.filter((r) => r.includes(INSTALLERS[platform]));
        const e = await refused(h.manager.apply({ by: { kind: "human", id: "human-j" } }));
        expect(e.code).toBe("not_supported");
        expect(e.details).toMatchObject({
          reason: "installer_artifact",
          version: "1.2.0",
          artifact: INSTALLERS[platform],
        });
        expect(e.message).toContain(INSTALLERS[platform]);
        expect(e.message).toContain("Download the installer");
        // Nothing happened: no download, no staging, no release row, no pointer, no restart.
        expect(server.requests.filter((r) => r.includes(INSTALLERS[platform]))).toEqual(
          downloadsBefore,
        );
        const root = versionsRoot(h.dirs);
        const onDisk = existsSync(root)
          ? readdirSync(root).filter((n) => n !== "install.lock")
          : [];
        expect(onDisk).toEqual([]);
        expect(await h.store.release.list({ release_version: "1.2.0" })).toEqual([]);
        expect(readPointer(h.dirs)).toBeNull();
        expect(h.restarter.requests).toEqual([]);
        // The refusal is audited as the human's.
        const audit = await h.store.auditLog.list({ tool: "update.apply" });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ allowed: false, denied_reason: "installer_artifact" });
        // An agent's apply is refused the same way, and nobody is asked to approve it.
        const agent = await refused(h.manager.apply({ by: { kind: "agent", id: "agent-a" } }));
        expect(agent.details.reason).toBe("installer_artifact");
        expect(h.human.asks).toEqual([]);
        // The lower-level stage() refuses as well.
        const signed = (await h.manager.check()).signed;
        expect(signed).not.toBeNull();
        if (signed)
          expect((await refused(h.manager.stage(signed))).details.reason).toBe(
            "installer_artifact",
          );
        expect(
          existsSync(root) ? readdirSync(root).filter((n) => n !== "install.lock") : [],
        ).toEqual([]);
      } finally {
        await h.close();
      }
    });
  }

  it("POST /updates/apply answers 400 with the message the person reads", async () => {
    const h = await makeHarness({ feed, platform: "windows-x64" });
    try {
      const app = createUpdateRoutes({
        manager: h.manager,
        clock: h.clock,
        extensions: h.store.extension,
        catalog: new StaticExtensionCatalog([]),
        modelWatch: new StaticModelWatchReport([]),
        humanId: "human-j",
      });
      const res = await app.request("/updates/apply", {
        method: "POST",
        body: JSON.stringify({ version: "1.2.0" }),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("not_supported");
      expect(body.message).toContain("Forerunner_1.2.0_x64_en-US.msi");
      expect(h.restarter.requests).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
