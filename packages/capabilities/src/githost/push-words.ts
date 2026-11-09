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
  /**
   * The host refused it: a token that may not write, a protected branch, an archived repository.
   * `said` is the host's own line ("Permission to o/r.git denied to some-bot"), when it gave one.
   */
  | { kind: "refused"; said?: string }
  /** Anything else, with the one line of the host's (or git's) that says why, if any. */
  | { kind: "other"; said: string };

const UNREACHABLE =
  /could not resolve host|unable to access|timed out|connection (refused|reset)|network/i;
const REFUSED =
  /\b(401|403)\b|denied|permission|not allowed|protected branch|authentication|no token/i;
/**
 * The host answered and refused (R-2, polish-words): over HTTPS git ends a refused push with
 * "fatal: unable to access '<url>': The requested URL returned error: 403" after the host's own
 * line ("remote: Permission to o/r.git denied ...", "remote: This repository was archived ..."),
 * so this is read before UNREACHABLE, which "unable to access" also matches.
 */
const HOST_REFUSED = /returned error: 40[13]\b|^\s*remote:.*\b(denied|permission)\b/im;
/** git's framing around the reason: never the reason itself. */
const BOILERPLATE =
  /^(to |error: failed to push|hint:|warning:|fatal: expected 'acknowledgments'|everything up-to-date)/i;
/**
 * The host's progress lines (`remote: Resolving deltas: 100% ...`, `Total 3 (delta 0)`): never
 * the reason. Only the progress shapes: a host's reason may start with the same word ("Writing
 * to this repository is disabled", R-3).
 */
const REMOTE_PROGRESS =
  /^(?:(?:enumerating|counting|compressing|writing|receiving|resolving|processing) (?:objects|deltas|references)\b|total \d)/i;
/**
 * The header `GitOps` puts before git's output (`git push main failed: `). It shares a line with
 * git's first line, which with git's default configuration is the host's own `remote:` line.
 */
const GITOPS_HEADER = /^git [^:\r\n]*? failed:\s*/i;

export function pushFailure(e: unknown): PushFailure {
  const raw = errorMessage(e);
  const refused = (): PushFailure => {
    const said = pushSaid(raw, true);
    return said ? { kind: "refused", said } : { kind: "refused" };
  };
  if (HOST_REFUSED.test(raw)) return refused();
  if (UNREACHABLE.test(raw)) return { kind: "unreachable" };
  if (REFUSED.test(raw)) return refused();
  return { kind: "other", said: pushSaid(raw) };
}

/**
 * The one line that says why: the host's own message ("remote: ..."), else the reason git puts
 * in brackets after "[remote rejected]", else git's first line that is not its framing. Without
 * a final dot, so it can be quoted inside a sentence.
 *
 * `GitOps`'s header is taken off the first line before anything is read: with git's default
 * configuration the host's line is git's first, so it shared the header's line and was missed
 * (CI on 193e579, git 2.56); it was found only where `push.negotiate` made git print two lines
 * before it, as on the development container.
 */
function pushSaid(raw: string, hostOnly = false): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l, i) => (i === 0 ? l.replace(GITOPS_HEADER, "") : l).trim())
    .filter(Boolean);
  const remote = lines
    .filter((l) => /^remote:/i.test(l))
    .map((l) =>
      l
        .replace(/^remote:\s*/i, "")
        .replace(/^error:\s*/i, "")
        .trim(),
    )
    .find((l) => l && !REMOTE_PROGRESS.test(l));
  const rejected = lines
    .map((l) => /\[(?:remote )?rejected\][^(]*\(([^)]+)\)/i.exec(l)?.[1]?.trim())
    .find(Boolean);
  const other = lines.find((l) => !BOILERPLATE.test(l));
  // A refusal quotes the host's own words only: git's "fatal: unable to access ..." is no reason.
  return redact(hostOnly ? remote || rejected || "" : remote || rejected || other || "")
    .slice(0, 160)
    .replace(/[.\s]+$/, "");
}

/** The host's line inside a refusal's sentence: whole when short, else cut at a word. */
function hostLine(said: string, max = 80): string {
  if (said.length <= max) return said;
  const cut = said.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * A task's branch the host refused, in words with what to do (design §5.8): before, the task's
 * reason was git's own output ("push failed: git push fr/... failed: remote: ... error: failed
 * to push some refs"), which the person read on the Tasks tab and in the session result.
 *
 * The branch is not named (C-59, design §5.3; the review of polish-words): it is the task's id
 * part and its title ("fr/1a2b3c4d-write-the-guide"), and the sentence is the task's reason, read
 * on its own row, in its drawer and on its card, which name the task. A refusal leads with
 * GitHub's own line, so the row's "Failed: …" (cut at 100 characters) reaches it.
 */
export function pushFailedWords(repoName: string, _branch: string, e: unknown): string {
  const failure = pushFailure(e);
  if (failure.kind === "unreachable")
    return `Forerunner could not push the work to ${repoName}: GitHub could not be reached. Try again later.`;
  if (failure.kind === "refused")
    return failure.said
      ? `GitHub refused the push: "${hostLine(failure.said)}". Check the GitHub token in Settings and ${repoName} on GitHub, then press Try again.`
      : `GitHub refused the push to ${repoName} (the token may not write to it, or a rule protects the branch). Check the GitHub token in Settings, then press Try again.`;
  return `Forerunner could not push the work to ${repoName}${failure.said ? `: git said "${failure.said}"` : ""}. Press Try again; if it fails again, look at the repository on GitHub.`;
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
    return failure.said
      ? `${repoName} is empty and GitHub refused Forerunner's first commit: "${hostLine(failure.said, 60)}". Check the token in Settings, then press Try again.`
      : `${repoName} is empty and GitHub refused Forerunner's first commit (the token may not write to it). Add a README on GitHub or check the token in Settings, then press Try again.`;
  return `${repoName} is empty and Forerunner could not make its first commit${failure.said ? `: git said "${failure.said}"` : ""}. Add a README on GitHub, then press Try again.`;
}
