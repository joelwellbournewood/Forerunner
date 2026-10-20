import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, redact, safeSegment } from "@forerunner/platform";

/**
 * Original-block store (ADR 0003 section 2): the original of every tool result the pipeline
 * changed is written, after `redact()`, to `<cache>/context/<sessionId>/<hash>.txt` so the log
 * view can show it and a retry can re-expand it. Every write is best effort and synchronous
 * (the transforms run inline in the loop); a failed write never affects the compressed result,
 * the caller just learns that nothing was stored. There is no session retention mechanism yet,
 * so `prune()` deletes session directories by age instead (the manager runs it at start).
 */
export const ORIGINAL_HASH_LENGTH = 12;
export const DEFAULT_ORIGINALS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Stable identifier of a block: the hash the `truncate` marker and the file name share. */
export function originalHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, ORIGINAL_HASH_LENGTH);
}

export interface OriginalsSink {
  /** Stores the original under its hash; returns false when nothing could be written. */
  write(hash: string, original: string): boolean;
}

/** One session's directory under the store. */
export class SessionOriginals implements OriginalsSink {
  readonly dir: string;
  private prepared = false;

  constructor(
    base: string,
    readonly sessionId: string,
  ) {
    this.dir = join(base, safeSegment(sessionId, "session"));
  }

  path(hash: string): string {
    return join(this.dir, `${safeSegment(hash, "block")}.txt`);
  }

  write(hash: string, original: string): boolean {
    try {
      if (!this.prepared) {
        mkdirSync(this.dir, { recursive: true });
        this.prepared = true;
      }
      const file = this.path(hash);
      if (existsSync(file)) return true; // same hash, same content
      writeFileSync(file, redact(original), "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /** The stored (redacted) original, or null when the hash resolves to nothing. */
  read(hash: string): string | null {
    try {
      return readFileSync(this.path(hash), "utf8");
    } catch {
      return null;
    }
  }

  /** Hashes stored for this session. */
  list(): string[] {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith(".txt"))
        .map((f) => f.slice(0, -4))
        .sort();
    } catch {
      return [];
    }
  }
}

export class ContextOriginals {
  constructor(readonly base: string) {}

  forSession(sessionId: string): SessionOriginals {
    return new SessionOriginals(this.base, sessionId);
  }

  /** Deletes one session's originals (with the session's data). */
  remove(sessionId: string): void {
    rmSync(this.forSession(sessionId).dir, { recursive: true, force: true });
  }

  /**
   * Deletes every session directory whose newest file is older than `maxAgeMs` before `now`.
   * Returns the session segments removed. Never throws.
   */
  prune(now: number, maxAgeMs = DEFAULT_ORIGINALS_MAX_AGE_MS): string[] {
    const removed: string[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.base);
    } catch {
      return removed;
    }
    for (const name of entries) {
      const dir = join(this.base, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        let newest = 0;
        for (const f of readdirSync(dir)) {
          const t = statSync(join(dir, f)).mtimeMs;
          if (t > newest) newest = t;
        }
        if (now - newest >= maxAgeMs) {
          rmSync(dir, { recursive: true, force: true });
          removed.push(name);
        }
      } catch {
        // a directory that vanished or cannot be read is left alone
      }
    }
    return removed;
  }
}
