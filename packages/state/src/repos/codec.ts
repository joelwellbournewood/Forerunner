import { ForerunnerError } from "@forerunner/platform";
import type { Dialect, Row } from "../db/types.ts";
import { allColumns, type ColumnDef, type EntityDef } from "../schema.ts";

/**
 * Row encoding and decoding driven by the schema, so both dialects present identical
 * JS values: booleans as booleans, JSON parsed, numbers as numbers, timestamps as strings.
 */

export function columnMap(entity: EntityDef): Map<string, ColumnDef> {
  return new Map(allColumns(entity).map((c) => [c.name, c]));
}

export function encodeValue(col: ColumnDef, value: unknown, dialect: Dialect): unknown {
  if (value === undefined || value === null) return null;
  switch (col.type) {
    case "bool":
      return dialect === "sqlite" ? (value ? 1 : 0) : Boolean(value);
    case "json":
      return JSON.stringify(value);
    case "int":
    case "money": {
      const n = typeof value === "bigint" ? Number(value) : Number(value);
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        throw new ForerunnerError("validation", `${col.name} must be an integer`, {
          details: { column: col.name, value: String(value) },
        });
      }
      if (!Number.isSafeInteger(n)) {
        throw new ForerunnerError(
          "validation",
          `${col.name} exceeds 2^53 and cannot be stored safely`,
          {
            details: { column: col.name },
          },
        );
      }
      return n;
    }
    case "real": {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new ForerunnerError("validation", `${col.name} must be a finite number`, {
          details: { column: col.name },
        });
      }
      return n;
    }
    case "timestamp": {
      if (value instanceof Date) return value.toISOString();
      if (typeof value !== "string") {
        throw new ForerunnerError("validation", `${col.name} must be an ISO-8601 string`, {
          details: { column: col.name },
        });
      }
      return value;
    }
    case "text":
      return typeof value === "string" ? value : String(value);
  }
}

export function decodeValue(col: ColumnDef, value: unknown, dialect: Dialect): unknown {
  if (value === null || value === undefined) return null;
  switch (col.type) {
    case "bool":
      return value === true || value === 1 || value === 1n || value === "1" || value === "t";
    case "json":
      // SQLite stores JSON text; pg already parses JSONB (a JSON string value is a plain string).
      return dialect === "sqlite" && typeof value === "string" ? JSON.parse(value) : value;
    case "int":
    case "money":
    case "real":
      return typeof value === "number" ? value : Number(value);
    case "timestamp":
      return value instanceof Date ? value.toISOString() : String(value);
    case "text":
      return typeof value === "string" ? value : String(value);
  }
}

/** Decode a raw driver row into the entity's JS shape. Unknown columns (joins, aggregates) pass through. */
export function decodeRow<T>(entity: EntityDef, raw: Row, dialect: Dialect): T {
  const cols = columnMap(entity);
  const out: Row = {};
  for (const [k, v] of Object.entries(raw)) {
    const col = cols.get(k);
    out[k] = col ? decodeValue(col, v, dialect) : v;
  }
  return out as T;
}

/** Encode the known columns of a partial row for binding; unknown keys throw. */
export function encodePatch(
  entity: EntityDef,
  patch: Record<string, unknown>,
  dialect: Dialect,
): { columns: string[]; values: unknown[] } {
  const cols = columnMap(entity);
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const col = cols.get(k);
    if (!col) {
      throw new ForerunnerError("validation", `${entity.table}: unknown column ${k}`, {
        details: { table: entity.table, column: k },
      });
    }
    if (v === null && !col.nullable) {
      throw new ForerunnerError("validation", `${entity.table}.${k} cannot be null`, {
        details: { table: entity.table, column: k },
      });
    }
    if (col.enum && v !== null && !col.enum.includes(String(v))) {
      throw new ForerunnerError("validation", `${entity.table}.${k}: invalid value`, {
        details: { table: entity.table, column: k, value: String(v), allowed: [...col.enum] },
      });
    }
    columns.push(k);
    values.push(encodeValue(col, v, dialect));
  }
  return { columns, values };
}
