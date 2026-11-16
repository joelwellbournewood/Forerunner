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
        'Who merges: "Atlas"\'s setting applies to the moved work: merge automatically after review.',
      ],
      refusal: null,
    },
    proj_beacon: {
      moves: 'The tasks, plan, cards and pull requests of "Atlas" move into "Beacon".',
      stays: '"Atlas" keeps its sessions, changes and spending to read; no budget changes.',
      settings: ['Who merges: "Beacon"\'s setting applies to the moved work: you press Merge.'],
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
      'Who merges: "Atlas"\'s setting applies to the moved work: merge automatically after review.',
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
