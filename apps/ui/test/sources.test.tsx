import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { countsLine, kindLabel } from "../src/pages/SourcesSection.tsx";
import { SOURCES } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * The Sources section of Settings (spec A.4): connected sources with what their scans found,
 * the candidates with their status and the existing-install mark, Create project on a
 * proposal (the same POST path as the New project dialog, through the daemon), connect a new
 * source (a token value never leaves the form as a credential: the daemon's refusal is shown),
 * scan, rescan and remove with a confirmation; a daemon without the route degrades.
 */
describe("Sources section", () => {
  it("formats counts and kinds", () => {
    const acme = SOURCES[0];
    if (!acme) throw new Error("fixture");
    expect(countsLine(acme.candidates)).toBe(
      "1 proposed, 1 accepted, 1 duplicate, 1 with an existing install",
    );
    expect(
      countsLine({ total: 0, proposed: 0, accepted: 0, duplicate: 0, gone: 0, installs: 0 }),
    ).toBe("nothing found yet");
    expect(kindLabel("github_org")).toBe("GitHub organisation");
    expect(kindLabel("local_folder")).toBe("Local folder");
  });

  it("lists the connected source, shows its candidates with statuses and the install mark, and creates a project from a proposal", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const rows = await screen.findAllByTestId("source");
    expect(rows).toHaveLength(1);
    const acme = rows[0];
    if (!acme) throw new Error("no source row");
    expect(acme).toHaveAttribute("data-kind", "github_org");
    expect(acme).toHaveTextContent("Acme");
    expect(within(acme).getByTestId("source-credential")).toHaveTextContent("secret:github_token");
    expect(within(acme).getByTestId("source-counts")).toHaveTextContent(
      "1 proposed, 1 accepted, 1 duplicate, 1 with an existing install",
    );
    await user.click(within(acme).getByTestId("source-candidates"));
    const candidates = await within(acme).findAllByTestId("candidate");
    expect(candidates.map((c) => c.dataset.status)).toEqual(["duplicate", "accepted", "proposed"]);
    const gamma = candidates.find((c) => c.dataset.candidateId === "cand_gamma");
    const alpha = candidates.find((c) => c.dataset.candidateId === "cand_alpha");
    if (!gamma || !alpha) throw new Error("candidates");
    expect(within(gamma).getByTestId("candidate-install")).toHaveTextContent(
      "existing install (.forerunner/project.json)",
    );
    expect(within(alpha).getByTestId("candidate-project")).toHaveAttribute(
      "href",
      "/projects/proj_atlas",
    );
    expect(within(alpha).queryByTestId("candidate-accept")).toBeNull();
    await user.click(within(gamma).getByTestId("candidate-accept"));
    await waitFor(() => expect(gamma).toHaveAttribute("data-status", "accepted"));
    const accept = postedCalls(harness, "/sources/candidates/cand_gamma/accept");
    expect(accept).toHaveLength(1);
    expect(accept[0]?.body).toEqual({});
    expect(within(acme).getByTestId("source-created")).toHaveTextContent("Project created: gamma");
    await waitFor(() =>
      expect(harness.store.getState().projects.some((p) => p.name === "gamma")).toBe(true),
    );
    // The daemon's list now counts it as accepted.
    await waitFor(() =>
      expect(within(acme).getByTestId("source-counts")).toHaveTextContent("2 accepted"),
    );
  });

  it("connects a folder source, scans it, and removes it after a confirmation; a token value is refused by the daemon and shown", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    await screen.findAllByTestId("source");
    await user.selectOptions(screen.getByTestId("add-source-kind"), "local_folder");
    expect(screen.queryByTestId("add-source-credential")).toBeNull();
    await user.type(screen.getByTestId("add-source-locator"), "/srv/projects");
    await user.type(screen.getByTestId("add-source-name"), "Server projects");
    await user.click(screen.getByTestId("add-source"));
    await waitFor(() => expect(screen.getAllByTestId("source")).toHaveLength(2));
    expect(postedCalls(harness, "/sources")[0]?.body).toEqual({
      kind: "local_folder",
      locator: "/srv/projects",
      displayName: "Server projects",
    });
    const folder = screen.getAllByTestId("source").find((r) => r.dataset.kind === "local_folder");
    if (!folder) throw new Error("no folder row");
    expect(within(folder).getByTestId("source-counts")).toHaveTextContent("not scanned yet");
    expect(within(folder).queryByTestId("source-credential")).toBeNull();
    await user.click(within(folder).getByTestId("source-scan"));
    const found = await within(folder).findAllByTestId("candidate");
    expect(found.map((c) => c.dataset.status)).toEqual(["proposed", "proposed"]);
    expect(within(found[1] as HTMLElement).getByTestId("candidate-install")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(folder).getByTestId("source-counts")).toHaveTextContent("2 proposed"),
    );
    expect(within(folder).getByTestId("source-scan")).toHaveTextContent("Rescan");

    await user.click(within(folder).getByTestId("source-remove"));
    await user.click(within(folder).getByTestId("source-remove-confirm"));
    await waitFor(() => expect(screen.getAllByTestId("source")).toHaveLength(1));
    const deleted = harness.daemon.state.calls.filter((c) => c.method === "DELETE");
    expect(deleted.map((c) => c.path)).toEqual([expect.stringMatching(/^\/sources\/src_\d+$/)]);

    // A token pasted where the reference goes: the daemon refuses and the form says why.
    await user.selectOptions(screen.getByTestId("add-source-kind"), "github_org");
    await user.type(screen.getByTestId("add-source-locator"), "acme-two");
    await user.type(screen.getByTestId("add-source-credential"), "ghp_notareference");
    await user.click(screen.getByTestId("add-source"));
    await screen.findByText(/a token value is never stored/);
    expect(screen.getAllByTestId("source")).toHaveLength(1);
  });

  it("degrades when the daemon has no sources route", async () => {
    renderApp("/settings", createHarness({ missingRoutes: ["/sources"] }));
    expect(await screen.findByTestId("sources-missing")).toHaveTextContent(
      "no source discovery route",
    );
    expect(screen.queryByTestId("add-source-form")).toBeNull();
  });
});
