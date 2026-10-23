import { z } from "zod";

/**
 * Wire shapes of source discovery (spec A.4, ADR 0056): what the daemon's `/sources` routes,
 * the `fr sources` command and the Settings page exchange. Zod on both sides; this file
 * imports nothing but zod so the UI can load it through `daemon/api-types`.
 */
export const SOURCE_KINDS = [
  "github_org",
  "github_user",
  "github_repo",
  "gitlab",
  "git_remote",
  "local_folder",
] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** The kinds a scan supports today; the other two are refused with "later". */
export const SUPPORTED_SOURCE_KINDS = [
  "github_org",
  "github_user",
  "github_repo",
  "local_folder",
] as const;

export const SOURCE_CANDIDATE_STATUSES = ["proposed", "accepted", "duplicate", "gone"] as const;
export const SourceCandidateStatusSchema = z.enum(SOURCE_CANDIDATE_STATUSES);
export type SourceCandidateStatus = z.infer<typeof SourceCandidateStatusSchema>;

/** Counts of a source's candidates by status, plus how many carry an existing install. */
export const ScanSummary = z.object({
  total: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  duplicate: z.number().int().nonnegative(),
  gone: z.number().int().nonnegative(),
  installs: z.number().int().nonnegative(),
});
export type ScanSummary = z.infer<typeof ScanSummary>;

export const SourceView = z.object({
  id: z.string(),
  kind: SourceKindSchema,
  displayName: z.string(),
  /** A login for an org or user source, `owner/name` for a repository, an absolute path for a folder. */
  locator: z.string(),
  /** `secret:<name>` for a GitHub source, never a value; null for a folder. */
  credentialRef: z.string().nullable(),
  /** connected, or error after a failed scan (see `error`). */
  status: z.string(),
  lastScanAt: z.string().nullable(),
  /** The last successful scan's counts, or null before the first scan. */
  scanSummary: ScanSummary.nullable(),
  /** Why the last scan failed (redacted), or null. */
  error: z.string().nullable(),
  /** The candidates as they stand now (the summary is what the last scan found). */
  candidates: ScanSummary,
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type SourceView = z.infer<typeof SourceView>;

export const SourceCandidateView = z.object({
  id: z.string(),
  sourceId: z.string(),
  kind: z.enum(["repo", "folder"]),
  name: z.string(),
  /** What the project's repos entry will carry: `owner/name` or the absolute folder path. */
  locator: z.string(),
  /** The normalised duplicate key. */
  key: z.string(),
  proposedName: z.string(),
  status: SourceCandidateStatusSchema,
  existingInstall: z.boolean(),
  /** `.forerunner/project.json` or `install_record`, when an install was detected. */
  installMarker: z.string().nullable(),
  /** The project it became (accepted) or duplicates (duplicate), when one exists. */
  projectId: z.string().nullable(),
  isGit: z.boolean(),
  details: z.record(z.string(), z.unknown()),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int(),
});
export type SourceCandidateView = z.infer<typeof SourceCandidateView>;

export const AddSourceBody = z
  .object({
    kind: SourceKindSchema,
    locator: z.string().min(1).max(4096),
    displayName: z.string().min(1).max(200).optional(),
    /** `secret:<name>`; default `secret:github_token` for a GitHub kind. A value is refused. */
    credentialRef: z.string().min(1).max(200).optional(),
  })
  .strict();
export type AddSourceBody = z.infer<typeof AddSourceBody>;

export const ScanResultView = z.object({
  source: SourceView,
  candidates: z.array(SourceCandidateView),
  summary: ScanSummary,
});
export type ScanResultView = z.infer<typeof ScanResultView>;

export const AcceptCandidateBody = z
  .object({
    /** Project name; default the proposed name. */
    name: z.string().min(1).max(200).optional(),
    goal: z.string().min(1).max(2000).optional(),
    autonomyLevel: z.number().int().min(0).max(4).optional(),
    budgetUsdMicro: z.number().int().nonnegative().optional(),
  })
  .strict();
export type AcceptCandidateBody = z.infer<typeof AcceptCandidateBody>;

export const AcceptCandidateView = z.object({
  candidate: SourceCandidateView,
  project: z.object({ id: z.string(), name: z.string() }),
});
export type AcceptCandidateView = z.infer<typeof AcceptCandidateView>;

export const RemoveSourceView = z.object({
  ok: z.literal(true),
  id: z.string(),
  candidatesRemoved: z.number().int().nonnegative(),
});
export type RemoveSourceView = z.infer<typeof RemoveSourceView>;

export const SOURCES_ROUTES = [
  "GET /sources",
  "POST /sources",
  "GET /sources/:id",
  "POST /sources/:id/scan",
  "GET /sources/:id/candidates",
  "POST /sources/candidates/:id/accept",
  "DELETE /sources/:id",
] as const;
