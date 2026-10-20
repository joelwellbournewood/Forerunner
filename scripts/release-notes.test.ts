import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "@forerunner/platform";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildReleaseNotes,
  listArtefacts,
  parseChangelog,
  sectionFor,
  signingStatus,
  versionFromTag,
  // @ts-expect-error plain JS module
} from "./release-notes.mjs";

const repoRoot = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Added
- something new

## [1.0.0] - 2026-11-01

### Added
- First release.

### Fixed
- A bug.

## [0.9.0-rc.1] - 2026-10-20

- Release candidate.

[Unreleased]: https://example.invalid/compare/v1.0.0...HEAD
[1.0.0]: https://example.invalid/releases/tag/v1.0.0
`;

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe("release-notes changelog parsing", () => {
  it("splits sections with version and date, dropping link references", () => {
    const sections = parseChangelog(CHANGELOG);
    expect(sections.map((s: { version: string }) => s.version)).toEqual([
      "Unreleased",
      "1.0.0",
      "0.9.0-rc.1",
    ]);
    expect(sections[1].date).toBe("2026-11-01");
    expect(sections[1].body).toContain("- First release.");
    expect(sections[1].body).toContain("### Fixed");
    expect(sections[1].body).not.toContain("example.invalid");
    expect(sections[0].date).toBeNull();
  });

  it("finds the section for a tag with or without the v prefix", () => {
    expect(versionFromTag("v1.0.0")).toBe("1.0.0");
    expect(sectionFor(CHANGELOG, "v1.0.0")?.date).toBe("2026-11-01");
    expect(sectionFor(CHANGELOG, "1.0.0")?.date).toBe("2026-11-01");
    expect(sectionFor(CHANGELOG, "v0.9.0-rc.1")?.body).toContain("Release candidate");
    expect(sectionFor(CHANGELOG, "v2.0.0")).toBeNull();
  });

  it("handles CRLF input", () => {
    const sections = parseChangelog(CHANGELOG.replace(/\n/g, "\r\n"));
    expect(sections[1].body).toContain("- First release.");
    expect(sections[1].body).not.toContain("\r");
  });

  it("the repository CHANGELOG.md has an Unreleased section", () => {
    const text = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    expect(parseChangelog(text).some((s: { version: string }) => s.version === "Unreleased")).toBe(
      true,
    );
  });
});

describe("release-notes signing status", () => {
  it("reports unsigned when the Windows certificate is absent and signed when present", () => {
    expect(signingStatus({}).windows).toBe("unsigned (no certificate provided)");
    expect(signingStatus({ WINDOWS_CERTIFICATE: "" }).windows).toBe(
      "unsigned (no certificate provided)",
    );
    expect(signingStatus({ WINDOWS_CERTIFICATE: "x" }).windows).toBe("signed");
    expect(signingStatus({}).updater).toMatch(/^unsigned/);
    expect(signingStatus({ TAURI_SIGNING_PRIVATE_KEY: "x" }).updater).toMatch(/^signed/);
    expect(signingStatus({}).android).toMatch(/development key/);
    expect(signingStatus({ ANDROID_KEYSTORE_BASE64: "x" }).android).toMatch(/release keystore/);
  });
});

describe("release-notes body", () => {
  it("uses the tag's section, lists artefacts, signing status and the checksum note", () => {
    const dir = mkdtempSync(join(tmpdir(), "fr-artefacts-"));
    temps.push(dir);
    mkdirSync(join(dir, "desktop-windows-latest"), { recursive: true });
    writeFileSync(join(dir, "desktop-windows-latest", "Forerunner_1.0.0_x64_en-US.msi"), "msi");
    writeFileSync(join(dir, "SHA256SUMS.txt"), "abc  x\n");
    const artefacts = listArtefacts(dir);
    expect(artefacts.map((a: { name: string }) => a.name)).toEqual([
      "SHA256SUMS.txt",
      "desktop-windows-latest/Forerunner_1.0.0_x64_en-US.msi",
    ]);
    const notes = buildReleaseNotes({
      tag: "v1.0.0",
      changelog: CHANGELOG,
      env: { GITHUB_REPOSITORY_OWNER: "some-owner" },
      artefacts,
    });
    expect(notes).toContain("# Forerunner 1.0.0");
    expect(notes).toContain("Released 2026-11-01.");
    expect(notes).toContain("- First release.");
    expect(notes).not.toContain("something new");
    expect(notes).toContain(
      "| `desktop-windows-latest/Forerunner_1.0.0_x64_en-US.msi` | Windows installer (MSI) |",
    );
    expect(notes).toContain("ghcr.io/some-owner/forerunner-runner:1.0.0");
    expect(notes).toContain("- Windows installer: unsigned (no certificate provided)");
    expect(notes).toContain("SmartScreen");
    expect(notes).toContain("SHA256SUMS.txt");
    expect(notes).toContain("sha256sum -c");
  });

  it("falls back to Unreleased with a visible note when the tag has no section", () => {
    const notes = buildReleaseNotes({ tag: "v2.0.0", changelog: CHANGELOG, env: {} });
    expect(notes).toContain("no section for 2.0.0");
    expect(notes).toContain("something new");
    expect(notes).toContain("ghcr.io/<owner>/forerunner-runner:2.0.0");
    expect(notes).toContain("- Windows installer (MSI)");
  });

  it("marks the Windows installer signed when the certificate is present and omits the SmartScreen note", () => {
    const notes = buildReleaseNotes({
      tag: "v1.0.0",
      changelog: CHANGELOG,
      env: { WINDOWS_CERTIFICATE: "x" },
    });
    expect(notes).toContain("- Windows installer: signed");
    expect(notes).not.toContain("SmartScreen");
  });
});
