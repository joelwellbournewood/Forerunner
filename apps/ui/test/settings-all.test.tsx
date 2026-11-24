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

  it("w8-status-write (W8-write-7, -10): the status issue's switch: a repository project's row, on by default, says where the status is on GitHub and, on a public repository, who can read it; Off sends settings.set status_issue false and the row reads off with its sentence", async () => {
    // The daemon lists the row for a project on a host repository only (settings-view.ts).
    const user = userEvent.setup();
    const harness = createHarness();
    harness.daemon.state.statusIssue.proj_atlas = {
      sentence: "Status on GitHub: issue #12 (pinned)",
      docsNote: "In the app; also on GitHub: issue #12",
      public: true,
    };
    renderApp("/settings", harness);
    const row = await rowFor("project.status_issue");
    expect(within(row).getByTestId("setting-scope")).toHaveTextContent("Atlas");
    expect(within(row).getByTestId("setting-label")).toHaveTextContent("Status issue on GitHub");
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent("on");
    expect(row).toHaveTextContent(
      "The status of Atlas on GitHub: this Forerunner's own comment on the project's pinned status issue, with no costs (off: it stays in the app, under Docs, Status). Status on GitHub: issue #12 (pinned) Everyone who can see this repository can read it.",
    );
    const rows = await screen.findAllByTestId("setting-row");
    expect(rows.filter((r) => r.dataset.key === "project.status_issue")).toHaveLength(1);
    // The status pull request went with it (amendment 2).
    for (const r of rows) expect(r).not.toHaveTextContent("Status pull request");
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    await user.selectOptions(within(dialog).getByTestId("setting-value"), "false");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [
        {
          name: "settings.set",
          params: { key: "status_issue", value: false, project: "proj_atlas" },
        },
      ],
    });
    // The daemon's sentence: what the switch does, in words.
    expect(await within(dialog).findByTestId("command-done")).toHaveTextContent(
      "this Forerunner writes no status issue or comment for the project; its status stays in the app (Docs, Status)",
    );
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(async () =>
      expect(
        within(await rowFor("project.status_issue")).getByTestId("setting-value-cell"),
      ).toHaveTextContent("off"),
    );
    expect(await rowFor("project.status_issue")).toHaveTextContent(
      'Status stays in the app: the status issue is turned off for "Atlas" in Settings.',
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

  it("no 'When my first choice runs out mid-session' row: the one choice is Basics' 'Which Claude does the work' (d1109-cred-screens CS-2; before U-078's row)", async () => {
    const harness = createHarness();
    renderApp("/settings", harness);
    await screen.findAllByTestId("setting-row");
    expect(
      screen
        .queryAllByTestId("setting-row")
        .some((r) => r.dataset.key === "human.mid_session_limit"),
    ).toBe(false);
    expect(document.body).not.toHaveTextContent("When my first choice runs out mid-session");
    expect(await screen.findByTestId("credential-policy")).toBeInTheDocument();
  });

  it("code tasks that need commands: my first choice by default; the API key asks a yes and is sent as settings.set (U-078, the chooser)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const row = await rowFor("human.code_commands");
    expect(within(row).getByTestId("setting-label")).toHaveTextContent(
      "Code tasks that need commands",
    );
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent(
      "My first choice anyway (on a subscription their tests do not run)",
    );
    // The row says what each value costs: no tests on a subscription, money on the key.
    expect(row).toHaveTextContent("so their own tests do not run");
    expect(row).toHaveTextContent("costs money");
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    expect(dialog).not.toHaveTextContent("..");
    await user.selectOptions(within(dialog).getByTestId("setting-value"), "api_key");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [{ name: "settings.set", params: { key: "code_commands", value: "api_key" } }],
      wordsUsed:
        "Settings: Code tasks that need commands to The API key (runs their tests; costs money)",
      source: "ui",
    });
    // Moving code work onto money is a yes first (medium risk).
    const pending = await within(dialog).findByTestId("command-pending");
    expect(pending).toHaveAttribute("data-decision", "needs_yes");
    await user.click(within(pending).getByTestId("command-yes"));
    await within(dialog).findByTestId("command-done");
    expect(harness.daemon.state.settingValues.code_commands).toBe("api_key");
    await user.click(within(dialog).getByTestId("command-close"));
    await waitFor(async () =>
      expect(
        within(await rowFor("human.code_commands")).getByTestId("setting-value-cell"),
      ).toHaveTextContent("The API key (runs their tests; costs money)"),
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

/**
 * l3-small, run L3 (live check 3, L3-github-8): the Who merges row and its change dialog read
 * "on Kite trips's Overview". The project's name is not made a possessive.
 */
describe("l3-small, run L3: Settings never makes a project's name a possessive (L3-github-8)", () => {
  it("the Who merges row and its dialog say 'on the Overview of Atlas'; the highest model says 'the runs of Atlas'", async () => {
    const user = userEvent.setup();
    renderApp("/settings", createHarness());
    const row = await rowFor("project.merge_mode");
    expect(row).toHaveTextContent("waits for your Merge on the Overview of Atlas)");
    await user.click(within(row).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    expect(dialog).toHaveTextContent("waits for your Merge on the Overview of Atlas)");
    expect(dialog).not.toHaveTextContent("Atlas's");
    expect(await rowFor("project.critic_ceiling")).toHaveTextContent(
      "The highest model the runs of Atlas may use",
    );
    for (const r of await screen.findAllByTestId("setting-row"))
      expect(r).not.toHaveTextContent("Atlas's");
  });
});

describe("l4-github-link, run L4", () => {
  it("w8-status-write (W8-write-6): a project worked on together has the Status issue on GitHub row too (its own comment on the shared issue); no Status pull request row anywhere; Who merges stays", async () => {
    // Before (L4-github-103): the together project had no status at all on GitHub.
    const harness = createHarness();
    harness.daemon.state.repositoryOverview.proj_atlas = {
      kind: "together",
      text: "Shared on GitHub with another Forerunner: each keeps its own tasks.",
      canTakeOver: false,
      takeOverLine: null,
      details: null,
    };
    renderApp("/settings", harness);
    await rowFor("project.merge_mode");
    const row = await rowFor("project.status_issue");
    expect(within(row).getByTestId("setting-value-cell")).toHaveTextContent("on");
    expect(row).toHaveTextContent(
      "Status on GitHub: the status issue is written when a task starts or a session ends.",
    );
    const rows = await screen.findAllByTestId("setting-row");
    for (const r of rows) expect(r).not.toHaveTextContent("Status pull request");
  });
});
