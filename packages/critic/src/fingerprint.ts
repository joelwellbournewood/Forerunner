import { createHash } from "node:crypto";

/**
 * Finding fingerprints (H.5): the same defect reported in another session, on another file or
 * at another line must hash the same, so `FindingRepo.patterns` can count repeats. The
 * normalisation drops everything that changes between occurrences: case, quotes, paths, line
 * numbers, urls, numbers and punctuation. What survives is the wording of the defect.
 */
const FILE_RE =
  /(?:[\w.-]+[/\\])*[\w.-]+\.(?:tsx?|m?[cj]s|jsonc?|md|py|rs|go|java|kt|ya?ml|toml|sql|sh|ps1|html?|css|svg)(?::\d+(?::\d+)?)?/gi;

export function normaliseFindingText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " <url> ")
    .replace(FILE_RE, " <file> ")
    .replace(/\b0x[0-9a-f]+\b/g, " <n> ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " <n> ")
    .replace(/[^a-z0-9<>\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Sixteen hex digits of sha256 over the normalised description. Empty text hashes to "". */
export function fingerprintOf(description: string): string {
  const norm = normaliseFindingText(description);
  if (!norm) return "";
  return createHash("sha256").update(norm, "utf8").digest("hex").slice(0, 16);
}
