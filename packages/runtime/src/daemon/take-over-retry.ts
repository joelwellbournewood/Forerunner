import { errorMessage, ForerunnerError, log, redact } from "@forerunner/platform";
import type { ProjectRow } from "@forerunner/state";
import { docsPullRequestNamesProject } from "../loop/docs.ts";
import type { DocsScaffoldOutcome } from "../loop/ports.ts";
import type { RepositoryOverview } from "../sources/repository-use.ts";
import {
  TAKE_OVER_NO_REPOSITORY,
  TAKE_OVER_NOT_TAKEN,
  TAKE_OVER_NOTHING_TO_RETRY,
  type TakeOverRetryFailure,
  takeOverRetryFailedSentence,
  takeOverRetryOpenedSentence,
  tookOverOf,
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
 * never a pull request that is not this project's, L4i-left-2). Only a line the Overview shows
 * now as that outcome is tried again; once a docs pull request names the project the record
 * says so and the line goes (`scaffoldLeftNoMarker`). One press at a time per project.
 *
 * Wave 8 (w8-repo-guide): a refusal names the repository as the line above it does
 * (`owner/name`, L4i-left-5: before, as the person typed it, "https://github.com/bench/empty"),
 * says what actually stopped the scaffold (L4i-left-6: before, any thrown error read "check the
 * token" and any run without a pull request "another project's pull request is open"), and a
 * press with nothing to try answers by the real state (L4i-left-7).
 */
export interface TakeOverRetryDeps {
  /** The Overview's repository line now (`RepositoryUse.overviewOf`). */
  overviewOf(project: ProjectRow): Promise<RepositoryOverview | null>;
  /** The take-over's scaffold run (`ProjectDocs.scaffoldProject`); it records its outcome. */
  scaffold(project: ProjectRow): Promise<DocsScaffoldOutcome>;
  /**
   * The project's repository as the Overview's line names it (`owner/name`,
   * `RepositoryUse.locatorOf`), or null when it has none on GitHub.
   */
  locatorOf(project: ProjectRow): string | null;
}

const running = new Set<string>();
const logger = log("take-over-retry");

/** L4i-left-6: what a thrown scaffold error says about GitHub, from its code and words. */
export function retryFailureOf(e: unknown): TakeOverRetryFailure {
  const code = e instanceof ForerunnerError ? e.code : "";
  const text = errorMessage(e);
  if (code === "provider_auth" || code === "tool_not_allowed") return "refused";
  if (
    code === "timeout" ||
    (e instanceof ForerunnerError && e.retryable && !/push .*failed/i.test(text)) ||
    /unreachable|could not resolve|connection refused|failed to connect|timed out|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(
      text,
    )
  )
    return "unreachable";
  return "refused";
}

/** L4i-left-6: why a scaffold run that opened nothing stopped, from its outcome. */
function outcomeFailure(out: DocsScaffoldOutcome): TakeOverRetryFailure {
  if (out.stopped === "pull_request_open") return "blocked";
  if (out.stopped === "branches_taken") return "branches";
  return "refused";
}

export async function retryTakeOverDocs(
  deps: TakeOverRetryDeps,
  project: ProjectRow,
): Promise<TakeOverRetryAnswer> {
  const refused = (sentence: string): TakeOverRetryAnswer => ({
    state: "refused",
    sentence,
    prUrl: null,
  });
  if (running.has(project.id))
    return refused("It is being tried again now: the answer comes in a moment.");
  running.add(project.id);
  try {
    // L4i-left-5: the repository as the line above names it, whatever the person typed.
    const locator = deps.locatorOf(project);
    const line = await deps.overviewOf(project);
    if (line?.outcome !== "took_over_no_pull_request") {
      // L4i-left-7: said by the real state.
      if (!locator) return refused(TAKE_OVER_NO_REPOSITORY);
      const took = tookOverOf(project);
      if (!took || took.removed) return refused(TAKE_OVER_NOT_TAKEN);
      return refused(TAKE_OVER_NOTHING_TO_RETRY);
    }
    const shown = locator ?? project.repos[0]?.trim() ?? "";
    let out: DocsScaffoldOutcome;
    try {
      out = await deps.scaffold(project);
    } catch (e) {
      logger.warn("take-over docs pull request not opened again", {
        projectId: project.id,
        error: redact(errorMessage(e)).slice(0, 300),
      });
      return refused(takeOverRetryFailedSentence(shown, retryFailureOf(e)));
    }
    if (!docsPullRequestNamesProject(out))
      return refused(takeOverRetryFailedSentence(shown, outcomeFailure(out)));
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
