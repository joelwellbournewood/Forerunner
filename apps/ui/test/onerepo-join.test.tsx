import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { JoinPreviewView } from "../src/api/client.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * D1 (the owner's words of 2026-11-09: "There should not be 2 projects in one repo. ... Make it
 * such that multiple projects are not done on one repo, in an intelligent way."): two projects
 * that already share a repository on this computer (made before the rule) say so on their
 * Overviews and become one with Make one project, the person choosing the one to keep.
 */
const SHARED = '"Atlas" and "Beacon" both work in org/atlas.';

const PREVIEW: JoinPreviewView = {
  projectId: "proj_atlas",
  shared: { text: SHARED, projects: [{ id: "proj_beacon", name: "Beacon" }] },
  projects: [
    {
      id: "proj_atlas",
      name: "Atlas",
      together: false,
      lines: [
        "3 open tasks, 2 done",
        "Spent so far: CHF 1.20",
        "Budget per session: CHF 5.00",
        "Project budget: no project budget",
        "Who merges: Merge automatically after review",
        "Research reads: any public website",
      ],
    },
    {
      id: "proj_beacon",
      name: "Beacon",
      together: false,
      lines: [
        "1 open task, 1 done",
        "1 open pull request",
        "Spent so far: CHF 3.20",
        "Budget per session: CHF 5.00",
        "Project budget: no project budget",
        "Who merges: You press Merge",
        "Research reads: any public website",
      ],
    },
  ],
  ifKept: {
    proj_atlas: {
      moves: 'The tasks, plan, cards and pull requests of "Beacon" move into "Atlas".',
      stays: '"Beacon" keeps its sessions, changes and spending to read; no budget changes.',
      settings: [
        'Who merges: the setting of "Atlas" applies to the moved work: merge automatically after review.',
        'Status issue: the setting of "Atlas" applies to the moved work: on.',
      ],
      refusal: null,
    },
    proj_beacon: {
      moves: 'The tasks, plan, cards and pull requests of "Atlas" move into "Beacon".',
      stays: '"Atlas" keeps its sessions, changes and spending to read; no budget changes.',
      settings: ['Who merges: the setting of "Beacon" applies to the moved work: you press Merge.'],
      refusal: null,
    },
  },
  keepOnly: null,
  keepOnlyLine: null,
};

describe("d1109-onerepo-join, run C: Make one project on the Overview (OJ-01, OJ-05, OJ-06)", () => {
  it("the Overview says both work in the repository, with Make one project and its line; the dialog lists both with their figures, nothing chosen and the button disabled; choosing one names its differing setting; the press sends project.join (source ui) and lands on the kept project, which includes the other's work", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.sharedRepository.proj_atlas = {
      text: SHARED,
      projects: [{ id: "proj_beacon", name: "Beacon" }],
    };
    harness.daemon.state.joinPreviews.proj_atlas = PREVIEW;
    renderApp("/projects/proj_atlas/summary", harness);
    const section = await screen.findByTestId("shared-repository");
    expect(within(section).getByTestId("shared-repository-line")).toHaveTextContent(SHARED);
    expect(section).toHaveTextContent(
      "You choose which to keep; the other's tasks, plan and cards move into it.",
    );
    await user.click(within(section).getByTestId("make-one-project"));
    const dialog = await screen.findByTestId("join-projects-dialog");
    await within(dialog).findByTestId("join-project-proj_beacon");
    expect(within(dialog).getByTestId("join-project-proj_atlas")).toHaveTextContent(
      "Who merges: Merge automatically after review",
    );
    expect(within(dialog).getByTestId("join-project-proj_beacon")).toHaveTextContent(
      "Spent so far: CHF 3.20",
    );
    // Nothing chosen at first: no guessing.
    const radios = within(dialog).getAllByTestId("join-keep") as HTMLInputElement[];
    expect(radios.every((r) => !r.checked)).toBe(true);
    expect(within(dialog).getByTestId("join-confirm")).toBeDisabled();
    await user.click(within(dialog).getByLabelText('Keep "Atlas"'));
    expect(within(dialog).getByTestId("join-plan")).toHaveTextContent(
      'The tasks, plan, cards and pull requests of "Beacon" move into "Atlas".',
    );
    expect(
      within(dialog)
        .getAllByTestId("join-setting")
        .map((e) => e.textContent),
    ).toEqual([
      'Who merges: the setting of "Atlas" applies to the moved work: merge automatically after review.',
      // w8-status-write: the status issue's switch is named (the status pull request went).
      'Status issue: the setting of "Atlas" applies to the moved work: on.',
    ]);
    expect(within(dialog).getByTestId("join-confirm")).toBeEnabled();
    await user.click(within(dialog).getByTestId("join-confirm"));
    await waitFor(() =>
      expect(postedCalls(harness, "/commands/execute").at(-1)?.body).toMatchObject({
        commands: [
          { name: "project.join", params: { keep: "proj_atlas", close: ["proj_beacon"] } },
        ],
        source: "ui",
        confirm: "tap",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("join-projects-dialog")).toBeNull());
    expect(await screen.findByTestId("includes-work-of")).toHaveTextContent(
      'Includes the work of "Beacon".',
    );
    expect(screen.queryByTestId("shared-repository")).toBeNull();
    const row = harness.daemon.state.changes[0];
    expect(row?.sentence).toBe('Made one project: "Beacon" joined "Atlas".');
    // Home lists Atlas only.
    expect((await harness.client.projects()).map((p) => p.name)).not.toContain("Beacon");
  });

  it("what holds the join now is said in its sentence and keeps Make one project disabled", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.sharedRepository.proj_atlas = {
      text: SHARED,
      projects: [{ id: "proj_beacon", name: "Beacon" }],
    };
    harness.daemon.state.joinPreviews.proj_atlas = {
      ...PREVIEW,
      ifKept: {
        ...PREVIEW.ifKept,
        proj_atlas: {
          ...(PREVIEW.ifKept.proj_atlas as NonNullable<(typeof PREVIEW.ifKept)[string]>),
          refusal: 'A session is working on "Beacon". Make one project when it ends.',
        },
      },
    };
    renderApp("/projects/proj_atlas/summary", harness);
    await user.click(await screen.findByTestId("make-one-project"));
    const dialog = await screen.findByTestId("join-projects-dialog");
    await user.click(await within(dialog).findByLabelText('Keep "Atlas"'));
    expect(within(dialog).getByTestId("join-refusal")).toHaveTextContent(
      'A session is working on "Beacon". Make one project when it ends.',
    );
    expect(within(dialog).getByTestId("join-confirm")).toBeDisabled();
    expect(postedCalls(harness, "/commands/execute")).toHaveLength(0);
  });

  it("a joined project's page reads where its work went with Open it, never 'This project was removed.', and offers no start", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.joined.proj_beacon = {
      projectId: "proj_atlas",
      name: "Atlas",
      at: "2026-11-09T10:00:00.000Z",
      text: 'Joined into "Atlas" on 9 Nov.',
    };
    renderApp("/projects/proj_beacon/summary", harness);
    const header = await screen.findByTestId("project-joined");
    expect(header).toHaveTextContent('Joined into "Atlas" on 9 Nov.');
    expect(screen.queryByText("This project was removed.")).toBeNull();
    expect(screen.queryByTestId("start-session")).toBeNull();
    await user.click(within(header).getByTestId("project-joined-open"));
    expect(await screen.findByTestId("includes-work-of")).toHaveTextContent(
      'Includes the work of "Beacon".',
    );
  });
});

describe("d1109-onerepo-join, run C: a joined project offers no new work (OJ-06)", () => {
  /** Beacon closed into Atlas, its tasks moved, as `project.join` leaves it. */
  const joinedBeacon = () => {
    const harness = createHarness();
    const { state } = harness.daemon;
    state.joined.proj_beacon = {
      projectId: "proj_atlas",
      name: "Atlas",
      at: "2026-11-09T10:00:00.000Z",
      text: 'Joined into "Atlas" on 9 Nov.',
    };
    for (const t of state.tasks) if (t.projectId === "proj_beacon") t.projectId = "proj_atlas";
    return harness;
  };

  it("its Tasks tab has no New task and says where its tasks are, with Open it; Atlas's has New task", async () => {
    const user = userEvent.setup();
    const harness = joinedBeacon();
    renderApp("/projects/proj_beacon/tasks", harness);
    const empty = await screen.findByTestId("no-tasks");
    expect(empty).toHaveTextContent('Its tasks are in "Atlas". Open it');
    expect(empty).not.toHaveTextContent("Press New task");
    expect(screen.queryByTestId("new-task")).toBeNull();
    await user.click(within(empty).getByRole("link", { name: "Open it" }));
    expect(await screen.findByTestId("new-task")).toBeEnabled();
    expect((await screen.findAllByTestId("task-row")).length).toBeGreaterThan(0);
  });

  it("its Overview has no note for the next session, no Research reads with Change and no Decisions (they moved); Atlas's Overview has them", async () => {
    const harness = joinedBeacon();
    renderApp("/projects/proj_beacon/summary", harness);
    await screen.findByTestId("project-joined");
    await screen.findByTestId("summary-tab");
    expect(screen.queryByTestId("queue")).toBeNull();
    expect(screen.queryByTestId("queue-text")).toBeNull();
    expect(screen.queryByTestId("research-reads")).toBeNull();
    expect(screen.queryByTestId("research-reads-change")).toBeNull();
    expect(screen.queryByTestId("decisions")).toBeNull();
    renderApp("/projects/proj_atlas/summary", harness);
    expect(await screen.findByTestId("queue-text")).toBeInTheDocument();
    expect(await screen.findByTestId("research-reads-change")).toBeInTheDocument();
  });

  it("its Chat keeps the conversation to read: no message box, no 'add a task' example, no Make this a task; it says where to ask, with Open it to Atlas's Chat", async () => {
    const user = userEvent.setup();
    const harness = joinedBeacon();
    renderApp("/projects/proj_beacon/chat", harness);
    const line = await screen.findByTestId("chat-closed");
    expect(line).toHaveTextContent(
      'This chat is kept to read; ask about its work in the Chat of "Atlas".',
    );
    expect(within(line).getByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      "/projects/proj_atlas/chat",
    );
    expect(screen.queryByTestId("chat-intro")).toBeNull();
    // An empty kept-to-read chat promises no change either.
    expect(await screen.findByTestId("chat-empty")).toHaveTextContent("Nothing was said here.");
    expect(screen.queryByTestId("chat-input")).toBeNull();
    expect(screen.queryByTestId("chat-send")).toBeNull();
    expect(screen.queryByTestId("chat-examples")).toBeNull();
    expect(screen.queryByText("add a task: …")).toBeNull();
    expect(screen.queryByText("Make this a task")).toBeNull();
    await user.click(within(line).getByRole("link", { name: "Open it" }));
    expect(await screen.findByTestId("chat-input")).toBeEnabled();
    expect(screen.getByTestId("chat-examples")).toHaveTextContent("add a task: …");
  });

  it("as the daemon, the fake refuses New task and a note on the joined project with the same sentence", async () => {
    const harness = joinedBeacon();
    const refused = '"Beacon" joined "Atlas", so its work runs there.';
    await expect(
      harness.client.createTask("proj_beacon", { title: "Probe task", outcome: "probe" }),
    ).rejects.toMatchObject({ status: 409, message: refused });
    await expect(
      harness.client.enqueue("proj_beacon", { kind: "note", text: "Use the red kite." }),
    ).rejects.toMatchObject({ status: 409, message: refused });
    const r = await harness.client.executeCommands({
      commands: [
        { name: "note.add", params: { text: "Use the red kite.", project: "proj_beacon" } },
      ],
      wordsUsed: "Note for the next session",
      source: "ui",
      projectId: "proj_beacon",
      confirm: "tap",
    });
    expect(r).toMatchObject({ status: "refused", reason: refused });
  });
});

describe("d1109-onerepo-join, run C: the kept project's Sessions and Costs (OJ-10, OJ-07)", () => {
  it("the kept project's Sessions list ends with the joined project's line and Open; its Costs names what the joined project spent before it joined", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.joined.proj_beacon = {
      projectId: "proj_atlas",
      name: "Atlas",
      at: "2026-11-09T10:00:00.000Z",
      text: 'Joined into "Atlas" on 9 Nov.',
    };
    const rows = harness.daemon.state.projectSessions.proj_atlas ?? [];
    harness.daemon.state.projectSessions.proj_beacon = rows.slice(0, 1);
    harness.daemon.state.costs.proj_atlas = {
      ...(harness.daemon.state.costs.proj_atlas as NonNullable<
        (typeof harness.daemon.state.costs)[string]
      >),
      joinedSpend: [
        {
          projectId: "proj_beacon",
          name: "Beacon",
          spent: { usdMicro: 4_000_000, chfMicro: 3_200_000 },
          words: 'Spent in "Beacon" before it joined: CHF 3.20',
        },
      ],
    };
    renderApp("/projects/proj_atlas/sessions", harness);
    const line = await screen.findByTestId("sessions-joined");
    expect(line).toHaveTextContent('"Beacon" had 1 session before it joined. Open');
    renderApp("/projects/proj_atlas/costs", harness);
    expect(await screen.findByTestId("cost-joined")).toHaveTextContent(
      'Spent in "Beacon" before it joined: CHF 3.20',
    );
    await user.click(within(line).getByTestId("sessions-joined-open"));
    await waitFor(() =>
      expect(screen.getAllByTestId("project-joined")[0]).toHaveTextContent(
        'Joined into "Atlas" on 9 Nov.',
      ),
    );
  });
});

describe("l4-github-merge, run L4", () => {
  const joinedBeacon = () => {
    const harness = createHarness();
    const { state } = harness.daemon;
    state.joined.proj_beacon = {
      projectId: "proj_atlas",
      name: "Atlas",
      at: "2026-11-09T10:00:00.000Z",
      text: 'Joined into "Atlas" on 9 Nov.',
    };
    // As the daemon: a joined project is archived, so GET /projects lists Atlas only.
    for (const p of state.projects) if (p.id === "proj_beacon") p.status = "archived";
    state.folders.proj_beacon = "/home/you/.forerunner/worktrees/docs/proj_beacon";
    return harness;
  };

  it("L4-github-115: a joined project's page names it in the header, not the active project", async () => {
    const harness = joinedBeacon();
    renderApp("/projects/proj_beacon/summary", harness);
    await screen.findByTestId("project-joined");
    // Before: the header read "Atlas" (the active project; Beacon is not in the active list).
    await waitFor(() => expect(screen.getByTestId("active-project")).toHaveTextContent("Beacon"));
    expect(screen.getByTestId("active-project")).not.toHaveTextContent("Atlas");
  });

  it("L4-github-115: its Your files says where its files are, with no folder path of Forerunner's own", async () => {
    const harness = joinedBeacon();
    renderApp("/projects/proj_beacon/summary", harness);
    const files = await screen.findByTestId("joined-files");
    expect(files).toHaveTextContent('Its files are in "Atlas".');
    expect(screen.getByTestId("your-files")).not.toHaveTextContent("worktrees");
    expect(screen.getByTestId("your-files")).not.toHaveTextContent("proj_beacon");
  });
});

describe("l4-chat-carried, run L4: Talk on a joined project (C4-left-9)", () => {
  // Talk shows the conversation of the project on screen (design section 3.9). On a project closed
  // into another it said nothing of that and kept its message box and Talk button: a change asked
  // there was refused in words. It says what the joined page's Chat says, with no message box.
  const joinedBeacon = () => {
    const harness = createHarness();
    const { state } = harness.daemon;
    state.joined.proj_beacon = {
      projectId: "proj_atlas",
      name: "Atlas",
      at: "2026-11-09T10:00:00.000Z",
      text: 'Joined into "Atlas" on 9 Nov.',
    };
    for (const p of state.projects) if (p.id === "proj_beacon") p.status = "archived";
    return harness;
  };

  it("on the joined project's page Talk says the chat is kept to read, with Open it, and has no message box, examples or Talk button; Open it leads to Atlas's chat, where Talk has them", async () => {
    const user = userEvent.setup();
    const harness = joinedBeacon();
    renderApp("/projects/proj_beacon/summary", harness);
    await screen.findByTestId("project-joined");
    await user.click(screen.getByTestId("talk-open"));
    const talk = await screen.findByTestId("conversation");
    const line = await within(talk).findByTestId("conversation-closed");
    expect(line).toHaveTextContent(
      'This chat is kept to read; ask about its work in the Chat of "Atlas".',
    );
    expect(within(line).getByRole("link", { name: "Open it" })).toHaveAttribute(
      "href",
      "/projects/proj_atlas/chat",
    );
    expect(within(talk).queryByTestId("conversation-input")).toBeNull();
    expect(within(talk).queryByTestId("conversation-send")).toBeNull();
    expect(within(talk).queryByTestId("conversation-examples")).toBeNull();
    expect(within(talk).queryByTestId("voice-talk")).toBeNull();
    // Nothing reached the daemon's chat from it.
    expect(postedCalls(harness, "/chat")).toEqual([]);
    await user.click(within(line).getByRole("link", { name: "Open it" }));
    expect(await within(talk).findByTestId("conversation-input")).toBeEnabled();
    expect(within(talk).queryByTestId("conversation-closed")).toBeNull();
    expect(within(talk).getByTestId("voice-talk")).toBeInTheDocument();
    expect(within(talk).getByTestId("conversation-about")).toHaveTextContent("About Atlas");
  });
});

describe("l4-github-carried, run L4", () => {
  it("L4e-left-10: when the viewed project cannot be read (GET /projects/:id fails), the header's switcher still says what it does, never an empty name", async () => {
    const harness = createHarness();
    renderApp("/projects/proj_gone/summary", harness);
    // Before: the switcher button read "" (no name, no words) once the read failed.
    await waitFor(() =>
      expect(screen.getByTestId("active-project")).toHaveTextContent("Switch project"),
    );
    expect(screen.getByTestId("active-project")).not.toHaveTextContent("Atlas");
  });
});

describe("w8-together, wave 8: Work together for a project already here (OJ-11, W8-join-1, -2)", () => {
  const ELSEWHERE_LINE =
    'org/atlas is also the Forerunner project "Kite club", which is not on this computer; another GitHub account worked on it on 20 Nov.';
  const TOGETHER_LINE =
    'This project\'s tasks, plan and cards move into "Kite club"; both Forerunners work on it.';

  it("the Overview's line offers Work together first with its line; the dialog says what the press does and its one write on GitHub; the press sends project.join's together form (source ui) and lands on the project it became; Changes says what was closed and its Undo what stays closed", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = {
      kind: "elsewhere",
      text: ELSEWHERE_LINE,
      canWorkTogether: true,
      togetherLine: TOGETHER_LINE,
      canTakeOver: false,
      takeOverLine: null,
      details: null,
    };
    harness.daemon.state.oldStatusPr.proj_atlas = 4;
    renderApp("/projects/proj_atlas/summary", harness);
    const section = await screen.findByTestId("repository-elsewhere");
    expect(within(section).getByTestId("repository-elsewhere-line")).toHaveTextContent(
      ELSEWHERE_LINE,
    );
    expect(within(section).getByTestId("repository-work-together-line")).toHaveTextContent(
      TOGETHER_LINE,
    );
    expect(within(section).queryByTestId("repository-take-over")).toBeNull();
    await user.click(within(section).getByTestId("repository-work-together"));
    const dialog = await screen.findByTestId("join-together-dialog");
    expect(await within(dialog).findByTestId("join-together-sentence")).toHaveTextContent(
      '"Atlas" becomes "Kite club", the project GitHub knows: its tasks, plan and cards move into it, and this Forerunner works on it together with the other one.',
    );
    expect(within(dialog).getByTestId("join-together-github")).toHaveTextContent(
      'On GitHub only the old status pull request #4 of "Atlas" is closed, with one line saying why; nothing of the other Forerunner is touched.',
    );
    expect(dialog).toHaveTextContent(
      '"Atlas" keeps its sessions, changes and spending to read; no budget changes.',
    );
    expect(dialog).toHaveTextContent("Changes has its Undo.");
    await user.click(within(dialog).getByTestId("join-together-confirm"));
    await waitFor(() =>
      expect(postedCalls(harness, "/commands/execute").at(-1)?.body).toMatchObject({
        commands: [
          {
            name: "project.join",
            params: { keep: { together: true }, close: ["proj_atlas"] },
          },
        ],
        source: "ui",
        confirm: "tap",
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("join-together-dialog")).toBeNull());
    // It lands on the project it became, which says it is shared.
    expect(await screen.findByTestId("repository-elsewhere-line")).toHaveTextContent(
      "Shared on GitHub with another Forerunner: each keeps its own tasks.",
    );
    const row = harness.daemon.state.changes[0];
    expect(row?.sentence).toBe(
      '"Atlas" joined "Kite club", which this Forerunner works on together with another one; its old status pull request #4 is closed.',
    );
    const undone = await harness.client.undoChange(row?.id ?? "");
    expect(undone.sentence).toBe(
      '"Atlas" is its own project again; its old status pull request #4 stays closed on GitHub.',
    );
    expect(harness.daemon.state.repositoryOverview.proj_atlas?.canWorkTogether).toBe(true);
  });

  it("GitHub that does not answer is said in the dialog and keeps Work together disabled; nothing is sent", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = {
      kind: "elsewhere",
      text: ELSEWHERE_LINE,
      canWorkTogether: true,
      togetherLine: TOGETHER_LINE,
      canTakeOver: false,
      takeOverLine: null,
      details: null,
    };
    harness.daemon.state.togetherRefusal.proj_atlas =
      "GitHub did not answer, so the project cannot be checked. Try again.";
    renderApp("/projects/proj_atlas/summary", harness);
    const section = await screen.findByTestId("repository-elsewhere");
    await user.click(within(section).getByTestId("repository-work-together"));
    const dialog = await screen.findByTestId("join-together-dialog");
    expect(await within(dialog).findByTestId("join-refusal")).toHaveTextContent(
      "GitHub did not answer, so the project cannot be checked. Try again.",
    );
    expect(within(dialog).getByTestId("join-together-confirm")).toBeDisabled();
    expect(postedCalls(harness, "/commands/execute")).toEqual([]);
  });
});

describe("w8-together, wave 8: the guide could not go out (W8a-left-22)", () => {
  const LINE =
    "The repository guide on GitHub was not updated: every branch this project may write its docs on holds someone else's pull request.";

  it("the Overview says in one line why the repository guide was not updated, with no button, only while the daemon's card carries it", async () => {
    const harness = createHarness();
    harness.daemon.state.guideStopped.proj_atlas = true;
    renderApp("/projects/proj_atlas/summary", harness);
    const line = await screen.findByTestId("guide-stopped-line");
    expect(line).toHaveTextContent(LINE);
    expect(line.textContent).toBe(LINE);
    expect(within(line).queryAllByRole("button")).toEqual([]);
  });

  it("no line when the guide's last run got through", async () => {
    const harness = createHarness();
    renderApp("/projects/proj_atlas/summary", harness);
    await screen.findByTestId("summary-tab");
    expect(screen.queryByTestId("guide-stopped-line")).toBeNull();
  });
});
