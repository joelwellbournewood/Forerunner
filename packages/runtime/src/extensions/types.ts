import { z } from "zod";
import { Money } from "../daemon/api-types.ts";
import type { ActionClass } from "../enforcement/autonomy.ts";

/**
 * Shared shapes of the extensions registry (spec K "Extensions panel", L "Connectors").
 * Everything stored in the `extension` row's JSON columns is validated with these schemas on
 * the way in and on the way out, so a hand-edited row cannot widen a grant silently.
 */

/** Kinds shown in the panel. `mcp_server` rows (state alias) are treated as connectors. */
export const EXTENSION_PANEL_KINDS = [
  "connector",
  "skill",
  "specialist",
  "capability",
  "model_provider",
] as const;
export type ExtensionPanelKind = (typeof EXTENSION_PANEL_KINDS)[number];

export const EXTENSION_STATUSES = ["enabled", "disabled", "error", "pending_approval"] as const;
export type ExtensionStatus = (typeof EXTENSION_STATUSES)[number];

/** Row-level status strings stored in `extension.status`. */
export const ROW_STATUS_INSTALLED = "installed";
export const ROW_STATUS_PENDING = "pending_approval";
export const ROW_STATUS_ERROR = "error";

/**
 * What a pending row is waiting for. `discovery`: the human has not yet allowed the
 * connector's command (or endpoint) to be started for discovery with the secrets it names;
 * `grant`: the review is complete and the human decides on the capability grant itself.
 */
export const GRANT_STAGES = ["discovery", "grant"] as const;
export type GrantStage = (typeof GRANT_STAGES)[number];

export const ACTION_CLASSES = [
  "read",
  "routine_reversible",
  "non_routine",
  "merge_pr",
  "deploy_staging",
  "deploy_production",
  "external_send",
  "destructive",
  "financial",
  "credential",
  "permission_change",
  "capability_grant",
] as const satisfies readonly ActionClass[];

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISK_LEVELS)[number];

/** Forerunner tool names: letters, digits, `_ . -`; never a wildcard. */
export const BRIDGED_TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

const Domain = z
  .string()
  .trim()
  .min(1)
  .refine((d) => d !== "*" && !/^\*(\.\*)*$/.test(d), "'*' is not an allowed domain")
  .refine(
    (d) => /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(d),
    "domains are hostnames, optionally with a leading '*.'",
  )
  .transform((d) => d.toLowerCase());

const SecretName = z.string().regex(/^[a-z][a-z0-9_.:-]{0,127}$/, "invalid secret name");

const ToolName = z
  .string()
  .regex(BRIDGED_TOOL_NAME_RE, "tool names are letters, digits, '_', '.', '-'")
  .refine((t) => !t.includes("*"), "wildcards are never allowed");

/**
 * What an extension is allowed to do: the tool names it contributes, the action classes those
 * tools fall in, the domains and path roots its tools may touch (empty = no extra ceiling
 * beyond the run token), the secret names it may receive, and the human-readable scopes the
 * panel shows as granted.
 */
export const ExtensionPermissions = z
  .object({
    tools: z.array(ToolName).default([]),
    actionClasses: z.array(z.enum(ACTION_CLASSES)).default([]),
    domains: z.array(Domain).default([]),
    paths: z.array(z.string().min(1)).default([]),
    secrets: z.array(SecretName).default([]),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ExtensionPermissions = z.infer<typeof ExtensionPermissions>;

export const EMPTY_PERMISSIONS: ExtensionPermissions = {
  tools: [],
  actionClasses: [],
  domains: [],
  paths: [],
  secrets: [],
  scopes: [],
};

export const ReviewedTool = z
  .object({
    /** Name on the MCP server. */
    name: z.string().min(1),
    /** Name the runtime and the tokens use. */
    bridgedName: ToolName,
    description: z.string().default(""),
    actionClass: z.enum(ACTION_CLASSES),
    risk: z.enum(RISK_LEVELS),
    pathFields: z.array(z.string()).default([]),
    domainFields: z.array(z.string()).default([]),
    /** Why the class was chosen: annotation, name pattern or default. */
    inferredFrom: z.string().default(""),
  })
  .strict();
export type ReviewedTool = z.infer<typeof ReviewedTool>;

export const ReviewedResource = z
  .object({
    uri: z.string().min(1),
    name: z.string().default(""),
    description: z.string().default(""),
    mimeType: z.string().default(""),
  })
  .strict();
export type ReviewedResource = z.infer<typeof ReviewedResource>;

/**
 * What the human sees before saying yes: every tool with its inferred class and risk, the
 * resources, the domains the server will reach, the secret references it needs, the paths it
 * may touch and the overall risk. Never a secret value.
 */
export const PermissionReview = z
  .object({
    tools: z.array(ReviewedTool),
    resources: z.array(ReviewedResource),
    permissions: ExtensionPermissions,
    risk: z.enum(RISK_LEVELS),
    /** One line per grant for the approval card. */
    summary: z.array(z.string()),
  })
  .strict();
export type PermissionReview = z.infer<typeof PermissionReview>;

export interface Actor {
  humanId?: string | null;
  agentId?: string | null;
}

export type ExtensionEventType =
  | "extension.requested"
  | "extension.approved"
  | "extension.denied"
  | "extension.enabled"
  | "extension.disabled"
  | "extension.removed"
  | "extension.permissions_updated"
  | "extension.discovered"
  | "extension.error";

export interface ExtensionEvent {
  type: ExtensionEventType;
  extensionId: string;
  name: string;
  kind: ExtensionPanelKind;
  at: string;
  by: Actor;
  detail: Record<string, unknown>;
}

export type ExtensionEventSink = (event: ExtensionEvent) => void;

/** Why the human is asked; "granting a new capability" always needs a human. */
export interface CapabilityGrantRequest {
  extensionId: string;
  name: string;
  kind: ExtensionPanelKind;
  humanId: string | null;
  /** `discovery`: allow the command/endpoint to be started once, with the named secrets; `grant`: the capability grant. */
  stage: GrantStage;
  why: string;
  review: PermissionReview;
  /** The permissions that would be in force after a yes. */
  permissions: ExtensionPermissions;
  /** The permissions in force now (null for a fresh install). */
  previous: ExtensionPermissions | null;
  sourceUrl: string | null;
}

export type GrantOutcome = "approved" | "denied" | "pending";

export interface GrantAnswer {
  outcome: GrantOutcome;
  /** Id of the HumanRequest (or fake) that carries the question; null when answered at once. */
  requestId: string | null;
}

/** The port every capability grant goes through. Production: HumanRequestRepo; tests: a fake. */
export interface ExtensionApprovalPort {
  ask(request: CapabilityGrantRequest): Promise<GrantAnswer>;
  status(requestId: string): Promise<GrantOutcome>;
}

export { Money } from "../daemon/api-types.ts";

/** What the panel shows per extension. */
export const ExtensionView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(EXTENSION_PANEL_KINDS),
  status: z.enum(EXTENSION_STATUSES),
  enabled: z.boolean(),
  description: z.string(),
  permissions: ExtensionPermissions,
  /** Permissions waiting for a yes (re-permissioning), or null. */
  pendingPermissions: ExtensionPermissions.nullable(),
  /** What a pending row waits for: the discovery run, or the grant itself. */
  pendingStage: z.enum(GRANT_STAGES).nullable(),
  review: PermissionReview.nullable(),
  cost: Money,
  version: z.string(),
  /** Catalog id (`catalog:<id>`) or the URL it was installed from. */
  source: z.string().nullable(),
  installedAt: z.string(),
  updatedAt: z.string(),
  rowVersion: z.number().int(),
  error: z.string().nullable(),
  /** True while an MCP connection is open. */
  connected: z.boolean(),
});
export type ExtensionView = z.infer<typeof ExtensionView>;

export function riskOf(actionClass: ActionClass): Risk {
  switch (actionClass) {
    case "read":
      return "low";
    case "routine_reversible":
    case "non_routine":
      return "medium";
    default:
      return "high";
  }
}

export const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function maxRisk(risks: Iterable<Risk>): Risk {
  let out: Risk = "low";
  for (const r of risks) if (RISK_ORDER[r] > RISK_ORDER[out]) out = r;
  return out;
}

/** Parse a stored permissions blob; anything invalid collapses to no permissions (fail closed). */
export function parsePermissions(value: unknown): ExtensionPermissions {
  const parsed = ExtensionPermissions.safeParse(value ?? {});
  return parsed.success ? parsed.data : { ...EMPTY_PERMISSIONS };
}

export function normalizePermissions(p: Partial<ExtensionPermissions>): ExtensionPermissions {
  return ExtensionPermissions.parse({
    tools: uniq(p.tools ?? []),
    actionClasses: uniq(p.actionClasses ?? []),
    domains: uniq(p.domains ?? []),
    paths: uniq(p.paths ?? []),
    secrets: uniq(p.secrets ?? []),
    scopes: uniq(p.scopes ?? []),
  });
}

export function uniq<T>(items: readonly T[]): T[] {
  return [...new Set(items)].sort();
}

/**
 * True when `next` grants anything `current` does not: a new tool, class, domain, path,
 * secret or scope. Narrowing never needs a new approval; widening always does.
 */
export function widens(current: ExtensionPermissions, next: ExtensionPermissions): string[] {
  const added: string[] = [];
  const diff = (key: keyof ExtensionPermissions) => {
    const have = new Set<string>(current[key]);
    for (const v of next[key]) if (!have.has(v)) added.push(`${key}:${v}`);
  };
  diff("tools");
  diff("actionClasses");
  diff("domains");
  diff("paths");
  diff("secrets");
  diff("scopes");
  return added;
}
