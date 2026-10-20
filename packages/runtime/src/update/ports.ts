import type { HumanRequestRepo, RiskLevel } from "@forerunner/state";

/**
 * Ports the updater needs from the outside: a human (approval of an agent-initiated update,
 * notification after a rollback), a restarter (the shells implement "Update and restart"),
 * and the two catalogue ports the updates screen composes (connector catalog, model watch).
 */
export interface UpdateHumanAsk {
  kind: "approval" | "decision" | "info";
  why: string;
  steps?: string[];
  options?: string[];
  risk: RiskLevel;
  blocking: boolean;
  humanId?: string | null;
}

export type UpdateHumanOutcome = "approved" | "denied" | "pending";

export interface UpdateHumanAnswer {
  outcome: UpdateHumanOutcome;
  /** Id of the human_request row when one was created. */
  requestId?: string;
  detail?: string;
}

export interface UpdateNotification {
  title: string;
  body: string;
  severity: "info" | "warning" | "error";
  humanId?: string | null;
}

export interface UpdateHumanPort {
  ask(req: UpdateHumanAsk): Promise<UpdateHumanAnswer>;
  notify(note: UpdateNotification): Promise<void>;
}

/** Production port: every ask and notification becomes a human_request row (inbox item). */
export class HumanRequestUpdatePort implements UpdateHumanPort {
  constructor(
    private readonly repo: Pick<HumanRequestRepo, "insert">,
    private readonly defaultHumanId: string | null = null,
  ) {}

  async ask(req: UpdateHumanAsk): Promise<UpdateHumanAnswer> {
    const row = await this.repo.insert({
      human_id: req.humanId ?? this.defaultHumanId,
      kind: req.kind,
      why: req.why,
      steps: req.steps ?? [],
      options: req.options ?? [],
      blocking: req.blocking,
      risk: req.risk,
      author_agent: "updater",
    });
    // A human answers from the inbox; the caller treats "pending" as not approved.
    return { outcome: "pending", requestId: row.id };
  }

  async notify(note: UpdateNotification): Promise<void> {
    await this.repo.insert({
      human_id: note.humanId ?? this.defaultHumanId,
      kind: "info",
      why: `${note.title}\n\n${note.body}`,
      steps: [],
      options: [],
      blocking: false,
      risk: note.severity === "error" ? "high" : note.severity === "warning" ? "medium" : "low",
      author_agent: "updater",
    });
  }
}

/** Test port: scripted answers, recorded asks and notifications. */
export class FakeUpdateHumanPort implements UpdateHumanPort {
  readonly asks: UpdateHumanAsk[] = [];
  readonly notifications: UpdateNotification[] = [];
  constructor(private outcome: UpdateHumanOutcome = "approved") {}

  setOutcome(outcome: UpdateHumanOutcome): void {
    this.outcome = outcome;
  }
  async ask(req: UpdateHumanAsk): Promise<UpdateHumanAnswer> {
    this.asks.push(req);
    return { outcome: this.outcome, requestId: `fake-${this.asks.length}` };
  }
  async notify(note: UpdateNotification): Promise<void> {
    this.notifications.push(note);
  }
}

export interface RestartRequest {
  reason: "update" | "rollback";
  /** Version named by current.json after the write; the shell launches this one. */
  targetVersion: string;
  fromVersion: string | null;
}

/** "Update and restart": the desktop and Android shells relaunch into current.json's version. */
export interface Restarter {
  restart(req: RestartRequest): Promise<void>;
}

/** Records restart requests; the CLI and tests use it (a CLI cannot relaunch the app). */
export class RecordingRestarter implements Restarter {
  readonly requests: RestartRequest[] = [];
  async restart(req: RestartRequest): Promise<void> {
    this.requests.push(req);
  }
}

export interface ExtensionRef {
  kind: string;
  name: string;
}

export interface CatalogEntry extends ExtensionRef {
  /** Newest version the catalog offers. */
  version: string;
  sourceUrl?: string | null;
  notes?: string;
}

/** Where connector, MCP server, skill and specialist versions come from (the registry). */
export interface ExtensionCatalog {
  latestVersions(refs: ExtensionRef[]): Promise<CatalogEntry[]>;
}

export interface ModelWatchEntry {
  model: string;
  provider: string;
  kind: "new_model" | "price_change" | "deprecation" | "recommendation";
  summary: string;
  recommendedAction?: string;
  evidence?: string[];
  reportedAt: string;
}

/** The weekly model watch (spec D, phase 7) lives in its own module; this is what it reports. */
export interface ModelWatchReport {
  latest(): Promise<ModelWatchEntry[]>;
}

/** Catalog and model-watch stand-ins for tests and for installs without a registry. */
export class StaticExtensionCatalog implements ExtensionCatalog {
  constructor(private readonly entries: CatalogEntry[] = []) {}
  async latestVersions(refs: ExtensionRef[]): Promise<CatalogEntry[]> {
    return this.entries.filter((e) => refs.some((r) => r.kind === e.kind && r.name === e.name));
  }
}

export class StaticModelWatchReport implements ModelWatchReport {
  constructor(private readonly entries: ModelWatchEntry[] = []) {}
  async latest(): Promise<ModelWatchEntry[]> {
    return this.entries;
  }
}
