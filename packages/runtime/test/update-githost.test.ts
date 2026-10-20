import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, SimulatedClock } from "@forerunner/platform";
import { FakeGitHost } from "@forerunner/testenv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_MANIFEST_ASSET_NAME } from "../src/update/config.ts";
import { feedFromConfig, GitHubReleasesFeed } from "../src/update/feed.ts";
import type { ReleaseManifest } from "../src/update/manifest.ts";
import { readPointer } from "../src/update/pointer.ts";
import { signManifest } from "../src/update/sign.ts";
import { sha256Hex } from "../src/update/verify.ts";
import { makeHarness, makeZip, testKey } from "./update-helpers.ts";

/**
 * The GitHub feed against the testenv fake git host (the same REST shapes as GitHub): a
 * release is created and its assets uploaded through the API exactly as the release workflow
 * does, then the updater lists, verifies and stages it from the host's download URLs. Nothing
 * names an organisation: owner and repo come from the feed configuration.
 */
const owner = "someone";
const repo = "forerunner";
const tag = "v1.1.0";
let root: string;
let host: FakeGitHost;
let token: string;
let zip: Buffer;
let manifest: ReleaseManifest;

async function api(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${host.baseUrl}${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      ...(body !== undefined && !(body instanceof Uint8Array)
        ? { "content-type": "application/json" }
        : {}),
      ...headers,
    },
    body:
      body === undefined
        ? undefined
        : body instanceof Uint8Array
          ? new Uint8Array(body)
          : JSON.stringify(body),
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "fr-update-githost-"));
  host = await FakeGitHost.start({
    rootDir: root,
    clock: new SimulatedClock("2026-10-20T09:00:00.000Z"),
  });
  host.createUser({ login: owner, name: "Someone", email: "someone@example.test" });
  token = host.createToken({ owner, kind: "classic", scopes: ["repo"] }).token;
  await host.createRepo({
    owner,
    name: repo,
    private: false,
    initialFiles: { "README.md": "# forerunner\n" },
  });
  // the release workflow: create the release, upload the artefacts, then the signed manifest
  const created = await api("POST", `/repos/${owner}/${repo}/releases`, {
    tag_name: tag,
    name: tag,
    body: "release notes on the host are advisory; the manifest's notes are signed",
  });
  expect(created.status).toBe(201);
  const releaseId = ((await created.json()) as { id: number }).id;
  zip = makeZip({ "app/VERSION": "1.1.0", "app/bin/forerunner": "#!/bin/sh\n" });
  const assetName = "forerunner-1.1.0-linux-x64.zip";
  const upload = await api(
    "POST",
    `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${assetName}`,
    zip,
    { "content-type": "application/zip" },
  );
  expect(upload.status).toBe(201);
  const uploaded = (await upload.json()) as { browser_download_url: string };
  manifest = {
    schema: 1,
    version: "1.1.0",
    channel: "stable",
    publishedAt: "2026-10-20T09:00:00.000Z",
    notes: "## 1.1.0\n- served by the fake git host",
    minSchema: 1,
    artifacts: [
      {
        platform: "linux-x64",
        name: assetName,
        url: uploaded.browser_download_url,
        sha256: sha256Hex(zip),
        size: zip.length,
      },
    ],
  };
  const signed = signManifest(manifest, testKey().privateKey);
  const manifestUpload = await api(
    "POST",
    `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${DEFAULT_MANIFEST_ASSET_NAME}`,
    Buffer.from(JSON.stringify(signed), "utf8"),
    { "content-type": "application/json" },
  );
  expect(manifestUpload.status).toBe(201);
});

afterAll(async () => {
  await host.stop();
  await rm(root, { recursive: true, force: true });
});

describe("GitHubReleasesFeed against the fake git host", () => {
  it("lists the signed manifest from the release asset and stages the artefact from the host's download URL", async () => {
    const feed = feedFromConfig({ kind: "github", owner, repo, apiBase: host.baseUrl });
    expect(feed).toBeInstanceOf(GitHubReleasesFeed);
    const list = await feed.list("stable");
    expect(list.map((r) => r.manifest.version)).toEqual(["1.1.0"]);
    expect(list[0]?.signature?.keyId).toBe(testKey().keyId);
    expect(await feed.latest("beta")).toBeNull();

    const h = await makeHarness({ feed });
    try {
      const check = await h.manager.check();
      expect(check.available?.version).toBe("1.1.0");
      expect(check.available?.artifacts[0]?.url).toContain(
        `/${owner}/${repo}/releases/download/${encodeURIComponent(tag)}/`,
      );
      const r = await h.manager.apply({ by: { kind: "human", id: "human-j" } });
      expect(r.staged.unpackedFiles).toBe(2);
      expect(readFileSync(join(r.staged.dir, "app", "VERSION"), "utf8")).toBe("1.1.0");
      expect(readPointer(h.dirs)).toMatchObject({ current: "1.1.0", previous: "1.0.0" });
      expect(await h.manager.healthCheck()).toMatchObject({ kind: "healthy", version: "1.1.0" });
    } finally {
      await h.close();
    }
  });

  it("a private repository needs the token; the token is passed by the caller, never read from the environment", async () => {
    await host.createRepo({
      owner,
      name: "private-app",
      private: true,
      initialFiles: { "README.md": "# private\n" },
    });
    const created = await api("POST", `/repos/${owner}/private-app/releases`, {
      tag_name: "v0.1.0",
      name: "v0.1.0",
      body: "",
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { id: number }).id;
    const signed = signManifest({ ...manifest, version: "0.1.0" }, testKey().privateKey);
    expect(
      (
        await api(
          "POST",
          `/repos/${owner}/private-app/releases/${id}/assets?name=${DEFAULT_MANIFEST_ASSET_NAME}`,
          Buffer.from(JSON.stringify(signed), "utf8"),
          { "content-type": "application/json" },
        )
      ).status,
    ).toBe(201);
    const anonymous = new GitHubReleasesFeed({ owner, repo: "private-app", apiBase: host.baseUrl });
    const e = await anonymous.list("stable").catch((err: unknown) => err);
    expect(e).toBeInstanceOf(Error);
    expect(String((e as Error).message)).toMatch(/answered 40[14]/);
    const withToken = feedFromConfig(
      { kind: "github", owner, repo: "private-app", apiBase: host.baseUrl },
      { token },
    );
    expect((await withToken.list("stable")).map((r) => r.manifest.version)).toEqual(["0.1.0"]);
  });
});
