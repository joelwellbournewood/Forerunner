import { ForerunnerError, normalizeNewlines } from "@forerunner/platform";

/**
 * A strict, tiny YAML subset for registry frontmatter. No dependency, no surprises:
 *
 *  - top-level `key: scalar`, `key: [a, b]`, `key:` followed by a `- item` block list, a one-level
 *    nested map (`  sub: scalar`, whose values may be scalars, inline lists or a deeper block list)
 *    or a block scalar (`key: |` literal, `key: >` folded);
 *  - scalars: `"double quoted"` (\" \\ \n \t escapes), `'single quoted'` ('' escape), true/false,
 *    null/~, integers and decimals, everything else is a string;
 *  - `#` comments on their own line or after an unquoted scalar; two-space indentation; tabs are
 *    an error; duplicate keys are an error; `__proto__` is never a key (parsed maps have no
 *    prototype, so `constructor` or `toString` are ordinary keys).
 *
 * Anything outside this subset fails with the file and line number so a broken registry file is
 * found by the author, not by a run at 3 am.
 */
export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  /** The markdown after the closing `---`, newline-normalised, without a leading blank line. */
  body: string;
  /** 1-based line on which the body starts. */
  bodyStartLine: number;
}

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlScalar[] | Record<string, YamlScalar | YamlScalar[]>;

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*)|\s*)$/;

function fail(message: string, file: string | undefined, line: number): never {
  throw new ForerunnerError("validation", `${file ?? "<frontmatter>"}:${line}: ${message}`, {
    details: { file, line },
  });
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function isSkippable(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** Split an inline list body (without brackets) on commas outside quotes. */
function splitInline(body: string, file: string | undefined, line: number): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"' && i + 1 < body.length) {
        cur += body[++i] as string;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else if (ch === "[" || ch === "{") {
      fail("nested inline collections are not supported", file, line);
    } else {
      cur += ch;
    }
  }
  if (quote) fail("unterminated quoted string in inline list", file, line);
  out.push(cur);
  return out;
}

function parseDoubleQuoted(s: string, file: string | undefined, line: number): string {
  let out = "";
  let i = 1;
  for (; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === "\\") {
      const next = s[++i];
      if (next === "n") out += "\n";
      else if (next === "t") out += "\t";
      else if (next === '"') out += '"';
      else if (next === "\\") out += "\\";
      else fail(`unsupported escape \\${next ?? ""} in double-quoted string`, file, line);
      continue;
    }
    if (ch === '"') {
      const rest = s.slice(i + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) {
        fail("unexpected text after closing quote", file, line);
      }
      return out;
    }
    out += ch;
  }
  return fail("unterminated double-quoted string", file, line);
}

function parseSingleQuoted(s: string, file: string | undefined, line: number): string {
  let out = "";
  for (let i = 1; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === "'") {
      if (s[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      const rest = s.slice(i + 1).trim();
      if (rest !== "" && !rest.startsWith("#")) {
        fail("unexpected text after closing quote", file, line);
      }
      return out;
    }
    out += ch;
  }
  return fail("unterminated single-quoted string", file, line);
}

const NUMBER_RE = /^[-+]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** Parse one scalar or inline list. Exported for tests. */
export function parseScalar(
  raw: string,
  file?: string,
  line = 0,
): YamlScalar | YamlScalar[] | Record<string, never> {
  const s = raw.trim();
  if (s.startsWith('"')) return parseDoubleQuoted(s, file, line);
  if (s.startsWith("'")) return parseSingleQuoted(s, file, line);
  if (s.startsWith("[")) {
    const close = s.lastIndexOf("]");
    if (close < 0) fail("unterminated inline list", file, line);
    const after = s.slice(close + 1).trim();
    if (after !== "" && !after.startsWith("#"))
      fail("unexpected text after inline list", file, line);
    const inner = s.slice(1, close).trim();
    if (inner === "") return [];
    return splitInline(inner, file, line).map((item) => {
      const v = parseScalar(item, file, line);
      if (Array.isArray(v) || (v !== null && typeof v === "object")) {
        return fail("inline lists may only hold scalars", file, line);
      }
      return v;
    });
  }
  if (s === "{}") return {};
  if (s.startsWith("{")) fail("inline maps are not supported (use a nested block)", file, line);
  const noComment = s.replace(/\s+#.*$/, "").trim();
  if (noComment === "" || noComment === "~" || noComment === "null") return null;
  if (noComment === "true") return true;
  if (noComment === "false") return false;
  if (NUMBER_RE.test(noComment)) return Number(noComment);
  return noComment;
}

interface Cursor {
  lines: string[];
  i: number;
  file: string | undefined;
  offset: number;
}

const lineNo = (c: Cursor, i = c.i): number => i + 1 + c.offset;

/**
 * Result maps have no prototype, so `constructor`, `toString` or `hasOwnProperty` are ordinary
 * keys and a duplicate is only a key seen twice in the same map. `__proto__` is never data.
 */
function claimKey(out: object, key: string, c: Cursor): void {
  if (key === "__proto__") fail('key "__proto__" is not allowed', c.file, lineNo(c));
  if (Object.hasOwn(out, key)) fail(`duplicate key "${key}"`, c.file, lineNo(c));
}

function nextMeaningful(c: Cursor, from: number): number {
  let j = from;
  while (j < c.lines.length && isSkippable(c.lines[j] as string)) j++;
  return j;
}

function checkTabs(c: Cursor, line: string): void {
  const lead = line.match(/^\s*/)?.[0] ?? "";
  if (lead.includes("\t")) fail("tabs are not allowed in indentation", c.file, lineNo(c));
}

function parseBlockScalar(c: Cursor, marker: string, parentIndent: number): string {
  const literal = marker.startsWith("|");
  const collected: string[] = [];
  let blockIndent = -1;
  while (c.i < c.lines.length) {
    const line = c.lines[c.i] as string;
    if (line.trim() === "") {
      collected.push("");
      c.i++;
      continue;
    }
    checkTabs(c, line);
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (blockIndent < 0) blockIndent = ind;
    if (ind < blockIndent)
      fail("block scalar line is indented less than its first line", c.file, lineNo(c));
    collected.push(line.slice(blockIndent));
    c.i++;
  }
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
  if (literal) return collected.join("\n");
  // folded: single newlines become spaces, blank lines become newlines
  let out = "";
  for (let k = 0; k < collected.length; k++) {
    const l = collected[k] as string;
    if (l === "") {
      out += "\n";
    } else {
      if (out !== "" && !out.endsWith("\n")) out += " ";
      out += l;
    }
  }
  return out;
}

function parseBlockList(c: Cursor, listIndent: number): YamlScalar[] {
  const items: YamlScalar[] = [];
  while (c.i < c.lines.length) {
    const line = c.lines[c.i] as string;
    if (isSkippable(line)) {
      c.i++;
      continue;
    }
    checkTabs(c, line);
    const ind = indentOf(line);
    if (ind < listIndent) break;
    if (ind > listIndent) fail("unexpected indentation inside a list", c.file, lineNo(c));
    const t = line.slice(ind);
    if (t === "-" || t.startsWith("- ")) {
      const body = t === "-" ? "" : t.slice(2);
      if (body.trim() === "" || body.trim().startsWith("#")) {
        fail(
          "list items must hold a scalar (nested lists and maps are not supported)",
          c.file,
          lineNo(c),
        );
      }
      if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:(\s|$)/.test(body.trim())) {
        fail("maps inside lists are not supported", c.file, lineNo(c));
      }
      const v = parseScalar(body, c.file, lineNo(c));
      if (Array.isArray(v) || (v !== null && typeof v === "object")) {
        fail("list items must be scalars", c.file, lineNo(c));
      }
      items.push(v);
      c.i++;
    } else {
      break;
    }
  }
  return items;
}

function parseNestedMap(c: Cursor, mapIndent: number): Record<string, YamlScalar | YamlScalar[]> {
  const out = Object.create(null) as Record<string, YamlScalar | YamlScalar[]>;
  while (c.i < c.lines.length) {
    const line = c.lines[c.i] as string;
    if (isSkippable(line)) {
      c.i++;
      continue;
    }
    checkTabs(c, line);
    const ind = indentOf(line);
    if (ind < mapIndent) break;
    if (ind > mapIndent) fail("unexpected indentation inside a nested map", c.file, lineNo(c));
    const m = line.slice(ind).match(KEY_RE);
    if (!m) fail(`expected "key: value" in nested map, got "${line.trim()}"`, c.file, lineNo(c));
    const key = m[1] as string;
    const rest = (m[2] ?? "").trim();
    claimKey(out, key, c);
    const here = lineNo(c);
    c.i++;
    if (rest === "" || rest.startsWith("#")) {
      const j = nextMeaningful(c, c.i);
      const nextLine = c.lines[j];
      if (nextLine !== undefined && indentOf(nextLine) > mapIndent) {
        const t = nextLine.trim();
        if (t === "-" || t.startsWith("- ")) {
          c.i = j;
          out[key] = parseBlockList(c, indentOf(nextLine));
          continue;
        }
        fail("only one level of nesting is supported", c.file, lineNo(c, j));
      }
      out[key] = null;
      continue;
    }
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      out[key] = parseBlockScalar(c, rest, mapIndent);
      continue;
    }
    const v = parseScalar(rest, c.file, here);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      fail("nested maps may only hold scalars and lists", c.file, here);
    }
    out[key] = v;
  }
  return out;
}

/** Parse the YAML subset. `lineOffset` makes reported line numbers match the enclosing file. */
export function parseYamlSubset(
  text: string,
  file?: string,
  lineOffset = 0,
): Record<string, YamlValue> {
  const c: Cursor = { lines: normalizeNewlines(text).split("\n"), i: 0, file, offset: lineOffset };
  const out = Object.create(null) as Record<string, YamlValue>;
  while (c.i < c.lines.length) {
    const line = c.lines[c.i] as string;
    if (isSkippable(line)) {
      c.i++;
      continue;
    }
    checkTabs(c, line);
    if (indentOf(line) !== 0) fail("unexpected indentation at top level", c.file, lineNo(c));
    const m = line.match(KEY_RE);
    if (!m) fail(`expected "key: value", got "${line.trim()}"`, c.file, lineNo(c));
    const key = m[1] as string;
    const rest = (m[2] ?? "").trim();
    claimKey(out, key, c);
    const here = lineNo(c);
    c.i++;
    if (rest === "" || rest.startsWith("#")) {
      const j = nextMeaningful(c, c.i);
      const nextLine = c.lines[j];
      if (nextLine !== undefined && indentOf(nextLine) > 0) {
        const ind = indentOf(nextLine);
        const t = nextLine.trim();
        c.i = j;
        out[key] =
          t === "-" || t.startsWith("- ") ? parseBlockList(c, ind) : parseNestedMap(c, ind);
        continue;
      }
      out[key] = null;
      continue;
    }
    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      out[key] = parseBlockScalar(c, rest, 0);
      continue;
    }
    out[key] = parseScalar(rest, c.file, here) as YamlValue;
  }
  return out;
}

/**
 * Split a markdown file into frontmatter and body. The file must start with `---` on its own
 * line (a UTF-8 BOM is tolerated) and the frontmatter must be closed by a `---` line at column
 * zero; an indented `---` inside a block scalar is content, not the close.
 */
export function parseFrontmatter(text: string, file?: string): ParsedFrontmatter {
  const normalized = normalizeNewlines(text.replace(/^﻿/, ""));
  const lines = normalized.split("\n");
  if ((lines[0] ?? "").trim() !== "---") {
    fail("file must start with a '---' frontmatter line", file, 1);
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i] as string)) {
      close = i;
      break;
    }
  }
  if (close < 0) fail("frontmatter is not closed by a '---' line", file, lines.length);
  const yaml = lines.slice(1, close).join("\n");
  const data = parseYamlSubset(yaml, file, 1);
  let bodyLines = lines.slice(close + 1);
  let bodyStartLine = close + 2;
  while (bodyLines.length > 0 && (bodyLines[0] as string).trim() === "") {
    bodyLines = bodyLines.slice(1);
    bodyStartLine++;
  }
  return { data, body: bodyLines.join("\n"), bodyStartLine };
}

const NEEDS_QUOTES_RE =
  /^(?:true|false|null|~|[-+]?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?)$|^[\s"'[\]{}#&*!|>%@`-]|[:#]\s|:\s*$|\s$|^\s/;

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\t/g, "\\t")}"`;
}

function scalarText(v: unknown, key: string): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean" || typeof v === "number") {
    if (typeof v === "number" && !Number.isFinite(v)) {
      throw new ForerunnerError("validation", `cannot serialize non-finite number for "${key}"`);
    }
    return String(v);
  }
  if (typeof v === "string") {
    if (/[\r\n]/.test(v)) {
      throw new ForerunnerError(
        "validation",
        `multi-line scalar in "${key}" must be written as a block`,
      );
    }
    return NEEDS_QUOTES_RE.test(v) || v === "" ? quote(v) : v;
  }
  throw new ForerunnerError("validation", `unsupported value type for "${key}": ${typeof v}`);
}

const isMultiLine = (v: unknown): v is string => typeof v === "string" && /[\r\n]/.test(v);

/**
 * Content lines of a literal block (`key: |`). Line breaks are normalised first (a lone `\r`
 * is a break on re-read, so it must be one on write too). The parser takes the indentation of
 * the first non-blank line as the block indent, so a value whose first line starts with
 * whitespace, or a line indented with a tab, cannot be represented and is refused by key.
 */
function blockBody(value: string, key: string, indent: string): string[] {
  const lines = normalizeNewlines(value)
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => (l.trim() === "" ? "" : l));
  const first = lines.find((l) => l !== "");
  if (first !== undefined && /^\s/.test(first)) {
    throw new ForerunnerError(
      "validation",
      `multi-line value for "${key}" must not start with a space (a block scalar cannot represent it)`,
    );
  }
  for (const l of lines) {
    if (/^[ ]*\t/.test(l)) {
      throw new ForerunnerError(
        "validation",
        `multi-line value for "${key}" has a line indented with a tab`,
      );
    }
  }
  return lines.map((l) => (l === "" ? "" : `${indent}${l}`));
}

function listLines(items: unknown[], key: string, indent: string): string[] {
  if (items.length === 0) return [];
  return items.map((it) => {
    if (it !== null && typeof it === "object") {
      throw new ForerunnerError("validation", `list "${key}" may only hold scalars`);
    }
    return `${indent}- ${scalarText(it, key)}`;
  });
}

/** Serialize a record in the same subset. Multi-line strings become literal blocks. */
export function serializeYamlSubset(data: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
      throw new ForerunnerError("validation", `invalid frontmatter key "${key}"`);
    }
    if (Array.isArray(value)) {
      if (value.length === 0) lines.push(`${key}: []`);
      else lines.push(`${key}:`, ...listLines(value, key, "  "));
    } else if (isMultiLine(value)) {
      lines.push(`${key}: |`, ...blockBody(value, key, "  "));
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      if (entries.length === 0) {
        lines.push(`${key}: {}`);
        continue;
      }
      lines.push(`${key}:`);
      for (const [sub, sv] of entries) {
        if (Array.isArray(sv)) {
          if (sv.length === 0) lines.push(`  ${sub}: []`);
          else lines.push(`  ${sub}:`, ...listLines(sv, `${key}.${sub}`, "    "));
        } else if (sv !== null && typeof sv === "object") {
          throw new ForerunnerError(
            "validation",
            `"${key}.${sub}": only one level of nesting is supported`,
          );
        } else if (isMultiLine(sv)) {
          lines.push(`  ${sub}: |`, ...blockBody(sv, `${key}.${sub}`, "    "));
        } else {
          lines.push(`  ${sub}: ${scalarText(sv, `${key}.${sub}`)}`);
        }
      }
    } else {
      lines.push(`${key}: ${scalarText(value, key)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Build a registry file: frontmatter block plus markdown body, LF line endings. */
export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const b = normalizeNewlines(body).replace(/^\n+/, "").replace(/\n*$/, "\n");
  return `---\n${serializeYamlSubset(data)}---\n\n${b}`;
}
