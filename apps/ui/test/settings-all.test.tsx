import { DESKTOP_ALLOWLIST_CONTROL } from "@forerunner/runtime/daemon/api-types";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Every setting is visible in Settings (U-060): quiet hours, the notification channel, voice
 * alerts, the model watch, the highest model and the per-session cap had no control and were
 * shown nowhere, while texts pointed to Settings for them. Each is a row with a plain label
 * and its own control; the monthly jobs are labelled fields, not JSON.
 */
const rowFor = async (key: string) => {
  const rows = await screen.findAllByTestId("setting-row");
  const row = rows.find((r) => r.dataset.key === key);
  if (!row) throw new Error(`no row ${key}`);
  return row as HTMLElement;
};

describe("every setting is visible in Settings (U-060)", () => {
  it("lists them with plain labels and values in words, never a raw key or JSON", async () => {
    renderApp("/settings", createHarness());
    const rows = await screen.findAllByTestId("setting-row");
    const labels = rows.map((r) => within(r).getByTestId("setting-label").textContent);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Quiet hours",
        "Where notifications go",
        "Read urgent notifications aloud",
        "Model watch evaluations",
        "Monthly critic calibration",
        "Budget per session",
        "Highest model",
        "Small-project mode",
        "Speed or quality",
      ]),
    );
    for (const row of rows) {
      expect(within(row).getByTestId("setting-label").textContent).not.toMatch(
        /^[a-z]+\.[a-z_.]+$/,
      );
      expect(within(row).getByTestId("setting-value-cell").textContent).not.toMatch(/^[{[]/);
    }
    const quiet = await rowFor("human.quiet_hours");
    expect(within(quiet).getByTestId("setting-value-cell")).toHaveTextContent("off");
    const watch = await rowFor("human.model_watch");
    expect(within(watch).getByTestId("setting-value-cell")).toHaveTextContent(
      "asks before any paid evaluation; evaluations need a container",
    );
    // Stored but read by nothing yet: a row that changes nothing is not listed (validation rule
    // 7, design §6: "Rows that do nothing are hidden"); before, it sat beside the monthly cap as
    // "Language … the stored choice changes nothing yet" with "read-only".
    expect(rows.map((r) => r.dataset.key)).not.toContain("human.language");
    expect(screen.queryByText(/changes nothing yet/)).toBeNull();
    // Every row listed has its Change.
    for (const row of rows) expect(within(row).getByTestId("setting-change")).toBeInTheDocument();
  });

  it("quiet hours: a check box and two times send settings.set with the times", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    await user.click(within(await rowFor("human.quiet_hours")).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    expect(dialog).toHaveTextContent("Change quiet hours");
    await user.click(within(dialog).getByTestId("setting-field-on"));
    const from = within(dialog).getByTestId("setting-field-start");
    await user.clear(from);
    await user.type(from, "21:30");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        {
          name: "settings.set",
          params: { key: "quiet_hours", value: { start: "21:30", end: "07:00" } },
        },
      ],
      wordsUsed: "Settings: Quiet hours to from 21:30 to 07:00",
      source: "ui",
    });
    await within(dialog).findByTestId("command-done");
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(async () =>
      expect(
        within(await rowFor("human.quiet_hours")).getByTestId("setting-value-cell"),
      ).toHaveTextContent("from 21:30 to 07:00"),
    );
  });

  it("the status pull request: a repository project's row, off by default; On sends settings.set and the row reads on (C-57)", async () => {
    // The daemon lists the row for a project on a host repository only (settings-view.ts).
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const row = await rowFor("project.status_pull_request");
    expect(within(row).getByTestId("setting-scope")).toHaveTextContent("Atlas");
    expect(within(row).getByTestId("setting-label")).toHaveTextContent("Status pull request");
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent("off");
    const rows = await screen.findAllByTestId("setting-row");
    expect(rows.filter((r) => r.dataset.key === "project.status_pull_request")).toHaveLength(1);
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    await user.selectOptions(within(dialog).getByTestId("setting-value"), "true");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [
        {
          name: "settings.set",
          params: { key: "status_pull_request", value: true, project: "proj_atlas" },
        },
      ],
    });
    // The daemon's sentence: what the switch does, in words.
    expect(await within(dialog).findByTestId("command-done")).toHaveTextContent(
      "each session's status goes to the repository as one pull request",
    );
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(async () =>
      expect(
        within(await rowFor("project.status_pull_request")).getByTestId("setting-value-cell"),
      ).toHaveTextContent("on"),
    );
  });

  it("who merges accepted work: You press Merge by default; Merge automatically after review says what it means, asks a yes and is sent as settings.set (merge-in-app, U-028)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const row = await rowFor("project.merge_mode");
    expect(within(row).getByTestId("setting-scope")).toHaveTextContent("Atlas");
    expect(within(row).getByTestId("setting-label")).toHaveTextContent("Who merges accepted work");
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent("You press Merge");
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    await user.selectOptions(within(dialog).getByTestId("setting-value"), "after_review");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        {
          name: "settings.set",
          params: { key: "merge_mode", value: "after_review", project: "proj_atlas" },
        },
      ],
      wordsUsed: "Settings: Who merges accepted work to Merge automatically after review",
      source: "ui",
      projectId: "proj_atlas",
    });
    // Automatic merges are a yes first, and the card says what they mean (owner-answers.md 1).
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_yes");
    expect(pending).toHaveTextContent("Merges show under your GitHub name");
    expect(pending).toHaveTextContent("a comment on a merged pull request starts nothing");
    expect(pending).toHaveTextContent("every accepted task goes live");
    await user.click(within(pending).getByTestId("command-yes"));
    await within(dialog).findByTestId("command-done");
    expect(harness.daemon.state.settingValues["merge_mode:proj_atlas"]).toBe("after_review");
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(async () =>
      expect(
        within(await rowFor("project.merge_mode")).getByTestId("setting-value-cell"),
      ).toHaveTextContent("Merge automatically after review"),
    );
  });

  it("when my first choice runs out mid-session: Wait by default; Use the other one asks a yes and is sent as settings.set (U-078)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const row = await rowFor("human.mid_session_limit");
    expect(within(row).getByTestId("setting-label")).toHaveTextContent(
      "When my first choice runs out mid-session",
    );
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent(
      "Wait for its reset; the tasks start by themselves",
    );
    // The row says what it covers: tasks only, and that the other one may cost money.
    expect(row).toHaveTextContent("Chat, planning and reviews always use the next one");
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    // One full stop after the description (review of credential-limits: "next one.. The same").
    expect(dialog).toHaveTextContent("Chat, planning and reviews always use the next one. The");
    expect(dialog).not.toHaveTextContent("..");
    await user.selectOptions(within(dialog).getByTestId("setting-value"), "use_other");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        { name: "settings.set", params: { key: "mid_session_limit", value: "use_other" } },
      ],
      wordsUsed:
        "Settings: When my first choice runs out mid-session to Use the other one at once (may cost money)",
      source: "ui",
    });
    // Moving plan-limit work onto money is a yes first (medium risk).
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_yes");
    await user.click(within(pending).getByTestId("command-yes"));
    await within(dialog).findByTestId("command-done");
    expect(harness.daemon.state.settingValues.mid_session_limit).toBe("use_other");
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(async () =>
      expect(
        within(await rowFor("human.mid_session_limit")).getByTestId("setting-value-cell"),
      ).toHaveTextContent("Use the other one at once (may cost money)"),
    );
  });

  it("the model watch: run the paid evaluations without asking, confirmed with a yes", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    await user.click(within(await rowFor("human.model_watch")).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    const runEvals = within(dialog).getByTestId("setting-field-run_evals");
    expect(runEvals.closest("label")).toHaveTextContent(
      "Run the paid evaluations every week without asking",
    );
    await user.click(runEvals);
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [
        {
          name: "settings.set",
          params: { key: "model_watch", value: { run_evals: true, allow_process_sandbox: false } },
        },
      ],
    });
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_yes");
    await user.click(within(pending).getByTestId("command-yes"));
    await within(dialog).findByTestId("command-done");
    expect(harness.daemon.state.settingValues.model_watch).toEqual({
      run_evals: true,
      allow_process_sandbox: false,
    });
  });

  it("the per-session cap and the highest model have their own controls", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const cap = await rowFor("project.session_cap");
    expect(within(cap).getByTestId("setting-value-cell")).toHaveTextContent("CHF 5.00");
    await user.click(within(cap).getByTestId("setting-change"));
    let dialog = await screen.findByTestId("setting-dialog");
    expect(dialog).toHaveTextContent("Change budget per session for Atlas");
    const amount = within(dialog).getByTestId("setting-value");
    await user.clear(amount);
    await user.type(amount, "8");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [
        { name: "budget.set", params: { scope: "session", amountChf: 8, project: "proj_atlas" } },
      ],
    });
    await user.click(await within(dialog).findByTestId("command-no"));
    await user.click(await within(dialog).findByTestId("command-close"));

    // The control the model rows name ("raise it in Settings, per project: Highest model").
    const ceiling = await rowFor("project.critic_ceiling");
    expect(within(ceiling).getByTestId("setting-label")).toHaveTextContent("Highest model");
    await user.click(within(ceiling).getByTestId("setting-change"));
    dialog = await screen.findByTestId("setting-dialog");
    const select = within(dialog).getByTestId("setting-value");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "haiku",
      "sonnet",
      "opus (the default)",
      "fable (the top model; costs the most)",
    ]);
  });

  it("the desktop allowlist the approval card points to is here: add and remove an application", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const section = await screen.findByTestId("desktop-allowlist");
    // The approval card says "add it in Settings under <this heading>".
    expect(within(section).getByRole("heading")).toHaveTextContent(DESKTOP_ALLOWLIST_CONTROL);
    expect(await within(section).findAllByTestId("desktop-allowlist-entry")).toHaveLength(1);
    expect(within(section).getByTestId("desktop-allowlist-entry")).toHaveTextContent("code");
    await user.type(within(section).getByTestId("desktop-allowlist-name"), "firefox");
    await user.click(within(section).getByTestId("desktop-allowlist-add"));
    await waitFor(() =>
      expect(
        harness.daemon.state.calls.find((c) => c.path === "/desktop/allowlist/human_alice")?.body,
      ).toEqual({ entries: [{ app: "code" }, "firefox"] }),
    );
    expect(await within(section).findByTestId("desktop-allowlist-saved")).toHaveTextContent(
      "Added firefox",
    );
    expect(harness.daemon.state.desktopAllowlist).toEqual([{ app: "code" }, { app: "firefox" }]);
    const entries = within(section).getAllByTestId("desktop-allowlist-entry");
    await user.click(within(entries[0] as HTMLElement).getByTestId("desktop-allowlist-remove"));
    await waitFor(() =>
      expect(harness.daemon.state.desktopAllowlist).toEqual([{ app: "firefox" }]),
    );
  });
});
