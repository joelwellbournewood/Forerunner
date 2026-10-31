import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "@forerunner/platform";
import { BUNDLED_RUNTIME_MARKER } from "../registry/loader.ts";
import { DEFAULT_RUNNER_IMAGE } from "./container.ts";

/**
 * Which runner image a task container uses (U-079, ADR 0101), in order:
 *
 * 1. the project or app configuration (`settings.sandbox.image`);
 * 2. `FORERUNNER_RUNNER_IMAGE`;
 * 3. the image the desktop build named in the runtime payload's `runtime.json`
 *    (`runnerImage`, written by `scripts/build-runtime-payload.mjs` from the build's
 *    `GITHUB_REPOSITORY_OWNER`): `<repository>:<app version>`, and `<repository>:latest` when
 *    the registry has no image for this version (a development build between releases);
 * 4. `forerunner-runner:local`, which a source checkout builds itself.
 *
 * No registry owner is ever written in code: the build names it, or nothing does.
 */
export interface BuildRunnerImage {
  /** `ghcr.io/<owner>/forerunner-runner`, as the build named it. */
  repository: string;
  /** The app version the build was made for. */
  tag: string;
  /** Tried when the registry says it has no image for `tag`; null: none. */
  fallbackTag: string | null;
}

export type SandboxImageSource = "config" | "env" | "build" | "local";

export interface SandboxImageChoice {
  /** The image tried first. */
  image: string;
  /** Used instead when a pull of `image` says the registry has no such image. */
  fallback: string | null;
  source: SandboxImageSource;
  /** Whether `docker pull` can fetch it; the local default is built, never pulled. */
  pullable: boolean;
}

/** `runnerImage` from a parsed `runtime.json`, or null when it names none (or a malformed one). */
export function parseBuildRunnerImage(manifest: unknown): BuildRunnerImage | null {
  const r = (manifest as { runnerImage?: unknown } | null)?.runnerImage;
  if (!r || typeof r !== "object") return null;
  const { repository, tag, fallbackTag } = r as Record<string, unknown>;
  const valid = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && !/\s/.test(v) && !v.startsWith("-");
  if (!valid(repository) || !valid(tag) || repository.includes("@")) return null;
  return { repository, tag, fallbackTag: valid(fallbackTag) ? fallbackTag : null };
}

/**
 * The image the desktop build named: `runtime.json` at the payload root, searched upward from
 * `startDir` (this file's directory). Null in a repository checkout or when the build named none.
 */
export function readBuildRunnerImage(
  startDir: string = dirname(fileURLToPath(import.meta.url)),
  read: (file: string) => string | null = (file) =>
    existsSync(file) ? readFileSync(file, "utf8") : null,
  maxDepth = 8,
): BuildRunnerImage | null {
  let current = startDir;
  for (let depth = 0; depth < maxDepth; depth++) {
    const text = read(join(current, BUNDLED_RUNTIME_MARKER));
    if (text !== null) {
      try {
        return parseBuildRunnerImage(JSON.parse(text));
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/** A local tag (`:local`, the source checkout's build) cannot be pulled from any registry. */
export function isPullableImage(image: string): boolean {
  return !/:local$/.test(image.trim());
}

/** The image precedence above, with the fallback a build-named image carries. */
export function resolveSandboxImage(opts: {
  configured?: string;
  env: NodeJS.ProcessEnv;
  build: BuildRunnerImage | null;
}): SandboxImageChoice {
  const fromConfig = opts.configured?.trim();
  if (fromConfig)
    return {
      image: fromConfig,
      fallback: null,
      source: "config",
      pullable: isPullableImage(fromConfig),
    };
  const fromEnv = opts.env.FORERUNNER_RUNNER_IMAGE?.trim();
  if (fromEnv)
    return { image: fromEnv, fallback: null, source: "env", pullable: isPullableImage(fromEnv) };
  const b = opts.build;
  if (b) {
    const image = `${b.repository}:${b.tag}`;
    const fallback =
      b.fallbackTag && b.fallbackTag !== b.tag ? `${b.repository}:${b.fallbackTag}` : null;
    return { image, fallback, source: "build", pullable: true };
  }
  return { image: DEFAULT_RUNNER_IMAGE, fallback: null, source: "local", pullable: false };
}
