import type { ExtensionCatalog } from "../extensions/catalog.ts";
import { panelKind } from "../extensions/registry.ts";
import type { ModelWatch } from "../models/watch.ts";
import type {
  ExtensionRef,
  ModelWatchEntry,
  ModelWatchReport as ModelWatchReportPort,
  CatalogEntry as UpdateCatalogEntry,
  ExtensionCatalog as UpdateCatalogPort,
} from "../update/ports.ts";

/**
 * Adapters the updates screen needs (spec M.5): connector versions come from the extension
 * catalog (built-in plus the remote catalog the human configured), model updates from the
 * latest model watch report. Both are read-only views over modules that exist already.
 */
export class RegistryConnectorCatalog implements UpdateCatalogPort {
  constructor(private readonly catalog: ExtensionCatalog) {}

  async latestVersions(refs: ExtensionRef[]): Promise<UpdateCatalogEntry[]> {
    const entries = this.catalog.entries();
    const out: UpdateCatalogEntry[] = [];
    for (const ref of refs) {
      const match = entries.find((e) => e.kind === panelKind(ref.kind) && e.name === ref.name);
      if (!match) continue;
      out.push({
        kind: ref.kind,
        name: ref.name,
        version: match.version,
        sourceUrl: match.homepage ?? null,
        notes: match.description,
      });
    }
    return out;
  }
}

export class ModelWatchUpdates implements ModelWatchReportPort {
  constructor(private readonly watch: ModelWatch) {}

  async latest(): Promise<ModelWatchEntry[]> {
    const found = await this.watch.latestReport();
    if (!found) return [];
    const { report, health } = found;
    const at = report.generated_at;
    const out: ModelWatchEntry[] = [];
    for (const m of report.diff.new_models) {
      out.push({
        model: m.id,
        provider: m.provider,
        kind: "new_model",
        summary: `${m.id} (${m.tier}) is listed by ${m.provider}; ${m.priced ? `priced from the ${m.price_origin.replace("_", " ")}` : "no price known, not evaluated"}`,
        reportedAt: at,
      });
    }
    for (const m of report.diff.retired_models) {
      out.push({
        model: m.id,
        provider: m.provider,
        kind: "deprecation",
        summary: `${m.id} is no longer listed by ${m.provider}; rung ${m.tier} needs a replacement`,
        reportedAt: at,
      });
    }
    for (const r of report.diff.repriced) {
      out.push({
        model: r.model,
        provider: "",
        kind: "price_change",
        summary: `${r.model}: ${r.changes
          .map((c) => `${c.field} ${c.before ?? "n/a"} -> ${c.after}`)
          .join(", ")}`,
        evidence: r.changes.map((c) =>
          c.delta_pct === null ? `${c.field}: new` : `${c.field}: ${c.delta_pct}%`,
        ),
        reportedAt: at,
      });
    }
    for (const rec of report.recommendations) {
      out.push({
        model:
          rec.kind === "reprice" ? rec.model : rec.kind === "switch_model" ? rec.to : rec.model,
        provider: rec.kind === "reprice" ? "" : rec.provider,
        kind: "recommendation",
        summary: rec.text,
        recommendedAction:
          health.decision === "pending"
            ? `Decide in the inbox${health.request_id ? ` (request ${health.request_id})` : ""}`
            : `Decision: ${health.decision}`,
        evidence: rec.kind === "reprice" ? [] : rec.evidence,
        reportedAt: at,
      });
    }
    return out;
  }
}
