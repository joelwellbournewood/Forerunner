import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, ForerunnerError, join } from "@forerunner/platform";

/**
 * The committed spend ledger, `tests/live/spend.json`: one row per live model call with the
 * usage the provider reported and its price from the billing table. The ledger is the memory
 * of the budget across runs and machines: the cap check reads it before every call, and every
 * call appends to it afterwards, success or failure. Numbers only; never a credential.
 */
export const LEDGER_FILE_NAME = "spend.json";

/**
 * What a row is: an API call priced in USD (the default, the field is omitted), or an Agent
 * SDK run on the subscription (ADR 0044), which has no USD price: its `usd` is 0, so the caps
 * ignore it, and its `note` reads "subscription: plan usage, est. USD x" with the SDK's own
 * list-price figure.
 */
export type SpendKind = "api" | "subscription";

export interface SpendRow {
  /** YYYY-MM-DD (UTC) of the call. */
  date: string;
  /** The run id: one vitest invocation (`FORERUNNER_LIVE_RUN`), or a name a caller chose. */
  run: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** USD at the billing table's prices, six decimals (micro-USD precision); 0 for plan usage. */
  usd: number;
  /** "subscription" for an SDK run on the plan; absent for an API call. */
  kind?: SpendKind;
  /** What happened when it was not a plain success (an error code, an abort, no usage). */
  note?: string;
}

export interface LedgerFile {
  rows: SpendRow[];
}

export interface ModelTotals {
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

export function usdFromMicro(micro: number): number {
  return Math.round(micro) / 1_000_000;
}

export function microFromUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

function nonNegativeInt(v: unknown, what: string, index: number): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new ForerunnerError(
      "validation",
      `spend ledger row ${index}: ${what} must be a non-negative integer`,
    );
  }
  return v;
}

function text(v: unknown, what: string, index: number): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new ForerunnerError(
      "validation",
      `spend ledger row ${index}: ${what} must be a non-empty string`,
    );
  }
  return v;
}

/** Parse and validate the ledger file; a malformed file fails loudly, never reads as empty. */
export function parseLedger(json: string): LedgerFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new ForerunnerError("validation", `spend ledger is not JSON: ${String(e)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ForerunnerError("validation", "spend ledger must be an object with a rows array");
  }
  const rowsRaw = (parsed as { rows?: unknown }).rows;
  if (!Array.isArray(rowsRaw)) {
    throw new ForerunnerError("validation", "spend ledger must be an object with a rows array");
  }
  const rows: SpendRow[] = rowsRaw.map((r, i) => {
    if (!r || typeof r !== "object") {
      throw new ForerunnerError("validation", `spend ledger row ${i} is not an object`);
    }
    const o = r as Record<string, unknown>;
    const usd = o.usd;
    if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) {
      throw new ForerunnerError(
        "validation",
        `spend ledger row ${i}: usd must be a non-negative number`,
      );
    }
    const row: SpendRow = {
      date: text(o.date, "date", i),
      run: text(o.run, "run", i),
      model: text(o.model, "model", i),
      tokensIn: nonNegativeInt(o.tokensIn, "tokensIn", i),
      tokensOut: nonNegativeInt(o.tokensOut, "tokensOut", i),
      cacheRead: nonNegativeInt(o.cacheRead ?? 0, "cacheRead", i),
      cacheWrite: nonNegativeInt(o.cacheWrite ?? 0, "cacheWrite", i),
      usd,
    };
    if (o.kind !== undefined) {
      if (o.kind !== "subscription" && o.kind !== "api") {
        throw new ForerunnerError(
          "validation",
          `spend ledger row ${i}: kind must be "api" or "subscription"`,
        );
      }
      if (o.kind === "subscription") row.kind = o.kind;
    }
    if (typeof o.note === "string" && o.note !== "") row.note = o.note;
    return row;
  });
  return { rows };
}

export function formatLedger(file: LedgerFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** The subscription rows (plan usage, USD 0) of a set of rows. */
export function subscriptionRows(rows: readonly SpendRow[]): SpendRow[] {
  return rows.filter((r) => r.kind === "subscription");
}

export function sumUsd(rows: readonly SpendRow[]): number {
  // Sum in micro-USD so float noise never changes a cap decision.
  return usdFromMicro(rows.reduce((s, r) => s + microFromUsd(r.usd), 0));
}

export function totalsByModel(rows: readonly SpendRow[]): Record<string, ModelTotals> {
  const out: Record<string, ModelTotals> = {};
  for (const r of rows) {
    let t = out[r.model];
    if (!t) {
      t = { calls: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
      out[r.model] = t;
    }
    t.calls++;
    t.tokensIn += r.tokensIn;
    t.tokensOut += r.tokensOut;
    t.cacheRead += r.cacheRead;
    t.cacheWrite += r.cacheWrite;
    t.usd = usdFromMicro(microFromUsd(t.usd) + microFromUsd(r.usd));
  }
  return out;
}

/**
 * The ledger on disk. Every read goes to the file (another process may have appended), every
 * append is read-modify-write through a temp file and a rename, so a crash mid-write leaves
 * the previous ledger intact. A missing file is an empty ledger; a malformed one is an error.
 */
export class SpendLedger {
  constructor(readonly path: string) {}

  static load(path: string): SpendLedger {
    const ledger = new SpendLedger(path);
    ledger.rows();
    return ledger;
  }

  rows(): SpendRow[] {
    if (!existsSync(this.path)) return [];
    return parseLedger(readFileSync(this.path, "utf8")).rows;
  }

  totalUsd(): number {
    return sumUsd(this.rows());
  }

  forRun(run: string): SpendRow[] {
    return this.rows().filter((r) => r.run === run);
  }

  runUsd(run: string): number {
    return sumUsd(this.forRun(run));
  }

  byModel(rows: readonly SpendRow[] = this.rows()): Record<string, ModelTotals> {
    return totalsByModel(rows);
  }

  append(row: SpendRow): void {
    const rows = this.rows();
    rows.push(row);
    this.write({ rows });
  }

  private write(file: LedgerFile): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${LEDGER_FILE_NAME}.${process.pid}.tmp`);
    writeFileSync(tmp, formatLedger(file), "utf8");
    renameSync(tmp, this.path);
  }
}
