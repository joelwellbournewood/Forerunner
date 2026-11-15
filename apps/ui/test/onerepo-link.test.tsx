import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

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
