import { errorMessage, redact } from "@forerunner/platform";

/**
 * A push the host refused, in the person's words (design §5.8: one sentence of what went wrong
 * plus what to do, never the exception text). git's own output for a refused push runs over
 * several lines ("git push main failed: fatal: ...", "warning: push negotiation failed ...",
 * "remote: Permission to o/r denied ...", "To <url>", " ! [remote rejected] ...", "error: failed
 * to push some refs"); before, it went whole into the task's reason, the session result and the
 * failed-task card.
 */
export type PushFailure =
  /** The host could not be reached (no network, DNS, a timeout). */
  | { kind: "unreachable" }
  /** The host refused it: a token that may not write, a protected branch, a permission. */
  | { kind: "refused" }
  /** Anything else, with the one line of the host's (or git's) that says why, if any. */
  | { kind: "other"; said: string };

const UNREACHABLE =
  /could not resolve host|unable to access|timed out|connection (refused|reset)|network/i;
const REFUSED =
  /\b(401|403)\b|denied|permission|not allowed|protected branch|authentication|no token/i;
/** git's framing around the reason: never the reason itself. */
const BOILERPLATE =
  /^(to |error: failed to push|hint:|warning:|fatal: expected 'acknowledgments'|everything up-to-date)/i;

export function pushFailure(e: unknown): PushFailure {
  const raw = errorMessage(e);
  if (UNREACHABLE.test(raw)) return { kind: "unreachable" };
  if (REFUSED.test(raw)) return { kind: "refused" };
  return { kind: "other", said: pushSaid(raw) };
}

/**
 * The one line that says why: the host's own message ("remote: ..."), else the reason git puts
 * in brackets after "[remote rejected]", else git's first line that is not its framing. Without
 * a final dot, so it can be quoted inside a sentence.
 */
function pushSaid(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const remote = lines
    .filter((l) => /^remote:/i.test(l))
    .map((l) =>
      l
        .replace(/^remote:\s*/i, "")
        .replace(/^error:\s*/i, "")
        .trim(),
    )
    .find(Boolean);
  const rejected = lines
    .map((l) => /\[(?:remote )?rejected\][^(]*\(([^)]+)\)/i.exec(l)?.[1]?.trim())
    .find(Boolean);
  const other = lines
    .map((l) => l.replace(/^git push .*? failed:?\s*/i, "").trim())
    .find((l) => l && !BOILERPLATE.test(l));
  return redact(remote || rejected || other || "")
    .slice(0, 160)
    .replace(/[.\s]+$/, "");
}

/**
 * A task's branch the host refused, in words with what to do (design §5.8): before, the task's
 * reason was git's own output ("push failed: git push fr/... failed: remote: ... error: failed
 * to push some refs"), which the person read on the Tasks tab and in the session result.
 */
export function pushFailedWords(repoName: string, branch: string, e: unknown): string {
  const failure = pushFailure(e);
  const head = `Forerunner could not push the branch ${branch} to ${repoName}`;
  if (failure.kind === "unreachable")
    return `${head}: GitHub could not be reached. Try again later.`;
  if (failure.kind === "refused")
    return `${head}: GitHub refused it (the token may not write to it, or a rule protects the branch). Check the GitHub token in Settings, then press Try again.`;
  return `${head}${failure.said ? `: git said "${failure.said}"` : ""}. Press Try again; if it fails again, look at the repository on GitHub.`;
}

/**
 * The first commit of an empty repository (ADR 0106) the host refused, in words with what to
 * do; short enough (under 200 characters for a usual name) that the task's reason, which the
 * runner cuts at 200, keeps all of it. Review (2026-11-02): before, git's multi-line output
 * stood in the middle of the person's message.
 */
export function firstPushFailedWords(repoName: string, e: unknown): string {
  const failure = pushFailure(e);
  if (failure.kind === "unreachable")
    return `${repoName} is empty, and Forerunner could not reach GitHub to make its first commit. Try again later.`;
  if (failure.kind === "refused")
    return `${repoName} is empty and GitHub refused Forerunner's first commit (the token may not write to it). Add a README on GitHub or check the token in Settings, then press Try again.`;
  return `${repoName} is empty and Forerunner could not make its first commit${failure.said ? `: git said "${failure.said}"` : ""}. Add a README on GitHub, then press Try again.`;
}
