import { errorMessage, log, redact } from "@forerunner/platform";
import type { ProjectRow } from "@forerunner/state";
import { DOCS_SCAFFOLD_BRANCH, docsPullRequestNamesProject } from "../loop/docs.ts";
import type { DocsScaffoldOutcome } from "../loop/ports.ts";
import type { RepositoryOverview } from "../sources/repository-use.ts";
import {
  TAKE_OVER_NOTHING_TO_RETRY,
  takeOverRetryFailedSentence,
  takeOverRetryOpenedSentence,
} from "../sources/repository-words.ts";
import type { TakeOverRetryAnswer } from "./api-types.ts";

/**
 * L4e-left-1 (l4-github-carried; the default of owner question OQ-L4e-1): Try again beside the
 * take-over's no-pull-request line ('Took over o/kite from "Kite club" here, but the docs pull
 * request that names this project could not be opened, so GitHub still names "Kite club".').
 * Before, the line gave no next step (design §5 rule 8) and nothing tried the pull request again.
 *
 * The press runs the scaffold again, exactly as the take-over ran it (`ProjectDocs.scaffold
 * Project`, L4-github-102's rules: this project's own branch only, `fr/docs-scaffold-<name>`
 * when another project holds `fr/docs-scaffold`, a push with a lease, never the default branch,
 * never another project's open pull request). Only a line the Overview shows now as that
 * outcome is tried again; once a docs pull request names the project the record says so and the
 * line goes (`scaffoldLeftNoMarker`). One press at a time per project.
 */
export interface TakeOverRetryDeps {
  /** The Overview's repository line now (`RepositoryUse.overviewOf`). */
  overviewOf(project: ProjectRow): Promise<RepositoryOverview | null>;
  /** The take-over's scaffold run (`ProjectDocs.scaffoldProject`); it records its outcome. */
  scaffold(project: ProjectRow): Promise<DocsScaffoldOutcome>;
}

const running = new Set<string>();
const logger = log("take-over-retry");

export async function retryTakeOverDocs(
  deps: TakeOverRetryDeps,
  project: ProjectRow,
): Promise<TakeOverRetryAnswer> {
  const refused = (sentence: string): TakeOverRetryAnswer => ({
    state: "refused",
    sentence,
    prUrl: null,
  });
  const locator = project.repos[0]?.trim() ?? "";
  if (running.has(project.id))
    return refused("It is being tried again now: the answer comes in a moment.");
  running.add(project.id);
  try {
    const line = await deps.overviewOf(project);
    if (line?.outcome !== "took_over_no_pull_request") return refused(TAKE_OVER_NOTHING_TO_RETRY);
    let out: DocsScaffoldOutcome;
    try {
      out = await deps.scaffold(project);
    } catch (e) {
      logger.warn("take-over docs pull request not opened again", {
        projectId: project.id,
        error: redact(errorMessage(e)).slice(0, 300),
      });
      return refused(takeOverRetryFailedSentence(locator, "refused"));
    }
    if (!docsPullRequestNamesProject(out))
      return refused(
        takeOverRetryFailedSentence(
          locator,
          !out.prUrl && (out.branch === DOCS_SCAFFOLD_BRANCH || !out.branch)
            ? "blocked"
            : "refused",
        ),
      );
    const n = Number(/\/pull\/(\d+)/.exec(out.prUrl ?? "")?.[1]) || null;
    logger.info("take-over docs pull request opened on Try again", {
      projectId: project.id,
      pr: n,
    });
    return { state: "opened", sentence: takeOverRetryOpenedSentence(n), prUrl: out.prUrl ?? null };
  } finally {
    running.delete(project.id);
  }
}
