/**
 * Anthropic's web search on an API key, the daemon's side ('web-search', the owner's decision of
 * 2026-11-02; ADR 0107 amended): whether a run may be offered the search, with which lists, and
 * the marks a refusal leaves.
 *
 * - The account's administrator switched web search off (the API's "not enabled" 400): search is
 *   off for that key, kept on its billing source (`limits.webSearchOffAt` with the key's
 *   fingerprint), after a restart too, and over once another key is saved.
 * - The server refused the project's lists (a domain it cannot take, an allowed list outside the
 *   organisation's): search is off for that project's lists on that key
 *   (`limits.webSearchRefusedLists[projectId]`), over once the lists or the key change.
 *
 * Either way the run goes on without the tool (the loop driver makes the call again) and the
 * session's log says it once; the chooser reads the key's mark (`keySearchOff`), so research is
 * not sent to the key for a search it cannot do. No table: the marks live beside the refused and
 * resting marks of credential-limits (ADR 0100).
 */
import { errorMessage, log, redact } from "@forerunner/platform";
import type { JsonObject, StateStore } from "@forerunner/state";
import type { Vault } from "@forerunner/vault";
import { credentialFingerprint, updateSourceLimits } from "./billing-pick.ts";
import type { WebSearchLists } from "./web-ports.ts";

/** The audit row a web search refusal writes ('web-search'). */
export const WEB_SEARCH_REFUSED_AUDIT = "web_search.refused";

/** At most this many searches per task, over all its runs (the owner's decision of 2026-11-02). */
export const WEB_SEARCH_TASK_CAP = 10;

/** What the session's log says once when the account switched search off. */
export const WEB_SEARCH_OFF_LINE =
  "Web search is switched off for this API key; research reads pages by address.";
/** What the session's log says once when the server refused the project's lists. */
export const WEB_SEARCH_LISTS_LINE =
  "Web search refused this project's site list; research reads pages by address.";

export type WebSearchRefusal = "off" | "lists";

export interface WebSearchMarksDeps {
  store: Pick<StateStore, "billingSource" | "auditLog">;
  /** `get` fingerprints the key, so a new key ends the marks. */
  vault: Partial<Pick<Vault, "get">>;
  clock: { nowIso(): string };
  humanId: string;
}

/** The kinds of billing source whose key Anthropic's web search runs on. */
const KEY_KINDS: ReadonlySet<string> = new Set(["api_key", "plan_credits"]);

export class WebSearchMarks {
  private readonly logger = log("web-search");
  /** The chooser's view (sync): whether every saved API key has search off. */
  private offCache = false;

  constructor(private readonly deps: WebSearchMarksDeps) {}

  /** The current key's fingerprint, or null when the vault holds none (or cannot say). */
  private async fingerprint(row: { credential_ref: string | null }): Promise<string | null> {
    if (!row.credential_ref || !this.deps.vault.get) return null;
    const v = await this.deps.vault.get(row.credential_ref).catch(() => null);
    return v ? credentialFingerprint(v) : null;
  }

  /** Whether the source's key has search switched off (the mark of the key in the vault now). */
  async offFor(sourceId: string): Promise<boolean> {
    const row = await this.deps.store.billingSource.get(sourceId).catch(() => undefined);
    if (!row || typeof row.limits.webSearchOffAt !== "string") return false;
    const key = row.limits.webSearchOffKey;
    if (typeof key !== "string") return true;
    const now = await this.fingerprint(row);
    return now === null || now === key;
  }

  /** Whether the server refused these lists of the project on the source's key. */
  async listsRefused(sourceId: string, projectId: string, lists: WebSearchLists): Promise<boolean> {
    const row = await this.deps.store.billingSource.get(sourceId).catch(() => undefined);
    const all = row?.limits.webSearchRefusedLists;
    if (!row || !all || typeof all !== "object" || Array.isArray(all)) return false;
    const mark = (all as JsonObject)[projectId];
    if (!mark || typeof mark !== "object" || Array.isArray(mark)) return false;
    const m = mark as JsonObject;
    if (m.lists !== lists.key) return false;
    const now = await this.fingerprint(row);
    return typeof m.key !== "string" || now === null || now === m.key;
  }

  /**
   * A refusal met by a run: the mark on the source (once; a second refusal changes nothing), one
   * audit row, and the chooser's view refreshed.
   */
  async refused(input: {
    sourceId: string;
    projectId: string;
    reason: WebSearchRefusal;
    message: string;
    lists?: WebSearchLists;
  }): Promise<void> {
    const row = await this.deps.store.billingSource.get(input.sourceId).catch(() => undefined);
    if (!row) return;
    const fp = await this.fingerprint(row);
    const words = redact(input.message).slice(0, 300);
    // Written with the version check (R-limitsrmw), so a rest or a wait written meanwhile stays.
    await updateSourceLimits(this.deps.store, row.id, (stored) => {
      const limits: JsonObject = { ...stored };
      if (input.reason === "off") {
        limits.webSearchOffAt = this.deps.clock.nowIso();
        if (fp) limits.webSearchOffKey = fp;
        limits.webSearchOffWhy = words;
      } else {
        const prev = stored.webSearchRefusedLists;
        const all: JsonObject =
          prev && typeof prev === "object" && !Array.isArray(prev)
            ? { ...(prev as JsonObject) }
            : {};
        all[input.projectId] = {
          at: this.deps.clock.nowIso(),
          lists: input.lists?.key ?? "",
          ...(fp ? { key: fp } : {}),
          why: words,
        };
        limits.webSearchRefusedLists = all;
      }
      return limits;
    });
    this.logger.warn("web search refused", { sourceId: row.id, reason: input.reason });
    await this.deps.store.auditLog
      .append({
        tool: WEB_SEARCH_REFUSED_AUDIT,
        allowed: true,
        human_id: this.deps.humanId,
        input_summary: JSON.stringify({
          sourceId: row.id,
          reason: input.reason,
          ...(input.reason === "lists" ? { projectId: input.projectId } : {}),
        }),
        result_summary: `search off (${input.reason}): ${words}`.slice(0, 500),
        occurred_at: this.deps.clock.nowIso(),
      })
      .catch((e: unknown) =>
        this.logger.warn("web search refusal not audited", { error: errorMessage(e) }),
      );
    await this.refresh();
  }

  /**
   * Reads the marks again for the chooser (`keySearchOff`): at the start, after a refusal and on
   * the scheduler's tick, so a key saved in Settings ends the mark without a restart.
   */
  async refresh(): Promise<void> {
    try {
      const rows = (await this.deps.store.billingSource.enabledFor(this.deps.humanId)).filter((r) =>
        KEY_KINDS.has(r.kind),
      );
      if (!rows.length) {
        this.offCache = false;
        return;
      }
      let off = 0;
      for (const r of rows) if (await this.offFor(r.id)) off++;
      this.offCache = off === rows.length;
    } catch (e) {
      this.logger.warn("web search marks not read", { error: errorMessage(e) });
    }
  }

  /** Whether search is off on every saved API key (the chooser's `keySearch` is then false). */
  keySearchOff(): boolean {
    return this.offCache;
  }
}
