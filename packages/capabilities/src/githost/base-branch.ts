import { mkdirSync, rmSync } from "node:fs";
import { dirname, errorMessage, ForerunnerError, log } from "@forerunner/platform";
import { type GitAuth, type GitIdentity, GitOps } from "./git.ts";

/**
 * The branch every task branch, docs branch and status branch starts from (`origin/<base>`),
 * made when the linked repository is empty (ADR 0104). A repository created on GitHub without a
 * README has no branch at all: before, every task failed with git's own words ("fatal:
 * 'origin/main' is not a commit and a branch ... cannot be created from it"), the doc scaffold
 * failed silently at project creation, and nothing said the repository was empty.
 *
 * An empty repository gets one first commit on its default branch, written by `first` into a
 * scratch repository and pushed (as `RepoCreator` pushes a new repository's first commit): the
 * doc set where the caller has it (the scaffold, the intake's docs), else a README with the
 * project's name and goal. Then the clone is fetched and the caller branches as usual. A
 * repository that has branches but not `base` is not empty: that is a configuration Forerunner
 * does not guess at, and the error says what to check. Pushing the first commit can fail (a
 * token without write access, a rule on the host): the error says the repository is empty and
 * what the person can do.
 */
export interface EnsureBaseInput {
  /** The clone of the repository, fetched (or just cloned). */
  git: GitOps;
  cloneUrl: string;
  base: string;
  /** `owner/name`, for the words. */
  repoName: string;
  /** A folder the first commit is made in; removed before and after. */
  scratchDir: string;
  auth?: GitAuth;
  identity?: GitIdentity;
  /** Writes the first commit's files into `dir`; returns the commit message. */
  first: (dir: string) => Promise<string> | string;
}

export type EnsureBaseOutcome = "existing" | "created";

const logger = log("githost:base");

export async function ensureBaseBranch(input: EnsureBaseInput): Promise<EnsureBaseOutcome> {
  const { git, base, repoName } = input;
  if (await git.hasRef(`origin/${base}`)) return "existing";
  const branches = await git.remoteBranches();
  if (branches.length > 0) {
    throw new ForerunnerError(
      "not_found",
      `${repoName} has no branch "${base}" to start from (it has ${branches.slice(0, 3).join(", ")}${branches.length > 3 ? " and more" : ""}). Set its default branch on GitHub, then press Try again.`,
      { details: { repo: repoName, base, branches: branches.slice(0, 10) } },
    );
  }
  rmSync(input.scratchDir, { recursive: true, force: true });
  mkdirSync(dirname(input.scratchDir), { recursive: true });
  try {
    const scratch = new GitOps({
      cwd: input.scratchDir,
      ...(input.auth ? { auth: input.auth } : {}),
      ...(input.identity ? { identity: input.identity } : {}),
    });
    await scratch.init(base);
    const message = await input.first(input.scratchDir);
    await scratch.commitAll(message, { allowEmpty: true });
    await scratch.setRemote("origin", input.cloneUrl);
    try {
      await scratch.push(base);
    } catch (e) {
      // Someone (another install, the person) made the first commit meanwhile: use theirs.
      await git.fetch();
      if (await git.hasRef(`origin/${base}`)) return "existing";
      throw new ForerunnerError(
        "provider_error",
        `${repoName} is empty and Forerunner could not make its first commit: ${errorMessage(e).slice(0, 300)}. Add a first commit (a README) to it on GitHub, then press Try again.`,
        { cause: e, details: { repo: repoName, base } },
      );
    }
    await git.fetch();
    logger.info("first commit made on an empty repository", { repo: repoName, base });
    return "created";
  } finally {
    rmSync(input.scratchDir, { recursive: true, force: true });
  }
}
