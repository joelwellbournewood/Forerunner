import { ForerunnerError } from "@forerunner/platform";
import type { ToolDefinition } from "../provider/types.ts";

/** Keys dropped from tool JSON schemas; they carry no instruction value. */
const DROP_KEYS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "examples",
  "example",
  "deprecated",
  "readOnly",
  "writeOnly",
  "markdownDescription",
]);

const VOLATILE = [
  {
    name: "iso-timestamp",
    re: /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})\b/,
  },
  { name: "uuid", re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: "hex-hash", re: /\b[0-9a-f]{32}\b|\b[0-9a-f]{40}\b|\b[0-9a-f]{64}\b/i },
];

export function compactToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (DROP_KEYS.has(k)) continue;
        out[k] =
          k === "description" && typeof val === "string"
            ? val.replace(/\s+/g, " ").trim()
            : walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(schema) as Record<string, unknown>;
}

const memo = new Map<string, ToolDefinition[]>();

export function compactTools(tools: ToolDefinition[]): ToolDefinition[] {
  const key = JSON.stringify(tools);
  const hit = memo.get(key);
  if (hit) return hit;
  const out = tools.map((t) => ({
    ...t,
    description: t.description.replace(/\s+/g, " ").trim(),
    input_schema: compactToolSchema(t.input_schema),
  }));
  if (memo.size > 200) memo.clear();
  memo.set(key, out);
  return out;
}

/** Volatile markers in a system prompt defeat prompt caching. */
export function findVolatile(system: string): string[] {
  return VOLATILE.filter((v) => v.re.test(system)).map((v) => v.name);
}

export function assertStablePrefix(system: string, mode: "throw" | "warn" = "throw"): string[] {
  const found = findVolatile(system);
  if (found.length && mode === "throw") {
    throw new ForerunnerError(
      "validation",
      `system prompt contains volatile content that defeats caching: ${found.join(", ")}`,
      {
        details: { found },
      },
    );
  }
  return found;
}

export interface PromptLayout {
  registryPrompt: string;
  projectBrief?: string;
  instructions?: string;
  pinnedLessons?: string[];
}

/** Stable system prompt: registry prompt -> project brief -> instructions -> pinned lessons. */
export function layoutSystem(p: PromptLayout): string {
  return [
    p.registryPrompt,
    p.projectBrief,
    p.instructions,
    p.pinnedLessons?.length
      ? `# Pinned lessons\n${p.pinnedLessons.map((l) => `- ${l}`).join("\n")}`
      : undefined,
  ]
    .filter((s): s is string => !!s && s.trim().length > 0)
    .join("\n\n");
}

/** Volatile facts belong in the first user message, never in system. */
export function volatilePreamble(
  facts: Record<string, string | number | boolean | undefined>,
): string {
  const lines = Object.entries(facts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `- ${k}: ${String(v)}`);
  return lines.length ? `# Now\n${lines.join("\n")}` : "";
}
