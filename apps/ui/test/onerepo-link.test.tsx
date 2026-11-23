import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  TAKE_OVER_UNDO_MERGED,
  TAKE_OVER_UNDO_OPEN,
  TAKE_OVER_UNDO_UNREADABLE,
} from "../../../packages/runtime/src/sources/repository-words.ts";
import { createClient } from "../src/api/client.ts";
import { createHarness, fetchFromApp, postedCalls, renderApp, testConfig } from "./helpers.tsx";

/**
 * D1 (the owner's words of 2026-11-09: "There should not be 2 projects in one repo. ... Make it
 * such that multiple projects are not done on one repo, in an intelligent way."): New project on
 * a repository another project uses offers that project instead of making a second one, and a
 * repository whose Forerunner project is not on this computer offers to work on it together
 * (D9). Before (bench walk of 2026-11-15, /tmp/frbench/fix-d1109-onerepo-link/before), the
 * dialog made "Shop" on Atlas's repository without a word.
 */
describe("d1109-onerepo-link, run C: the New project offer (OR-02, OR-15)", () => {
  const KITE = "01a1a000-0000-7000-8000-00000000c1ab";

  const fill = async (
    user: ReturnType<typeof userEvent.setup>,
    dialog: HTMLElement,
    v: { name: string; goal?: string; brief?: string; repo: string },
  ) => {
    await user.type(within(dialog).getByLabelText("Name"), v.name);
    if (v.goal) await user.type(within(dialog).getByLabelText(/Goal/), v.goal);
    if (v.brief) await user.type(within(dialog).getByLabelText(/Brief/), v.brief);
    await user.type(within(dialog).getByLabelText(/Repository link/), v.repo);
    await user.click(within(dialog).getByTestId("create-project"));
  };
  const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("new-project"));
    return screen.findByTestId("new-project-dialog");
  };

  it("a repository Atlas uses: the sentence with Open it, Add to it and Cancel; nothing is made; Cancel goes back to the form", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    const before = harness.daemon.state.projects.length;
    const dialog = await openDialog(user);
    await fill(user, dialog, {
      name: "Shop",
      brief: "A shop page for the docs.",
      repo: "https://github.com/Org/atlas.git",
    });
    const offer = await within(dialog).findByTestId("link-offer");
    expect(within(offer).getByTestId("link-offer-sentence")).toHaveTextContent(
      'org/atlas is already the project "Atlas". Open it, or add this to it as new work.',
    );
    expect(
      within(offer)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Open it", "Add to it", "Cancel"]);
    expect(harness.daemon.state.projects).toHaveLength(before);
    await user.click(within(offer).getByTestId("offer-cancel"));
    expect(within(dialog).queryByTestId("link-offer")).toBeNull();
    expect(within(dialog).getByTestId("create-project")).toBeInTheDocument();
  });

  it("Open it switches to Atlas and lands on it", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    harness.daemon.state.projects.forEach((p) => {
      p.active = p.id === "proj_beacon";
    });
    const dialog = await openDialog(user);
    await fill(user, dialog, { name: "Shop", goal: "A shop", repo: "org/atlas" });
    await user.click(await within(dialog).findByTestId("offer-open"));
    await waitFor(() =>
      expect(postedCalls(harness, "/commands/execute").at(-1)?.body).toMatchObject({
        commands: [{ name: "project.switch", params: { project: "proj_atlas" } }],
        source: "ui",
      }),
    );
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Atlas");
    expect(postedCalls(harness, "/projects")).toHaveLength(1);
  });

  it("Add to it sends the brief to Atlas's plan and lands on Atlas", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/", harness);
    const dialog = await openDialog(user);
    await fill(user, dialog, {
      name: "Shop",
      brief: "Add a shop page.",
      repo: "org/atlas",
    });
    await user.click(await within(dialog).findByTestId("offer-add"));
    await waitFor(() =>
      expect(postedCalls(harness, "/projects/proj_atlas/intake")).toEqual([
        expect.objectContaining({ body: { brief: "Add a shop page." } }),
      ]),
    );
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Atlas");
    expect(harness.daemon.state.intake.proj_atlas?.state).toBe("pending");
  });

  it("a repository whose project is not on this computer: Work together first with its line, Take it over with its line; Work together makes the same project here", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.repositoryElsewhere["o/kite"] = {
      ids: [KITE],
      name: "Kite club",
      lastActive: { at: "2026-11-03T09:00:00.000Z", own: false },
      otherAccount: null,
      canWorkTogether: true,
      canTakeOver: true,
    };
    renderApp("/", harness);
    const dialog = await openDialog(user);
    await fill(user, dialog, { name: "Kites", goal: "Kites", repo: "o/kite" });
    const offer = await within(dialog).findByTestId("link-offer");
    expect(within(offer).getByTestId("link-offer-sentence")).toHaveTextContent(
      'o/kite is already the Forerunner project "Kite club", which is not on this computer; last active on GitHub on 3 Nov. Work on it together, or take it over if nobody works on it any more.',
    );
    expect(
      within(offer)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Work together", "Take it over", "Cancel"]);
    expect(offer).toHaveTextContent(
      'This Forerunner works on "Kite club" too; nothing on GitHub changes now.',
    );
    expect(offer).toHaveTextContent(
      'The repository then names this project: choose it only if no Forerunner uses "Kite club" now.',
    );
    await user.click(within(offer).getByTestId("offer-together"));
    await waitFor(() =>
      expect(postedCalls(harness, "/projects").at(-1)?.body).toMatchObject({
        repos: ["o/kite"],
        together: { project: KITE },
      }),
    );
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Kite club");
    expect(harness.daemon.state.projects.find((p) => p.id === KITE)?.name).toBe("Kite club");
  });

  it("Sources: a candidate a project here covers reads 'Already the project \"Atlas\"' with Open, never 'duplicate' or a file path; one whose marker names a project that is not on this computer says so (OR-05)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const gamma = harness.daemon.state.sourceCandidates.find((c) => c.id === "cand_gamma");
    if (!gamma) throw new Error("fixture changed");
    gamma.details = { ...gamma.details, marker_project: KITE, marker_name: "Kite club" };
    renderApp("/settings", harness);
    const [acme] = await screen.findAllByTestId("source");
    if (!acme) throw new Error("no source row");
    await user.click(within(acme).getByTestId("source-candidates"));
    const rows = await within(acme).findAllByTestId("candidate");
    const alpha = rows.find((c) => c.dataset.candidateId === "cand_alpha") as HTMLElement;
    expect(within(alpha).getByTestId("candidate-status")).toHaveTextContent(
      'Already the project "Atlas"',
    );
    expect(within(alpha).getByTestId("candidate-project")).toHaveTextContent("Open");
    const marked = rows.find((c) => c.dataset.candidateId === "cand_gamma") as HTMLElement;
    expect(within(marked).getByTestId("candidate-install")).toHaveTextContent(
      'Used by "Kite club", not on this computer',
    );
    for (const row of rows) {
      expect(row).not.toHaveTextContent(/duplicate|\.forerunner\/project\.json/);
    }
  });

  it("another account worked on it within 14 days: Work together and Cancel only; Take it over sends the ids the offer named", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.repositoryElsewhere["o/kite"] = {
      ids: [KITE],
      name: "Kite club",
      lastActive: { at: "2026-11-08T09:00:00.000Z", own: false },
      otherAccount: "2026-11-08T09:00:00.000Z",
      canWorkTogether: true,
      canTakeOver: false,
    };
    renderApp("/", harness);
    const dialog = await openDialog(user);
    await fill(user, dialog, { name: "Kites", goal: "Kites", repo: "o/kite" });
    const offer = await within(dialog).findByTestId("link-offer");
    expect(within(offer).getByTestId("link-offer-sentence")).toHaveTextContent(
      'o/kite is already the Forerunner project "Kite club"; another GitHub account worked on it on 8 Nov. One repository is one project, so work on it together here.',
    );
    expect(
      within(offer)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Work together", "Cancel"]);
    // Nobody else for 14 days: Take it over is there and sends the ids the offer named.
    harness.daemon.state.repositoryElsewhere["o/kite"] = {
      ids: [KITE],
      name: "Kite club",
      lastActive: { at: "2026-10-01T09:00:00.000Z", own: true },
      otherAccount: null,
      canWorkTogether: true,
      canTakeOver: true,
    };
    await user.click(within(offer).getByTestId("offer-cancel"));
    await user.click(within(dialog).getByTestId("create-project"));
    await user.click(await within(dialog).findByTestId("offer-take-over"));
    await waitFor(() =>
      expect(postedCalls(harness, "/projects").at(-1)?.body).toMatchObject({
        takeOver: { projects: [KITE] },
      }),
    );
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Kites");
  });
});

/**
 * OR-07: a project made before the rule (or while GitHub could not be read) whose repository is
 * also a Forerunner project that is not on this computer: one line on the Overview, no card.
 */
describe("d1109-onerepo-link, run C: the Overview's line about the repository (OR-07)", () => {
  const ELSEWHERE = {
    kind: "elsewhere" as const,
    text: 'org/atlas is also the Forerunner project "Kite club", which is not on this computer.',
    canTakeOver: true,
    takeOverLine:
      'The repository then names this project: choose it only if no Forerunner uses "Kite club" now.',
    details: 'The pull requests of "Kite club" stay as they are.',
  };

  it("the line with Take it over and its consequence line; the press takes it over at once (the press is the yes), the line goes, Changes has the row with its Undo, and Undo brings the line back", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = ELSEWHERE;
    renderApp("/projects/proj_atlas/summary", harness);
    const section = await screen.findByTestId("repository-elsewhere");
    expect(within(section).getByTestId("repository-elsewhere-line")).toHaveTextContent(
      'org/atlas is also the Forerunner project "Kite club", which is not on this computer.',
    );
    expect(within(section).getByTestId("repository-take-over-line")).toHaveTextContent(
      'The repository then names this project: choose it only if no Forerunner uses "Kite club" now.',
    );
    await user.click(within(section).getByTestId("repository-elsewhere-details-toggle"));
    expect(within(section).getByTestId("repository-elsewhere-details")).toHaveTextContent(
      'The pull requests of "Kite club" stay as they are.',
    );
    // No Inbox card: the line is visible, not blocking.
    expect(harness.daemon.state.requests.some((r) => /Kite club/.test(String(r.why)))).toBe(false);
    await user.click(within(section).getByTestId("repository-take-over"));
    expect(await screen.findByTestId("repository-took-over")).toHaveTextContent(
      'Took over org/atlas from "Kite club". Changes has its Undo.',
    );
    const posted = postedCalls(harness, "/commands/execute");
    expect(posted.at(-1)?.body).toMatchObject({
      commands: [{ name: "repo.take_over", params: { project: "proj_atlas" } }],
      source: "ui",
      confirm: "tap",
    });
    await waitFor(() => expect(screen.queryByTestId("repository-elsewhere-line")).toBeNull());
    const row = harness.daemon.state.changes[0];
    expect(row?.sentence).toBe('Took over org/atlas from "Kite club".');
    expect(row?.undoable).toBe(true);
    // Undo from Changes puts the line back.
    await harness.client.undoChange(String(row?.id));
    expect(harness.daemon.state.repositoryOverview.proj_atlas).toEqual(ELSEWHERE);
  });

  it("Take it over while the background service does not answer says so in its words, never the raw error (C2-left-13)", async () => {
    // Design §5 rule 8: the error path showed e.message ("daemon unreachable at http://…:
    // Failed to fetch").
    const user = userEvent.setup();
    const base = createHarness();
    base.daemon.state.repositoryOverview.proj_atlas = ELSEWHERE;
    const inner = fetchFromApp(base.daemon.app);
    const client = createClient(testConfig("test-token"), (input, init) =>
      String(input).includes("/commands/execute")
        ? Promise.reject(new TypeError("Failed to fetch"))
        : inner(input, init),
    );
    renderApp("/projects/proj_atlas/summary", { ...base, client });
    const section = await screen.findByTestId("repository-elsewhere");
    await user.click(within(section).getByTestId("repository-take-over"));
    expect(await within(section).findByRole("alert")).toHaveTextContent(
      /^Forerunner's background service does not answer\.$/,
    );
    expect(section).not.toHaveTextContent(/unreachable|Failed to fetch|http/);
  });

  it("another GitHub account worked on it within 14 days: the line says when, with no Take it over", async () => {
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = {
      ...ELSEWHERE,
      text: 'org/atlas is also the Forerunner project "Kite club", which is not on this computer; another GitHub account worked on it on 8 Nov.',
      canTakeOver: false,
      takeOverLine: null,
      details: null,
    };
    renderApp("/projects/proj_atlas/summary", harness);
    const section = await screen.findByTestId("repository-elsewhere");
    expect(section).toHaveTextContent(
      'org/atlas is also the Forerunner project "Kite club", which is not on this computer; another GitHub account worked on it on 8 Nov.',
    );
    expect(within(section).queryByTestId("repository-take-over")).toBeNull();
    expect(within(section).queryByTestId("repository-take-over-line")).toBeNull();
  });

  it("a project worked on together says so, with Details; a project with no line shows none", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = {
      kind: "together",
      text: "Shared on GitHub with another Forerunner: each keeps its own tasks.",
      canTakeOver: false,
      takeOverLine: null,
      details:
        "What the other Forerunner does shows in its pull requests on GitHub; each of you merges your own.",
    };
    renderApp("/projects/proj_atlas/summary", harness);
    const section = await screen.findByTestId("repository-elsewhere");
    expect(within(section).getByTestId("repository-elsewhere-line")).toHaveTextContent(
      "Shared on GitHub with another Forerunner: each keeps its own tasks.",
    );
    expect(within(section).queryByTestId("repository-take-over")).toBeNull();
    await user.click(within(section).getByTestId("repository-elsewhere-details-toggle"));
    expect(within(section).getByTestId("repository-elsewhere-details")).toHaveTextContent(
      "What the other Forerunner does shows in its pull requests on GitHub; each of you merges your own.",
    );
    delete harness.daemon.state.repositoryOverview.proj_atlas;
  });
});

/**
 * Review of fix/d1109-onerepo-link (bench, 2026-11-15): the plan card of Add to it, and every
 * plan of a project worked on together, read "About CHF 0.31 for the 5 tasks; the docs go to the
 * project's repository as a pull request." although its approval writes no document (design
 * section 5 rule 9). The take-over's Undo refusal read "Cannot be undone now: Its pull request on
 * GitHub already names this project: close it there first.." on Changes.
 */
describe("d1109-onerepo-link, run C: a plan-only plan promises no documents; the take-over's Undo refusal on Changes (review)", () => {
  const planCard = (
    id: string,
    projectId: string,
    projectName: string,
    extra: Record<string, unknown>,
  ) => ({
    id,
    projectId,
    projectName,
    taskId: null,
    taskTitle: null,
    sessionId: null,
    kind: "approval",
    why: `Plan for "${projectName}"`,
    steps: [],
    options: ["Approve and start", "Change the plan", "Reject"],
    blocking: true,
    risk: "medium",
    changeCard: {
      key: `intake:${projectId}`,
      project_id: projectId,
      applied_at: null,
      ...extra,
      proposal: {
        plan: {
          reason: "the brief",
          milestones: [],
          tasks: [
            { key: "a", title: "Add the shop page", priority: 5 },
            { key: "b", title: "Link the shop", priority: 4, dependsOn: ["a"] },
          ],
        },
        docs: {},
        firstSession: {
          summary: "The shop.",
          items: [
            { key: "a", estimateUsdMicro: 400_000 },
            { key: "b", estimateUsdMicro: 250_000 },
          ],
        },
      },
    },
    status: "open",
    answer: null,
    createdAt: "2026-11-15T09:00:00.000Z",
    version: 1,
  });

  it("a plan-only card says its total and nothing about documents, even beside a repository target (the daemon's card before the fix); a first plan to a repository keeps its docs clause", async () => {
    const harness = createHarness();
    harness.daemon.state.requests.unshift(
      planCard("req_only", "proj_atlas", "Atlas", {
        docs_target: "repository",
        plan_only: true,
      }) as never,
      planCard("req_first", "proj_beacon", "Beacon", { docs_target: "repository" }) as never,
    );
    renderApp("/inbox", harness);
    await screen.findAllByTestId("intake-card");
    const totalOf = (requestId: string) => {
      const request = screen
        .getAllByTestId("request")
        .find((r) => r.getAttribute("data-request-id") === requestId) as HTMLElement;
      return within(request).getByTestId("intake-total");
    };
    expect(totalOf("req_only")).toHaveTextContent(/^About CHF 0\.52 for the 2 tasks\.$/);
    expect(totalOf("req_first")).toHaveTextContent(
      /^About CHF 0\.52 for the 2 tasks; the docs go to the project's repository as a pull request\.$/,
    );
  });

  it("Add to it on a project with tasks: Atlas's plan card in the Inbox lists the new work and says nothing about documents", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.projects
      .filter((p) => p.id === "proj_atlas")
      .forEach((p) => {
        p.repos = ["org/atlas"];
      });
    expect(harness.daemon.state.tasks.some((t) => t.projectId === "proj_atlas")).toBe(true);
    const home = renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("new-project"));
    const dialog = await screen.findByTestId("new-project-dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Shop");
    await user.type(within(dialog).getByLabelText(/Brief/), "Add a shop page.");
    await user.type(within(dialog).getByLabelText(/Repository link/), "org/atlas");
    await user.click(within(dialog).getByTestId("create-project"));
    await user.click(await within(dialog).findByTestId("offer-add"));
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Atlas");
    home.unmount();
    renderApp("/inbox", harness);
    const card = (await screen.findAllByTestId("intake-card"))[0] as HTMLElement;
    expect(
      within(card)
        .getAllByTestId("intake-task")
        .map((t) => t.textContent),
    ).toEqual([expect.stringMatching(/^Add a shop page\. · the agent chooses who · about CHF /)]);
    expect(within(card).getByTestId("intake-total")).not.toHaveTextContent(/docs|pull request/);
    const filed = harness.daemon.state.requests[0]?.changeCard as { plan_only?: unknown } | null;
    expect(filed?.plan_only).toBe(true);
  });

  it("the take-over's Undo refusal reads as one sentence on Changes, for each of its three reasons", async () => {
    for (const [reason, shown] of [
      [
        TAKE_OVER_UNDO_OPEN,
        "Cannot be undone now: its pull request on GitHub already names this project. Close it there first.",
      ],
      [
        TAKE_OVER_UNDO_MERGED,
        "Cannot be undone now: the repository already names this project on GitHub.",
      ],
      [
        TAKE_OVER_UNDO_UNREADABLE,
        "Cannot be undone now: GitHub did not answer, so the repository cannot be checked. Try again.",
      ],
    ] as const) {
      const harness = createHarness();
      harness.daemon.state.takeOverUndoBlocked = reason;
      harness.daemon.state.changes.unshift({
        ...(harness.daemon.state.changes[0] as (typeof harness.daemon.state.changes)[number]),
        id: "chg_took",
        source: "ui",
        wordsUsed: "Take it over",
        commands: [{ name: "repo.take_over", params: { project: "proj_atlas" } }],
        sentence: 'Took over org/atlas from "Kite club".',
        undoState: "undoable",
        expiresAt: null,
        before: { line: null },
        after: { took_over: { name: "Kite club" } },
      });
      const { unmount } = renderApp("/changes", harness);
      const row = (await screen.findAllByTestId("change")).find(
        (r) => r.getAttribute("data-change-id") === "chg_took",
      ) as HTMLElement;
      expect(within(row).queryByTestId("change-undo")).toBeNull();
      expect(within(row).getByTestId("change-undo-blocked").textContent).toBe(shown);
      unmount();
    }
  });
});

describe("l4-github-link, run L4", () => {
  it("L4-github-109: with a 60-character marker name the lines under Work together and Take it over stay within 100 characters, the name whole or cut at a word", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    const name = "The neighbourhood kite flying club of the lower lake district";
    expect(name.length).toBe(61);
    harness.daemon.state.repositoryElsewhere["o/kite"] = {
      ids: ["01a1a000-0000-7000-8000-00000000c1ab"],
      name: name.slice(0, 60),
      lastActive: null,
      otherAccount: null,
      canWorkTogether: true,
      canTakeOver: true,
    };
    renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("new-project"));
    const dialog = await screen.findByTestId("new-project-dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Kites");
    await user.type(within(dialog).getByLabelText(/Goal/), "Kites");
    await user.type(within(dialog).getByLabelText(/Repository link/), "o/kite");
    await user.click(within(dialog).getByTestId("create-project"));
    const offer = await within(dialog).findByTestId("link-offer");
    const lines = [...offer.querySelectorAll("p.text-xs")].map((p) => p.textContent ?? "");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.length, line).toBeLessThanOrEqual(100);
      const quoted = /"([^"]+)"/.exec(line)?.[1] ?? "";
      // Whole, or cut at a word: what is kept is the start of the name up to a space.
      const kept = quoted.replace(/…$/, "");
      expect(name.startsWith(kept), line).toBe(true);
      if (quoted.endsWith("…")) expect(name[kept.length], line).toBe(" ");
    }
    expect(lines[0]).toBe(
      'This Forerunner works on "The neighbourhood kite flying club…" too; nothing on GitHub changes now.',
    );
    expect(lines[1]).toBe(
      'GitHub then names this project; choose it only if nobody uses "The neighbourhood kite flying…" now.',
    );
  });

  it("L4-creds-23: Work together through the dialog, then Docs: each doc the project does not have says the other Forerunner writes it, with no missing mark", async () => {
    // The fake had no notWrittenHere: a together project's Docs was empty against it.
    const user = userEvent.setup();
    const harness = createHarness();
    const KITE = "01a1a000-0000-7000-8000-00000000c1ab";
    harness.daemon.state.repositoryElsewhere["o/kite"] = {
      ids: [KITE],
      name: "Kite club",
      lastActive: null,
      otherAccount: null,
      canWorkTogether: true,
      canTakeOver: false,
    };
    renderApp("/", harness);
    await screen.findAllByTestId("project-card");
    await user.click(screen.getByTestId("new-project"));
    const dialog = await screen.findByTestId("new-project-dialog");
    await user.type(within(dialog).getByLabelText("Name"), "Kites");
    await user.type(within(dialog).getByLabelText(/Goal/), "Kites");
    await user.type(within(dialog).getByLabelText(/Repository link/), "o/kite");
    await user.click(within(dialog).getByTestId("create-project"));
    const offer = await within(dialog).findByTestId("link-offer");
    await user.click(within(offer).getByTestId("offer-together"));
    expect(await screen.findByTestId("project-header")).toHaveTextContent("Kite club");
    await user.click(screen.getByTestId("tab-docs"));
    const docs = await screen.findByTestId("docs");
    const rows = await within(docs).findAllByTestId("doc-row");
    expect(rows.length).toBe(8);
    for (const row of rows) {
      expect(row).toHaveTextContent(
        'The other Forerunner of "Kite club" writes this doc on GitHub; this project does not write docs.',
      );
      expect(row).not.toHaveTextContent("missing");
      expect(row).not.toHaveTextContent("not written yet");
    }
  });

  it("L4-creds-23: the Data tab's import of a repository another project uses shows the daemon's sentence and imports nothing", async () => {
    // The fake imported Atlas's repository into Beacon; the daemon answers 409 with the offer.
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_beacon/data", harness);
    await screen.findByTestId("data");
    await user.selectOptions(screen.getByTestId("import-source"), "github");
    await user.type(screen.getByTestId("import-locator"), "https://github.com/org/atlas");
    await user.click(screen.getByTestId("import-run"));
    await waitFor(() =>
      expect(postedCalls(harness, "/projects/proj_beacon/data/import")).toHaveLength(1),
    );
    expect(
      await screen.findByText(
        'org/atlas is already the project "Atlas". Open it, or add this to it as new work.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("import-result")).toBeNull();
  });
});
