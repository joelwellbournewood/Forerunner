#!/usr/bin/env node
// The files a GitHub release publishes, picked from the artefacts the release workflow downloaded
// (artifacts/desktop-*/, artifacts/android/ and the signed manifest): the Windows .msi, the Linux
// .AppImage and .deb, the Android .apk and forerunner-release.json when it was signed. Nothing
// else: rc.3 uploaded the whole Linux bundle tree (hundreds of .so files, icons, `copyright`)
// and hit GitHub's secondary rate limit before the APK went up (run 40248159390).
//
// Writes <dir>/SHA256SUMS.txt over exactly those files, by the flat name GitHub publishes them
// under (so `sha256sum -c SHA256SUMS.txt` works in a download folder), prints the list plus the
// sums file one per line, and with GITHUB_OUTPUT set appends it as the `files` output. Fails when
// an installer or the APK is missing, or when two picked files share a name.
//
// Usage: node scripts/release-files.mjs [artifacts]
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const SUMS_FILE = "SHA256SUMS.txt";
export const MANIFEST_FILE = "forerunner-release.json";
/** Each must be present exactly as an extension of at least one file. */
export const REQUIRED_EXTENSIONS = [".msi", ".AppImage", ".deb", ".apk"];

const picked = (name) =>
  name === MANIFEST_FILE || REQUIRED_EXTENSIONS.some((ext) => name.endsWith(ext));

/** Release files under dir, as sorted `/`-separated paths relative to dir. */
export function releaseFiles(dir) {
  if (!existsSync(dir)) throw new Error(`release-files: ${dir} does not exist`);
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.join(dir, ...rel), { withFileTypes: true })) {
      if (entry.isDirectory()) walk([...rel, entry.name]);
      else if (entry.isFile() && picked(entry.name)) out.push([...rel, entry.name].join("/"));
    }
  };
  walk([]);
  out.sort();
  for (const ext of REQUIRED_EXTENSIONS) {
    if (!out.some((f) => f.endsWith(ext))) {
      throw new Error(`release-files: no *${ext} file under ${dir}`);
    }
  }
  const seen = new Map();
  for (const f of out) {
    const base = f.split("/").pop();
    if (seen.has(base)) {
      throw new Error(`release-files: two files named ${base}: ${seen.get(base)} and ${f}`);
    }
    seen.set(base, f);
  }
  return out;
}

/** `sha256sum` lines for files (relative to dir) by their flat names, sorted by name. */
export function checksums(dir, files) {
  return files
    .map((f) => {
      const hash = createHash("sha256")
        .update(readFileSync(path.join(dir, ...f.split("/"))))
        .digest("hex");
      return { name: f.split("/").pop(), hash };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((x) => `${x.hash}  ${x.name}\n`)
    .join("");
}

/**
 * Writes the sums under root and returns the paths to publish, spelled from `dir` (the path the
 * workflow passes), the sums file last. `root` is where dir is on disk (tests pass a temp dir).
 */
export function publishReleaseFiles(dir, env = process.env, root = dir) {
  const files = releaseFiles(root);
  writeFileSync(path.join(root, SUMS_FILE), checksums(root, files));
  const prefix = dir.replace(/\\/g, "/").replace(/\/+$/, "");
  const list = [...files, SUMS_FILE].map((f) => `${prefix}/${f}`);
  if (env.GITHUB_OUTPUT) {
    const delimiter = `FR_FILES_${createHash("sha256").update(list.join("\n")).digest("hex").slice(0, 16)}`;
    appendFileSync(env.GITHUB_OUTPUT, `files<<${delimiter}\n${list.join("\n")}\n${delimiter}\n`);
  }
  return list;
}

const isMain =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  try {
    const list = publishReleaseFiles(process.argv[2] ?? "artifacts");
    process.stdout.write(`${list.join("\n")}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
