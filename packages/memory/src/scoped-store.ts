import { ForerunnerError } from "@forerunner/platform";
import {
  type Filter,
  LESSON_SCOPES,
  type LessonRow,
  type LessonScope,
  type LessonSearch,
  type ListOptions,
  type NewLesson,
} from "@forerunner/state";
import type { LessonStore } from "./types.ts";

/**
 * One lesson store over two (ADR 0002 "Private rows exist only in the local SQLite", ADR 0083):
 * the private scope lives in a local index on the owner's PC, critic and shared lessons in the
 * shared state store. Writes route by the row's scope; reads by id look in the private index
 * first, then the shared store; a list or count without a single scope unions both. A row
 * never changes store: an update, patch or supersede that would move a lesson across the
 * boundary is refused with `MEMORY_SCOPE_VIOLATION` (promotion copies, it does not move).
 *
 * The shared store refuses a private write on its own too (`LessonRepo` on the Postgres
 * dialect); this class is what keeps the memory functions from ever sending one.
 */
export interface ScopedLessonStoreOptions {
  /** The local index: `agent_private` rows only. */
  private: LessonStore;
  /** The shared state: `critic` and `shared` rows. */
  shared: LessonStore;
}

function isScope(value: unknown): value is LessonScope {
  return typeof value === "string" && (LESSON_SCOPES as readonly string[]).includes(value);
}

export class ScopedLessonStore implements LessonStore {
  private readonly privateStore: LessonStore;
  private readonly sharedStore: LessonStore;

  constructor(opts: ScopedLessonStoreOptions) {
    this.privateStore = opts.private;
    this.sharedStore = opts.shared;
  }

  /** The store that holds a scope. */
  storeFor(scope: LessonScope): LessonStore {
    return scope === "agent_private" ? this.privateStore : this.sharedStore;
  }

  private storeForInput(scope: unknown, operation: string): LessonStore {
    if (!isScope(scope)) {
      throw new ForerunnerError("validation", `lesson ${operation}: a scope is required`, {
        details: { scope, operation },
      });
    }
    return this.storeFor(scope);
  }

  /** The store that holds a row, by id; undefined when neither does. */
  private async locate(id: string): Promise<{ store: LessonStore; row: LessonRow } | undefined> {
    const mine = await this.privateStore.get(id);
    if (mine) return { store: this.privateStore, row: mine };
    const ours = await this.sharedStore.get(id);
    if (ours) return { store: this.sharedStore, row: ours };
    return undefined;
  }

  private async mustLocate(id: string): Promise<{ store: LessonStore; row: LessonRow }> {
    const found = await this.locate(id);
    if (!found) {
      throw new ForerunnerError("not_found", `lesson ${id} not found`, {
        details: { table: "lesson", id },
      });
    }
    return found;
  }

  /** A patch may keep a row's scope; it may never carry it into the other store. */
  private assertStaysHome(row: LessonRow, scope: unknown, operation: string): void {
    if (scope === undefined || scope === row.scope) return;
    if (isScope(scope) && this.storeFor(scope) === this.storeFor(row.scope)) return;
    throw new ForerunnerError(
      "MEMORY_SCOPE_VIOLATION",
      `lesson ${operation}: a ${row.scope} lesson is never moved into the ${String(scope)} store`,
      { details: { id: row.id, from: row.scope, to: scope, operation } },
    );
  }

  // --- writes -----------------------------------------------------------------------------

  async insert(input: Record<string, unknown>): Promise<LessonRow> {
    return this.storeForInput(input.scope, "insert").insert(input);
  }

  async insertMany(inputs: Record<string, unknown>[]): Promise<LessonRow[]> {
    const out: LessonRow[] = [];
    for (const input of inputs) out.push(await this.insert(input));
    return out;
  }

  add(input: NewLesson): Promise<LessonRow> {
    return this.insert(input);
  }

  async update(id: string, expectedVersion: number, patch: Partial<LessonRow>): Promise<LessonRow> {
    const { store, row } = await this.mustLocate(id);
    this.assertStaysHome(row, patch.scope, "update");
    return store.update(id, expectedVersion, patch);
  }

  async patch(id: string, patch: Partial<LessonRow>): Promise<LessonRow> {
    const { store, row } = await this.mustLocate(id);
    this.assertStaysHome(row, patch.scope, "patch");
    return store.patch(id, patch);
  }

  /**
   * Raw updates route by the scope the patch names (the index mirror always names it); without
   * one they run on both stores, which is harmless for a `"id" = ?` clause.
   */
  async updateWhere(
    patch: Partial<LessonRow>,
    whereSql: string,
    whereParams: unknown[],
    extra: { set: string[]; params: unknown[] } = { set: [], params: [] },
  ): Promise<LessonRow[]> {
    if (patch.scope !== undefined) {
      return this.storeForInput(patch.scope, "update").updateWhere(
        patch,
        whereSql,
        whereParams,
        extra,
      );
    }
    return [
      ...(await this.privateStore.updateWhere(patch, whereSql, whereParams, extra)),
      ...(await this.sharedStore.updateWhere(patch, whereSql, whereParams, extra)),
    ];
  }

  async overwriteEnvelope(
    id: string,
    envelope: { version: number; updated_at: string; created_at: string },
  ): Promise<void> {
    const { store } = await this.mustLocate(id);
    await store.overwriteEnvelope(id, envelope);
  }

  async delete(id: string): Promise<boolean> {
    const found = await this.locate(id);
    return found ? found.store.delete(id) : false;
  }

  async touch(id: string, now?: string): Promise<LessonRow> {
    const { store } = await this.mustLocate(id);
    return now === undefined ? store.touch(id) : store.touch(id, now);
  }

  async retire(id: string, expectedVersion: number): Promise<LessonRow> {
    const { store } = await this.mustLocate(id);
    return store.retire(id, expectedVersion);
  }

  async supersede(oldId: string, input: Partial<NewLesson> & { text: string }): Promise<LessonRow> {
    const { store, row } = await this.mustLocate(oldId);
    this.assertStaysHome(row, input.scope, "supersede");
    return store.supersede(oldId, input);
  }

  async setPinned(id: string, expectedVersion: number, pinned: boolean): Promise<LessonRow> {
    const { store } = await this.mustLocate(id);
    return store.setPinned(id, expectedVersion, pinned);
  }

  // --- reads ------------------------------------------------------------------------------

  async get(id: string): Promise<LessonRow | undefined> {
    return (await this.locate(id))?.row;
  }

  async mustGet(id: string): Promise<LessonRow> {
    return (await this.mustLocate(id)).row;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.locate(id)) !== undefined;
  }

  search(q: LessonSearch): Promise<LessonRow[]> {
    return this.storeFor(q.scope).search(q);
  }

  /** One store for a single-scope filter; both (private first, then shared) otherwise. */
  async list(filter?: Filter<LessonRow>, opts: ListOptions = {}): Promise<LessonRow[]> {
    const scope = filter?.scope;
    if (isScope(scope)) return this.storeFor(scope).list(filter, opts);
    const rows = [
      ...(await this.privateStore.list(filter, opts)),
      ...(await this.sharedStore.list(filter, opts)),
    ];
    return opts.limit === undefined ? rows : rows.slice(0, Math.max(0, Math.floor(opts.limit)));
  }

  async count(filter?: Filter<LessonRow>): Promise<number> {
    const scope = filter?.scope;
    if (isScope(scope)) return this.storeFor(scope).count(filter);
    return (await this.privateStore.count(filter)) + (await this.sharedStore.count(filter));
  }
}
