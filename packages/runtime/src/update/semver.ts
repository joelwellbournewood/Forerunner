import { ForerunnerError } from "@forerunner/platform";

/**
 * Minimal semantic versioning for release manifests (no dependency). Supports
 * MAJOR.MINOR.PATCH with an optional pre-release and build metadata, an optional leading "v",
 * and semver 2.0 precedence (pre-releases sort before the release, identifiers compare
 * numerically when both are numbers, otherwise lexically; build metadata is ignored).
 */
export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string[];
}

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

export function parseSemver(input: string): Semver | null {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
    build: m[5] ? m[5].split(".") : [],
  };
}

export function isSemver(input: string): boolean {
  return parseSemver(input) !== null;
}

/** Parse or throw ForerunnerError("validation"). */
export function mustParseSemver(input: string): Semver {
  const v = parseSemver(input);
  if (!v) {
    throw new ForerunnerError("validation", `not a semantic version: ${input.slice(0, 40)}`, {
      details: { version: input.slice(0, 40) },
    });
  }
  return v;
}

function cmpIdent(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Math.sign(Number(a) - Number(b));
  if (na) return -1; // numeric identifiers sort before alphanumeric ones
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** -1 when a < b, 0 when equal, 1 when a > b. Throws on a non-semver input. */
export function compareSemver(a: string | Semver, b: string | Semver): -1 | 0 | 1 {
  const va = typeof a === "string" ? mustParseSemver(a) : a;
  const vb = typeof b === "string" ? mustParseSemver(b) : b;
  for (const k of ["major", "minor", "patch"] as const) {
    if (va[k] !== vb[k]) return va[k] < vb[k] ? -1 : 1;
  }
  if (va.prerelease.length === 0 && vb.prerelease.length === 0) return 0;
  if (va.prerelease.length === 0) return 1; // a release outranks its pre-releases
  if (vb.prerelease.length === 0) return -1;
  const n = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < n; i++) {
    const ia = va.prerelease[i];
    const ib = vb.prerelease[i];
    if (ia === undefined) return -1;
    if (ib === undefined) return 1;
    const c = cmpIdent(ia, ib);
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

/** True when `candidate` is strictly newer than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) > 0;
}

/** Highest version first. */
export function sortVersionsDesc<T>(items: T[], version: (item: T) => string): T[] {
  return [...items].sort((x, y) => compareSemver(version(y), version(x)));
}
