import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { repoNameFor } from "../src/pages/project/CreateRepoDialog.tsx";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * U-037: a project without a repository offers "Create a repository" on its page. The dialog
 * runs the same `repo.create` command as Chat and the agent's Inbox card: the daemon answers
 * with the change card (the name, the account, private), and Yes creates and links it.
 */
describe("Create a repository (U-037)", () => {
  it("shows only for a project without a repository", async () => {
    renderApp("/projects/proj_atlas/summary");
    await screen.findByTestId("project-header");
    expect(screen.queryByTestId("create-repo")).not.toBeInTheDocument();
  });

  it("previews the card, creates on Yes, and the button goes once the project has one", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_beacon/summary", harness);
    await user.click(await screen.findByTestId("create-repo"));
    const dialog = await screen.findByTestId("create-repo-dialog");
    expect(within(dialog).getByTestId("create-repo-name")).toHaveValue("beacon");
    expect(within(dialog).getByTestId("create-repo-private")).toBeChecked();
    await user.click(within(dialog).getByTestId("create-repo-preview"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        { name: "repo.create", params: { project: "proj_beacon", private: true, name: "beacon" } },
      ],
      wordsUsed: "Create a repository (project page)",
      source: "ui",
      projectId: "proj_beacon",
    });
    // The card says what will be created, where, and that it is private; nothing exists yet.
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveTextContent("alice/beacon (private, under your GitHub account alice)");
    await user.click(within(dialog).getByTestId("command-yes"));
    await waitFor(() =>
      expect(
        harness.daemon.state.calls.filter(
          (c) => c.method === "POST" && /\/commands\/.+\/confirm$/.test(c.path),
        ),
      ).toHaveLength(1),
    );
    const confirm = harness.daemon.state.calls.find(
      (c) => c.method === "POST" && /\/commands\/.+\/confirm$/.test(c.path),
    );
    expect(confirm?.body).toEqual({ answer: "tap" });
    expect(await within(dialog).findByTestId("command-sentence")).toBeInTheDocument();
    // The project now has its repository: the page no longer offers to create one.
    await waitFor(() => expect(screen.queryByTestId("create-repo")).not.toBeInTheDocument());
  });

  it("No leaves the project without a repository", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/projects/proj_beacon/summary", harness);
    await user.click(await screen.findByTestId("create-repo"));
    const dialog = await screen.findByTestId("create-repo-dialog");
    await user.click(within(dialog).getByTestId("create-repo-preview"));
    await user.click(await within(dialog).findByTestId("command-no"));
    await waitFor(() =>
      expect(
        harness.daemon.state.calls.find(
          (c) => c.method === "POST" && /\/commands\/.+\/confirm$/.test(c.path),
        )?.body,
      ).toEqual({ answer: "no" }),
    );
    expect(screen.getByTestId("create-repo")).toBeInTheDocument();
  });

  it("names the repository as the daemon does", () => {
    expect(repoNameFor("Garden Planner")).toBe("garden-planner");
    expect(repoNameFor("Zürich Café: v2!")).toBe("zurich-cafe-v2");
  });
});
