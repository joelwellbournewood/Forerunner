import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type GitHost, GitOps, gitAuthFor, type RepoInfo } from "@forerunner/capabilities";
import type { RepoCommandPort, RepoPreview } from "@forerunner/commands";
import {
  basename,
  type Clock,
  errorMessage,
  ForerunnerError,
  join,
  log,
  redact,
  safeSegment,
} from "@forerunner/platform";
import type { HumanRequestRow, JsonObject, ProjectRow, StateStore } from "@forerunner/state";
import { type AutonomyLevel, decideAutonomy } from "../enforcement/autonomy.ts";
import { ANSWER_CARD_KEYS, repoProposalAnswer } from "../wiring/request-answers.ts";
import { projectWorkspaceDir } from "./docs.ts";
import type { CommandResultView } from "./ports.ts";

/**
 * A repository for a project that has none (U-037, ADR 0097). Two pieces:
 *
 * - `RepoCreator`, the `repo.create` command's port: names the repository (from the project's
 *   name, private by default, under the person's GitHub account or an organization), creates it
 *   with the person's GitHub token through the git host, pushes the project's workspace folder
 *   as the first commit and links the repository to the project (`repos[0]`, what "Repository
 *   link" in New project sets). From then on the project's tasks run on branches of clones
 *   with pull requests (`PrTaskExecutor`).
 * - `RepoProposals`: when a session plans code work on a project without a repository, the
 *   project's agent proposes one. Below Autopilot (autonomy 4) that is one Inbox card per
 *   project (options "Create the repository" / "Not now"; the card says the name, the account
 *   or organization and that it is private); at Autopilot the agent runs `repo.create` itself.
 *   The person's yes runs the same command, through the change log; "Not now" is remembered
 *   on the project, so the agent does not ask again (the project page's button still works).
 *   Nothing is created without a yes below Autopilot.
 */

/** Audit row kind of a repository creation (and of a first push that failed). */
export const REPO_CREATE_AUDIT_TOOL = "repo.create";

/** The proposal card's key prefix (`ANSWER_CARD_KEYS.repoCreatePrefix`) and options. */
export const REPO_PROPOSAL_KEY_PREFIX = ANSWER_CARD_KEYS.repoCreatePrefix;
export const REPO_PROPOSAL_OPTIONS = ["Create the repository", "Not now"] as const;

/** The project setting that remembers "Not now" (U-031's lesson: a no is not asked again). */
export const REPO_PROPOSAL_SETTING = "repo_proposal";

/** A repository name from a project's name: lower case, letters, digits, '.', '_' and '-'. */
export function repoNameFor(projectName: string, projectId: string): string {
  const slug = projectName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100)
    .replace(/[-.]+$/g, "");
  return slug || `project-${projectId.slice(0, 8).toLowerCase()}`;
}

export interface RepoCreatorDeps {
  store: StateStore;
  clock: Clock;
  host: GitHost;
  /** The person's GitHub token, read when needed; null: no repository can be created. */
  token: () => string | null;
  identity?: { name: string; email: string };
  /** `<data>/projects`: the workspace pushed as the first commit lives under it. */
  projectsRoot: string;
  /** Scratch clones for the first commit go under `<worktreeRoot>/repo-init`. */
  worktreeRoot: string;
  /** Called once the project is linked (the daemon tells the screens). */
  onLinked?: (projectId: string) => void;
}

const NO_TOKEN =
  "Creating a repository uses your GitHub token, and none is set: add one in the setup assistant (the GitHub step), then try again.";

export class RepoCreator implements RepoCommandPort {
  private readonly logger = log("repo-create");

  constructor(private readonly deps: RepoCreatorDeps) {}

  async preview(req: {
    projectId: string;
    name?: string;
    owner?: string;
    private: boolean;
  }): Promise<RepoPreview> {
    const project = await this.deps.store.project.mustGet(req.projectId);
    if (project.repos.length > 0) {
      throw new ForerunnerError(
        "validation",
        `${project.name} already has a repository (${project.repos[0]}); one is created only for a project without one`,
      );
    }
    if (!this.deps.token()) throw new ForerunnerError("unavailable", NO_TOKEN);
    const login = (await this.deps.host.whoAmI()).login;
    const owner = req.owner?.trim() || login;
    const name = req.name?.trim() || repoNameFor(project.name, project.id);
    return {
      projectId: project.id,
      projectName: project.name,
      owner,
      name,
      fullName: `${owner}/${name}`,
      private: req.private,
      accountKind: owner.toLowerCase() === login.toLowerCase() ? "account" : "organization",
    };
  }

  async create(req: {
    projectId: string;
    name: string;
    owner?: string;
    private: boolean;
    humanId: string;
    agentId: string | null;
  }): Promise<{ fullName: string; htmlUrl: string; files: number }> {
    const { store } = this.deps;
    const preview = await this.preview(req);
    const project = await store.project.mustGet(req.projectId);
    const token = this.deps.token() as string;
    let info: RepoInfo;
    try {
      info = await this.deps.host.createRepo({
        ...(preview.accountKind === "organization" ? { owner: preview.owner } : {}),
        name: preview.name,
        private: preview.private,
        description: project.goal.slice(0, 300),
        // Empty: the workspace is the first commit.
        autoInit: false,
      });
    } catch (e) {
      throw new ForerunnerError(
        "provider_error",
        `GitHub did not create ${preview.fullName}: ${redact(errorMessage(e))}. If it says the token may not, the token needs to create repositories (a fine-grained token with Administration: write, or a classic token with the repo scope).`,
        { cause: e },
      );
    }
    let files = 0;
    try {
      files = await this.pushWorkspace(project, info, token);
    } catch (e) {
      const why = redact(errorMessage(e));
      await this.audit(req, project, info, false, `first push failed: ${why}`);
      throw new ForerunnerError(
        "provider_error",
        `The repository ${info.fullName} was created on GitHub, but pushing the project's folder to it failed: ${why}. It is not linked to the project: push the folder to it yourself and add it as the project's repository link, or delete it on GitHub.`,
        { cause: e },
      );
    }
    await store.project.patch(project.id, { repos: [info.fullName] });
    await this.audit(req, project, info, true, `created and linked; ${files} file(s) pushed`);
    this.deps.onLinked?.(project.id);
    this.logger.info("repository created and linked", {
      projectId: project.id,
      repo: info.fullName,
      files,
    });
    return { fullName: info.fullName, htmlUrl: info.htmlUrl, files };
  }

  /**
   * The workspace as one first commit on the default branch: a scratch repository gets a copy
   * of the folder (its own `.git`, the local history of earlier runs, left out), or a README
   * when the folder is empty, and pushes it. The workspace itself is not changed.
   */
  private async pushWorkspace(project: ProjectRow, info: RepoInfo, token: string): Promise<number> {
    const branch = info.defaultBranch || "main";
    const dir = join(this.deps.worktreeRoot, "repo-init", safeSegment(project.id, "project"));
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      const git = new GitOps({
        cwd: dir,
        auth: gitAuthFor(token, info.cloneUrl),
        ...(this.deps.identity ? { identity: this.deps.identity } : {}),
      });
      await git.init(branch);
      const workspace = projectWorkspaceDir(this.deps.projectsRoot, project.id);
      if (existsSync(workspace)) {
        cpSync(workspace, dir, {
          recursive: true,
          filter: (src) => basename(src) !== ".git",
        });
      }
      const files = countFiles(dir);
      if (files === 0) {
        writeFileSync(join(dir, "README.md"), `# ${project.name}\n\n${project.goal}\n`, "utf8");
      }
      await git.commitAll(`Start ${project.name} from its Forerunner workspace`);
      await git.setRemote("origin", info.cloneUrl);
      await git.push(branch);
      return Math.max(files, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private async audit(
    req: { humanId: string; agentId: string | null },
    project: ProjectRow,
    info: RepoInfo,
    allowed: boolean,
    result: string,
  ): Promise<void> {
    try {
      await this.deps.store.auditLog.append({
        tool: REPO_CREATE_AUDIT_TOOL,
        allowed,
        ...(allowed ? {} : { denied_reason: result }),
        human_id: req.humanId,
        agent_id: req.agentId,
        input_summary: JSON.stringify({
          projectId: project.id,
          repo: info.fullName,
          private: info.private,
        }),
        result_summary: result,
        cost_usd_micro: 0,
        occurred_at: this.deps.clock.nowIso(),
      });
    } catch (e) {
      this.logger.warn("repository creation not audited", { error: errorMessage(e) });
    }
  }
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const parent = (e as { parentPath?: string; path?: string }).parentPath ?? "";
    if (e.isFile() && !parent.split(/[\\/]/).includes(".git")) n++;
  }
  return n;
}

/** What `RepoProposals` needs of the command loop (`CommandLoop`). */
export interface RepoCommandRunner {
  execute(
    call: { name: string; params: unknown },
    turn: {
      humanId: string;
      agentId: string;
      activeProjectId: string | null;
      sessionId: string;
      source: "text" | "voice" | "phone" | "ui";
      wordsUsed: string;
    },
    opts?: {
      confirmation?: { kind: "tap"; by: { kind: "human" | "agent"; id: string } };
      actor?: { kind: "human" | "agent"; id: string };
    },
  ): Promise<CommandResultView>;
}

export interface RepoProposalsDeps {
  store: StateStore;
  clock: Clock;
  creator: Pick<RepoCreator, "preview">;
  commands: RepoCommandRunner;
  humanId: string;
  agentId: string;
  /** Whether a plan item's specialist does code work (edits files and runs commands). */
  isCodeWork: (specialist: string) => boolean;
}

export type RepoProposalOutcome =
  | "filed"
  | "created"
  | "has_repository"
  | "no_code_work"
  | "declined_before"
  | "already_asked"
  | "unavailable";

export class RepoProposals {
  private readonly logger = log("repo-create");

  constructor(private readonly deps: RepoProposalsDeps) {}

  /**
   * After a session planned (`SessionRunnerDeps.onPlanned`): a project without a repository
   * whose plan holds code work gets a proposal, once. The session goes on in the workspace
   * either way.
   */
  async consider(req: {
    projectId: string;
    sessionId: string;
    items: readonly { specialist: string }[];
  }): Promise<RepoProposalOutcome> {
    const { store } = this.deps;
    const project = await store.project.get(req.projectId);
    if (!project || project.repos.length > 0) return "has_repository";
    if (!req.items.some((i) => this.deps.isCodeWork(i.specialist))) return "no_code_work";
    if ((project.settings as JsonObject)[REPO_PROPOSAL_SETTING]) return "declined_before";
    const key = `${REPO_PROPOSAL_KEY_PREFIX}${project.id}`;
    const open = await store.humanRequest.open({ humanId: this.deps.humanId }, { limit: 500 });
    if (open.some((r) => (r.change_card as JsonObject | null)?.key === key)) return "already_asked";
    let preview: RepoPreview;
    try {
      preview = await this.deps.creator.preview({ projectId: project.id, private: true });
    } catch (e) {
      // No token, or the host cannot be reached: nothing to propose; the work stays local.
      this.logger.info("no repository proposed", {
        projectId: project.id,
        error: errorMessage(e),
      });
      return "unavailable";
    }
    const level = project.autonomy_level as AutonomyLevel;
    if (decideAutonomy("external_send", { level }) === "allow") {
      // Autopilot: the agent creates it; the change log and the sentence tell the person.
      const r = await this.deps.commands.execute(
        { name: "repo.create", params: { project: project.id } },
        {
          humanId: this.deps.humanId,
          agentId: this.deps.agentId,
          activeProjectId: project.id,
          sessionId: req.sessionId,
          source: "ui",
          wordsUsed: "agent: the plan holds code work and the project has no repository",
        },
        { actor: { kind: "agent", id: this.deps.agentId } },
      );
      if (r.status === "done") return "created";
      this.logger.warn("repository not created at autopilot", {
        projectId: project.id,
        status: r.status,
        reason: r.reason ?? null,
      });
      return "unavailable";
    }
    await store.humanRequest.insert({
      human_id: this.deps.humanId,
      project_id: project.id,
      session_id: req.sessionId,
      kind: "approval",
      why: `Code work is planned for ${project.name}, which has no repository: its tasks run in the project's folder on this computer, with no branch, pull request or review on GitHub. Create a repository for it?`,
      steps: [
        `Repository: ${preview.fullName}`,
        `Under: ${preview.accountKind === "organization" ? `the organization ${preview.owner}` : `your GitHub account ${preview.owner}`}`,
        "Visibility: private",
        "The project's folder is pushed as the first commit; later tasks run on branches with pull requests.",
        "Not now: tasks keep running in the project's folder, and the agent does not ask again (Create a repository on the project page still works).",
      ],
      options: [...REPO_PROPOSAL_OPTIONS],
      blocking: false,
      risk: "medium",
      change_card: {
        key,
        project_id: project.id,
        name: preview.name,
        owner: preview.owner,
        account_kind: preview.accountKind,
        private: true,
      },
      author_agent: this.deps.agentId,
    });
    return "filed";
  }

  /**
   * Answered proposal cards: "Create the repository" runs `repo.create` with the person's
   * answer as the confirmation (the change log row and the sentence as for a tap in the app);
   * "Not now" is remembered on the project. Each card is applied once (`applied_at`).
   */
  async sync(): Promise<{ created: number; declined: number; failed: number }> {
    const { store, clock } = this.deps;
    const out = { created: 0, declined: 0, failed: 0 };
    const rows = await store.humanRequest.list(
      { human_id: this.deps.humanId, status: "answered" } as never,
      { limit: 500 },
    );
    for (const row of rows) {
      const card = row.change_card as JsonObject | null;
      if (typeof card?.key !== "string" || !card.key.startsWith(REPO_PROPOSAL_KEY_PREFIX)) continue;
      if (card.applied_at) continue;
      const projectId = String(card.project_id ?? "");
      const answer = repoProposalAnswer(row.answer);
      if (answer === "decline") {
        const project = await store.project.get(projectId);
        if (project) {
          await store.project.patch(project.id, {
            settings: {
              ...project.settings,
              [REPO_PROPOSAL_SETTING]: { declined_at: clock.nowIso(), request_id: row.id },
            },
          });
        }
        await this.mark(row, { outcome: "declined" });
        out.declined++;
        continue;
      }
      if (answer !== "create") {
        await this.mark(row, { outcome: "unrecognized_answer" });
        continue;
      }
      const by = { kind: "human" as const, id: row.answered_by ?? this.deps.humanId };
      const r = await this.deps.commands.execute(
        {
          name: "repo.create",
          params: {
            project: projectId,
            ...(typeof card.name === "string" ? { name: card.name } : {}),
            ...(card.account_kind === "organization" && typeof card.owner === "string"
              ? { owner: card.owner }
              : {}),
            private: true,
          },
        },
        {
          humanId: this.deps.humanId,
          agentId: this.deps.agentId,
          activeProjectId: projectId,
          sessionId: row.session_id ?? "",
          source: "ui",
          wordsUsed: `${REPO_PROPOSAL_OPTIONS[0]} (Inbox)`,
        },
        { confirmation: { kind: "tap", by } },
      );
      if (r.status === "done") {
        await this.mark(row, { outcome: "created", sentence: r.sentence ?? "" });
        out.created++;
        continue;
      }
      out.failed++;
      const reason = r.reason ?? r.status;
      await this.mark(row, { outcome: "failed", reason });
      await store.message.send({
        from_agent_id: this.deps.agentId,
        to_human_id: this.deps.humanId,
        project_id: projectId || null,
        type: "warning",
        body: `The repository you asked for was not created: ${reason}`,
        requires_ack: false,
        author_agent: this.deps.agentId,
      });
    }
    return out;
  }

  private async mark(row: HumanRequestRow, extra: JsonObject): Promise<void> {
    const fresh = await this.deps.store.humanRequest.mustGet(row.id);
    await this.deps.store.humanRequest.patch(row.id, {
      change_card: {
        ...((fresh.change_card as JsonObject | null) ?? {}),
        ...extra,
        applied_at: this.deps.clock.nowIso(),
      },
    });
  }
}
