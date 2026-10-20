import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  dirname,
  ForerunnerError,
  join,
  normalizeNewlines,
  safeSegment,
} from "@forerunner/platform";
import { canonicalJson, type RequestFingerprint } from "./hash.ts";
import type { ReplyBody } from "./replies.ts";

export const RECORDING_FORMAT_VERSION = 1;

/** One recorded model reply: `testenv/recordings/<suite>/<hash>.json`. */
export interface Recording {
  version: typeof RECORDING_FORMAT_VERSION;
  hash: string;
  suite: string;
  /** ISO-8601 UTC, from the recording provider's clock. */
  recordedAt: string;
  /** Name of the provider that produced the reply (e.g. "anthropic"). */
  provider: string;
  request: RequestFingerprint;
  reply: ReplyBody;
}

/** `testenv/recordings`, resolved from this file so it works from any working directory. */
export function defaultRecordingsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "recordings");
}

export interface RecordingStoreOptions {
  /** Test suite name; becomes the directory under the root (sanitised for every OS). */
  suite: string;
  /** Defaults to {@link defaultRecordingsRoot}. Tests pass a temp directory. */
  root?: string;
}

/**
 * Directory of JSON recordings, one file per request hash. Files are pretty-printed with sorted
 * keys and LF line endings so they diff cleanly in git on Windows and Linux alike.
 */
export class RecordingStore {
  readonly root: string;
  readonly suite: string;
  readonly dir: string;

  constructor(opts: RecordingStoreOptions) {
    if (!opts.suite) throw new ForerunnerError("validation", "RecordingStore needs a suite name");
    this.root = opts.root ?? defaultRecordingsRoot();
    this.suite = opts.suite;
    this.dir = join(this.root, safeSegment(opts.suite, "suite"));
  }

  pathFor(hash: string): string {
    return join(this.dir, `${hash}.json`);
  }

  has(hash: string): boolean {
    return existsSync(this.pathFor(hash));
  }

  /** The recording for `hash`, or undefined when none was recorded. Corrupt files throw. */
  load(hash: string): Recording | undefined {
    const file = this.pathFor(hash);
    if (!existsSync(file)) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(normalizeNewlines(readFileSync(file, "utf8")));
    } catch (cause) {
      throw new ForerunnerError("validation", `recording ${file} is not valid JSON`, { cause });
    }
    const rec = parsed as Partial<Recording> | null;
    if (
      !rec ||
      typeof rec !== "object" ||
      rec.version !== RECORDING_FORMAT_VERSION ||
      typeof rec.hash !== "string" ||
      !rec.reply ||
      typeof rec.reply !== "object" ||
      !rec.request ||
      typeof rec.request !== "object"
    ) {
      throw new ForerunnerError("validation", `recording ${file} has an unknown format`, {
        details: { expectedVersion: RECORDING_FORMAT_VERSION },
      });
    }
    if (rec.hash !== hash) {
      throw new ForerunnerError("validation", `recording ${file} carries hash ${rec.hash}`, {
        details: { expected: hash, found: rec.hash },
      });
    }
    return rec as Recording;
  }

  /** Writes (or replaces) the recording and returns its path. */
  save(rec: Recording): string {
    mkdirSync(this.dir, { recursive: true });
    const file = this.pathFor(rec.hash);
    writeFileSync(file, `${normalizeNewlines(canonicalJson(rec, 2))}\n`, "utf8");
    return file;
  }

  /** Hashes recorded in this suite, sorted. */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length))
      .sort();
  }
}
