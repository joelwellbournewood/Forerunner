import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  columnsFor,
  modelSettingCommand,
  optionsFor,
  rowsOf,
} from "../src/pages/ModelSettingsSection.tsx";
import { MODEL_SETTINGS, SETTINGS } from "./fixtures.ts";
import { createHarness, postedCalls, renderApp } from "./helpers.tsx";

/**
 * Settings → Models (spec D.4, ADR 0072): model, effort, max tokens, speed mode and timeout per
 * agent and specialist with the defaults from the effort table or the registry file; the
 * temperature column only for a provider whose capability flag says it accepts one; changes
 * through `model.settings.set` with the change card and the change log.
 */

const rowOf = async (kind: string, name: string, mode?: string) => {
  const rows = await screen.findAllByTestId("model-settings-row");
  const row = rows.find(
    (r) => r.dataset.kind === kind && r.dataset.name === name && (!mode || r.dataset.mode === mode),
  );
  if (!row) throw new Error(`no row ${kind} ${name} ${mode ?? ""}`);
  return row as HTMLElement;
};

describe("Settings: models per agent and specialist", () => {
  it("shows model, effort, max tokens, speed mode and timeout with their defaults and sources", async () => {
    renderApp("/settings", createHarness({ acceptsTemperature: false }));
    const section = await screen.findByTestId("model-settings");
    await within(section).findAllByTestId("model-settings-row");
    for (const field of ["tier", "effort", "max_tokens", "speed_mode", "timeout_minutes"])
      expect(within(section).getByTestId(`model-settings-col-${field}`)).toBeInTheDocument();
    const planning = await rowOf("agent", "Alice", "planning");
    expect(within(planning).getByTestId("model-setting-tier")).toHaveTextContent(
      "sonnet (fake-sonnet)",
    );
    expect(within(planning).getByTestId("model-setting-max_tokens")).toHaveTextContent("16000");
    expect(within(planning).getByTestId("model-setting-max_tokens")).toHaveTextContent(
      "effort table",
    );
    expect(within(planning).getByTestId("model-setting-timeout_minutes")).toHaveTextContent("5");
    // An agent override is marked and says the default it replaced.
    const chat = await rowOf("agent", "Alice", "text_chat");
    const chatTokens = within(chat).getByTestId("model-setting-max_tokens");
    expect(chatTokens).toHaveAttribute("data-source", "agent");
    expect(within(chatTokens).getByText("set")).toHaveAttribute(
      "title",
      "default 400 from the effort table",
    );
    // A specialist's own values come from its registry file.
    const coder = await rowOf("specialist", "coder");
    expect(within(coder).getByTestId("model-setting-timeout_minutes")).toHaveTextContent(
      "45 registry file",
    );
    expect(within(coder).getByTestId("model-setting-speed_mode")).toHaveTextContent("standard");
    // The critic is shown but not editable here (spec H sets its model).
    const critic = await rowOf("agent", "Critic", "critic_t1");
    expect(within(critic).queryAllByTestId("model-setting-change")).toHaveLength(0);
    expect(within(critic).getByTestId("model-settings-note")).toHaveTextContent(/review tiers/);
  });

  it("hides temperature for a provider that does not accept one", async () => {
    renderApp("/settings", createHarness({ acceptsTemperature: false }));
    const section = await screen.findByTestId("model-settings");
    await within(section).findAllByTestId("model-settings-row");
    expect(within(section).queryByTestId("model-settings-col-temperature")).toBeNull();
    expect(within(section).queryAllByTestId("model-setting-temperature")).toHaveLength(0);
    expect(within(section).getByTestId("model-provider")).toHaveTextContent("takes no temperature");
  });

  it("shows temperature for a provider that accepts one", async () => {
    renderApp("/settings", createHarness({ acceptsTemperature: true }));
    const section = await screen.findByTestId("model-settings");
    await within(section).findAllByTestId("model-settings-row");
    expect(within(section).getByTestId("model-settings-col-temperature")).toBeInTheDocument();
    const researcher = await rowOf("specialist", "researcher");
    expect(within(researcher).getByTestId("model-setting-temperature")).toHaveTextContent("0.2");
    expect(within(section).getByTestId("model-provider")).toHaveTextContent(
      "accepts a temperature",
    );
  });

  it("changes a specialist's max tokens through model.settings.set and shows the new value", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ acceptsTemperature: false });
    renderApp("/settings", harness);
    const coder = await rowOf("specialist", "coder");
    await user.click(
      within(within(coder).getByTestId("model-setting-max_tokens")).getByTestId(
        "model-setting-change",
      ),
    );
    const dialog = await screen.findByTestId("setting-dialog");
    const input = within(dialog).getByTestId("setting-value");
    expect(input).toHaveValue("default");
    await user.clear(input);
    await user.type(input, "8000");
    await user.click(within(dialog).getByTestId("setting-apply"));
    await waitFor(() => expect(postedCalls(harness, "/commands/execute")).toHaveLength(1));
    expect(postedCalls(harness, "/commands/execute")[0]?.body).toEqual({
      commands: [
        {
          name: "model.settings.set",
          params: { agent: "agent_alice", specialist: "coder", field: "max_tokens", value: 8000 },
        },
      ],
      wordsUsed: "Settings: specialist.coder.max_tokens to 8000",
      source: "ui",
    });
    const done = await within(dialog).findByTestId("command-done");
    expect(within(done).getByTestId("command-sentence")).toHaveTextContent(
      "Set the max tokens per call of the coder specialist for Alice from the default to 8000.",
    );
    await user.click(within(done).getByTestId("command-close"));
    await waitFor(async () =>
      expect(
        within(await rowOf("specialist", "coder")).getByTestId("model-setting-max_tokens"),
      ).toHaveAttribute("data-source", "agent"),
    );
    expect(
      within(await rowOf("specialist", "coder")).getByTestId("model-setting-max_tokens"),
    ).toHaveTextContent("8000");
  });

  it("picks a speed mode from a list; fast asks for a yes on the change card", async () => {
    const user = userEvent.setup();
    const harness = createHarness({ acceptsTemperature: false });
    renderApp("/settings", harness);
    const coder = await rowOf("specialist", "coder");
    await user.click(
      within(within(coder).getByTestId("model-setting-speed_mode")).getByTestId(
        "model-setting-change",
      ),
    );
    const dialog = await screen.findByTestId("setting-dialog");
    const select = within(dialog).getByTestId("setting-value");
    expect(select.tagName).toBe("SELECT");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["default (standard, effort table)", "standard", "fast"]);
    await user.selectOptions(select, "fast");
    await user.click(within(dialog).getByTestId("setting-apply"));
    const pending = await within(dialog).findByTestId("command-pending");
    expect(within(pending).getByTestId("change-card")).toHaveAttribute("data-risk", "medium");
    await user.click(within(pending).getByTestId("command-yes"));
    await within(dialog).findByTestId("command-done");
  });

  it("maps every field to the command's parameters and refuses values out of range", () => {
    const target = { agent: "agent_alice", mode: "planning", subject: "Alice · planning" };
    const planning = MODEL_SETTINGS.agents[0]?.modes[0];
    if (!planning) throw new Error("fixture");
    const tokens = modelSettingCommand(target, "max_tokens", planning.maxTokens);
    expect(tokens.command.name).toBe("model.settings.set");
    expect(tokens.command.params("20000")).toEqual({
      agent: "agent_alice",
      mode: "planning",
      field: "max_tokens",
      value: 20000,
    });
    expect(tokens.command.params("default")).toMatchObject({ value: null });
    expect(tokens.command.params("0")).toBeNull();
    expect(tokens.command.params("200000")).toBeNull();
    expect(tokens.command.params("1.5")).toBeNull();
    expect(tokens.setting.risk).toBe("low");
    const tier = modelSettingCommand(target, "tier", planning.tier);
    expect(tier.command.params("opus")).toMatchObject({ field: "tier", value: "opus" });
    expect(tier.command.params("gpt")).toBeNull();
    expect(tier.setting.risk).toBe("medium");
    const temp = modelSettingCommand(target, "temperature", planning.temperature ?? planning.tier);
    expect(temp.command.params("0.7")).toMatchObject({ value: 0.7 });
    expect(temp.command.params("1.2")).toBeNull();
    // Rows: two of Alice's modes, the critic's, then the specialists.
    expect(rowsOf(MODEL_SETTINGS).map((r) => r.label)).toEqual([
      "Alice · planning",
      "Alice · chat",
      "Critic · review tier 1",
      "coder",
      "researcher",
    ]);
    expect(columnsFor(MODEL_SETTINGS).map((c) => c.field)).toContain("temperature");
    expect(
      columnsFor({ provider: { ...MODEL_SETTINGS.provider, acceptsTemperature: false } }).map(
        (c) => c.field,
      ),
    ).not.toContain("temperature");
  });

  it("offers a specialist's effort only up to its max_effort", async () => {
    const user = userEvent.setup();
    renderApp("/settings", createHarness({ acceptsTemperature: false }));
    const coder = await rowOf("specialist", "coder");
    await user.click(
      within(within(coder).getByTestId("model-setting-effort")).getByTestId("model-setting-change"),
    );
    const dialog = await screen.findByTestId("setting-dialog");
    const options = within(within(dialog).getByTestId("setting-value"))
      .getAllByRole("option")
      .map((o) => o.getAttribute("value"));
    // The fixture's coder says max_effort high: no xhigh, no max.
    expect(options).toEqual(["default", "low", "medium", "high"]);
    const target = {
      agent: "agent_alice",
      specialist: "coder",
      subject: "coder",
      maxEffort: "high",
    };
    const effort = MODEL_SETTINGS.specialists[0]?.settings.effort;
    if (!effort) throw new Error("fixture");
    expect(modelSettingCommand(target, "effort", effort).command.params("max")).toBeNull();
    expect(optionsFor("effort", {})).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(optionsFor("tier", { maxEffort: "low" })).toEqual(["haiku", "sonnet", "opus", "fable"]);
  });

  it("names the missing route on an older daemon and keeps the rest of the page", async () => {
    renderApp("/settings", createHarness({ missingRoutes: ["/settings/models"] }));
    const section = await screen.findByTestId("model-settings");
    await waitFor(() => expect(section).toHaveTextContent("/settings/models"));
    // Every row of "All settings" is still there (the fixture's, the D.16 slider row included).
    expect(await screen.findAllByTestId("setting-row")).toHaveLength(SETTINGS.length);
  });
});

/**
 * Model settings show only choices that run (U-059): chat and planning always run at standard
 * speed, so their speed has no choice; every row says the highest model it runs at, chat
 * offers nothing above opus, and fable is offered to a specialist with what it takes to run.
 */
describe("Settings: models show what runs (U-059)", () => {
  it("chat and planning offer no speed choice; the specialists do", async () => {
    renderApp("/settings", createHarness());
    for (const mode of ["planning", "text_chat"]) {
      const row = await rowOf("agent", "Alice", mode);
      const speed = within(row).getByTestId("model-setting-speed_mode");
      expect(speed).toHaveTextContent("standard (always)");
      expect(speed).toHaveAttribute("data-fixed", "true");
      expect(within(speed).queryByTestId("model-setting-change")).toBeNull();
    }
    const coder = await rowOf("specialist", "coder");
    expect(
      within(within(coder).getByTestId("model-setting-speed_mode")).getByTestId(
        "model-setting-change",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("model-provider")).toHaveTextContent(
      "Chat and planning always run at standard speed",
    );
  });

  it("each row says its highest model; chat offers nothing above opus, a specialist says what fable needs", async () => {
    const user = userEvent.setup();
    renderApp("/settings", createHarness());
    const chat = await rowOf("agent", "Alice", "text_chat");
    expect(within(chat).getByTestId("model-settings-ceiling")).toHaveTextContent(
      "Chat runs at most opus; no setting raises it.",
    );
    await user.click(
      within(within(chat).getByTestId("model-setting-tier")).getByTestId("model-setting-change"),
    );
    let dialog = await screen.findByTestId("setting-dialog");
    const chatOptions = [
      ...within(dialog).getByTestId("setting-value").querySelectorAll("option"),
    ].map((o) => o.value);
    expect(chatOptions).toEqual(["default", "haiku", "sonnet", "opus"]);
    await user.click(within(dialog).getByText("Cancel"));

    const coder = await rowOf("specialist", "coder");
    expect(within(coder).getByTestId("model-settings-ceiling")).toHaveTextContent(
      "Runs at most opus unless a project raises its highest model (Settings, per project: Highest model).",
    );
    await user.click(
      within(within(coder).getByTestId("model-setting-tier")).getByTestId("model-setting-change"),
    );
    dialog = await screen.findByTestId("setting-dialog");
    const fable = [...within(dialog).getByTestId("setting-value").querySelectorAll("option")].find(
      (o) => o.value === "fable",
    );
    expect(fable?.textContent).toBe(
      "fable (runs only where a project's highest model is fable; else opus)",
    );
  });
});
