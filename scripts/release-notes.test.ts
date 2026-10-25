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

describe("release-notes: the signed release manifest (ADR 0015)", () => {
  it("reports the manifest signature from UPDATE_SIGNING_KEY, presence only", () => {
    expect(signingStatus({}).manifest).toMatch(/^not signed/);
    expect(signingStatus({ UPDATE_SIGNING_KEY: "" }).manifest).toMatch(/^not signed/);
    expect(signingStatus({ UPDATE_SIGNING_KEY: "x" }).manifest).toMatch(/^signed/);
    // the value never reaches the text
    expect(JSON.stringify(signingStatus({ UPDATE_SIGNING_KEY: "secret-value-123" }))).not.toContain(
      "secret-value-123",
    );
  });

  it("the unsigned updater line does not claim the in-app updater refuses the build (it verifies the manifest)", () => {
    expect(signingStatus({}).updater).not.toMatch(/in-app updater will not accept/);
  });

  it("the Signing section names the release manifest", () => {
    const body = buildReleaseNotes({
      tag: "v1.0.0",
      changelog: CHANGELOG,
      env: { UPDATE_SIGNING_KEY: "x" },
    });
    expect(body).toMatch(/- Release manifest: signed/);
  });
});

describe("release.yml: the GitHub release job sees the secrets it reports on", () => {
  const text = () => readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");

  /** The `- name:` / `- uses:` / `- run:` step block (6-space indent) that contains `marker`. */
  const stepAround = (wf: string, marker: string): string => {
    const at = wf.indexOf(marker);
    expect(at, `marker not found: ${marker}`).toBeGreaterThan(-1);
    const start = wf.lastIndexOf("\n      - ", at);
    const next = wf.indexOf("\n      - ", at);
    return wf.slice(start, next >= 0 ? next : wf.length);
  };

  /** `NAME: value` entries of an `env:` block at `indent` spaces (entries two deeper; comments allowed). */
  const envBlock = (block: string, indent: number): Map<string, string> => {
    const pad = " ".repeat(indent);
    const inner = " ".repeat(indent + 2);
    const m = block.match(new RegExp(`\\n${pad}env:\\n((?:${inner}(?:#.*|[A-Z0-9_]+:.*)\\n?)+)`));
    const out = new Map<string, string>();
    if (!m) return out;
    for (const x of (m[1] ?? "").matchAll(new RegExp(`^${inner}([A-Z0-9_]+):\\s*(.*)$`, "gm"))) {
      out.set(x[1] ?? "", (x[2] ?? "").trim());
    }
    return out;
  };

  /** The job block `  <id>:` up to the next job (or the end of the file). */
  const jobBlock = (wf: string, id: string): string => {
    const start = wf.indexOf(`\n  ${id}:\n`);
    expect(start, `job not found: ${id}`).toBeGreaterThan(-1);
    const rest = wf.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
    return next >= 0 ? rest.slice(0, next + 1) : rest;
  };

  /** The job's own `env:` (4-space key, before `steps:`), not any step's. */
  const jobEnv = (job: string): Map<string, string> =>
    envBlock(job.slice(0, job.indexOf("\n    steps:")), 4);

  const stepEnv = (step: string): Map<string, string> => envBlock(step, 8);

  it("the GitHub release job downloads only the build artefacts, never another action's records (rc.1 run 40229971920 failed downloading the Docker build record)", () => {
    const publish = jobBlock(text(), "publish");
    const downloads = publish
      .split("\n      - ")
      .filter((step) => step.startsWith("uses: actions/download-artifact@"));
    expect(downloads.length).toBeGreaterThan(0);
    for (const d of downloads) {
      // Every download names its artefacts; none downloads "everything" in the run.
      expect(d).toMatch(/\n? {10}(name|pattern): /);
    }
    const named = downloads.map((d) => /(?:name|pattern): (\S+)/.exec(d)?.[1]);
    expect(named).toEqual(expect.arrayContaining(["desktop-*", "android"]));
    // And the image build does not upload its record as a run artefact in the first place.
    const image = stepAround(text(), "docker/build-push-action");
    expect(stepEnv(image).get("DOCKER_BUILD_RECORD_UPLOAD")).toBe("false");
  });

  it("a step's `if:` reads env names only from its job's or the workflow's env, never from its own (GitHub evaluates `if` without the step env)", () => {
    const wf = text();
    const workflowEnv = envBlock(wf.slice(0, wf.indexOf("\njobs:")), 0);
    let envReads = 0;
    for (const id of [...wf.matchAll(/\n {2}([a-z][a-z0-9_-]*):\n/g)].map((m) => m[1] ?? "")) {
      const job = jobBlock(wf, id);
      const declared = new Set([...workflowEnv.keys(), ...jobEnv(job).keys()]);
      for (const m of job.matchAll(/\n {8}if: (.*)/g)) {
        const own = stepEnv(stepAround(job, m[0]));
        const cond = m[1] ?? "";
        for (const x of cond.matchAll(/env\.([A-Z0-9_]+)/g)) {
          const name = x[1] ?? "";
          envReads++;
          expect(own.has(name), `${id}: if: ${cond} reads env.${name} declared on the step`).toBe(
            false,
          );
          expect(
            declared.has(name),
            `${id}: if: ${cond} reads env.${name}, not in the job or workflow env`,
          ).toBe(true);
        }
      }
    }
    // the manifest step's condition is one such read; a parser that finds nothing fails here
    expect(envReads).toBeGreaterThan(0);
  });

  it("the signed manifest step runs on the job-level presence flag of UPDATE_SIGNING_KEY and signs with the key from its own env", () => {
    const job = jobBlock(text(), "publish");
    expect(jobEnv(job).get("HAS_UPDATE_SIGNING_KEY")).toBe(
      `\${{ secrets.UPDATE_SIGNING_KEY != '' }}`,
    );
    const step = stepAround(job, "Signed release manifest");
    expect(step).toMatch(/\n {8}if: env\.HAS_UPDATE_SIGNING_KEY == 'true'\n/);
    expect(stepEnv(step).get("UPDATE_SIGNING_KEY")).toBe(`\${{ secrets.UPDATE_SIGNING_KEY }}`);
  });

  it("both release-notes runs (the release body and the manifest's signed notes) see the same presence-only signing facts", () => {
    const job = jobBlock(text(), "publish");
    const jEnv = jobEnv(job);
    for (const name of ["ANDROID_KEYSTORE_BASE64", "UPDATE_SIGNING_KEY"]) {
      // a presence flag, never the secret's value, at job level
      expect(jEnv.get(name), name).toBe(`\${{ secrets.${name} != '' && 'present' || '' }}`);
    }
    for (const marker of ["> RELEASE_NOTES.md", "> notes-section.md"]) {
      const own = stepEnv(stepAround(job, marker));
      // Only the manifest step may override a flag, and only UPDATE_SIGNING_KEY with exactly
      // its own secret (it signs with it); no step re-exposes the keystore or empties a flag.
      const allowed =
        marker === "> notes-section.md"
          ? new Map([["UPDATE_SIGNING_KEY", `\${{ secrets.UPDATE_SIGNING_KEY }}`]])
          : new Map<string, string>();
      for (const name of ["ANDROID_KEYSTORE_BASE64", "UPDATE_SIGNING_KEY"]) {
        if (own.has(name)) expect(own.get(name), `${marker}: ${name}`).toBe(allowed.get(name));
      }
      // Windows signing is not wired (release.md): the notes must not call the MSI signed
      expect(own.has("WINDOWS_CERTIFICATE"), marker).toBe(false);
    }
    expect(jEnv.has("WINDOWS_CERTIFICATE")).toBe(false);
  });
});
