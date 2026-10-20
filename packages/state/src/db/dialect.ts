import type { Dialect } from "./types.ts";

/** Column types of the declarative schema. The storage mapping per dialect is below. */
export type ColumnType = "text" | "int" | "real" | "bool" | "json" | "timestamp" | "money";

/**
 * Storage mapping. Identical semantics in both dialects:
 * - ids and timestamps are TEXT (ISO-8601 UTC, lexicographically ordered),
 * - booleans are INTEGER 0/1 in SQLite and BOOLEAN in Postgres, always read back as JS booleans,
 * - JSON is TEXT in SQLite and JSONB in Postgres, always read back parsed,
 * - money is micro-USD integers (INTEGER / BIGINT), read back as JS numbers.
 *   Safe up to 2^53 micro-USD (about 9 billion USD); the adapters do not use BigInt.
 */
export function sqlType(type: ColumnType, dialect: Dialect): string {
  switch (type) {
    case "text":
    case "timestamp":
      return "TEXT";
    case "int":
    case "money":
      return dialect === "sqlite" ? "INTEGER" : "BIGINT";
    case "real":
      return dialect === "sqlite" ? "REAL" : "DOUBLE PRECISION";
    case "bool":
      return dialect === "sqlite" ? "INTEGER" : "BOOLEAN";
    case "json":
      return dialect === "sqlite" ? "TEXT" : "JSONB";
  }
}

/** Render a default value as a SQL literal for a DEFAULT clause. */
export function sqlLiteral(value: unknown, type: ColumnType, dialect: Dialect): string {
  if (value === null || value === undefined) return "NULL";
  if (type === "bool") {
    const on = value === true || value === 1;
    return dialect === "sqlite" ? (on ? "1" : "0") : on ? "TRUE" : "FALSE";
  }
  if (type === "json") return quoteString(JSON.stringify(value));
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  return quoteString(String(value));
}

export function quoteString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Quote an identifier (table, column, schema). Both dialects use double quotes. */
export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/**
 * Rewrite `?` placeholders to `$1..$n` for Postgres. Skips quoted strings, quoted
 * identifiers and dollar-quoted bodies so a literal `?` inside them survives.
 */
export function toPositional(sql: string): string {
  let out = "";
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    if (ch === "'" || ch === '"') {
      const end = closingQuote(sql, i, ch);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "$" && sql[i + 1] === "$") {
      const end = sql.indexOf("$$", i + 2);
      const stop = end < 0 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "?") {
      n += 1;
      out += `$${n}`;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function closingQuote(sql: string, start: number, q: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === q) {
      if (sql[i + 1] === q) {
        i += 2;
        continue;
      }
      return i;
    }
    i += 1;
  }
  return sql.length - 1;
}

/** `column` holds a JSON array; the fragment is true when it contains the single `?` parameter. */
export function jsonArrayContains(column: string, dialect: Dialect): string {
  if (dialect === "sqlite") {
    return `EXISTS (SELECT 1 FROM json_each(${column}) WHERE json_each.value = ?)`;
  }
  return `${column} @> CAST(? AS JSONB)`;
}

/** The parameter that goes with jsonArrayContains(): the raw value for SQLite, a JSON array for Postgres. */
export function jsonArrayContainsParam(value: string, dialect: Dialect): string {
  return dialect === "sqlite" ? value : JSON.stringify([value]);
}

/** Upsert on a conflict target; identical syntax in SQLite >= 3.24 and Postgres. */
export function upsertSql(
  table: string,
  columns: string[],
  conflictColumns: string[],
  updateColumns: string[],
): string {
  const cols = columns.map(quoteIdent).join(", ");
  const marks = columns.map(() => "?").join(", ");
  const conflict = conflictColumns.map(quoteIdent).join(", ");
  const updates = updateColumns.map((c) => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`);
  const action = updates.length === 0 ? "DO NOTHING" : `DO UPDATE SET ${updates.join(", ")}`;
  return `INSERT INTO ${quoteIdent(table)} (${cols}) VALUES (${marks}) ON CONFLICT (${conflict}) ${action} RETURNING *`;
}

interface DriverError {
  code?: unknown;
  errcode?: unknown;
  message?: unknown;
}

function asDriverError(e: unknown): DriverError {
  return typeof e === "object" && e !== null ? (e as DriverError) : {};
}

/** True for a UNIQUE / PRIMARY KEY violation in either driver. */
export function isUniqueViolation(e: unknown): boolean {
  const d = asDriverError(e);
  if (d.code === "23505") return true; // postgres unique_violation
  if (d.errcode === 1555 || d.errcode === 2067) return true; // SQLITE_CONSTRAINT_PRIMARYKEY / UNIQUE
  return typeof d.message === "string" && /UNIQUE constraint failed/.test(d.message);
}

/** True for a write refused by the append-only triggers. */
export function isAppendOnlyViolation(e: unknown): boolean {
  const d = asDriverError(e);
  return typeof d.message === "string" && /append_only/.test(d.message);
}

/** True for a CHECK constraint failure (enum or range). */
export function isCheckViolation(e: unknown): boolean {
  const d = asDriverError(e);
  if (d.code === "23514") return true;
  if (d.errcode === 275) return true; // SQLITE_CONSTRAINT_CHECK
  return typeof d.message === "string" && /CHECK constraint failed/.test(d.message);
}

/** True for a FOREIGN KEY failure. */
export function isForeignKeyViolation(e: unknown): boolean {
  const d = asDriverError(e);
  if (d.code === "23503") return true;
  if (d.errcode === 787) return true; // SQLITE_CONSTRAINT_FOREIGNKEY
  return typeof d.message === "string" && /FOREIGN KEY constraint failed/.test(d.message);
}
