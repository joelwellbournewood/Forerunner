import { type GitHost, MemoryGitHost } from "@forerunner/capabilities";
import { ForerunnerError, Logger, type LogRecord } from "@forerunner/platform";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPullRequests } from "../src/daemon/pull-requests.ts";
import { type LoopWorld, loopWorld } from "./loop-helpers.ts";

/**
 * C-56 (phase C leftover, merge-in-app): the Overview's pull-request block said "GitHub did not
 * answer, so the pull requests are not listed (<error text>). Try again later." for every
 * failure, the raw error in parentheses, and said it too when no GitHub token was saved, where
 * GitHub was never asked. Each case now has its own sentence, never the raw error, which goes
 * to the log; no token and a refused token say what fixes it (the Overview adds Connect GitHub).
 */
const worlds: LoopWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
});

async function world() {
  const w = await loopWorld({ replies: [] });
  worlds.push(w);
  await w.store.project.patch(w.project, { repos: ["o/app"] });
  return { w, project: await w.store.project.mustGet(w.project) };
}

/** A host whose list of pull requests fails with `error`. */
function failing(error: Error): GitHost {
  const host = new MemoryGitHost("alice");
  return new Proxy(host, {
    get(target, prop, receiver) {
      if (prop === "listPullRequests") return async () => Promise.reject(error);
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe("the Overview's pull requests say why they are not listed, in words (C-56)", () => {
  it("no token: GitHub is not asked, and the words say to add one", async () => {
    const { w, project } = await world();
    let asked = 0;
    const host = new Proxy(new MemoryGitHost("alice"), {
      get(target, prop, receiver) {
        if (prop === "listPullRequests")
          return async () => {
            asked += 1;
            return [];
          };
        return Reflect.get(target, prop, receiver);
      },
    });
    const view = await new ProjectPullRequests({
      store: w.store,
      host,
      hasToken: async () => false,
    }).view(project);
    expect(view).toMatchObject({
      error: "Add a GitHub token in Settings to see the pull requests.",
      errorKind: "no_token",
      waiting: [],
    });
    expect(asked).toBe(0);
  });

  it("a refused token, a token without access and a silent GitHub each have their sentence; the raw error is in the log only", async () => {
    const { w, project } = await world();
    const cases: [Error, string, string][] = [
      [
        new ForerunnerError("provider_auth", "GET /repos/o/app/pulls -> 401: Bad credentials"),
        "GitHub refused the saved token, so the pull requests are not listed: save a new one in Settings.",
        "refused",
      ],
      [
        new ForerunnerError("not_found", "GET /repos/o/app/pulls -> 404: Not Found"),
        "The saved GitHub token cannot read o/app: give it access to the repository, or save another one in Settings.",
        "refused",
      ],
      [
        new ForerunnerError("provider_error", "fetch failed: ECONNRESET 140.82.112.6:443"),
        "GitHub did not answer, so the pull requests are not listed. Try again later.",
        "unreachable",
      ],
    ];
    const logged: string[] = [];
    const off = Logger.addSink((rec: LogRecord) => {
      if (rec.scope === "pull-requests") logged.push(JSON.stringify(rec.data ?? {}));
    });
    try {
      for (const [error, sentence, kind] of cases) {
        const view = await new ProjectPullRequests({
          store: w.store,
          host: failing(error),
          hasToken: async () => true,
        }).view(project);
        expect(view).toMatchObject({ error: sentence, errorKind: kind, waiting: [] });
        expect(view.error).not.toContain(error.message);
      }
    } finally {
      off();
    }
    expect(logged.join("\n")).toContain("ECONNRESET");
  });
});

/**
 * R-overviewcalls (leftovers7-merge): every read of a repository project's Overview asked GitHub
 * for the repository's settings and each base branch's rules again (4 calls a read with the
 * list), and a settling row reads the list on every card change, for up to a day.
 */
describe("the Overview's pull requests read the repository's settings and rules once a minute (R-overviewcalls)", () => {
  it("consecutive views within the minute make one getRepo and one getBranchRules per base; the list is read each time", async () => {
    const { w, project } = await world();
    const memory = new MemoryGitHost("alice");
    await memory.createRepo({ owner: "o", name: "app", private: true });
    await memory.createPullRequest(
      { owner: "o", name: "app" },
      { title: "One", body: "", head: "fr/one", base: "main" },
    );
    await memory.createPullRequest(
      { owner: "o", name: "app" },
      { title: "Two", body: "", head: "fr/two", base: "release" },
    );
    const calls: string[] = [];
    const host = new Proxy(memory, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (prop === "getRepo" || prop === "getBranchRules" || prop === "listPullRequests")
            calls.push(prop === "getBranchRules" ? `${String(prop)} ${String(args[1])}` : prop);
          return value.apply(target, args);
        };
      },
    });
    const prs = new ProjectPullRequests({ store: w.store, host });
    for (let i = 0; i < 3; i++) await prs.view(project);
    const count = (name: string) => calls.filter((c) => c === name).length;
    expect(count("listPullRequests")).toBe(3);
    expect(count("getRepo")).toBe(1);
    expect(count("getBranchRules main")).toBe(1);
    expect(count("getBranchRules release")).toBe(1);
    // A minute later they are read again.
    await w.clock.advance(61_000);
    await prs.view(project);
    expect(count("getRepo")).toBe(2);
    expect(count("getBranchRules main")).toBe(2);
  });
});
