#!/usr/bin/env node
// Builds the GitHub Release body for a tag from CHANGELOG.md (Keep a Changelog format), the
// artefacts the release workflow downloaded, the signing status read from the environment, and
// the SHA256SUMS note. Prints Markdown to stdout; nothing is written.
//
// Usage: node scripts/release-notes.mjs <tag> [--changelog CHANGELOG.md] [--artifacts artifacts]
//
// Environment read: WINDOWS_CERTIFICATE (Windows code signing), TAURI_SIGNING_PRIVATE_KEY (Tauri
// updater signatures; the Tauri updater is not enabled), UPDATE_SIGNING_KEY (the signed release
// manifest the in-app updater verifies, ADR 0015), ANDROID_KEYSTORE_BASE64 (Android release key),
// GITHUB_REPOSITORY_OWNER (image name).
// Only presence is checked; values are never printed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s*[-–]\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

/** Split a Keep-a-Changelog document into its version sections. */
export function parseChangelog(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      current = { version: m[1].replace(/^v/i, ""), date: m[2] ?? null, lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  // Drop the trailing link-reference block of each section and surrounding blank lines.
  return sections.map((s) => ({
    version: s.version,
    date: s.date,
    body: s.lines
      .filter((l) => !/^\[[^\]]+\]:\s*\S+/.test(l))
      .join("\n")
      .trim(),
  }));
}

/** "v1.0.0" -> "1.0.0"; "1.0.0-rc.1" stays. */
export function versionFromTag(tag) {
  return String(tag).trim().replace(/^v/i, "");
}

/** The section for the tag, or null. */
export function sectionFor(changelog, tag) {
  const version = versionFromTag(tag);
  const sections = parseChangelog(changelog);
  return sections.find((s) => s.version.toLowerCase() === version.toLowerCase()) ?? null;
}

export function unreleasedSection(changelog) {
  return parseChangelog(changelog).find((s) => s.version.toLowerCase() === "unreleased") ?? null;
}

/** Signing status from the environment (presence only). */
export function signingStatus(env = process.env) {
  const has = (k) => typeof env[k] === "string" && env[k].trim().length > 0;
  return {
    windows: has("WINDOWS_CERTIFICATE") ? "signed" : "unsigned (no certificate provided)",
    updater: has("TAURI_SIGNING_PRIVATE_KEY")
      ? "signed (Tauri updater key)"
      : "unsigned (the Tauri updater is not enabled; in-app updates are verified through the signed release manifest)",
    manifest: has("UPDATE_SIGNING_KEY")
      ? "signed (`forerunner-release.json`; the in-app updater verifies it against `update.trustedKeys`)"
      : "not signed (no `UPDATE_SIGNING_KEY`; the in-app updater cannot install this release)",
    android: has("ANDROID_KEYSTORE_BASE64")
      ? "signed with the release keystore"
      : "signed with a build-generated development key (sideloading only, not for distribution)",
  };
}

/** Files under dir (recursive), sorted, with sizes. */
export function listArtefacts(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else
        out.push({
          name: path.relative(dir, p).split(path.sep).join("/"),
          bytes: statSync(p).size,
        });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); // codepoint order, same on every locale
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function kindOf(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".msi")) return "Windows installer (MSI)";
  if (lower.endsWith(".exe")) return "Windows installer (NSIS)";
  if (lower.endsWith(".appimage")) return "Linux AppImage";
  if (lower.endsWith(".deb")) return "Linux Debian package";
  if (lower.endsWith(".rpm")) return "Linux RPM package";
  if (lower.endsWith(".apk")) return "Android APK";
  if (lower.endsWith(".sig")) return "updater signature";
  if (lower.endsWith("sha256sums.txt")) return "checksums";
  if (lower.endsWith(".json")) return "updater manifest";
  return "file";
}

/**
 * Build the release notes. `artefacts` is the list from listArtefacts (may be empty, in which
 * case the expected artefact kinds are listed instead).
 */
export function buildReleaseNotes({ tag, changelog, env = process.env, artefacts = [] }) {
  const version = versionFromTag(tag);
  const owner = env.GITHUB_REPOSITORY_OWNER?.trim() || "<owner>";
  const signing = signingStatus(env);
  const out = [];
  out.push(`# Forerunner ${version}`, "");

  const section = sectionFor(changelog, tag);
  if (section) {
    if (section.date) out.push(`Released ${section.date}.`, "");
    out.push(section.body || "_No entries._", "");
  } else {
    const unreleased = unreleasedSection(changelog);
    out.push(
      `> CHANGELOG.md has no section for ${version}; the Unreleased section is shown instead. Add a \`## [${version}] - YYYY-MM-DD\` section before the next release.`,
      "",
    );
    out.push(unreleased?.body || "_No entries._", "");
  }

  out.push("## Artefacts", "");
  if (artefacts.length > 0) {
    out.push("| File | Kind | Size |", "| --- | --- | --- |");
    for (const a of artefacts) {
      out.push(`| \`${a.name}\` | ${kindOf(a.name)} | ${formatBytes(a.bytes)} |`);
    }
  } else {
    out.push(
      "- Windows installer (MSI)",
      "- Linux AppImage and Debian package (.deb)",
      "- Android APK (sideloading)",
      "- `SHA256SUMS.txt`",
      "- User guide and setup guide (Markdown)",
    );
  }
  out.push(
    "",
    `Cloud runner image: \`ghcr.io/${owner}/forerunner-runner:${version}\` (also \`:latest\`). The state service runs from the same image (\`pnpm state-api\`).`,
    "",
  );

  out.push(
    "## Signing",
    "",
    `- Windows installer: ${signing.windows}`,
    `- Update signatures: ${signing.updater}`,
    `- Release manifest: ${signing.manifest}`,
    `- Android APK: ${signing.android}`,
    "",
  );
  if (signing.windows.startsWith("unsigned")) {
    out.push(
      'Windows SmartScreen will warn about the unsigned installer; choose "More info" then "Run anyway", or verify the checksum first. A signed build follows once a code-signing certificate is provided (see docs/maintainers/release.md).',
      "",
    );
  }

  out.push(
    "## Checksums",
    "",
    "`SHA256SUMS.txt` lists the SHA-256 of every file above. Verify a download before installing:",
    "",
    "```",
    "sha256sum -c SHA256SUMS.txt --ignore-missing          # Linux",
    "Get-FileHash .\\<file> -Algorithm SHA256                  # Windows, compare with the list",
    "```",
    "",
    "Install and upgrade steps: see the setup guide attached to this release.",
    "",
  );
  return out.join("\n");
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const tag = process.argv
    .slice(2)
    .find((a) => !a.startsWith("--") && a !== arg("--changelog") && a !== arg("--artifacts"));
  if (!tag) {
    console.error(
      "usage: node scripts/release-notes.mjs <tag> [--changelog CHANGELOG.md] [--artifacts artifacts]",
    );
    process.exit(2);
  }
  const changelogPath = arg("--changelog") ?? "CHANGELOG.md";
  const artefactsDir = arg("--artifacts") ?? "artifacts";
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  if (!changelog)
    console.error(
      `release-notes: ${changelogPath} not found; notes will have no changelog section`,
    );
  process.stdout.write(
    buildReleaseNotes({ tag, changelog, env: process.env, artefacts: listArtefacts(artefactsDir) }),
  );
}
