import { lstat, readdir } from "node:fs/promises";
import type { GitHost, RepoInfo, RepoRef } from "@forerunner/capabilities";
import {
  basename,
  type Clock,
  errorMessage,
  ForerunnerError,
  isAbsolute,
  join,
  redact,
} from "@forerunner/platform";
import type {
  JsonValue,
  ProjectRow,
  SourceCandidateRow,
  SourceCandidateStatus,
  SourceRow,
  StateStore,
} from "@forerunner/state";
import { isSecretRef } from "@forerunner/vault";
import type { InstallRecord } from "../setup/install-record.ts";
import {
  DEFAULT_REPO_HOSTS,
  folderKey,
  isGitHubLogin,
  isRepoHost,
  keysOfProject,
  normaliseFolder,
  parseRepoLocator,
  repoKey,
} from "./locators.ts";
import { INSTALL_MARKER_FILE } from "./marker.ts";
import {
  type AcceptCandidateBody,
  type AcceptCandidateView,
  type AddSourceBody,
  type RemoveSourceView,
  type ScanResultView,
  type ScanSummary,
  type SourceCandidateView,
  type SourceKind,
  type SourceView,
  SUPPORTED_SOURCE_KINDS,
} from "./types.ts";

/**
 * Source discovery (spec A.4, ADR 0056). The human connects sources: a GitHub organisation
 * or account, a chosen repository, a local folder (other git hosts later). A scan lists what
 * is there (repositories through the git host port, paged; a folder's immediate subfolders,
 * or the folder itself when it is a repository), proposes one project per repository or
 * folder, detects an existing Forerunner install (the `.forerunner/project.json` marker, or
 * the folder being this install's own checkout per the install record) and never proposes
 * what a project already covers or what another source already proposes: those candidates
 * are `duplicate`. A rescan is idempotent: new candidates appear, ones no longer found are
 * `gone` (and back when they return), accepted ones stay. Accepting a proposal creates the
 * project through the same path as `POST /projects` with no brief (the intake is spec A.2).
 * Removing a source removes its candidates and never a project.
 *
 * Credentials by reference only: a GitHub source names `secret:<name>`; the daemon builds
 * the host from the vault at scan time (`hostFor`). A token value is refused at `add` and
 * never stored, logged or audited. Rows belong to the human who added them (the owner rule):
 * another human's source is hidden from the list and refused on every operation.
 */
export interface SourceActor {
  humanId: string;
}

export type AddSourceInput = AddSourceBody;
export type AcceptCandidateInput = AcceptCandidateBody;

export interface CreateProjectInput {
  name: string;
  goal: string;
  repos: string[];
  autonomyLevel?: number;
  budgetUsdMicro?: number;
}

/** The folder access a scan needs; tests may inject one, the default is node:fs. */
export interface SourceFs {
  /** Immediate entries of a directory (symlinks reported as such, never followed). */
  entries(dir: string): Promise<{ name: string; directory: boolean; symlink: boolean }[]>;
  exists(path: string): Promise<boolean>;
}

export type SourceStore = Pick<
  StateStore,
  "source" | "sourceCandidate" | "project" | "auditLog" | "transaction"
>;

export interface SourceDiscoveryDeps {
  store: SourceStore;
  clock: Clock;
  /** The host for a GitHub source: from the vault by the source's credential reference. */
  hostFor: (source: SourceRow) => Promise<GitHost> | GitHost;
  /** Creates the project the way `POST /projects` does, with no brief. */
  createProject: (
    input: CreateProjectInput,
    actor: SourceActor,
  ) => Promise<{ id: string; name: string }>;
  /** This process's install record: a folder equal to its checkout is Forerunner itself. */
  installRecord?: () => InstallRecord | null;
  fs?: SourceFs;
  /** The reference a GitHub source uses when none is given. Default `secret:github_token`. */
  defaultCredentialRef?: string;
  /**
   * The git hosts a repository URL may name (`repoHostsFor` in the daemon: the API base and
   * the git remote base). Default `github.com`. A URL on another host is refused at `add` and
   * is no duplicate of anything a scan finds.
   */
  repoHosts?: readonly string[];
  /**
   * Bound on the repositories or subfolders one scan may turn into candidates. Default
   * `DEFAULT_MAX_CANDIDATES`. Checked right after the listing, before any per-candidate host
   * call (the marker check costs one `contents` request per repository) or row.
   */
  maxCandidates?: number;
}

export const DEFAULT_SOURCE_CREDENTIAL_REF = "secret:github_token";
export const INSTALL_MARKER_RECORD = "install_record";
/** Bound on the projects loaded for the duplicate check; a scan beyond it is refused. */
const MAX_PROJECTS = 10_000;
/**
 * Bound on what one scan proposes. An organisation of ten thousand repositories would cost
 * as many marker requests against a five-thousand-an-hour token budget and a folder of as
 * many subfolders as many rows; a source that large is split into narrower ones instead.
 */
export const DEFAULT_MAX_CANDIDATES = 1_000;

/** What a scan found, before it is matched against the store. */
interface Found {
  kind: "repo" | "folder";
  name: string;
  locator: string;
  key: string;
  isGit: boolean;
  /** Disambiguates a proposed name that is taken: the owner or the parent folder. */
  qualifier: string;
  existingInstall: boolean;
  installMarker: string | null;
  details: Record<string, JsonValue>;
}

const nodeFs: SourceFs = {
  async entries(dir) {
    const list = await readdir(dir, { withFileTypes: true });
    return list.map((d) => ({
      name: d.name,
      directory: d.isDirectory(),
      symlink: d.isSymbolicLink(),
    }));
  },
  async exists(path) {
    try {
      await lstat(path);
      return true;
    } catch {
      return false;
    }
  },
};

function emptySummary(): ScanSummary {
  return { total: 0, proposed: 0, accepted: 0, duplicate: 0, gone: 0, installs: 0 };
}

function summarise(rows: readonly SourceCandidateRow[]): ScanSummary {
  const s = emptySummary();
  for (const c of rows) {
    s.total++;
    s[c.status]++;
    if (c.existing_install) s.installs++;
  }
  return s;
}

function conflict(message: string, details: Record<string, unknown> = {}): ForerunnerError {
  return new ForerunnerError("validation", message, { details: { ...details, conflict: true } });
}

function asObject(value: JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function candidateView(row: SourceCandidateRow): SourceCandidateView {
  return {
    id: row.id,
    sourceId: row.source_id,
    kind: row.kind,
    name: row.name,
    locator: row.locator,
    key: row.key,
    proposedName: row.proposed_name,
    status: row.status,
    existingInstall: row.existing_install,
    installMarker: row.install_marker,
    projectId: row.project_id,
    isGit: row.is_git,
    details: asObject(row.details),
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export function sourceView(row: SourceRow, candidates: readonly SourceCandidateRow[]): SourceView {
  const result = asObject(row.scan_result);
  const summary = result.summary;
  const parsed =
    summary && typeof summary === "object" && !Array.isArray(summary)
      ? { ...emptySummary(), ...(summary as Partial<ScanSummary>) }
      : null;
  return {
    id: row.id,
    kind: row.kind as SourceKind,
    displayName: row.display_name,
    locator: row.locator,
    credentialRef: row.credential_ref,
    status: row.status,
    lastScanAt: row.last_scan,
    scanSummary: parsed,
    error: typeof result.error === "string" ? result.error : null,
    candidates: summarise(candidates),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export class SourceDiscovery {
  private readonly fs: SourceFs;
  private readonly defaultRef: string;
  private readonly hosts: readonly string[];
  private readonly maxCandidates: number;

  constructor(private readonly deps: SourceDiscoveryDeps) {
    this.fs = deps.fs ?? nodeFs;
    this.defaultRef = deps.defaultCredentialRef ?? DEFAULT_SOURCE_CREDENTIAL_REF;
    this.hosts = deps.repoHosts?.length ? deps.repoHosts : DEFAULT_REPO_HOSTS;
    const max = deps.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
    if (!Number.isInteger(max) || max < 1) {
      throw new ForerunnerError("validation", "maxCandidates must be a positive integer", {
        details: { maxCandidates: max },
      });
    }
    this.maxCandidates = max;
  }

  private get store(): SourceStore {
    return this.deps.store;
  }

  private audit(
    actor: SourceActor,
    tool: string,
    input: string,
    result: string,
    denied?: string,
  ): Promise<unknown> {
    return this.store.auditLog.append({
      human_id: actor.humanId,
      tool,
      input_summary: input,
      result_summary: result,
      allowed: denied === undefined,
      denied_reason: denied ?? null,
      occurred_at: this.deps.clock.nowIso(),
    });
  }

  /** The source, when it exists and belongs to the actor (the owner rule). */
  private async owned(id: string, actor: SourceActor): Promise<SourceRow> {
    const row = await this.store.source.get(id);
    if (!row) throw new ForerunnerError("not_found", `source ${id} not found`, { details: { id } });
    if (row.author_human !== actor.humanId) {
      throw new ForerunnerError("tool_not_allowed", "not your source", {
        details: { forbidden: true, id },
      });
    }
    return row;
  }

  private async view(row: SourceRow): Promise<SourceView> {
    return sourceView(row, await this.store.sourceCandidate.forSource(row.id));
  }

  async list(actor: SourceActor): Promise<SourceView[]> {
    const rows = await this.store.source.list(
      { author_human: actor.humanId },
      { orderBy: [{ column: "created_at" }, { column: "id" }] },
    );
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string, actor: SourceActor): Promise<SourceView> {
    return this.view(await this.owned(id, actor));
  }

  async add(input: AddSourceInput, actor: SourceActor): Promise<SourceView> {
    const kind = input.kind;
    if (!(SUPPORTED_SOURCE_KINDS as readonly string[]).includes(kind)) {
      throw new ForerunnerError(
        "not_supported",
        `${kind} sources come later; today: ${SUPPORTED_SOURCE_KINDS.join(", ")}`,
        {
          details: { kind },
        },
      );
    }
    const raw = input.locator.trim();
    let locator: string;
    let displayName = input.displayName?.trim() || "";
    let credentialRef: string | null = null;
    if (kind === "local_folder") {
      if (input.credentialRef !== undefined) {
        throw new ForerunnerError("validation", "a folder source takes no credential", {
          details: { kind },
        });
      }
      if (!isAbsolute(raw)) {
        throw new ForerunnerError("validation", `folder path must be absolute: ${raw}`, {
          details: { locator: raw },
        });
      }
      locator = normaliseFolder(raw);
      let st: Awaited<ReturnType<typeof lstat>>;
      try {
        st = await lstat(locator);
      } catch {
        throw new ForerunnerError("not_found", `no folder at ${locator}`, { details: { locator } });
      }
      if (st.isSymbolicLink()) {
        throw new ForerunnerError("validation", `symlinks are never scanned: ${locator}`, {
          details: { locator },
        });
      }
      if (!st.isDirectory()) {
        throw new ForerunnerError("validation", `not a folder: ${locator}`, {
          details: { locator },
        });
      }
      displayName ||= basename(locator) || locator;
    } else {
      const ref = input.credentialRef?.trim() ?? this.defaultRef;
      if (!isSecretRef(ref)) {
        // Never echo what was pasted: it may be the token itself.
        throw new ForerunnerError(
          "validation",
          "a GitHub source needs a secret reference of the form secret:<name>; a token value is never stored (run fr setup to store it in the vault)",
          { details: { kind, credentialLength: ref.length } },
        );
      }
      credentialRef = ref;
      if (kind === "github_repo") {
        const repo = parseRepoLocator(raw, "any");
        if (!repo) {
          throw new ForerunnerError("validation", `a repository is owner/name or its URL: ${raw}`, {
            details: { locator: raw },
          });
        }
        if (repo.host !== null && !isRepoHost(repo.host, this.hosts)) {
          // The URL names another git host: not this install's GitHub, whatever owner and
          // name it carries; reading `owner/name` from GitHub instead would be a different
          // repository.
          throw new ForerunnerError(
            "validation",
            `a repository URL must be on this install's git host (${this.hosts.join(", ")}), not ${repo.host}; other git hosts come later`,
            { details: { locator: raw, host: repo.host, hosts: [...this.hosts] } },
          );
        }
        locator = repo.locator;
      } else {
        if (!isGitHubLogin(raw)) {
          throw new ForerunnerError("validation", `not a GitHub login: ${raw}`, {
            details: { locator: raw },
          });
        }
        locator = raw;
      }
      displayName ||= locator;
    }
    const existing = await this.findSame(kind, locator);
    if (existing) {
      // One row per kind and locator (the table's unique index). Another human's row stays
      // hidden, as everywhere else under the owner rule: the refusal names neither it nor them.
      if (existing.author_human !== actor.humanId) {
        throw conflict(`${kind} ${locator} is already connected by another human of this install`, {
          kind,
          locator,
        });
      }
      throw conflict(`${kind} ${locator} is already connected`, { id: existing.id, kind, locator });
    }
    const row = await this.store.source.insert({
      kind,
      display_name: displayName,
      locator,
      credential_ref: credentialRef,
      status: "connected",
      scan_result: {},
      author_human: actor.humanId,
    });
    await this.audit(
      actor,
      "source.add",
      `${kind} ${locator}${credentialRef ? ` (${credentialRef})` : ""}`,
      row.id,
    );
    return sourceView(row, []);
  }

  /** The same source under another spelling: logins and repository keys compare lower-cased. */
  private async findSame(kind: SourceKind, locator: string): Promise<SourceRow | undefined> {
    const rows = await this.store.source.list({ kind });
    const same = (a: string, b: string) =>
      kind === "local_folder" ? folderKey(a) === folderKey(b) : a.toLowerCase() === b.toLowerCase();
    return rows.find((r) => same(r.locator, locator));
  }

  async candidates(
    id: string,
    actor: SourceActor,
    status?: SourceCandidateStatus,
  ): Promise<SourceCandidateView[]> {
    await this.owned(id, actor);
    return (await this.store.sourceCandidate.forSource(id, status)).map(candidateView);
  }

  async scan(id: string, actor: SourceActor): Promise<ScanResultView> {
    const source = await this.owned(id, actor);
    const now = this.deps.clock.nowIso();
    let found: Found[];
    try {
      found = await this.discover(source);
    } catch (e) {
      const reason = redact(errorMessage(e));
      const code = e instanceof ForerunnerError ? e.code : "internal";
      await this.store.source.patch(source.id, {
        status: "error",
        last_scan: now,
        scan_result: { ...asObject(source.scan_result), error: reason } as JsonValue,
      });
      await this.audit(
        actor,
        "source.scan",
        `${source.kind} ${source.locator}`,
        "",
        `${code}: ${reason}`,
      );
      throw e;
    }
    const projectByKey = await this.projectKeys();
    const existing = await this.store.sourceCandidate.forSource(source.id);
    const byKey = new Map(existing.map((c) => [c.key, c]));
    const seen = new Set<string>();
    for (const f of found) {
      if (seen.has(f.key)) continue;
      seen.add(f.key);
      const prev = byKey.get(f.key);
      const dupProject = projectByKey.get(f.key);
      const others = (await this.store.sourceCandidate.withKey(f.key)).filter(
        (c) => c.source_id !== source.id && (c.status === "proposed" || c.status === "accepted"),
      );
      let status: SourceCandidateStatus;
      let projectId: string | null = null;
      const details: Record<string, JsonValue> = { ...f.details };
      if (prev?.status === "accepted") {
        status = "accepted";
        projectId = prev.project_id;
      } else if (dupProject) {
        status = "duplicate";
        projectId = dupProject.id;
      } else if (others[0]) {
        status = "duplicate";
        projectId = others[0].project_id;
        details.duplicate_of = others[0].id;
      } else {
        status = "proposed";
      }
      const proposedName =
        prev?.status === "accepted" ? prev.proposed_name : await this.proposeName(f, projectId);
      const patch = {
        name: f.name,
        locator: f.locator,
        proposed_name: proposedName,
        status,
        existing_install: f.existingInstall,
        install_marker: f.installMarker,
        project_id: projectId,
        is_git: f.isGit,
        details: details as JsonValue,
        last_seen_at: now,
        author_human: actor.humanId,
      };
      if (prev) await this.store.sourceCandidate.patch(prev.id, patch);
      else {
        await this.store.sourceCandidate.insert({
          source_id: source.id,
          kind: f.kind,
          key: f.key,
          ...patch,
        });
      }
    }
    for (const c of existing) {
      if (seen.has(c.key) || c.status === "gone" || c.status === "accepted") continue;
      await this.store.sourceCandidate.patch(c.id, { status: "gone", author_human: actor.humanId });
    }
    const rows = await this.store.sourceCandidate.forSource(source.id);
    const summary = summarise(rows);
    const scanResult: JsonValue = { summary: { ...summary }, scanned_at: now };
    const updated = await this.store.source.markScanned(source.id, scanResult, "connected", now);
    await this.audit(
      actor,
      "source.scan",
      `${source.kind} ${source.locator}`,
      `${summary.total} found: ${summary.proposed} proposed, ${summary.accepted} accepted, ${summary.duplicate} duplicate, ${summary.gone} gone, ${summary.installs} with an install`,
    );
    return { source: sourceView(updated, rows), candidates: rows.map(candidateView), summary };
  }

  /** Every project's keys (first project per key wins; projects are listed by name). */
  private async projectKeys(): Promise<Map<string, ProjectRow>> {
    const projects = await this.store.project.list(undefined, {
      orderBy: [{ column: "name" }, { column: "id" }],
      limit: MAX_PROJECTS + 1,
    });
    if (projects.length > MAX_PROJECTS) {
      throw new ForerunnerError(
        "validation",
        `more than ${MAX_PROJECTS} projects; the duplicate check is capped`,
        {
          details: { max: MAX_PROJECTS },
        },
      );
    }
    const byKey = new Map<string, ProjectRow>();
    for (const p of projects) {
      for (const key of keysOfProject(p.repos, this.hosts)) if (!byKey.has(key)) byKey.set(key, p);
    }
    return byKey;
  }

  /** The bound on one scan's candidates, checked before any per-candidate work. */
  private assertWithinBound(found: number, what: string): void {
    if (found <= this.maxCandidates) return;
    throw new ForerunnerError(
      "validation",
      `more than ${this.maxCandidates} ${what} (${found}); connect narrower sources instead (a repository, a subfolder)`,
      { details: { found, max: this.maxCandidates } },
    );
  }

  /** The name as found, or qualified when a project of that name exists (and is not this one). */
  private async proposeName(f: Found, projectId: string | null): Promise<string> {
    const taken = await this.store.project.byName(f.name);
    if (!taken || taken.id === projectId) return f.name;
    return `${f.name} (${f.qualifier})`;
  }

  private async discover(source: SourceRow): Promise<Found[]> {
    switch (source.kind) {
      case "github_org": {
        const host = await this.deps.hostFor(source);
        const repos = await host.listRepos({ org: source.locator });
        return this.repoCandidates(host, repos);
      }
      case "github_user": {
        const host = await this.deps.hostFor(source);
        const login = source.locator.toLowerCase();
        const me = await host.whoAmI();
        // The account's own repositories include private ones only through the token's
        // own listing; another user's are the public ones.
        const repos =
          me.login.toLowerCase() === login
            ? (await host.listRepos()).filter((r) => r.owner.toLowerCase() === login)
            : await host.listRepos({ user: source.locator });
        return this.repoCandidates(host, repos);
      }
      case "github_repo": {
        const host = await this.deps.hostFor(source);
        const repo = parseRepoLocator(source.locator);
        if (!repo) {
          throw new ForerunnerError("validation", `bad repository locator: ${source.locator}`);
        }
        return this.repoCandidates(host, [
          await host.getRepo({ owner: repo.owner, name: repo.name }),
        ]);
      }
      case "local_folder":
        return this.folderCandidates(source.locator);
      default:
        throw new ForerunnerError("not_supported", `${source.kind} sources come later`, {
          details: { kind: source.kind },
        });
    }
  }

  private async repoCandidates(host: GitHost, repos: RepoInfo[]): Promise<Found[]> {
    // Before the marker check: one `contents` request per repository is what a scan costs.
    this.assertWithinBound(repos.length, "repositories");
    const out: Found[] = [];
    for (const r of repos) {
      const ref: RepoRef = { owner: r.owner, name: r.name };
      const marked = await this.repoHasMarker(host, ref);
      out.push({
        kind: "repo",
        name: r.name,
        locator: `${r.owner}/${r.name}`,
        key: repoKey(r.owner, r.name),
        isGit: true,
        qualifier: r.owner,
        existingInstall: marked,
        installMarker: marked ? INSTALL_MARKER_FILE : null,
        details: {
          url: r.htmlUrl,
          default_branch: r.defaultBranch,
          private: r.private,
        },
      });
    }
    return out;
  }

  /** The marker file on the default branch; an empty or unreadable repository counts as unmarked. */
  private async repoHasMarker(host: GitHost, ref: RepoRef): Promise<boolean> {
    try {
      return (await host.getFile(ref, INSTALL_MARKER_FILE)) !== null;
    } catch (e) {
      if (e instanceof ForerunnerError && (e.code === "not_found" || e.code === "validation")) {
        return false;
      }
      throw e;
    }
  }

  private async folderCandidates(dir: string): Promise<Found[]> {
    // A folder that is itself a repository or a marked install is the candidate; its
    // subfolders are inside it. Otherwise every immediate subfolder is one.
    if (await this.isProjectRoot(dir)) return [await this.folderFound(dir, basename(dir))];
    const entries = (await this.fs.entries(dir)).filter(
      (e) => e.directory && !e.symlink && !e.name.startsWith("."),
    );
    this.assertWithinBound(entries.length, "subfolders");
    const out: Found[] = [];
    for (const e of entries) out.push(await this.folderFound(join(dir, e.name), basename(dir)));
    return out;
  }

  private async isProjectRoot(dir: string): Promise<boolean> {
    return (
      (await this.fs.exists(join(dir, ".git"))) ||
      (await this.fs.exists(join(dir, ".forerunner", "project.json"))) ||
      this.isOwnCheckout(dir)
    );
  }

  private isOwnCheckout(dir: string): boolean {
    const record = this.deps.installRecord?.();
    return !!record && folderKey(record.installDir) === folderKey(dir);
  }

  private async folderFound(path: string, qualifier: string): Promise<Found> {
    const isGit = await this.fs.exists(join(path, ".git"));
    const marker = (await this.fs.exists(join(path, ".forerunner", "project.json")))
      ? INSTALL_MARKER_FILE
      : this.isOwnCheckout(path)
        ? INSTALL_MARKER_RECORD
        : null;
    return {
      kind: "folder",
      name: basename(path),
      locator: path,
      key: folderKey(path),
      isGit,
      qualifier,
      existingInstall: marker !== null,
      installMarker: marker,
      details: {},
    };
  }

  async accept(
    candidateId: string,
    input: AcceptCandidateInput,
    actor: SourceActor,
  ): Promise<AcceptCandidateView> {
    const cand = await this.store.sourceCandidate.get(candidateId);
    if (!cand) {
      throw new ForerunnerError("not_found", `candidate ${candidateId} not found`, {
        details: { id: candidateId },
      });
    }
    await this.owned(cand.source_id, actor);
    if (cand.status === "accepted") {
      throw conflict(`${cand.locator} was already accepted as project ${cand.project_id}`, {
        candidateId,
        projectId: cand.project_id,
      });
    }
    if (cand.status === "duplicate") {
      throw conflict(
        cand.project_id
          ? `${cand.locator} is a duplicate of project ${cand.project_id}`
          : `${cand.locator} is a duplicate of another source's proposal`,
        { candidateId, projectId: cand.project_id },
      );
    }
    if (cand.status === "gone") {
      throw conflict(`${cand.locator} was no longer found by the last scan; rescan the source`, {
        candidateId,
      });
    }
    // A project may have been created for this repo since the scan: never a second one.
    const covering = (await this.projectKeys()).get(cand.key);
    if (covering) {
      await this.store.sourceCandidate.patch(cand.id, {
        status: "duplicate",
        project_id: covering.id,
        author_human: actor.humanId,
      });
      throw conflict(`${cand.locator} is already project ${covering.id} (${covering.name})`, {
        candidateId,
        projectId: covering.id,
      });
    }
    const name = input.name?.trim() || cand.proposed_name;
    if (await this.store.project.byName(name)) {
      throw conflict(`a project named ${name} exists; pass another name`, { candidateId, name });
    }
    const goal =
      input.goal?.trim() ||
      `Project from the ${cand.kind === "repo" ? "repository" : "folder"} ${cand.locator}`;
    const project = await this.deps.createProject(
      {
        name,
        goal,
        repos: [cand.locator],
        ...(input.autonomyLevel !== undefined ? { autonomyLevel: input.autonomyLevel } : {}),
        ...(input.budgetUsdMicro !== undefined ? { budgetUsdMicro: input.budgetUsdMicro } : {}),
      },
      actor,
    );
    const updated = await this.store.sourceCandidate.patch(cand.id, {
      status: "accepted",
      project_id: project.id,
      author_human: actor.humanId,
    });
    // The same repo proposed by another source is now a duplicate of this project.
    for (const other of await this.store.sourceCandidate.withKey(cand.key)) {
      if (other.id === cand.id || other.status !== "proposed") continue;
      await this.store.sourceCandidate.patch(other.id, {
        status: "duplicate",
        project_id: project.id,
        author_human: actor.humanId,
      });
    }
    await this.audit(
      actor,
      "source.accept",
      `${cand.kind} ${cand.locator}`,
      `project ${project.id} (${name})`,
    );
    return { candidate: candidateView(updated), project };
  }

  async remove(id: string, actor: SourceActor): Promise<RemoveSourceView> {
    const source = await this.owned(id, actor);
    const candidatesRemoved = await this.store.transaction(async (tx) => {
      const n = await tx.sourceCandidate.deleteForSource(source.id);
      await tx.source.delete(source.id);
      return n;
    });
    await this.audit(
      actor,
      "source.remove",
      `${source.kind} ${source.locator}`,
      `${candidatesRemoved} candidates removed; projects kept`,
    );
    return { ok: true, id: source.id, candidatesRemoved };
  }
}
