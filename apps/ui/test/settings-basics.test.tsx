import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings opens on Basics (design §6, review of fix/progress-navigation): the walk opened it on
 * one long page where the monthly cap sat between "Language … the stored choice changes nothing
 * yet" (read-only), "Monthly critic calibration … up to USD 10", "Opus fast mode … USD 8 / 40
 * per million", the daemon's state URL and high/medium/low risk badges. Basics: your name and
 * your agent's, Claude, GitHub, budget per session, monthly cap, default autonomy by name, quiet
 * hours and Docker. Everything else is under Advanced, collapsed; rows that change nothing are
 * not listed.
 */
describe("Settings Basics (design §6)", () => {
  const basicRows = async () =>
    within(await screen.findByTestId("settings-basics")).findAllByTestId("setting-row");

  it("opens on Basics with what a person changes day to day; the rest is under a collapsed Advanced", async () => {
    const user = userEvent.setup();
    renderApp("/settings", createHarness());
    const basics = await screen.findByTestId("settings-basics");
    expect(within(basics).getByRole("heading", { name: "Basics" })).toBeInTheDocument();
    // Names first: yours and your agent's.
    expect(within(basics).getByTestId("your-name-input")).toHaveValue("Alice");
    expect(within(basics).getByTestId("agent-name-input")).toHaveValue("Alice's agent");
    // Claude and GitHub, in words, with the setup assistant.
    const accounts = within(basics).getByTestId("settings-accounts");
    expect(within(accounts).getByTestId("account-claude")).toHaveTextContent("Claude: connected");
    expect(within(accounts).getByTestId("account-github")).toHaveTextContent("GitHub: connected");
    expect(
      within(accounts).getByRole("link", { name: "Open the setup assistant" }),
    ).toHaveAttribute("href", "/setup");
    // Budget per session, the monthly cap, the default autonomy by name and quiet hours.
    const rows = await basicRows();
    expect(rows.map((r) => r.dataset.key)).toEqual([
      "project.session_cap",
      "human.monthly_cap",
      "human.default_autonomy",
      "human.quiet_hours",
    ]);
    const autonomy = rows[2] as HTMLElement;
    expect(within(autonomy).getByTestId("setting-value-cell")).toHaveTextContent(
      "Standard: routine, reversible actions run; the rest asks you",
    );
    expect(within(rows[0] as HTMLElement).getByTestId("setting-scope")).toHaveTextContent("Atlas");
    for (const row of rows) {
      expect(within(row).getByTestId("setting-explain").textContent).not.toBe("");
      expect(within(row).getByTestId("setting-change")).toBeInTheDocument();
    }
    // Docker status.
    expect(within(basics).getByTestId("sandbox-settings")).toBeInTheDocument();
    // No internals in Basics: no risk badges, USD, read-only rows, state URL or model rows.
    expect(basics).not.toHaveTextContent(/USD|read-only|\b(high|medium|low)\b|sqlite|Opus fast/i);

    // Advanced: collapsed, with everything else, its contents named on the summary.
    const advanced = screen.getByTestId("settings-advanced") as HTMLDetailsElement;
    expect(advanced.tagName).toBe("DETAILS");
    expect(advanced.open).toBe(false);
    const summary = within(advanced).getByTestId("settings-advanced-summary");
    expect(summary).toHaveTextContent("Advanced");
    expect(summary).toHaveTextContent(/models.*voice.*devices/i);
    for (const id of [
      "daemon-status",
      "billing-order-section",
      "plan-allowance-section",
      "devices-section",
      "desktop-allowlist",
      "hotkey-settings",
      "capabilities-section",
    ])
      expect(within(advanced).getByTestId(id)).toBeInTheDocument();
    expect(basics).not.toContainElement(screen.getByTestId("daemon-status"));
    await user.click(summary);
    expect(advanced.open).toBe(true);
    // The other settings table holds the rest, and no row of Basics again (one place per fact).
    const table = within(advanced).getAllByTestId("setting-row");
    const keys = table.map((r) => r.dataset.key);
    expect(keys).toEqual(
      expect.arrayContaining(["project.autonomy", "project.critic_ceiling", "human.model_watch"]),
    );
    for (const k of ["human.monthly_cap", "human.default_autonomy", "human.quiet_hours"])
      expect(keys).not.toContain(k);
    // Rows that change nothing are not listed (validation rule 7): language, the model provider.
    expect(screen.queryByText("Language")).toBeNull();
    for (const k of ["human.language", "runtime.provider"])
      expect(screen.getAllByTestId("setting-row").map((r) => r.dataset.key)).not.toContain(k);
    // No risk column: the change card says how risky a change is.
    expect(within(advanced).queryByRole("columnheader", { name: "Risk" })).toBeNull();
  });

  it("budget per session takes any amount in CHF, with a point or a comma (design §6)", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const cap = (await basicRows()).find(
      (r) => r.dataset.key === "project.session_cap",
    ) as HTMLElement;
    expect(within(cap).getByTestId("setting-value-cell")).toHaveTextContent("CHF 5.00");
    await user.click(within(cap).getByTestId("setting-change"));
    const dialog = await screen.findByTestId("setting-dialog");
    const input = within(dialog).getByTestId("setting-value");
    for (const typed of ["12.30", "1,50"]) {
      await user.clear(input);
      await user.type(input, typed);
      expect(input).toBeValid();
      expect(within(dialog).queryByTestId("setting-value-problem")).toBeNull();
      expect(within(dialog).getByTestId("setting-apply")).toBeEnabled();
    }
    await user.clear(input);
    await user.type(input, "0");
    expect(within(dialog).getByTestId("setting-value-problem")).toHaveTextContent(
      "The amount must be more than CHF 0.",
    );
    expect(within(dialog).getByTestId("setting-apply")).toBeDisabled();
    await user.clear(input);
    await user.type(input, "12.30");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [
        {
          name: "budget.set",
          params: { scope: "session", amountChf: 12.3, project: "proj_atlas" },
        },
      ],
    });
  });

  it("autonomy is chosen by name everywhere: the default in Basics and each project's under Advanced", async () => {
    const user = userEvent.setup();
    const harness = createHarness();
    renderApp("/settings", harness);
    const named = [
      "Advisor: plans and proposes only; you approve every action",
      "Assisted: acts after you approve each session's plan",
      "Standard: routine, reversible actions run; the rest asks you",
      "Trusted: also merges reviewed pull requests",
      "Autopilot: everything except destructive, money and credential actions",
    ];
    const def = (await basicRows()).find(
      (r) => r.dataset.key === "human.default_autonomy",
    ) as HTMLElement;
    await user.click(within(def).getByTestId("setting-change"));
    let dialog = await screen.findByTestId("setting-dialog");
    let select = within(dialog).getByTestId("setting-value");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(named);
    await user.click(within(dialog).getByText("Cancel"));

    const project = screen
      .getAllByTestId("setting-row")
      .find(
        (r) =>
          r.dataset.key === "project.autonomy" &&
          within(r).getByTestId("setting-scope").textContent === "Atlas",
      ) as HTMLElement;
    expect(within(project).getByTestId("setting-value-cell")).toHaveTextContent(named[2] as string);
    await user.click(within(project).getByTestId("setting-change"));
    dialog = await screen.findByTestId("setting-dialog");
    select = within(dialog).getByTestId("setting-value");
    expect(select.tagName).toBe("SELECT");
    expect([...select.querySelectorAll("option")].map((o) => o.textContent)).toEqual(named);
    await user.selectOptions(select, "3");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toMatchObject({
      commands: [{ name: "autonomy.set", params: { level: 3, project: "proj_atlas" } }],
    });
  });

  it("your name: Save renames you through the setup assistant's route, and the app names you so", async () => {
    const user = userEvent.setup();
    // After "Set up later" the daemon names the person with its placeholder: not a name to show
    // (U-077; bench: the field read "me").
    const harness = createHarness({ me: { name: "me" } });
    renderApp("/settings", harness);
    const input = await screen.findByTestId("your-name-input");
    expect(input).toHaveValue("");
    expect(screen.getByTestId("your-name-save")).toBeDisabled();
    await user.clear(input);
    await user.type(input, "Robin");
    await user.click(screen.getByTestId("your-name-save"));
    await waitFor(() => expect(postedCalls(harness, "/setup/profile")).toHaveLength(1));
    expect(postedCalls(harness, "/setup/profile")[0]?.body).toEqual({ name: "Robin" });
    expect(await screen.findByTestId("your-name-saved")).toHaveTextContent(
      "Saved. Forerunner calls you Robin.",
    );
    await waitFor(() => expect(harness.store.getState().me?.name).toBe("Robin"));
  });

  it("without Claude, Basics says so with Connect Claude", async () => {
    const harness = createHarness({
      me: { provider: null },
      setup: { credentials: { github: false, anthropicApiKey: false, subscription: false } },
    });
    renderApp("/settings", harness);
    const accounts = await screen.findByTestId("settings-accounts");
    expect(await within(accounts).findByTestId("account-claude")).toHaveTextContent(
      "Claude: not connected",
    );
    expect(within(accounts).getByRole("link", { name: "Connect Claude" })).toHaveAttribute(
      "href",
      "/setup",
    );
    expect(await within(accounts).findByTestId("account-github")).toHaveTextContent(
      "GitHub: not connected",
    );
  });
});
