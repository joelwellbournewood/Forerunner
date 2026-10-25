import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalizeNewlines, SimulatedClock } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import {
  jsonArrayContains,
  sqlLiteral,
  sqlType,
  toPositional,
  upsertSql,
} from "../src/db/dialect.ts";
import { openSqlite, type SqliteDatabase } from "../src/db/sqlite.ts";
import { renderDataModelDoc, schemaSummary } from "../src/docs.ts";
import { monotonicId } from "../src/ids.ts";
import { MIGRATION_0001 } from "../src/migrations/0001-initial.ts";
import { MIGRATION_0002 } from "../src/migrations/0002-headroom-savings.ts";
import { MIGRATION_0003 } from "../src/migrations/0003-sources.ts";
import { MIGRATION_0004 } from "../src/migrations/0004-shared-secrets.ts";
import { MIGRATION_0005 } from "../src/migrations/0005-change-reasons.ts";
import {
  createTableSql,
  generateInitialMigration,
  generateSchemaSql,
  renderMigrationModule,
} from "../src/migrations/generate.ts";
import {
  appliedVersions,
  MIGRATIONS,
  migrate,
  pendingMigrations,
} from "../src/migrations/index.ts";
import { decodeRow, encodePatch } from "../src/repos/codec.ts";
import { createRepos } from "../src/repos/index.ts";
import { allColumns, COMMON_COLUMNS, ENTITIES, type EntityDef, tableOrder } from "../src/schema.ts";
import { parseStoreUrl } from "../src/store.ts";
import {
  assertTransition,
  canTransition,
  STATUS_GRAPHS,
  TASK_TRANSITIONS,
} from "../src/workflow.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("schema", () => {
  it("has the fourteen core entities, the supporting tables and the migrations table", () => {
    const core = [
      "human",
      "agent",
      "project",
      "milestone",
      "task",
      "run",
      "session",
      "event",
      "message",
      "decision",
      "human_request",
      "review",
      "finding",
      "lesson",
    ];
    const supporting = [
      "command",
      "change_log",
      "device",
      "source",
      "source_candidate",
      "cost_ledger",
      "secret_ref",
      "secret_grant",
      "extension",
      "data_asset",
      "release",
      "audit_log",
      "queue_item",
      "remote_command",
      "billing_source",
      "budget_window",
      "schema_migrations",
    ];
    for (const t of [...core, ...supporting]) expect(ENTITIES[t]?.table, t).toBe(t);
    expect(Object.keys(ENTITIES)).toHaveLength(core.length + supporting.length);
  });

  it("gives every entity the common envelope and every column a description", () => {
    expect(COMMON_COLUMNS.map((c) => c.name)).toEqual([
      "id",
      "created_at",
      "updated_at",
      "author_agent",
      "author_human",
      "version",
    ]);
    for (const e of Object.values(ENTITIES)) {
      expect(e.description.length, e.table).toBeGreaterThan(10);
      const names = allColumns(e).map((c) => c.name);
      expect(new Set(names).size, `${e.table} duplicate columns`).toBe(names.length);
      if (e.envelope) expect(names.slice(0, 6)).toEqual(COMMON_COLUMNS.map((c) => c.name));
      for (const c of allColumns(e)) {
        expect(c.description.trim().length, `${e.table}.${c.name}`).toBeGreaterThan(3);
        if (c.references)
          expect(
            ENTITIES[c.references.table],
            `${e.table}.${c.name} -> ${c.references.table}`,
          ).toBeDefined();
        if (c.enum && c.default !== undefined) expect(c.enum).toContain(c.default);
      }
      for (const idx of e.indexes)
        for (const col of idx.columns) expect(names, `${e.table} index ${col}`).toContain(col);
    }
  });

  it("orders tables so every referenced table comes first", () => {
    const order = tableOrder();
    expect(order).toHaveLength(Object.keys(ENTITIES).length);
    for (const [i, table] of order.entries()) {
      for (const c of (ENTITIES[table] as EntityDef).columns) {
        if (c.references && c.references.table !== table)
          expect(order.indexOf(c.references.table), `${table}.${c.name}`).toBeLessThan(i);
      }
    }
    const broken: Record<string, EntityDef> = {
      a: {
        table: "a",
        description: "a",
        envelope: true,
        indexes: [],
        columns: [
          {
            name: "b_id",
            type: "text",
            nullable: false,
            description: "x",
            references: { table: "b", column: "id" },
          },
        ],
      },
      b: {
        table: "b",
        description: "b",
        envelope: true,
        indexes: [],
        columns: [
          {
            name: "a_id",
            type: "text",
            nullable: false,
            description: "x",
            references: { table: "a", column: "id" },
          },
        ],
      },
    };
    expect(() => tableOrder(broken)).toThrow(/cycle/);
    expect(() => tableOrder({ a: broken.a as EntityDef })).toThrow(/unknown table/);
  });
});

/** SHA-256 of JSON.stringify(MIGRATION_0001.up) when v1 was frozen. A shipped migration never changes. */
const V1_FROZEN_SHA256 = "37a1b172413c2fce67967faacaf4626c24186deddde44deafbc69467872ff5d2";

interface SqliteColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

/** Column and index shape of every schema table, for comparing two SQLite databases. */
async function sqliteShape(db: SqliteDatabase): Promise<Record<string, unknown>> {
  const shape: Record<string, unknown> = {};
  for (const table of [...tableOrder(), "schema_migrations"]) {
    const columns = await db.query<SqliteColumn>(`PRAGMA table_info("${table}")`);
    const indexes = await db.query<{ name: string; unique: number }>(
      `PRAGMA index_list("${table}")`,
    );
    shape[table] = {
      columns: columns.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        dflt: c.dflt_value,
        pk: c.pk,
      })),
      indexes: indexes
        .filter((i) => !i.name.startsWith("sqlite_autoindex"))
        .map((i) => ({ name: i.name, unique: i.unique }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  return shape;
}

describe("migrations", () => {
  it("keeps v1 frozen and contiguous: a schema change needs a new migration file", () => {
    expect(MIGRATION_0001.version).toBe(1);
    expect(
      createHash("sha256").update(JSON.stringify(MIGRATION_0001.up)).digest("hex"),
      "0001-initial.ts changed; shipped migrations are frozen, add a new one instead",
    ).toBe(V1_FROZEN_SHA256);
    expect(MIGRATIONS[0]).toBe(MIGRATION_0001);
    expect(MIGRATIONS[1]).toBe(MIGRATION_0002);
    expect(MIGRATIONS[2]).toBe(MIGRATION_0003);
    expect(MIGRATIONS[3]).toBe(MIGRATION_0004);
    expect(MIGRATIONS[4]).toBe(MIGRATION_0005);
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    // v1 is the generator's output for the v1 subset: the v2 columns, the v3 table
    // (source_candidate with its indexes) and the v3 enum value, the v4 column
    // (device.wrap_public_key), the v4 table (secret_grant with its indexes) and the v5
    // columns (milestone.reason, session.reason; task.reason, which v1 had, stays) are the
    // only differences.
    const addedInV5: Record<string, RegExp> = { milestone: /"reason"/, session: /"reason"/ };
    const generated = generateInitialMigration();
    const strip = (stmts: string[]) =>
      stmts
        .filter((s) => !/"source_candidate"|"secret_grant"/.test(s))
        .map((s) => {
          const table = /^CREATE TABLE IF NOT EXISTS "([a-z_]+)"/.exec(s)?.[1];
          const v5 = table === undefined ? undefined : addedInV5[table];
          return s
            .split("\n")
            .filter(
              (line) =>
                !/"context_transforms"|"headroom_used"|"headroom_saved_tokens"|"wrap_public_key"/.test(
                  line,
                ) && !v5?.test(line),
            )
            .join("\n")
            .replace(/,\n {2}PRIMARY KEY/g, ",\n  PRIMARY KEY")
            .replace("'github_user', 'github_repo', 'gitlab'", "'github_user', 'gitlab'");
        });
    expect(strip(generated.sqlite)).toEqual(MIGRATION_0001.up.sqlite);
    expect(strip(generated.postgres)).toEqual(MIGRATION_0001.up.postgres);
  });

  it("every migration applied in order equals the generator's schema for the current declaration (SQLite)", async () => {
    const migrated = await openSqlite(":memory:");
    const generated = await openSqlite(":memory:");
    try {
      await migrate(migrated, { clock: new SimulatedClock() });
      for (const stmt of generateSchemaSql("sqlite")) await generated.exec(stmt);
      await generated.exec(createTableSql(ENTITIES.schema_migrations as EntityDef, "sqlite"));
      expect(await sqliteShape(migrated)).toEqual(await sqliteShape(generated));
    } finally {
      await migrated.close();
      await generated.close();
    }
  });

  it("migrates a v1 database forward: old rows read back with the v2 defaults and accept the new fields", async () => {
    const db = await openSqlite(":memory:");
    try {
      const clock = new SimulatedClock("2026-10-20T10:00:00.000Z");
      const at = clock.nowIso();
      expect(await migrate(db, { clock, migrations: [MIGRATION_0001] })).toEqual({
        applied: [1],
        version: 1,
      });
      // Rows written by the v1 schema, by hand: the repositories would fill in v2 columns.
      await db.query(
        `INSERT INTO "human" ("id", "created_at", "updated_at", "name", "email") VALUES (?, ?, ?, ?, ?)`,
        ["h1", at, at, "Ada", "ada@example.test"],
      );
      await db.query(
        `INSERT INTO "agent" ("id", "created_at", "updated_at", "name", "owner_human_id") VALUES (?, ?, ?, ?, ?)`,
        ["a1", at, at, "Alice", "h1"],
      );
      await db.query(
        `INSERT INTO "session" ("id", "created_at", "updated_at", "agent_id") VALUES (?, ?, ?, ?)`,
        ["s1", at, at, "a1"],
      );
      await db.query(
        `INSERT INTO "run" ("id", "created_at", "updated_at", "session_id", "specialist", "model", "tokens_before_compression", "tokens_after_compression") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["r1", at, at, "s1", "coder", "claude-sonnet-4-5", 5000, 2000],
      );
      const v1Columns = (await db.query<SqliteColumn>(`PRAGMA table_info("run")`)).map(
        (c) => c.name,
      );
      expect(v1Columns).not.toContain("context_transforms");

      expect(await migrate(db, { clock })).toEqual({ applied: [2, 3, 4, 5], version: 5 });
      expect(await appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);

      const repos = createRepos(db, clock);
      const run = await repos.run.mustGet("r1");
      expect(run.tokens_before_compression).toBe(5000);
      expect(run.tokens_after_compression).toBe(2000);
      expect(run.context_transforms).toEqual([]);
      expect(run.headroom_used).toBe(false);
      const session = await repos.session.mustGet("s1");
      expect(session.headroom_saved_tokens).toBe(0);

      const patched = await repos.run.patch("r1", {
        context_transforms: ["logs", "truncate"],
        headroom_used: true,
      });
      expect(patched.context_transforms).toEqual(["logs", "truncate"]);
      expect(patched.headroom_used).toBe(true);
      expect(
        (await repos.session.patch("s1", { headroom_saved_tokens: 1234 })).headroom_saved_tokens,
      ).toBe(1234);
      // A fresh insert through the repository fills the v2 defaults.
      const fresh = await repos.run.insert({ session_id: "s1", specialist: "x", model: "m" });
      expect(fresh.context_transforms).toEqual([]);
      expect(fresh.headroom_used).toBe(false);
    } finally {
      await db.close();
    }
  });

  it("migrates a v2 database forward: source rows survive the rebuild, github_repo is accepted and candidates round-trip", async () => {
    const db = await openSqlite(":memory:");
    try {
      const clock = new SimulatedClock("2026-10-23T10:00:00.000Z");
      const at = clock.nowIso();
      expect(await migrate(db, { clock, migrations: [MIGRATION_0001, MIGRATION_0002] })).toEqual({
        applied: [1, 2],
        version: 2,
      });
      await db.query(
        `INSERT INTO "source" ("id", "created_at", "updated_at", "kind", "display_name", "locator", "credential_ref", "scan_result") VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["src1", at, at, "github_org", "Acme", "acme", "secret:github_token", '{"repos":[]}'],
      );
      // The v2 CHECK refuses the new kind.
      await expect(
        db.query(
          `INSERT INTO "source" ("id", "created_at", "updated_at", "kind", "display_name", "locator") VALUES (?, ?, ?, ?, ?, ?)`,
          ["src2", at, at, "github_repo", "acme/alpha", "acme/alpha"],
        ),
      ).rejects.toThrow();
      expect(await migrate(db, { clock })).toEqual({ applied: [3, 4, 5], version: 5 });

      const repos = createRepos(db, clock);
      const kept = await repos.source.mustGet("src1");
      expect(kept).toMatchObject({
        kind: "github_org",
        display_name: "Acme",
        locator: "acme",
        credential_ref: "secret:github_token",
        scan_result: { repos: [] },
        status: "connected",
        version: 1,
      });
      expect((await repos.source.byLocator("github_org", "acme"))?.id).toBe("src1");
      // The unique (kind, locator) index came back with the rebuilt table.
      await expect(
        repos.source.insert({ kind: "github_org", display_name: "Acme again", locator: "acme" }),
      ).rejects.toThrow();
      const chosen = await repos.source.insert({
        kind: "github_repo",
        display_name: "acme/alpha",
        locator: "acme/alpha",
      });
      expect(chosen.kind).toBe("github_repo");
      const cand = await repos.sourceCandidate.insert({
        source_id: "src1",
        kind: "repo",
        name: "alpha",
        locator: "acme/alpha",
        key: "github:acme/alpha",
        proposed_name: "alpha",
        last_seen_at: at,
      });
      expect(cand.status).toBe("proposed");
      expect((await repos.sourceCandidate.forSource("src1")).map((c) => c.id)).toEqual([cand.id]);
      // A candidate references its source: an unknown source is refused.
      await expect(
        repos.sourceCandidate.insert({
          source_id: "nope",
          kind: "repo",
          name: "x",
          locator: "x/y",
          key: "github:x/y",
          proposed_name: "y",
          last_seen_at: at,
        }),
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it("migrates a v2 database forward to v4: devices read back without a wrapping key and secret grants can be filed", async () => {
    const db = await openSqlite(":memory:");
    try {
      const clock = new SimulatedClock("2026-10-23T10:00:00.000Z");
      const at = clock.nowIso();
      expect(await migrate(db, { clock, migrations: [MIGRATION_0001, MIGRATION_0002] })).toEqual({
        applied: [1, 2],
        version: 2,
      });
      await db.query(
        `INSERT INTO "human" ("id", "created_at", "updated_at", "name", "email") VALUES (?, ?, ?, ?, ?)`,
        ["h1", at, at, "Ada", "ada@example.test"],
      );
      await db.query(
        `INSERT INTO "device" ("id", "created_at", "updated_at", "owner_human_id", "name", "platform", "public_key", "kind", "paired_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["d1", at, at, "h1", "Ada's PC", "linux", "pk-1", "desktop", at],
      );
      const v2Columns = (await db.query<SqliteColumn>(`PRAGMA table_info("device")`)).map(
        (c) => c.name,
      );
      expect(v2Columns).not.toContain("wrap_public_key");
      expect(
        (await db.query(`SELECT name FROM sqlite_master WHERE name = 'secret_grant'`)).length,
      ).toBe(0);

      expect(await migrate(db, { clock })).toEqual({ applied: [3, 4, 5], version: 5 });
      expect(await appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);

      const repos = createRepos(db, clock);
      const device = await repos.device.mustGet("d1");
      expect(device.wrap_public_key).toBeNull();
      const keyed = await repos.device.patch("d1", { wrap_public_key: "wrap-pk" });
      expect(keyed.wrap_public_key).toBe("wrap-pk");
      const grant = await repos.secretGrant.propose({
        name: "org_deploy_token",
        owner_human_id: "h1",
        required_human_ids: ["h2"],
      });
      expect(grant).toMatchObject({ status: "pending", blobs: [], approvals: {}, kind: "token" });
      // A fresh device insert through the repository fills the v4 default.
      const fresh = await repos.device.register({
        owner_human_id: "h1",
        name: "phone",
        platform: "android",
        public_key: "pk-2",
        kind: "phone",
      });
      expect(fresh.wrap_public_key).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("migrates a v2 database forward: milestone and session rows read back with an empty reason and take one through the repositories (B.5)", async () => {
    const db = await openSqlite(":memory:");
    try {
      const clock = new SimulatedClock("2026-10-23T10:00:00.000Z");
      const at = clock.nowIso();
      expect(await migrate(db, { clock, migrations: [MIGRATION_0001, MIGRATION_0002] })).toEqual({
        applied: [1, 2],
        version: 2,
      });
      await db.query(
        `INSERT INTO "human" ("id", "created_at", "updated_at", "name", "email") VALUES (?, ?, ?, ?, ?)`,
        ["h1", at, at, "Ada", "ada@example.test"],
      );
      await db.query(
        `INSERT INTO "agent" ("id", "created_at", "updated_at", "name", "owner_human_id") VALUES (?, ?, ?, ?, ?)`,
        ["a1", at, at, "Alice", "h1"],
      );
      await db.query(
        `INSERT INTO "project" ("id", "created_at", "updated_at", "name") VALUES (?, ?, ?, ?)`,
        ["p1", at, at, "Demo"],
      );
      await db.query(
        `INSERT INTO "milestone" ("id", "created_at", "updated_at", "project_id", "name") VALUES (?, ?, ?, ?, ?)`,
        ["m1", at, at, "p1", "Release 0.1"],
      );
      await db.query(
        `INSERT INTO "session" ("id", "created_at", "updated_at", "agent_id") VALUES (?, ?, ?, ?)`,
        ["s1", at, at, "a1"],
      );
      for (const table of ["milestone", "session"]) {
        const v2Columns = (await db.query<SqliteColumn>(`PRAGMA table_info("${table}")`)).map(
          (c) => c.name,
        );
        expect(v2Columns).not.toContain("reason");
      }

      expect(await migrate(db, { clock })).toEqual({ applied: [3, 4, 5], version: 5 });
      expect(await appliedVersions(db)).toEqual([1, 2, 3, 4, 5]);

      const repos = createRepos(db, clock);
      const milestone = await repos.milestone.mustGet("m1");
      expect(milestone.reason).toBe("");
      expect((await repos.session.mustGet("s1")).reason).toBe("");
      const changed = await repos.milestone.change(
        "m1",
        milestone.version,
        { status: "active" },
        "started after the kickoff",
        { humanId: "h1" },
      );
      expect(changed).toMatchObject({
        status: "active",
        reason: "started after the kickoff",
        author_human: "h1",
        version: 2,
      });
      const planned = await repos.session.setPlan("s1", 1, { items: [] }, "nothing ready", {
        agentId: "a1",
      });
      expect(planned).toMatchObject({
        plan: { items: [] },
        reason: "nothing ready",
        author_agent: "a1",
        version: 2,
      });
      // A fresh session without a plan fills the v5 default through the repository; a fresh
      // milestone is a plan change and must name its reason and author (B.5, the insert guard).
      expect((await repos.session.insert({ agent_id: "a1" })).reason).toBe("");
      await expect(
        repos.milestone.insert({ project_id: "p1", name: "Release 0.2" }),
      ).rejects.toMatchObject({ code: "validation", details: { missing: "reason" } });
      const fresh = await repos.milestone.insert({
        project_id: "p1",
        name: "Release 0.2",
        reason: "the second cut",
        author_human: "h1",
      });
      expect(fresh).toMatchObject({ reason: "the second cut", author_human: "h1", version: 1 });
    } finally {
      await db.close();
    }
  });

  it("renders a module that round-trips through the generator text", () => {
    const text = renderMigrationModule({
      version: 1,
      name: "initial",
      up: generateInitialMigration(),
    });
    expect(text.startsWith("// GENERATED")).toBe(true);
    expect(text).toContain("export const MIGRATION_0001");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toMatch(/\r/);
  });

  it("emits dialect-specific types, enum checks, foreign keys, indexes and append-only triggers", () => {
    const sqlite = generateSchemaSql("sqlite").join("\n");
    const pg = generateSchemaSql("postgres").join("\n");
    expect(sqlite).toContain('"small_project_mode" INTEGER NOT NULL DEFAULT 0');
    expect(pg).toContain('"small_project_mode" BOOLEAN NOT NULL DEFAULT FALSE');
    expect(sqlite).toContain("\"settings\" TEXT NOT NULL DEFAULT '{}'");
    expect(pg).toContain("\"settings\" JSONB NOT NULL DEFAULT '{}'");
    expect(pg).toContain('"budget_usd_micro" BIGINT');
    expect(sqlite).toContain('"budget_usd_micro" INTEGER');
    expect(sqlite).toContain(`CHECK ("status" IN ('draft', 'ready', 'claimed'`);
    expect(pg).toContain('REFERENCES "project" ("id")');
    expect(pg).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "event_session_id_seq_idx"');
    expect(sqlite).toContain("RAISE(ABORT, 'append_only: audit_log')");
    expect(pg).toContain("CREATE OR REPLACE FUNCTION forerunner_append_only()");
    expect(pg).toContain('"audit_log_append_only" BEFORE UPDATE OR DELETE ON "audit_log"');
  });

  it("applies pending migrations once and records them, in order, with the clock's time", async () => {
    const db = await openSqlite(":memory:");
    try {
      const clock = new SimulatedClock("2026-05-05T05:05:05.000Z");
      const probe = MIGRATIONS.length + 1;
      const extra = [
        ...MIGRATIONS,
        {
          version: probe,
          name: "probe",
          up: {
            sqlite: ['CREATE TABLE "probe" ("id" TEXT PRIMARY KEY)'],
            postgres: ['CREATE TABLE "probe" ("id" TEXT PRIMARY KEY)'],
          },
        },
      ];
      const versions = extra.map((m) => m.version);
      expect(await pendingMigrations(db, extra)).toHaveLength(extra.length);
      const first = await migrate(db, { clock, migrations: extra });
      expect(first).toEqual({ applied: versions, version: probe });
      const rows = await db.query<{ version: number; applied_at: string }>(
        'SELECT * FROM "schema_migrations" ORDER BY "version"',
      );
      expect(rows.map((r) => r.applied_at)).toEqual(versions.map(() => "2026-05-05T05:05:05.000Z"));
      expect(await migrate(db, { clock, migrations: extra })).toEqual({
        applied: [],
        version: probe,
      });
      expect(await appliedVersions(db)).toEqual(versions);
      await expect(
        migrate(db, {
          migrations: [{ version: probe + 1, name: "gap", up: { sqlite: [], postgres: [] } }],
        }),
      ).rejects.toThrow(/contiguous/);
      await expect(
        migrate(db, {
          migrations: [
            ...extra,
            {
              version: probe + 1,
              name: "bad",
              up: { sqlite: ["THIS IS NOT SQL"], postgres: [] },
            },
          ],
        }),
      ).rejects.toThrow();
      expect(await appliedVersions(db)).toEqual(versions);
    } finally {
      await db.close();
    }
  });
});

describe("generated data-model doc", () => {
  it("is current: docs/maintainers/data-model.md equals the renderer output", () => {
    const target = join(here, "..", "..", "..", "docs", "maintainers", "data-model.md");
    const onDisk = normalizeNewlines(readFileSync(target, "utf8"));
    expect(onDisk).toBe(renderDataModelDoc());
  });

  it("is deterministic, LF-only, sorted, and documents every table, column and status graph", () => {
    const a = renderDataModelDoc();
    const b = renderDataModelDoc();
    expect(a).toBe(b);
    expect(a).not.toMatch(/\r/);
    expect(a.endsWith("\n")).toBe(true);
    expect(a.endsWith("\n\n")).toBe(false);
    expect(a.startsWith("# Data model\n\n> Generated by `pnpm docs:schema`")).toBe(true);
    const headings = [...a.matchAll(/^### ([a-z_]+)$/gm)]
      .map((m) => m[1])
      .filter((h) => ENTITIES[h as string]);
    expect(headings).toEqual([...headings].sort());
    expect(headings).toHaveLength(Object.keys(ENTITIES).length);
    for (const e of Object.values(ENTITIES))
      for (const c of e.columns) expect(a, `${e.table}.${c.name}`).toContain(`| \`${c.name}\` |`);
    for (const key of Object.keys(STATUS_GRAPHS)) expect(a).toContain(`\`${key}\`:`);
    expect(a).toContain("### Claims");
    expect(a).toContain("### Append-only tables");
    expect(schemaSummary().find((s) => s.table === "task")?.columns).toBe(
      allColumns(ENTITIES.task as EntityDef).length,
    );
  });
});

describe("dialect helpers", () => {
  it("rewrites ? to $n outside quotes and dollar-quoted bodies", () => {
    expect(toPositional("SELECT ? , ?")).toBe("SELECT $1 , $2");
    expect(toPositional(`SELECT '?' AS q, "a?b", ? FROM t WHERE x = ?`)).toBe(
      `SELECT '?' AS q, "a?b", $1 FROM t WHERE x = $2`,
    );
    expect(toPositional("SELECT 'it''s ?', ?")).toBe("SELECT 'it''s ?', $1");
    expect(toPositional("CREATE FUNCTION f() AS $$ SELECT '?' ? $$ LANGUAGE sql; SELECT ?")).toBe(
      "CREATE FUNCTION f() AS $$ SELECT '?' ? $$ LANGUAGE sql; SELECT $1",
    );
  });

  it("maps column types and literals per dialect", () => {
    expect(sqlType("json", "sqlite")).toBe("TEXT");
    expect(sqlType("json", "postgres")).toBe("JSONB");
    expect(sqlType("money", "postgres")).toBe("BIGINT");
    expect(sqlType("real", "postgres")).toBe("DOUBLE PRECISION");
    expect(sqlLiteral(true, "bool", "sqlite")).toBe("1");
    expect(sqlLiteral(false, "bool", "postgres")).toBe("FALSE");
    expect(sqlLiteral("it's", "text", "sqlite")).toBe("'it''s'");
    expect(sqlLiteral({ a: [1] }, "json", "postgres")).toBe(`'{"a":[1]}'`);
    expect(jsonArrayContains('"tags"', "sqlite")).toContain("json_each");
    expect(jsonArrayContains('"tags"', "postgres")).toContain("@>");
    expect(upsertSql("t", ["id", "n"], ["id"], ["n"])).toBe(
      `INSERT INTO "t" ("id", "n") VALUES (?, ?) ON CONFLICT ("id") DO UPDATE SET "n" = excluded."n" RETURNING *`,
    );
  });
});

describe("codec", () => {
  const task = ENTITIES.task as EntityDef;

  it("decodes SQLite and Postgres raw rows to the same JS shape", () => {
    const fromSqlite = decodeRow<Record<string, unknown>>(
      task,
      {
        small: 1,
        depends_on: '["a"]',
        budget_usd_micro: 5,
        risk_tier: "2",
        status: "ready",
      },
      "sqlite",
    );
    const fromPg = decodeRow<Record<string, unknown>>(
      task,
      {
        depends_on: ["a"],
        budget_usd_micro: 5,
        risk_tier: 2,
        status: "ready",
      },
      "postgres",
    );
    expect(fromSqlite.depends_on).toEqual(["a"]);
    expect(fromPg.depends_on).toEqual(["a"]);
    expect(fromSqlite.risk_tier).toBe(2);
    expect(
      decodeRow<Record<string, unknown>>(ENTITIES.project as EntityDef, { active: 0 }, "sqlite")
        .active,
    ).toBe(false);
    expect(
      decodeRow<Record<string, unknown>>(
        ENTITIES.project as EntityDef,
        { active: true },
        "postgres",
      ).active,
    ).toBe(true);
  });

  it("encodes booleans and JSON per dialect and rejects bad input", () => {
    expect(
      encodePatch(ENTITIES.project as EntityDef, { active: true, repos: ["r"] }, "sqlite"),
    ).toEqual({ columns: ["active", "repos"], values: [1, '["r"]'] });
    expect(
      encodePatch(ENTITIES.project as EntityDef, { active: true, repos: ["r"] }, "postgres"),
    ).toEqual({ columns: ["active", "repos"], values: [true, '["r"]'] });
    expect(() => encodePatch(task, { nope: 1 }, "sqlite")).toThrow(/unknown column/);
    expect(() => encodePatch(task, { title: null }, "sqlite")).toThrow(/cannot be null/);
    expect(() => encodePatch(task, { status: "flying" }, "sqlite")).toThrow(/invalid value/);
    expect(() => encodePatch(task, { priority: 1.5 }, "sqlite")).toThrow(/integer/);
    expect(() => encodePatch(task, { budget_usd_micro: 2 ** 53 + 2 }, "sqlite")).toThrow(/2\^53/);
    expect(() => encodePatch(task, { claim_expires: 12 }, "sqlite")).toThrow(/ISO-8601/);
    expect(
      encodePatch(task, { claim_expires: new Date("2026-01-01T00:00:00Z") }, "sqlite").values,
    ).toEqual(["2026-01-01T00:00:00.000Z"]);
  });
});

describe("workflow graphs", () => {
  it("encodes the task graph from the spec", () => {
    expect(canTransition(TASK_TRANSITIONS, "draft", "ready")).toBe(true);
    expect(canTransition(TASK_TRANSITIONS, "in_review", "done")).toBe(true);
    expect(canTransition(TASK_TRANSITIONS, "done", "ready")).toBe(false);
    for (const active of ["ready", "claimed", "in_progress", "in_review"] as const) {
      for (const exit of ["needs_human", "failed", "cancelled"] as const)
        expect(canTransition(TASK_TRANSITIONS, active, exit), `${active}->${exit}`).toBe(true);
    }
    expect(canTransition(TASK_TRANSITIONS, "needs_human", "ready")).toBe(true);
    expect(canTransition(TASK_TRANSITIONS, "failed", "ready")).toBe(true);
    expect(() => assertTransition(TASK_TRANSITIONS, "task", "draft", "done")).toThrow(
      /illegal transition/,
    );
    for (const graph of Object.values(STATUS_GRAPHS)) {
      for (const [from, targets] of Object.entries(graph))
        for (const to of targets) expect(graph[to], `${from}->${to}`).toBeDefined();
    }
  });
});

describe("store urls", () => {
  it("parses sqlite and postgres urls and rejects others without leaking credentials", () => {
    expect(parseStoreUrl("sqlite::memory:")).toEqual({ dialect: "sqlite", location: ":memory:" });
    expect(parseStoreUrl("sqlite:/tmp/x.db")).toEqual({ dialect: "sqlite", location: "/tmp/x.db" });
    expect(parseStoreUrl("sqlite:C:\\data\\x.db")).toEqual({
      dialect: "sqlite",
      location: "C:\\data\\x.db",
    });
    expect(parseStoreUrl("postgresql://u:p@h/d")).toEqual({
      dialect: "postgres",
      url: "postgresql://u:p@h/d",
    });
    expect(() => parseStoreUrl("sqlite:")).toThrow(/path/);
    let caught: unknown;
    try {
      parseStoreUrl("mysql://user:hunter2@host/db");
    } catch (e) {
      caught = e;
    }
    expect(String((caught as { details: { url: string } }).details.url)).not.toContain("hunter2");
  });
});

describe("monotonic ids", () => {
  it("are valid UUIDv7, unique and sorted in creation order within one millisecond", () => {
    const ids = Array.from({ length: 3000 }, () => monotonicId(1_700_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    for (const id of ids.slice(0, 50))
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const later = monotonicId(1_700_000_000_000 + 60_000);
    expect(later > (ids[ids.length - 1] as string)).toBe(true);
    expect(monotonicId(1)).toMatch(/^[0-9a-f]{8}-/); // time never runs backwards: reuses the last ms
  });
});
