import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, type RunResult } from "@forerunner/platform";
import { describe, expect, it } from "vitest";
import { GitOps } from "../src/githost/git.ts";
import { firstPushFailedWords, pushFailedWords, pushFailure } from "../src/githost/push-words.ts";

/**
 * What git prints when a host's pre-receive hook refuses a push, exactly as git writes it to
 * stderr (the host's line is padded with eight spaces when stderr is not a terminal). The shape
 * depends on the machine's git configuration, not on the code: with git's defaults (CI's git
 * 2.56 on Linux and Windows, and git 2.43 here) the host's `remote:` line is the first line;
 * with `push.negotiate=true` (this development container's global config) git prints two lines
 * about the failed negotiation first. The person must read the host's own sentence either way.
 *
 * CI on 193e579 (run 41456492496) found it: `GitOps` reports a failed command as
 * `git push main failed: <stderr>`, so with git's defaults the host's line shared its line with
 * that header, the `remote:` line was not found, and the person was told git's generic
 * "pre-receive hook declined" instead of "This repository is archived and read-only".
 */
const HOST_LINE = "This repository is archived and read-only.";
const TAIL = [
  "To /tmp/fr-pr-Ab12Cd/archived.git",
  " ! [remote rejected] main -> main (pre-receive hook declined)",
  "error: failed to push some refs to '/tmp/fr-pr-Ab12Cd/archived.git'",
  "",
];
const SHAPES: Record<string, string> = {
  "git's defaults (CI's git 2.56)": [`remote: ${HOST_LINE}        `, ...TAIL].join("\n"),
  "push.negotiate=true": [
    "fatal: expected 'acknowledgments', received 'packfile'",
    "warning: push negotiation failed; proceeding anyway with push",
    `remote: ${HOST_LINE}        `,
    ...TAIL,
  ].join("\n"),
  "git's defaults on Windows (CRLF)": [`remote: ${HOST_LINE}        `, ...TAIL].join("\r\n"),
};

/** The error `GitOps.push` throws when git exits 1 with `stderr`: the product's own path. */
async function pushError(stderr: string): Promise<unknown> {
  const cwd = mkdtempSync(join(tmpdir(), "fr-push-words-"));
  mkdirSync(join(cwd, ".git"));
  const git = new GitOps({
    cwd,
    runner: async (): Promise<RunResult> => ({
      code: 1,
      signal: null,
      stdout: "",
      stderr,
      truncated: false,
      timedOut: false,
      durationMs: 1,
    }),
  });
  try {
    await git.push("main");
  } catch (e) {
    return e;
  }
  throw new Error("push did not fail");
}

describe("a push the host refused, in the person's words", () => {
  for (const [shape, stderr] of Object.entries(SHAPES)) {
    it(`names the host's own line, not git's generic reason (${shape})`, async () => {
      const e = await pushError(stderr);
      expect(pushFailure(e)).toEqual({
        kind: "other",
        said: "This repository is archived and read-only",
      });
      expect(firstPushFailedWords("o/archived", e)).toBe(
        'o/archived is empty and Forerunner could not make its first commit: git said "This repository is archived and read-only". Add a README on GitHub, then press Try again.',
      );
      expect(pushFailedWords("o/archived", "fr/1-page", e)).toBe(
        'Forerunner could not push the branch fr/1-page to o/archived: git said "This repository is archived and read-only". Press Try again; if it fails again, look at the repository on GitHub.',
      );
    });
  }

  it("a host that says nothing of its own: the reason git puts in brackets", async () => {
    const e = await pushError(TAIL.join("\n"));
    expect(pushFailure(e)).toEqual({ kind: "other", said: "pre-receive hook declined" });
  });

  it("git's progress lines from the host are not the reason", async () => {
    const e = await pushError(
      [
        "warning: push negotiation failed; proceeding anyway with push",
        "remote: Resolving deltas: 100% (2/2), done.        ",
        `remote: error: ${HOST_LINE}        `,
        ...TAIL,
      ].join("\n"),
    );
    expect(pushFailure(e)).toEqual({
      kind: "other",
      said: "This repository is archived and read-only",
    });
  });

  it("no output beyond git's header: git's own first line", async () => {
    const e = await pushError("fatal: the object directory is corrupt\n");
    expect(pushFailure(e)).toEqual({
      kind: "other",
      said: "fatal: the object directory is corrupt",
    });
  });
});
