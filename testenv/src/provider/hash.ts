import { createHash } from "node:crypto";
import type { ChatMessage, ModelRequest } from "./types.ts";

/**
 * Stable request identity for the recording store. Two requests with the same model, system
 * prompt, messages and tool names hash alike on every run and every OS. Anything that does not
 * change the model's answer (max_tokens, effort, cache flags, metadata, signal) is left out.
 */
export interface RequestFingerprint {
  model: string;
  system: string;
  messages: ChatMessage[];
  /** Tool names, sorted. */
  tools: string[];
}

/** Deep copy with object keys sorted, so serialisation does not depend on insertion order. */
export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeysDeep(v);
    }
    return out as T;
  }
  return value;
}

/** JSON with sorted keys; `indent` 0 gives the compact form used for hashing. */
export function canonicalJson(value: unknown, indent = 0): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}

export function requestFingerprint(req: ModelRequest): RequestFingerprint {
  return {
    model: req.model,
    system: req.system ?? "",
    messages: structuredClone(req.messages),
    tools: (req.tools ?? []).map((t) => t.name).sort(),
  };
}

/** 32 hex characters of SHA-256 over the canonical fingerprint. Safe as a file name everywhere. */
export function requestHash(req: ModelRequest): string {
  return createHash("sha256")
    .update(canonicalJson(requestFingerprint(req)), "utf8")
    .digest("hex")
    .slice(0, 32);
}
